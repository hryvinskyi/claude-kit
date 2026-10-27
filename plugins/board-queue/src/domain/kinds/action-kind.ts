import type { z } from 'zod';
import type { BoardGateway, Clock, IssueGateway, Sleeper } from '../../application/ports.ts';
import type { IssueRef } from '../issue-ref.ts';

/**
 * Everything a kind may use while it runs. It is handed the gateways rather than
 * reaching for them, so a kind can be exercised without a network.
 */
export type ExecutionContext = {
  board: BoardGateway;
  issues: IssueGateway;
  clock: Clock;
  sleeper: Sleeper;
  /** Smallest gap a kind leaves between two mutations. */
  paceMs: number;
  /** Status values this system refuses to write, whatever a payload says. */
  refusedStatus: readonly string[];
  /** Identifies the action; anything this system posts carries it, so a retry can adopt what landed. */
  actionId: string;
  /** When the action was filed; a listing that looks for what already landed starts here. */
  enqueuedAt: Date;
};

export type ActionResult = {
  summary: string;
  /** What the board said after the write, field name → option text. */
  readback?: Record<string, string>;
};

/**
 * One sort of outward work, with everything that distinguishes it from the others.
 *
 * The queue knows no kind by name: it resolves one from the registry and asks it
 * to validate, to merge and to run. Teaching this system a new sort of work is
 * writing one of these and registering it — never a branch somewhere central.
 */
export interface ActionKind {
  /** The name a caller enqueues, e.g. `board.set-fields`. */
  readonly name: string;

  /** Validates and normalises a payload; a payload is stored only after it passed. */
  readonly payloadSchema: z.ZodType;

  /** One paragraph for the caller, including the rules that would otherwise surprise them. */
  readonly describe: string;

  /** The issue this payload is about, or null for work that names no issue. */
  issueRefOf(payload: unknown): IssueRef | null;

  /** The board status this payload asks to be written, as the caller typed it, or null when it writes none. */
  statusAskedFor(payload: unknown): string | null;

  /**
   * Folds a later request into one that is still waiting, and answers null when
   * this kind does not merge. It is only ever asked when the waiting action can
   * still be changed and the incoming request is neither held nor delayed, so a
   * kind never has to reason about when merging is safe — only about what the
   * merged payload says.
   */
  coalesce(existing: unknown, incoming: unknown): unknown;

  execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult>;
}
