import { RateBudget } from '../domain/rate-budget.ts';
import { asDate, asNumber, asString, isRecord, parseJson } from './json-values.ts';
import type { ActionRepository } from './ports.ts';

/**
 * What one run of the worker leaves behind for the next reader — the last tick,
 * the last allowance it saw, the last audit, and how many burst refusals came in
 * a row. The keys and the shapes live here rather than at each end, so a writer
 * and a reader in different processes cannot drift apart.
 */
export const LAST_TICK_AT = 'lastTickAt';
export const LAST_BUDGET = 'lastBudget';
export const LAST_AUDIT = 'lastAudit';
export const LAST_AUDIT_ATTEMPT_AT = 'lastAuditAttemptAt';
export const CONSECUTIVE_SECONDARY_HITS = 'consecutiveSecondaryHits';

/** How the last report-only pass ended, without the report itself. */
export type AuditSummary = {
  at: Date;
  notOnBoard: number;
  emptyFields: number;
  closedNotDone: number;
};

export async function readLastTickAt(repository: ActionRepository): Promise<Date | null> {
  return asDate(await repository.getMeta(LAST_TICK_AT));
}

export async function writeLastTickAt(repository: ActionRepository, at: Date): Promise<void> {
  await repository.setMeta(LAST_TICK_AT, at.toISOString());
}

export async function readLastBudget(repository: ActionRepository): Promise<RateBudget | null> {
  const stored = await repository.getMeta(LAST_BUDGET);
  if (stored === null) {
    return null;
  }
  const parsed = parseJson(stored);
  if (!isRecord(parsed)) {
    return null;
  }
  const resource = asString(parsed['resource']);
  const remaining = asNumber(parsed['remaining']);
  const limit = asNumber(parsed['limit']);
  const used = asNumber(parsed['used']);
  const resetAt = asDate(parsed['resetAt']);
  if (resource === null || remaining === null || limit === null || used === null || resetAt === null) {
    return null;
  }
  return new RateBudget({
    resource: resource === 'graphql' ? 'graphql' : 'core',
    remaining,
    limit,
    used,
    resetAt,
  });
}

export async function writeLastBudget(repository: ActionRepository, budget: RateBudget): Promise<void> {
  await repository.setMeta(LAST_BUDGET, JSON.stringify({
    resource: budget.resource,
    remaining: budget.remaining,
    limit: budget.limit,
    used: budget.used,
    resetAt: budget.resetAt.toISOString(),
  }));
}

export async function readLastAudit(repository: ActionRepository): Promise<AuditSummary | null> {
  const stored = await repository.getMeta(LAST_AUDIT);
  if (stored === null) {
    return null;
  }
  const parsed = parseJson(stored);
  if (!isRecord(parsed)) {
    return null;
  }
  const at = asDate(parsed['at']);
  const notOnBoard = asNumber(parsed['notOnBoard']);
  const emptyFields = asNumber(parsed['emptyFields']);
  const closedNotDone = asNumber(parsed['closedNotDone']);
  if (at === null || notOnBoard === null || emptyFields === null || closedNotDone === null) {
    return null;
  }
  return { at, notOnBoard, emptyFields, closedNotDone };
}

export async function writeLastAudit(repository: ActionRepository, summary: AuditSummary): Promise<void> {
  await repository.setMeta(LAST_AUDIT, JSON.stringify({
    at: summary.at.toISOString(),
    notOnBoard: summary.notOnBoard,
    emptyFields: summary.emptyFields,
    closedNotDone: summary.closedNotDone,
  }));
}

/**
 * When the report-only pass was last started, whether or not it finished.
 *
 * The pass stamps its own summary only when it got all the way through, which is
 * right — a half-read board must be looked at again. But a pass that fails every
 * time would then be started again at every tick, reading whatever it manages to
 * read before failing, every few minutes, out of the same allowance the queue is
 * pacing itself against. The attempt is what holds the cadence when the result
 * cannot.
 */
export async function readLastAuditAttemptAt(repository: ActionRepository): Promise<Date | null> {
  return asDate(await repository.getMeta(LAST_AUDIT_ATTEMPT_AT));
}

export async function writeLastAuditAttemptAt(repository: ActionRepository, at: Date): Promise<void> {
  await repository.setMeta(LAST_AUDIT_ATTEMPT_AT, at.toISOString());
}

/**
 * How many burst refusals have come in a row. It is counted here rather than
 * taken from the pause that is in force, because the pause expires and is cleared
 * while the doubling must survive into the next tick.
 */
export async function readSecondaryHits(repository: ActionRepository): Promise<number> {
  const stored = await repository.getMeta(CONSECUTIVE_SECONDARY_HITS);
  if (stored === null) {
    return 0;
  }
  const hits = asNumber(Number(stored));
  return hits === null || hits < 0 ? 0 : Math.trunc(hits);
}

export async function writeSecondaryHits(repository: ActionRepository, hits: number): Promise<void> {
  await repository.setMeta(CONSECUTIVE_SECONDARY_HITS, String(Math.max(0, Math.trunc(hits))));
}
