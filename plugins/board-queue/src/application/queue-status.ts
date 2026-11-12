import type { Action, ActionState } from '../domain/action.ts';
import { IssueOrder, stoppedIssues } from '../domain/issue-order.ts';
import type { DeferredWait, StoppedIssue } from '../domain/issue-order.ts';
import { ownerJobsOf } from '../domain/sync-config.ts';
import type { MirrorScope, OwnerJob, SyncConfig } from '../domain/sync-config.ts';
import { readLastAudit, readLastBudget, readLastTickAt } from './queue-meta.ts';
import { isMirrored } from './mirror-claims.ts';
import {
  readFinishRun,
  readForgeRun,
  readImportRun,
  readMirrorPassOver,
  readMirrorRun,
  readSyncRefusal,
} from './sync-meta.ts';
import type { FinishRun, ForgeRun, ImportRun, MirrorPassOver, MirrorRun, SyncRefusal } from './sync-meta.ts';
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

/** An action on a stopped issue: one of the stopped ones, or one waiting its turn behind them. */
export type IssueActionView = {
  id: string;
  kind: string;
  state: ActionState;
};

/**
 * An issue whose actions stopped moving: the oldest failed or blocked action in
 * front, every stopped action that holds work up, oldest first, and what was filed
 * after them and will not run until somebody retries or cancels every one of them.
 * A failed comment and the close waiting behind it read here as one issue that is
 * stuck, not as one failure and one action about to happen.
 */
export type StoppedIssueView = {
  ref: string | null;
  front: {
    id: string;
    kind: string;
    state: ActionState;
    lastError: string | null;
  };
  stopped: IssueActionView[];
  waiting: IssueActionView[];
};

/**
 * A queued action that waits for deferred work filed before it on its issue — a
 * close behind a comment put off to a date — and when it may run. From every other
 * angle it reads as work about to happen; this says it is not, and until when.
 */
export type DeferredWaitView = {
  id: string;
  kind: string;
  ref: string | null;
  /** The deferred actions in front of it, oldest first. */
  behind: { id: string; kind: string; runnableAt: string }[];
  /** When the last of them comes due, and this one may run after it. */
  until: string;
  /** How long until then, in days, to one decimal. */
  inDays: number;
};

/**
 * The mirrored actions this worker's last pass left queued because the mirror
 * could not say they still stand, why, and the work held behind each on its issue
 * — a close filed by a session waits there too, and would otherwise read as work
 * about to happen. Null when none of them is still queued.
 */
export type MirroredWaitView = {
  count: number;
  /** When the pass that left them ran. */
  at: string;
  reason: string;
  held: {
    id: string;
    kind: string;
    ref: string | null;
    /** What was filed after it on its issue and waits behind it. */
    waiting: IssueActionView[];
  }[];
};

/**
 * Keeping the boards in step with a coordination server, as this worker does it:
 * which directions are on, what each did last, and why this worker declined when
 * it is not the one that runs them.
 */
export type SyncView = {
  server: string;
  project: string;
  /** The one worker's login that runs the jobs kept for the owner's worker. */
  owner: string;
  /** The jobs switched on that run only in the owner's worker. */
  ownerJobs: OwnerJob[];
  mirror: { enabled: boolean; scope: MirrorScope; lastRun: MirrorRun | null; waiting: MirroredWaitView | null };
  /** Letting this worker's own person's claims go as the board moves their work on. */
  finish: { enabled: boolean; handOn: string[]; complete: string[]; lastRun: FinishRun | null };
  importer: { enabled: boolean; lastRun: ImportRun | null };
  forge: { enabled: boolean; lastRun: ForgeRun | null };
  refused: SyncRefusal | null;
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
  /** The actions that wait only for deferred work in front of them, the soonest due first. */
  waitingOnDeferred: DeferredWaitView[];
  /** The issues held up behind failed or blocked actions, oldest front first. */
  stopped: StoppedIssueView[];
  /** Null when this deployment keeps nothing in step. */
  sync: SyncView | null;
};

/**
 * What the queue is doing, in one answer.
 *
 * Held actions are reported with their age, oldest first, rather than as a
 * number: a move somebody held for a deploy and never released is a ticket that
 * never reaches anyone, and it only looks wrong once you can see how long it has
 * been sitting there. An issue held up behind a failed or blocked action is
 * reported with what waits behind it, for the same reason: the close that never
 * happens is invisible in a count of queued work.
 */
export class QueueStatus {
  readonly #repository: ActionRepository;
  readonly #clock: Clock;
  readonly #sync: SyncConfig | null;
  readonly #order: IssueOrder;

  /** `order`: the order of an issue's actions; without one, every kind is unknown to it and waits for deferred work. */
  constructor(
    repository: ActionRepository,
    clock: Clock,
    sync: SyncConfig | null = null,
    order: IssueOrder = new IssueOrder([]),
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#sync = sync;
    this.#order = order;
  }

  async execute(): Promise<QueueStatusView> {
    const now = this.#clock.now();
    const [counts, pause, lastTickAt, lastBudget, lastAudit, open] = await Promise.all([
      this.#repository.counts(),
      this.#repository.getPause(),
      readLastTickAt(this.#repository),
      readLastBudget(this.#repository),
      readLastAudit(this.#repository),
      this.#repository.list({ states: ['blocked', 'failed', 'held', 'queued'] }),
    ]);
    const inState = (state: ActionState): Action[] => open.filter((action) => action.state === state);
    const blocked = inState('blocked');
    const failed = inState('failed');
    const held = inState('held');
    const queued = inState('queued');

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
      waitingOnDeferred: this.#order.deferredWaits(open, now)
        .map((wait) => deferredWaitView(wait, now))
        .sort((one, other) => one.until.localeCompare(other.until)),
      stopped: stoppedIssues(open).map(stoppedIssueView),
      sync: await this.#syncView(open),
    };
  }

  async #syncView(open: readonly Action[]): Promise<SyncView | null> {
    const sync = this.#sync;
    if (sync === null) {
      return null;
    }
    const [mirrorRun, finishRun, importRun, forgeRun, refused, passOver] = await Promise.all([
      readMirrorRun(this.#repository),
      readFinishRun(this.#repository),
      readImportRun(this.#repository),
      readForgeRun(this.#repository),
      readSyncRefusal(this.#repository),
      readMirrorPassOver(this.#repository),
    ]);
    return {
      server: sync.server,
      project: sync.project,
      owner: sync.mirrorOwner,
      ownerJobs: ownerJobsOf(sync),
      mirror: {
        enabled: sync.mirror?.enabled === true,
        scope: sync.mirror?.scope ?? 'all',
        lastRun: mirrorRun,
        waiting: passOver === null ? null : mirroredWaitView(passOver, open),
      },
      finish: {
        enabled: sync.finish?.enabled === true,
        handOn: [...(sync.finish?.handOn ?? [])],
        complete: [...(sync.finish?.complete ?? [])],
        lastRun: finishRun,
      },
      importer: { enabled: sync.importer.enabled, lastRun: importRun },
      forge: { enabled: sync.forge.enabled, lastRun: forgeRun },
      refused,
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

function stoppedIssueView(stopped: StoppedIssue): StoppedIssueView {
  const front = stopped.front;
  return {
    ref: front.issueRef === null ? null : front.issueRef.toString(),
    front: { id: front.id, kind: front.kind, state: front.state, lastError: front.lastError },
    stopped: stopped.stopped.map(issueActionView),
    waiting: stopped.waiting.map(({ action }) => issueActionView(action)),
  };
}

function issueActionView(action: Action): IssueActionView {
  return { id: action.id, kind: action.kind, state: action.state };
}

function ageInDays(since: Date, now: Date): number {
  const days = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
  return Math.round(Math.max(0, days) * 10) / 10;
}

function deferredWaitView(wait: DeferredWait, now: Date): DeferredWaitView {
  return {
    id: wait.action.id,
    kind: wait.action.kind,
    ref: wait.action.issueRef === null ? null : wait.action.issueRef.toString(),
    behind: wait.behind.map((action) => ({
      id: action.id,
      kind: action.kind,
      runnableAt: (action.notBefore ?? now).toISOString(),
    })),
    until: wait.until.toISOString(),
    inDays: ageInDays(now, wait.until),
  };
}

/** The mirrored actions the last pass left that are still queued, and what waits behind each; null for none. */
function mirroredWaitView(passOver: MirrorPassOver, openInFilingOrder: readonly Action[]): MirroredWaitView | null {
  const left = new Set(passOver.ids);
  const held: MirroredWaitView['held'] = [];
  for (const [at, action] of openInFilingOrder.entries()) {
    if (action.state !== 'queued' || !isMirrored(action) || !left.has(action.id)) {
      continue;
    }
    const lane = action.issueRef?.key() ?? null;
    held.push({
      id: action.id,
      kind: action.kind,
      ref: action.issueRef === null ? null : action.issueRef.toString(),
      waiting: openInFilingOrder.slice(at + 1)
        .filter((later) => (later.issueRef?.key() ?? null) === lane && (later.state === 'queued' || later.state === 'held'))
        .map((later) => ({ id: later.id, kind: later.kind, state: later.state })),
    });
  }
  return held.length === 0 ? null : { count: held.length, at: passOver.at, reason: passOver.reason, held };
}
