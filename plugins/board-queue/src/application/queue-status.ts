import type { Action } from '../domain/action.ts';
import { readLastAudit, readLastBudget, readLastTickAt } from './queue-meta.ts';
import type { ActionCounts, ActionRepository, Clock } from './ports.ts';

export type PauseView = {
  until: string;
  reason: string;
  consecutiveHits: number;
  /** Zero once the pause has run out; the next tick will clear it. */
  remainingSec: number;
};

export type BudgetView = {
  resource: string;
  remaining: number;
  limit: number;
  used: number;
  resetAt: string;
};

export type AuditView = {
  at: string;
  notOnBoard: number;
  emptyFields: number;
  closedNotDone: number;
};

/** An action that stopped and will not move until somebody decides something. */
export type StuckActionView = {
  id: string;
  kind: string;
  ref: string | null;
  lastError: string | null;
};

/**
 * A queued action that cannot run yet because somebody pushed it into the future.
 *
 * It is listed apart from the rest of the queued count for the same reason held
 * actions are: from every other angle it reads as work about to happen, and the
 * one thing worth knowing about it — that nothing will touch it for a fortnight —
 * is the one thing a count cannot say.
 */
export type DelayedActionView = {
  id: string;
  kind: string;
  ref: string | null;
  origin: string;
  /** The first moment a worker may take it. */
  runnableAt: string;
  /** How long until then, in days, to one decimal. */
  inDays: number;
};

export type HeldActionView = {
  id: string;
  kind: string;
  ref: string | null;
  origin: string;
  /** How long it has been waiting, in days, to one decimal. */
  ageDays: number;
};

export type QueueStatusView = {
  counts: ActionCounts;
  pause: PauseView | null;
  lastTickAt: string | null;
  lastBudget: BudgetView | null;
  lastAudit: AuditView | null;
  blocked: StuckActionView[];
  failed: StuckActionView[];
  held: HeldActionView[];
  delayed: DelayedActionView[];
};

/**
 * What the queue is doing, in one answer.
 *
 * Held actions are reported with their age, oldest first, rather than as a
 * number: a move somebody held for a deploy and never released is a ticket that
 * never reaches anyone, and it only looks wrong once you can see how long it has
 * been sitting there.
 */
export class QueueStatus {
  readonly #repository: ActionRepository;
  readonly #clock: Clock;

  constructor(repository: ActionRepository, clock: Clock) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async execute(): Promise<QueueStatusView> {
    const now = this.#clock.now();
    const [counts, pause, lastTickAt, lastBudget, lastAudit, blocked, failed, held, queued] = await Promise.all([
      this.#repository.counts(),
      this.#repository.getPause(),
      readLastTickAt(this.#repository),
      readLastBudget(this.#repository),
      readLastAudit(this.#repository),
      this.#repository.list({ states: ['blocked'] }),
      this.#repository.list({ states: ['failed'] }),
      this.#repository.list({ states: ['held'] }),
      this.#repository.list({ states: ['queued'] }),
    ]);

    return {
      counts,
      pause: pause === null ? null : {
        until: pause.until.toISOString(),
        reason: pause.reason,
        consecutiveHits: pause.consecutiveHits,
        remainingSec: pause.remainingSec(now),
      },
      lastTickAt: lastTickAt === null ? null : lastTickAt.toISOString(),
      lastBudget: lastBudget === null ? null : {
        resource: lastBudget.resource,
        remaining: lastBudget.remaining,
        limit: lastBudget.limit,
        used: lastBudget.used,
        resetAt: lastBudget.resetAt.toISOString(),
      },
      lastAudit: lastAudit === null ? null : {
        at: lastAudit.at.toISOString(),
        notOnBoard: lastAudit.notOnBoard,
        emptyFields: lastAudit.emptyFields,
        closedNotDone: lastAudit.closedNotDone,
      },
      blocked: blocked.map(stuck),
      failed: failed.map(stuck),
      held: [...held]
        .sort((one, other) => one.createdAt.getTime() - other.createdAt.getTime())
        .map((action) => ({
          id: action.id,
          kind: action.kind,
          ref: action.issueRef === null ? null : action.issueRef.toString(),
          origin: action.origin,
          ageDays: ageInDays(action.createdAt, now),
        })),
      delayed: queued
        .filter((action) => waitsFor(action, now) !== null)
        .map((action) => {
          const runnableAt = waitsFor(action, now) ?? now;
          return {
            id: action.id,
            kind: action.kind,
            ref: action.issueRef === null ? null : action.issueRef.toString(),
            origin: action.origin,
            runnableAt: runnableAt.toISOString(),
            inDays: ageInDays(now, runnableAt),
          };
        })
        .sort((one, other) => one.runnableAt.localeCompare(other.runnableAt)),
    };
  }
}

/** When this action becomes runnable, or nothing when it already is. */
function waitsFor(action: Action, now: Date): Date | null {
  const notBefore = action.notBefore;
  return notBefore !== null && notBefore.getTime() > now.getTime() ? notBefore : null;
}

function stuck(action: Action): StuckActionView {
  return {
    id: action.id,
    kind: action.kind,
    ref: action.issueRef === null ? null : action.issueRef.toString(),
    lastError: action.lastError,
  };
}

function ageInDays(since: Date, now: Date): number {
  const days = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
  return Math.round(Math.max(0, days) * 10) / 10;
}
