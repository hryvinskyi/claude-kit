import type { ActionState } from '../domain/action.ts';
import type { ActionView } from '../application/list-actions.ts';
import { oneLine } from './human-text.ts';

/**
 * The two lines a session sees when it starts in one repository.
 *
 * They exist because work filed against the board leaves the session that filed
 * it: a move nobody released and a blocked action nobody fixed are invisible
 * until somebody thinks to look, and nobody thinks to look. So the queue says
 * where it stands at the moment a person opens the project, and says nothing at
 * all when there is nothing waiting — a line that is always there stops being
 * read.
 *
 * Only the database is touched. This runs at the start of every session, twice
 * over if two projects are open, and a brief that reached the network would spend
 * the same allowance the worker is pacing itself against, and would make a
 * session wait on it.
 */

/** The tag every line carries, so a session brief reads as one block. */
const TAG = '[BOARD QUEUE]';

/**
 * The states that mean work is still outstanding. Done and cancelled actions are
 * history, and history is not news at the start of a session.
 */
export const BRIEF_STATES: readonly ActionState[] = ['queued', 'running', 'held', 'blocked', 'failed'];

/** Beyond this, a wait is worth naming rather than counting as work in hand. */
const WORTH_NAMING_DAYS = 1;

export type BlockedHeadline = {
  id: string;
  ref: string | null;
  error: string;
};

export type RepositoryBrief = {
  repo: string;
  /** Work the worker will pick up, including whatever it has in hand right now. */
  queued: number;
  held: number;
  /** How long the oldest held action has been waiting, or nothing when none is. */
  oldestHeldDays: number | null;
  /** Queued work pushed into the future, which no tick will touch until it comes round. */
  delayed: number;
  /** How long until the nearest of them may run, or nothing when none is waiting. */
  nextDelayedDays: number | null;
  blocked: number;
  failed: number;
  /** The first action waiting for a person, which is the one worth naming. */
  firstBlocked: BlockedHeadline | null;
};

/**
 * The tally behind the lines.
 *
 * An action the worker has in hand is counted as queued: from the reader's side
 * it is work that is about to happen, and a state that lasts a second or two is
 * not worth a column of its own. It does mean a tick that died mid-action leaves
 * one in the count — which is the honest reading, because that action has not
 * happened.
 */
export function briefOf(repo: string, actions: readonly ActionView[], now: Date): RepositoryBrief {
  const brief: RepositoryBrief = {
    repo,
    queued: 0,
    held: 0,
    oldestHeldDays: null,
    delayed: 0,
    nextDelayedDays: null,
    blocked: 0,
    failed: 0,
    firstBlocked: null,
  };
  for (const action of actions) {
    if (action.state === 'queued' || action.state === 'running') {
      brief.queued += 1;
    }
    // A delayed action is counted among the queued as well: it is work that was
    // filed and has not happened, which is what the first number means. What the
    // count cannot say is that nothing will touch it today, so it is said here.
    const waiting = waitsFor(action, now);
    if (waiting !== null) {
      brief.delayed += 1;
      brief.nextDelayedDays = brief.nextDelayedDays === null
        ? waiting
        : Math.min(brief.nextDelayedDays, waiting);
    }
    if (action.state === 'held') {
      brief.held += 1;
      const age = ageInDays(action.createdAt, now);
      brief.oldestHeldDays = brief.oldestHeldDays === null ? age : Math.max(brief.oldestHeldDays, age);
    }
    if (action.state === 'blocked') {
      brief.blocked += 1;
      brief.firstBlocked ??= { id: action.id, ref: action.ref, error: oneLine(action.lastError) };
    }
    if (action.state === 'failed') {
      brief.failed += 1;
    }
  }
  return brief;
}

/** Whether there is anything to say at all. */
export function hasNews(brief: RepositoryBrief): boolean {
  return brief.queued + brief.held + brief.blocked + brief.failed > 0;
}

export function briefLines(brief: RepositoryBrief): string[] {
  if (!hasNews(brief)) {
    return [];
  }
  const held = brief.oldestHeldDays === null
    ? `held ${String(brief.held)}`
    : `held ${String(brief.held)} (oldest ${brief.oldestHeldDays.toFixed(1)}d)`;
  const delayed = brief.nextDelayedDays === null
    ? ''
    : ` · delayed ${String(brief.delayed)} (next in ${brief.nextDelayedDays.toFixed(1)}d)`;
  const lines = [
    `${TAG} queued ${String(brief.queued)} · ${held}${delayed} · blocked ${String(brief.blocked)}`
    + ` · failed ${String(brief.failed)}`,
  ];
  const blocked = brief.firstBlocked;
  if (blocked !== null) {
    lines.push(`${TAG} blocked ${blocked.ref ?? blocked.id} — ${blocked.error}`);
  }
  return lines;
}

/**
 * How long until a queued action may run, in days, or nothing when it may already.
 * Only a wait long enough to outlast the working day is worth a line: the queue's
 * own backoff pushes an action a minute or two ahead all the time, and a session
 * brief that reported those would be noise from the first morning.
 */
function waitsFor(action: ActionView, now: Date): number | null {
  if (action.state !== 'queued' || action.notBefore === null) {
    return null;
  }
  const moment = new Date(action.notBefore).getTime();
  if (Number.isNaN(moment)) {
    return null;
  }
  const days = (moment - now.getTime()) / (24 * 60 * 60 * 1000);
  return days >= WORTH_NAMING_DAYS ? days : null;
}

function ageInDays(since: string, now: Date): number {
  const filed = new Date(since).getTime();
  if (Number.isNaN(filed)) {
    return 0;
  }
  return Math.max(0, (now.getTime() - filed) / (24 * 60 * 60 * 1000));
}
