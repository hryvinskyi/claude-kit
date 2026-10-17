import { RefusedByRule } from '../domain/errors.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import type { BoardRouter } from './board-router.ts';
import type { ActionRepository, Clock } from './ports.ts';

/** One issue's row as everything outside this system reads it. */
export type BoardItemView = {
  ref: string;
  url: string;
  /** The board that carries the issue's repository, written owner/number. */
  board: string;
  onBoard: boolean;
  /** The row's own id, or nothing when the issue has no row. */
  itemId: string | null;
  /** Board field name to the option the row carries; empty when there is no row. */
  values: Record<string, string>;
  /** What the last answer said was left of the allowance, or nothing when none was read. */
  budget: string | null;
};

export type ShowBoardItemDeps = {
  boards: BoardRouter;
  repository: ActionRepository;
  clock: Clock;
};

/**
 * What the board that carries an issue's repository says about that issue.
 *
 * The answer comes out of one walk of that whole board — a few points for every
 * row at once, reused for a minute — so asking about several issues in a row
 * costs what asking about the first one cost. Membership is read from that walk
 * rather than from the issue's own side, which was measured to answer nothing for
 * rows that are demonstrably there whenever the repository's owner differs from
 * the board's.
 *
 * The allowance is reported with the answer because a caller deciding whether to
 * look again should not have to ask a second question to find out what looking
 * costs.
 *
 * It is the one thing a session does that touches the board, so it obeys the same
 * wait the worker does. A wait means the account has nothing left, or that the
 * burst limiter is holding everything off; a read during it spends what the queue
 * is waiting for and can earn the queue a longer wait than the one it is already
 * serving.
 */
export class ShowBoardItem {
  readonly #boards: BoardRouter;
  readonly #repository: ActionRepository;
  readonly #clock: Clock;

  constructor(deps: ShowBoardItemDeps) {
    this.#boards = deps.boards;
    this.#repository = deps.repository;
    this.#clock = deps.clock;
  }

  async execute(repo: string, issue: number): Promise<BoardItemView> {
    const ref = this.#boards.directory.canonical(IssueRef.of(repo, issue));
    const lane = this.#boards.laneOf(ref);
    const pause = await this.#repository.getPause();
    if (pause !== null && pause.isActive(this.#clock.now())) {
      throw new RefusedByRule(`the board is not read while the queue waits — ${pause.describe()}`);
    }
    const row = await lane.board.findItem(ref);
    const budget = this.#boards.lastBudget();
    return {
      ref: ref.toString(),
      url: ref.url(),
      board: lane.placement.name,
      onBoard: row !== null,
      itemId: row?.itemId ?? null,
      values: row === null ? {} : { ...row.values },
      budget: budget === null ? null : budget.describe(),
    };
  }
}
