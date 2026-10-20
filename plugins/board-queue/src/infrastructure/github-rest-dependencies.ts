import { z } from 'zod';
import type { DependencyAnswer, DependencyList, DependencyReader, LinkedIssue } from '../application/sync-ports.ts';
import { TransientFailure } from '../domain/errors.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import { decodeWire, type CallOptions, type GitHubHttp } from './github-http.ts';

/** One page holds every answer GitHub allows: an issue has at most a hundred sub-issues. */
const PAGE_SIZE = 100;
/** A `Link` header that points in a circle would otherwise page for ever. */
const MAX_PAGES = 10;

/** The path each list lives at under an issue. */
const PATH_OF: { readonly [L in DependencyList]: string } = {
  blocked_by: 'dependencies/blocked_by',
  sub_issues: 'sub_issues',
};

const LinkedPayload = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  repository_url: z.string(),
  repository: z.object({ full_name: z.string() }).nullable().optional(),
});

/** `…/repos/owner/name` → `owner/name`. */
const REPOSITORY_URL = /\/repos\/([^/]+)\/([^/]+)\/?$/;

/**
 * What blocks an issue, from GitHub's REST lists of its blockers and its
 * sub-issues. The first page is asked for conditionally with the tag the caller
 * holds, so an unchanged list costs nothing against the hourly allowance; a list
 * that changed is read whole. Each issue named keeps its own repository, so a
 * blocker in another repository is reported as such.
 */
export class GitHubRestDependencies implements DependencyReader {
  readonly #httpFor: (ref: IssueRef) => GitHubHttp;

  /** Handed the transport of the account whose board carries each issue it is asked about. */
  constructor(httpFor: (ref: IssueRef) => GitHubHttp) {
    this.#httpFor = httpFor;
  }

  async read(list: DependencyList, ref: IssueRef, etag: string | null): Promise<DependencyAnswer> {
    const subject = `what blocks ${ref.toString()} (${list})`;
    const first = `/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}/${PATH_OF[list]}`
      + `?per_page=${String(PAGE_SIZE)}`;
    const options: CallOptions = etag === null ? { scope: 'issue' } : { scope: 'issue', ifNoneMatch: etag };
    const http = this.#httpFor(ref);
    const opening = await http.rest('GET', first, undefined, subject, options);
    if (opening.notModified) {
      return { changed: false, etag: opening.etag ?? etag ?? '' };
    }
    const issues: LinkedIssue[] = [...this.#issuesIn(opening.data, subject)];
    let next = opening.nextPageUrl;
    for (let page = 1; next !== null; page += 1) {
      if (page >= MAX_PAGES) {
        throw new TransientFailure(`${subject} answered more pages than this reader will follow`);
      }
      const more = await http.rest('GET', next, undefined, subject, { scope: 'issue' });
      issues.push(...this.#issuesIn(more.data, subject));
      next = more.nextPageUrl;
    }
    return { changed: true, etag: opening.etag, issues };
  }

  #issuesIn(data: unknown, subject: string): LinkedIssue[] {
    if (!Array.isArray(data)) {
      throw new TransientFailure(`${subject} answered something that is not a list`);
    }
    return data.map((row: unknown) => {
      const issue = decodeWire(LinkedPayload, row, subject);
      return { ref: IssueRef.of(repositoryOf(issue, subject), issue.number), title: issue.title, state: issue.state };
    });
  }
}

/** The repository an issue lives in, from the address the answer gives for it; its name when that says nothing. */
function repositoryOf(issue: z.infer<typeof LinkedPayload>, subject: string): string {
  const match = REPOSITORY_URL.exec(issue.repository_url);
  if (match !== null) {
    return `${match[1] ?? ''}/${match[2] ?? ''}`;
  }
  const named = issue.repository?.full_name ?? null;
  if (named === null) {
    throw new TransientFailure(`${subject} named an issue without a repository it could read`);
  }
  return named;
}
