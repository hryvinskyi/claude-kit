import { z } from 'zod';
import type {
  BranchComparison,
  DefaultBranchRead,
  Forge,
  PullFilesPage,
  PullListing,
  PullPage,
  PullRead,
} from '../application/forge-ports.ts';
import type { CommitStatus } from '../domain/forge/commit-status.ts';
import type { ForgePull } from '../domain/forge/pull-requests.ts';
import type { WorkflowRun } from '../domain/forge/workflow-runs.ts';
import { TransientFailure } from '../domain/errors.ts';
import { decodeWire, type CallOptions, type GitHubHttp, type RestResult } from './github-http.ts';

/** The most rows one page of a listing holds. */
const PAGE_SIZE = 100;
/** The most files GitHub lists in one comparison of two branches. */
const COMPARE_FILE_CAP = 300;
/** The most paths a footprint carries, which is the most the coordination server takes. */
const FOOTPRINT_PATH_CAP = 3000;
/** Answers that say a commit is not one this repository holds. */
const NO_SUCH_COMMIT = [404, 422] as const;
/** The answer that says a branch is not there. */
const NO_SUCH_BRANCH = [404] as const;

const Moment = z.string().datetime({ offset: true }).transform((text) => new Date(text));

const PullPayload = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged_at: Moment.nullable(),
  updated_at: Moment,
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  base: z.object({ ref: z.string() }),
});

const SinglePullPayload = PullPayload.extend({ mergeable: z.boolean().nullable().optional() });

/** A changed file; a rename names the path it left too, and both are paths the change touched. */
const ChangedFile = z.object({ filename: z.string(), previous_filename: z.string().optional() });

const CommitPayload = z.object({ sha: z.string() });

const RepositoryPayload = z.object({ default_branch: z.string() });

const Signature = z.object({ date: Moment }).nullable().optional();

const ComparePayload = z.object({
  merge_base_commit: z.object({
    sha: z.string(),
    commit: z.object({ committer: Signature, author: Signature }),
  }),
  files: z.array(ChangedFile).optional(),
});

const RunsPayload = z.object({
  workflow_runs: z.array(z.object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    created_at: Moment,
    head_sha: z.string(),
  })),
});

/**
 * GitHub's REST answers about pull requests, branches, workflow runs and commit
 * statuses, read into what the forge jobs decide by. Its answers are a foreign
 * model and stop here; each is parsed, never cast, and an answer of another shape
 * is a failure of the moment. Conditional requests carry the tag the caller holds,
 * and an answer of "unchanged" costs nothing against the hourly allowance.
 */
export class GitHubRestForge implements Forge {
  readonly #httpFor: (repo: string) => GitHubHttp;

  /** Handed the transport of the account each repository is reached with. */
  constructor(httpFor: (repo: string) => GitHubHttp) {
    this.#httpFor = httpFor;
  }

  remaining(repo: string): number | null {
    return this.#httpFor(repo).lastBudget('core')?.remaining ?? null;
  }

  async pullPage(repo: string, listing: PullListing, page: number, etag: string | null): Promise<PullPage> {
    const subject = `page ${String(page)} of the pull requests of ${repo}`;
    const query = new URLSearchParams({
      state: listing,
      sort: 'updated',
      direction: 'desc',
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const answer = await this.#get(repo, `${repoPath(repo)}/pulls?${query.toString()}`, subject, etag);
    if (answer.notModified) {
      return { changed: false };
    }
    return {
      changed: true,
      etag: answer.etag,
      pulls: rowsOf(answer.data, subject).map((row) => pullOf(repo, decodeWire(PullPayload, row, subject))),
      more: answer.nextPageUrl !== null,
      servedAt: answer.servedAt,
    };
  }

  async pull(repo: string, number: number, etag: string | null): Promise<PullRead> {
    const subject = `the pull request ${repo}#${String(number)}`;
    const answer = await this.#get(repo, `${repoPath(repo)}/pulls/${String(number)}`, subject, etag);
    if (answer.notModified) {
      return { changed: false };
    }
    const payload = decodeWire(SinglePullPayload, answer.data, subject);
    return { changed: true, etag: answer.etag, pull: pullOf(repo, payload), mergeable: payload.mergeable ?? null };
  }

  async pullFilesPage(repo: string, number: number, page: number): Promise<PullFilesPage> {
    const subject = `page ${String(page)} of the files of ${repo}#${String(number)}`;
    const query = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
    const answer = await this.#httpFor(repo).rest(
      'GET',
      `${repoPath(repo)}/pulls/${String(number)}/files?${query.toString()}`,
      undefined,
      subject,
    );
    const files = rowsOf(answer.data, subject).map((row) => decodeWire(ChangedFile, row, subject));
    return { paths: pathsOf(files), more: answer.nextPageUrl !== null };
  }

  async resolveCommit(repo: string, sha: string): Promise<string | null> {
    const subject = `the commit ${sha} of ${repo}`;
    const answer = await this.#httpFor(repo).rest(
      'GET',
      `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
      undefined,
      subject,
      { absentOn: NO_SUCH_COMMIT },
    );
    return answer.missing ? null : decodeWire(CommitPayload, answer.data, subject).sha;
  }

  async defaultBranch(repo: string, etag: string | null): Promise<DefaultBranchRead> {
    const subject = `the repository ${repo}`;
    const answer = await this.#get(repo, repoPath(repo), subject, etag);
    if (answer.notModified) {
      return { changed: false };
    }
    return { changed: true, etag: answer.etag, name: decodeWire(RepositoryPayload, answer.data, subject).default_branch };
  }

  async compare(repo: string, base: string, branch: string, etag: string | null): Promise<BranchComparison> {
    const subject = `what ${branch} changes against ${base} in ${repo}`;
    // One commit a page keeps the answer small; the files of the whole comparison
    // come with the first page whatever its size.
    const path = `${repoPath(repo)}/compare/${refPath(base)}...${refPath(branch)}?per_page=1`;
    const options: CallOptions = etag === null ? { absentOn: NO_SUCH_BRANCH } : { absentOn: NO_SUCH_BRANCH, ifNoneMatch: etag };
    const answer = await this.#httpFor(repo).rest('GET', path, undefined, subject, options);
    if (answer.missing) {
      return { kind: 'missing' };
    }
    if (answer.notModified) {
      return { kind: 'unchanged' };
    }
    const payload = decodeWire(ComparePayload, answer.data, subject);
    const signed = payload.merge_base_commit.commit.committer ?? payload.merge_base_commit.commit.author;
    if (signed === null || signed === undefined) {
      throw new TransientFailure(`${subject} named a merge base without a commit time`);
    }
    if (payload.files === undefined) {
      // GitHub leaves the files out of a comparison too large to list; measuring
      // nothing would tell the server the branch changes nothing.
      throw new TransientFailure(`${subject} answered without the files it changes`);
    }
    return {
      kind: 'measured',
      etag: answer.etag,
      measure: {
        baseSha: payload.merge_base_commit.sha,
        baseAt: signed.date,
        paths: pathsOf(payload.files).slice(0, FOOTPRINT_PATH_CAP),
        truncated: payload.files.length >= COMPARE_FILE_CAP,
      },
    };
  }

  async runsFor(repo: string, sha: string): Promise<WorkflowRun[]> {
    const subject = `the workflow runs of ${sha} in ${repo}`;
    const query = new URLSearchParams({ head_sha: sha, per_page: String(PAGE_SIZE) });
    const answer = await this.#httpFor(repo).rest('GET', `${repoPath(repo)}/actions/runs?${query.toString()}`, undefined, subject);
    return decodeWire(RunsPayload, answer.data, subject).workflow_runs.map((run) => ({
      id: run.id,
      path: run.path ?? null,
      name: run.name ?? null,
      status: run.status ?? '',
      conclusion: run.conclusion,
      createdAt: run.created_at,
      headSha: run.head_sha,
    }));
  }

  async writeStatus(repo: string, sha: string, status: CommitStatus): Promise<void> {
    const subject = `the ${status.context} status of ${sha} in ${repo}`;
    await this.#httpFor(repo).rest(
      'POST',
      `${repoPath(repo)}/statuses/${encodeURIComponent(sha)}`,
      { state: status.state, description: status.description, context: status.context },
      subject,
    );
  }

  async #get(repo: string, path: string, subject: string, etag: string | null): Promise<RestResult> {
    const options: CallOptions = etag === null ? {} : { ifNoneMatch: etag };
    return this.#httpFor(repo).rest('GET', path, undefined, subject, options);
  }
}

function pullOf(repo: string, payload: z.infer<typeof PullPayload>): ForgePull {
  return {
    repo: repo.toLowerCase(),
    number: payload.number,
    state: payload.state,
    mergedAt: payload.merged_at,
    updatedAt: payload.updated_at,
    author: payload.user?.login ?? null,
    headRef: payload.head.ref,
    headRepo: payload.head.repo?.full_name.toLowerCase() ?? null,
    headSha: payload.head.sha,
    baseRef: payload.base.ref,
  };
}

/** Every path the files touched: a rename both the one it left and the one it took. */
function pathsOf(files: readonly z.infer<typeof ChangedFile>[]): string[] {
  const paths = files.flatMap((file) =>
    file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename]);
  return [...new Set(paths)];
}

function rowsOf(data: unknown, subject: string): unknown[] {
  if (!Array.isArray(data)) {
    throw new TransientFailure(`${subject} answered something that is not a list`);
  }
  const rows: unknown[] = data;
  return rows;
}

function repoPath(repo: string): string {
  const [owner = '', name = ''] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** A branch in a path: every character escaped but the slashes its name may hold. */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}
