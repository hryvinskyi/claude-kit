import type {
  IssueCloseReason,
  IssueCommentView,
  IssueGateway,
  IssueState,
  IssueSummary,
} from '../../src/application/ports.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';
import { IssueNotFound } from '../../src/domain/errors.ts';
import type { IssueRef } from '../../src/domain/issue-ref.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';

export type IssueCall = 'comment' | 'close' | 'get' | 'listComments' | 'listOpen' | 'listClosedSince';

export type SeededIssue = {
  ref: IssueRef;
  state?: IssueState;
  title?: string;
  comments?: readonly SeededComment[];
};

export type SeededComment = {
  body: string;
  createdAt: Date;
};

type HeldIssue = {
  ref: IssueRef;
  state: IssueState;
  title: string;
  comments: IssueCommentView[];
};

/**
 * The issues, in memory.
 *
 * It counts the two calls that cost something irreversibly — the comment that
 * cannot be unposted and the change that closes an issue — so a test can prove
 * that a retry posted nothing and that an issue already closed was left alone.
 */
export class FakeIssueGateway implements IssueGateway {
  readonly calls: IssueCall[] = [];
  readonly posted: { ref: string; body: string }[] = [];
  readonly closed: { ref: string; reason: IssueCloseReason }[] = [];
  budget: RateBudget | null = null;
  /** False when a close is accepted and the issue stays open, the way a lost write reads. */
  closesStick = true;

  readonly #scripted = new Map<IssueCall, BoardQueueError[]>();
  readonly #issues = new Map<string, HeldIssue>();
  #nextComment = 0;

  constructor(issues: readonly SeededIssue[] = []) {
    for (const issue of issues) {
      this.seed(issue);
    }
  }

  seed(issue: SeededIssue): this {
    this.#issues.set(issue.ref.key(), {
      ref: issue.ref,
      state: issue.state ?? 'open',
      title: issue.title ?? `issue ${String(issue.ref.number)}`,
      comments: (issue.comments ?? []).map((comment) => this.#toView(issue.ref, comment.body, comment.createdAt)),
    });
    return this;
  }

  fail(call: IssueCall, error: BoardQueueError): this {
    const queued = this.#scripted.get(call) ?? [];
    queued.push(error);
    this.#scripted.set(call, queued);
    return this;
  }

  stateOf(ref: IssueRef): IssueState | null {
    return this.#issues.get(ref.key())?.state ?? null;
  }

  commentsOn(ref: IssueRef): IssueCommentView[] {
    return [...(this.#issues.get(ref.key())?.comments ?? [])];
  }

  comment(ref: IssueRef, body: string): Promise<string> {
    this.#answer('comment');
    const issue = this.#require(ref);
    const view = this.#toView(ref, body, new Date());
    issue.comments.push(view);
    this.posted.push({ ref: ref.toString(), body });
    return Promise.resolve(view.url);
  }

  close(ref: IssueRef, reason: IssueCloseReason): Promise<void> {
    this.#answer('close');
    const issue = this.#require(ref);
    if (this.closesStick) {
      issue.state = 'closed';
    }
    this.closed.push({ ref: ref.toString(), reason });
    return Promise.resolve();
  }

  get(ref: IssueRef): Promise<IssueSummary> {
    this.#answer('get');
    const issue = this.#require(ref);
    return Promise.resolve({
      number: issue.ref.number,
      state: issue.state,
      title: issue.title,
      url: issue.ref.url(),
    });
  }

  listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]> {
    this.#answer('listComments');
    const issue = this.#require(ref);
    return Promise.resolve(issue.comments.filter(
      (comment) => since === null || comment.createdAt.getTime() >= since.getTime(),
    ));
  }

  listOpen(repo: string): Promise<IssueSummary[]> {
    this.#answer('listOpen');
    return Promise.resolve(this.#of(repo, 'open'));
  }

  listClosedSince(repo: string, _since: Date): Promise<IssueSummary[]> {
    this.#answer('listClosedSince');
    return Promise.resolve(this.#of(repo, 'closed'));
  }

  lastBudget(): RateBudget | null {
    return this.budget;
  }

  #of(repo: string, state: IssueState): IssueSummary[] {
    return [...this.#issues.values()]
      .filter((issue) => issue.ref.repoFullName().toLowerCase() === repo.toLowerCase() && issue.state === state)
      .map((issue) => ({
        number: issue.ref.number,
        state: issue.state,
        title: issue.title,
        url: issue.ref.url(),
      }));
  }

  #toView(ref: IssueRef, body: string, createdAt: Date): IssueCommentView {
    this.#nextComment += 1;
    return {
      id: this.#nextComment,
      body,
      url: `${ref.url()}#issuecomment-${String(this.#nextComment)}`,
      createdAt,
    };
  }

  #require(ref: IssueRef): HeldIssue {
    const issue = this.#issues.get(ref.key());
    if (issue === undefined) {
      throw new IssueNotFound(ref.toString());
    }
    return issue;
  }

  #answer(call: IssueCall): void {
    this.calls.push(call);
    const scripted = this.#scripted.get(call)?.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
  }
}
