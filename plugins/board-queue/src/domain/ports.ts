/**
 * What an action needs from the outside world while it runs: the board, the
 * issues, the time and a pause between writes. The kinds that do the work state
 * these, so they live beside them; an adapter keeps each promise, and nothing in
 * this file knows about HTTP or a process.
 */
import type { BoardSnapshot, FieldCatalog, ReadItemResult } from './catalog.ts';
import type { IssueRef } from './issue-ref.ts';
import type { RateBudget } from './rate-budget.ts';

/**
 * One board. Membership is written, never inferred from the issue's side: asking
 * an issue for its board items was measured to answer empty for issues that are
 * demonstrably on the board when the repository's owner and the board's owner
 * differ, which reads exactly like "not on the board".
 */
export interface BoardGateway {
  /** The board's fields and their options; cached, `force` refetches. */
  catalog(force?: boolean): Promise<FieldCatalog>;

  /** Every row in one paginated walk; cached for a short while, `force` refetches. */
  snapshot(force?: boolean): Promise<BoardSnapshot>;

  /**
   * Every row with the facts of the issue it holds — title, state, dates, and the
   * summaries of what blocks it — in a walk of its own, never cached: it is read
   * once per import, and no other read depends on those facts being answered.
   */
  readWork(): Promise<BoardSnapshot>;

  /** The row for this issue, matched on repository *and* number, or null. */
  findItem(ref: IssueRef): Promise<ReadItemResult | null>;

  /** The item id for this issue, adding it to the board if it is not there yet. */
  ensureItem(ref: IssueRef): Promise<string>;

  /** Reads one known row back; this is what a write is confirmed against. */
  readItemById(itemId: string): Promise<ReadItemResult>;

  setSingleSelect(itemId: string, fieldId: string, optionId: string): Promise<void>;

  /** Which of these issues are on the board, from one snapshot; keyed by `ref.key()`. */
  membership(refs: readonly IssueRef[]): Promise<Map<string, ReadItemResult | 'missing'>>;

  /** Asks the API what is left of the allowance, which every board on the account spends alike. */
  probeBudget(): Promise<RateBudget>;

  /** What the last response said, without spending anything. */
  lastBudget(): RateBudget | null;
}

export type IssueState = 'open' | 'closed';

export type IssueCloseReason = 'completed' | 'not_planned';

export type IssueSummary = {
  number: number;
  state: IssueState;
  title: string;
  url: string;
  /** The logins the issue is assigned to. */
  assignees: string[];
};

/**
 * One number read through the issue address. The issue endpoints answer for a
 * pull request's number as well, so the reading says which of the two it is.
 */
export type IssueReading = IssueSummary & {
  isPullRequest: boolean;
};

export type IssueCommentView = {
  id: number;
  body: string;
  url: string;
  createdAt: Date;
};

/** The issues themselves: comments, closes, and the cheap listings the audit reads. */
export interface IssueGateway {
  /** Posts a comment and answers its web address. */
  comment(ref: IssueRef, body: string): Promise<string>;

  close(ref: IssueRef, reason: IssueCloseReason): Promise<void>;

  /** Assigns these logins, keeping whoever is assigned already. */
  addAssignees(ref: IssueRef, logins: readonly string[]): Promise<void>;

  /** Takes these logins off the issue, leaving everybody else assigned. */
  removeAssignees(ref: IssueRef, logins: readonly string[]): Promise<void>;

  /** The issue, or the pull request, that carries this number. */
  get(ref: IssueRef): Promise<IssueReading>;

  /** Comments written since the given moment; null means all of them. */
  listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]>;

  /** Open issues of `owner/name`, pull requests excluded. */
  listOpen(repo: string): Promise<IssueSummary[]>;

  /** Closed issues of `owner/name` touched since the given moment, pull requests excluded. */
  listClosedSince(repo: string, since: Date): Promise<IssueSummary[]>;

  lastBudget(): RateBudget | null;
}

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
