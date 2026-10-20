import { z } from 'zod';
import type { IssueCloseReason, IssueCommentView, IssueGateway, IssueSummary } from '../application/ports.ts';
import { TransientFailure } from '../domain/errors.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { RateBudget } from '../domain/rate-budget.ts';
import { decodeWire, type CallOptions, type GitHubHttp } from './github-http.ts';

/**
 * The calls that name one issue and nothing else, so that a "not found" from them
 * is about that issue. A listing's 404 is not: it says the repository would not
 * answer, which is a fault of the moment as far as any single action is
 * concerned, and blocking work on it would blame the wrong thing.
 */
const ABOUT_AN_ISSUE: CallOptions = { scope: 'issue' };

const PAGE_SIZE = 100;
/** A `Link` header that points in a circle would otherwise page for ever. */
const MAX_PAGES = 100;

const IssuePayload = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  html_url: z.string(),
  assignees: z.array(z.object({ login: z.string() })).nullable().optional(),
});

const CommentPayload = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  created_at: z.string(),
});

/** The listing endpoint answers issues and pull requests alike; only one is ours. */
const PullRequestMarker = z.object({ pull_request: z.object({}).passthrough() });

export class GitHubRestIssues implements IssueGateway {
  private readonly http: GitHubHttp;

  constructor(http: GitHubHttp) {
    this.http = http;
  }

  async comment(ref: IssueRef, body: string): Promise<string> {
    const subject = `the comment on ${ref.toString()}`;
    const result = await this.http.rest('POST', `${issuePath(ref)}/comments`, { body }, subject, ABOUT_AN_ISSUE);
    return decodeWire(CommentPayload, result.data, subject).html_url;
  }

  async close(ref: IssueRef, reason: IssueCloseReason): Promise<void> {
    const subject = `closing ${ref.toString()}`;
    const body = { state: 'closed', state_reason: reason };
    await this.http.rest('PATCH', issuePath(ref), body, subject, ABOUT_AN_ISSUE);
  }

  async addAssignees(ref: IssueRef, logins: readonly string[]): Promise<void> {
    const subject = `assigning ${ref.toString()}`;
    await this.http.rest('POST', `${issuePath(ref)}/assignees`, { assignees: [...logins] }, subject, ABOUT_AN_ISSUE);
  }

  async removeAssignees(ref: IssueRef, logins: readonly string[]): Promise<void> {
    const subject = `unassigning ${ref.toString()}`;
    await this.http.rest('DELETE', `${issuePath(ref)}/assignees`, { assignees: [...logins] }, subject, ABOUT_AN_ISSUE);
  }

  async get(ref: IssueRef): Promise<IssueSummary> {
    const subject = ref.toString();
    const result = await this.http.rest('GET', issuePath(ref), undefined, subject, ABOUT_AN_ISSUE);
    return toSummary(decodeWire(IssuePayload, result.data, subject));
  }

  async listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]> {
    const subject = `the comments on ${ref.toString()}`;
    const query = new URLSearchParams({ per_page: String(PAGE_SIZE) });
    if (since !== null) {
      query.set('since', since.toISOString());
    }
    const rows = await this.collect(`${issuePath(ref)}/comments?${query.toString()}`, subject, ABOUT_AN_ISSUE);
    return rows.map((row) => {
      const comment = decodeWire(CommentPayload, row, subject);
      return {
        id: comment.id,
        body: comment.body ?? '',
        url: comment.html_url,
        createdAt: new Date(comment.created_at),
      };
    });
  }

  async listOpen(repo: string): Promise<IssueSummary[]> {
    const query = new URLSearchParams({ state: 'open', per_page: String(PAGE_SIZE) });
    return this.listIssues(repo, query, `the open issues of ${repo}`);
  }

  /**
   * The listing filters on when an issue was last touched, not on when it was
   * closed, so a window asks for a little more than it needs — which is the safe
   * direction for a report that only ever points a person at a row.
   */
  async listClosedSince(repo: string, since: Date): Promise<IssueSummary[]> {
    const query = new URLSearchParams({
      state: 'closed',
      since: since.toISOString(),
      per_page: String(PAGE_SIZE),
    });
    return this.listIssues(repo, query, `the closed issues of ${repo}`);
  }

  lastBudget(): RateBudget | null {
    return this.http.lastBudget('core');
  }

  private async listIssues(repo: string, query: URLSearchParams, subject: string): Promise<IssueSummary[]> {
    const rows = await this.collect(`/repos/${repo}/issues?${query.toString()}`, subject);
    return rows
      .filter((row) => !PullRequestMarker.safeParse(row).success)
      .map((row) => toSummary(decodeWire(IssuePayload, row, subject)));
  }

  private async collect(firstPath: string, subject: string, options: CallOptions = {}): Promise<unknown[]> {
    const rows: unknown[] = [];
    let path: string | null = firstPath;
    for (let page = 0; path !== null; page += 1) {
      if (page >= MAX_PAGES) {
        throw new TransientFailure(`${subject} answered more pages than this reader will follow`);
      }
      const result = await this.http.rest('GET', path, undefined, subject, options);
      if (!Array.isArray(result.data)) {
        throw new TransientFailure(`${subject} answered something that is not a list`);
      }
      rows.push(...(result.data as unknown[]));
      path = result.nextPageUrl;
    }
    return rows;
  }
}

function issuePath(ref: IssueRef): string {
  return `/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}`;
}

function toSummary(payload: z.infer<typeof IssuePayload>): IssueSummary {
  return {
    number: payload.number,
    state: payload.state,
    title: payload.title,
    url: payload.html_url,
    assignees: (payload.assignees ?? []).map((assignee) => assignee.login),
  };
}
