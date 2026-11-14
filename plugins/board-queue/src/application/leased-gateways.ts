import type { BoardSnapshot, FieldCatalog, ReadItemResult } from '../domain/catalog.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { RateBudget } from '../domain/rate-budget.ts';
import type { LaneGateways } from './board-router.ts';
import type {
  BoardGateway,
  IssueCloseReason,
  IssueCommentView,
  IssueGateway,
  IssueReading,
  IssueSummary,
  TickLease,
} from './ports.ts';

/** What a pass that found the tick lock taken by another one says about stopping. */
export const LOCK_LOST = 'another pass took the tick lock, so this one wrote nothing more and stopped';

/**
 * Thrown in place of an outward write when the pass making it no longer holds the
 * tick lock. It is not about the action — the action was never wrong — so it is
 * kept apart from every failure the action can meet, and the pass stops at it.
 */
export class TickLockLost extends Error {
  constructor() {
    super(LOCK_LOST);
    this.name = 'TickLockLost';
  }
}

/**
 * The gateways of one board, writing only while the pass still holds the lock.
 * Reads go straight through; before every write the lease is asked, and a lost
 * one stops the write with `TickLockLost`, so a pass that another pass took the
 * lock from never writes what that pass may be writing too.
 */
export function leasedLane(lane: LaneGateways, lease: TickLease): LaneGateways {
  return { board: new LeasedBoard(lane.board, lease), issues: new LeasedIssues(lane.issues, lease) };
}

/** Returns while the pass still holds the tick lock, and throws `TickLockLost` once it does not. */
export async function confirmStillHeld(lease: TickLease): Promise<void> {
  if (!(await lease.stillHeld())) {
    throw new TickLockLost();
  }
}

class LeasedBoard implements BoardGateway {
  readonly #board: BoardGateway;
  readonly #lease: TickLease;

  constructor(board: BoardGateway, lease: TickLease) {
    this.#board = board;
    this.#lease = lease;
  }

  catalog(force?: boolean): Promise<FieldCatalog> {
    return this.#board.catalog(force);
  }

  snapshot(force?: boolean): Promise<BoardSnapshot> {
    return this.#board.snapshot(force);
  }

  readWork(): Promise<BoardSnapshot> {
    return this.#board.readWork();
  }

  findItem(ref: IssueRef): Promise<ReadItemResult | null> {
    return this.#board.findItem(ref);
  }

  /** A write when the row is not there yet, so it is asked for like one. */
  async ensureItem(ref: IssueRef): Promise<string> {
    await confirmStillHeld(this.#lease);
    return this.#board.ensureItem(ref);
  }

  readItemById(itemId: string): Promise<ReadItemResult> {
    return this.#board.readItemById(itemId);
  }

  async setSingleSelect(itemId: string, fieldId: string, optionId: string): Promise<void> {
    await confirmStillHeld(this.#lease);
    return this.#board.setSingleSelect(itemId, fieldId, optionId);
  }

  membership(refs: readonly IssueRef[]): Promise<Map<string, ReadItemResult | 'missing'>> {
    return this.#board.membership(refs);
  }

  probeBudget(): Promise<RateBudget> {
    return this.#board.probeBudget();
  }

  lastBudget(): RateBudget | null {
    return this.#board.lastBudget();
  }
}

class LeasedIssues implements IssueGateway {
  readonly #issues: IssueGateway;
  readonly #lease: TickLease;

  constructor(issues: IssueGateway, lease: TickLease) {
    this.#issues = issues;
    this.#lease = lease;
  }

  async comment(ref: IssueRef, body: string): Promise<string> {
    await confirmStillHeld(this.#lease);
    return this.#issues.comment(ref, body);
  }

  async close(ref: IssueRef, reason: IssueCloseReason): Promise<void> {
    await confirmStillHeld(this.#lease);
    return this.#issues.close(ref, reason);
  }

  async addAssignees(ref: IssueRef, logins: readonly string[]): Promise<void> {
    await confirmStillHeld(this.#lease);
    return this.#issues.addAssignees(ref, logins);
  }

  async removeAssignees(ref: IssueRef, logins: readonly string[]): Promise<void> {
    await confirmStillHeld(this.#lease);
    return this.#issues.removeAssignees(ref, logins);
  }

  get(ref: IssueRef): Promise<IssueReading> {
    return this.#issues.get(ref);
  }

  listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]> {
    return this.#issues.listComments(ref, since);
  }

  listOpen(repo: string): Promise<IssueSummary[]> {
    return this.#issues.listOpen(repo);
  }

  listClosedSince(repo: string, since: Date): Promise<IssueSummary[]> {
    return this.#issues.listClosedSince(repo, since);
  }

  lastBudget(): RateBudget | null {
    return this.#issues.lastBudget();
  }
}
