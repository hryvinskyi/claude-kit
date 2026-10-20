import { createHash } from 'node:crypto';
import type {
  BranchComparison,
  BranchMeasure,
  DefaultBranchRead,
  Forge,
  PullFilesPage,
  PullListing,
  PullPage,
  PullRead,
} from '../../src/application/forge-ports.ts';
import type { CommitStatus } from '../../src/domain/forge/commit-status.ts';
import type { ForgePull } from '../../src/domain/forge/pull-requests.ts';
import type { WorkflowRun } from '../../src/domain/forge/workflow-runs.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';

export type ForgeCall =
  | 'pullPage'
  | 'pull'
  | 'pullFiles'
  | 'defaultBranch'
  | 'compare'
  | 'resolveCommit'
  | 'runsFor'
  | 'writeStatus';

/** A pull request with the defaults a test rarely cares about. */
export function pullRequest(repo: string, number: number, overrides: Partial<ForgePull> = {}): ForgePull {
  return {
    repo: repo.toLowerCase(),
    number,
    state: 'open',
    mergedAt: null,
    updatedAt: new Date('2026-03-02T08:00:00.000Z'),
    author: 'alice-gh',
    headRef: `alice/${String(number)}-work`,
    headRepo: repo.toLowerCase(),
    headSha: `${String(number).padStart(4, '0')}${'a'.repeat(36)}`,
    baseRef: 'main',
    ...overrides,
  };
}

/** One request the fake was asked, in the order it was asked. */
export type AskedForge = {
  readonly call: ForgeCall;
  readonly repo: string;
  readonly detail: string;
  /** The tag the request carried, if any. */
  readonly etag: string | null;
};

/**
 * GitHub, in memory: each repository's pull requests, their files and
 * mergeability, its branches and what each changes, its workflow runs and the
 * statuses written. Listings and reads carry tags taken from what they answer, so
 * a conditional request is answered "unchanged" exactly when nothing it covers
 * changed. A test scripts the refusals it wants and reads what was asked.
 */
export class FakeForge implements Forge {
  readonly asked: AskedForge[] = [];
  readonly statuses: { repo: string; sha: string; status: CommitStatus }[] = [];
  /** What the next answers say is left of the allowance; null says nothing. */
  remainingNow: number | null = null;
  pageSize = 100;
  /** When the next listings say GitHub answered; null says nothing. */
  servedAt: Date | null = null;
  /** Called as each page of a listing is asked for, before it is answered: what changes there, the page shows. */
  onPageAsked: ((page: number) => void) | null = null;

  readonly #pulls = new Map<string, Map<number, ForgePull>>();
  readonly #mergeable = new Map<string, boolean | null>();
  readonly #files = new Map<string, string[]>();
  readonly #branches = new Map<string, BranchMeasure>();
  readonly #defaults = new Map<string, string>();
  readonly #runs = new Map<string, WorkflowRun[]>();
  readonly #commits = new Map<string, string[]>();
  /** Pull requests whose files cannot be read, by reference. */
  readonly filesFail = new Set<string>();
  readonly #scripted = new Map<ForgeCall, BoardQueueError[]>();

  /** Puts a pull request in place, or replaces the one of the same number. */
  put(pull: ForgePull, mergeable: boolean | null = null, files: readonly string[] = []): this {
    const repo = this.#repo(pull.repo);
    repo.set(pull.number, pull);
    this.#mergeable.set(refOf(pull.repo, pull.number), mergeable);
    this.#files.set(refOf(pull.repo, pull.number), [...files]);
    return this;
  }

  setMergeable(repo: string, number: number, mergeable: boolean | null): this {
    this.#mergeable.set(refOf(repo, number), mergeable);
    return this;
  }

  branch(repo: string, base: string, branch: string, measure: BranchMeasure): this {
    this.#branches.set(branchKey(repo, base, branch), measure);
    return this;
  }

  deleteBranch(repo: string, base: string, branch: string): this {
    this.#branches.delete(branchKey(repo, base, branch));
    return this;
  }

  defaultBranchOf(repo: string, name: string): this {
    this.#defaults.set(repo.toLowerCase(), name);
    return this;
  }

  run(repo: string, run: WorkflowRun): this {
    const runs = this.#runs.get(repo.toLowerCase()) ?? [];
    runs.push(run);
    this.#runs.set(repo.toLowerCase(), runs);
    return this;
  }

  /** A commit the repository holds, by its full id. */
  commit(repo: string, sha: string): this {
    const commits = this.#commits.get(repo.toLowerCase()) ?? [];
    commits.push(sha);
    this.#commits.set(repo.toLowerCase(), commits);
    return this;
  }

  /** Replaces every run of a repository: a run that moved on is the same run with a later status. */
  setRuns(repo: string, runs: readonly WorkflowRun[]): this {
    this.#runs.set(repo.toLowerCase(), [...runs]);
    return this;
  }

  fail(call: ForgeCall, error: BoardQueueError): this {
    const queued = this.#scripted.get(call) ?? [];
    queued.push(error);
    this.#scripted.set(call, queued);
    return this;
  }

  /** How many requests of one kind were made. */
  count(call: ForgeCall): number {
    return this.asked.filter((asked) => asked.call === call).length;
  }

  remaining(): number | null {
    return this.remainingNow;
  }

  async pullPage(repo: string, listing: PullListing, page: number, etag: string | null): Promise<PullPage> {
    this.#answer('pullPage', repo, `${listing} ${String(page)}`, etag);
    this.onPageAsked?.(page);
    const all = [...this.#repo(repo).values()]
      .filter((pull) => listing === 'all' || pull.state === 'open')
      .sort((one, other) => other.updatedAt.getTime() - one.updatedAt.getTime() || other.number - one.number);
    const rows = all.slice((page - 1) * this.pageSize, page * this.pageSize);
    const tag = tagOf(rows);
    if (etag !== null && etag === tag) {
      return { changed: false };
    }
    return { changed: true, etag: tag, pulls: rows, more: all.length > page * this.pageSize, servedAt: this.servedAt };
  }

  async pull(repo: string, number: number, etag: string | null): Promise<PullRead> {
    this.#answer('pull', repo, String(number), etag);
    const pull = this.#repo(repo).get(number);
    if (pull === undefined) {
      throw new Error(`the fake holds no ${repo}#${String(number)}`);
    }
    const mergeable = this.#mergeable.get(refOf(repo, number)) ?? null;
    const tag = tagOf({ pull, mergeable });
    if (etag !== null && etag === tag) {
      return { changed: false };
    }
    return { changed: true, etag: tag, pull, mergeable };
  }

  async pullFilesPage(repo: string, number: number, page: number): Promise<PullFilesPage> {
    this.#answer('pullFiles', repo, `${String(number)} ${String(page)}`, null);
    if (this.filesFail.has(refOf(repo, number))) {
      throw new TransientFailure(`the files of ${refOf(repo, number)} answered 403`);
    }
    const files = this.#files.get(refOf(repo, number)) ?? [];
    const size = this.pageSize;
    return { paths: files.slice((page - 1) * size, page * size), more: files.length > page * size };
  }

  async resolveCommit(repo: string, sha: string): Promise<string | null> {
    this.#answer('resolveCommit', repo, sha, null);
    const known = [
      ...(this.#commits.get(repo.toLowerCase()) ?? []),
      ...(this.#runs.get(repo.toLowerCase()) ?? []).map((run) => run.headSha),
    ];
    return known.find((full) => full.startsWith(sha)) ?? null;
  }

  async defaultBranch(repo: string, etag: string | null): Promise<DefaultBranchRead> {
    this.#answer('defaultBranch', repo, '', etag);
    const name = this.#defaults.get(repo.toLowerCase()) ?? 'main';
    const tag = tagOf(name);
    return etag !== null && etag === tag ? { changed: false } : { changed: true, etag: tag, name };
  }

  async compare(repo: string, base: string, branch: string, etag: string | null): Promise<BranchComparison> {
    this.#answer('compare', repo, `${base}...${branch}`, etag);
    const measure = this.#branches.get(branchKey(repo, base, branch));
    if (measure === undefined) {
      return { kind: 'missing' };
    }
    const tag = tagOf(measure);
    if (etag !== null && etag === tag) {
      return { kind: 'unchanged' };
    }
    return { kind: 'measured', etag: tag, measure };
  }

  async runsFor(repo: string, sha: string): Promise<WorkflowRun[]> {
    this.#answer('runsFor', repo, sha, null);
    return (this.#runs.get(repo.toLowerCase()) ?? []).filter((run) => run.headSha === sha);
  }

  async writeStatus(repo: string, sha: string, status: CommitStatus): Promise<void> {
    this.#answer('writeStatus', repo, sha, null);
    this.statuses.push({ repo, sha, status });
  }

  #repo(repo: string): Map<number, ForgePull> {
    const key = repo.toLowerCase();
    const held = this.#pulls.get(key) ?? new Map<number, ForgePull>();
    this.#pulls.set(key, held);
    return held;
  }

  #answer(call: ForgeCall, repo: string, detail: string, etag: string | null): void {
    this.asked.push({ call, repo, detail, etag });
    const scripted = this.#scripted.get(call)?.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
  }
}

function refOf(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${String(number)}`;
}

function branchKey(repo: string, base: string, branch: string): string {
  return `${repo.toLowerCase()}\n${base}\n${branch}`;
}

function tagOf(value: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(value)).digest('hex')}"`;
}
