import { ACTION_STATES } from '../application/action-states.ts';
import type { TickReport } from '../application/drain-queue.ts';
import type { EnqueueOutcome } from '../application/enqueue-action.ts';
import type { ActionView } from '../application/list-actions.ts';
import type { QueueStatusView } from '../application/queue-status.ts';
import type { BoardItemView } from '../application/show-board-item.ts';

/**
 * What the queue looks like to somebody reading a terminal.
 *
 * Every function here takes a plain answer and gives back lines; none of them
 * prints, and none of them asks anything. That is what lets the same answers go
 * out as JSON instead, and what keeps a printer from quietly becoming the place a
 * rule is decided.
 *
 * The lines are terse on purpose. These are read in the middle of doing something
 * else — a session starting, a shim reporting what it filed — and a paragraph
 * where an identifier and a state would do is a paragraph nobody reads.
 */

/** Nothing to say about an issue, where a reference would otherwise stand. */
const NO_ISSUE = '(no issue)';

export function enqueueLines(outcome: EnqueueOutcome): string[] {
  const lines = [`${outcome.state} ${outcome.id}`];
  if (outcome.coalescedInto !== undefined) {
    lines.push(`coalesced into ${outcome.coalescedInto}`);
  }
  for (const warning of outcome.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines;
}

/** One action, one line: what it is, where it stands, and what stopped it. */
export function actionLine(action: ActionView): string {
  const line = `${action.id} ${action.state} ${action.kind} ${action.ref ?? NO_ISSUE}`;
  const note = action.lastError ?? action.result;
  return note === null ? line : `${line} — ${oneLine(note)}`;
}

/** One action that just changed, named by what happened to it. */
export function movedLine(verb: string, action: ActionView): string {
  return `${verb} ${action.id} → ${action.state}`;
}

export function statusLines(status: QueueStatusView): string[] {
  const lines: string[] = [
    ACTION_STATES.map((state) => `${state} ${String(status.counts[state])}`).join(' · '),
  ];
  if (status.pause !== null) {
    lines.push(
      `waiting until ${status.pause.until} (${String(status.pause.remainingSec)}s) — ${status.pause.reason}`
      + ` after ${String(status.pause.consecutiveHits)} refusals in a row`,
    );
  }
  lines.push(status.lastBudget === null
    ? 'no allowance has been read yet'
    : `allowance ${status.lastBudget.resource} ${String(status.lastBudget.remaining)}`
      + `/${String(status.lastBudget.limit)} until ${status.lastBudget.resetAt}`);
  lines.push(status.lastTickAt === null ? 'the worker has not run yet' : `last run ${status.lastTickAt}`);
  if (status.lastAudit !== null) {
    lines.push(
      `last report ${status.lastAudit.at} — ${String(status.lastAudit.notOnBoard)} not on the board, `
      + `${String(status.lastAudit.emptyFields)} with an empty field, `
      + `${String(status.lastAudit.closedNotDone)} closed without the board following`,
    );
  }
  for (const action of status.held) {
    lines.push(`held ${action.id} ${action.kind} ${action.ref ?? NO_ISSUE} `
      + `— ${action.ageDays.toFixed(1)}d, filed by ${action.origin}`);
  }
  for (const action of status.delayed) {
    lines.push(`delayed ${action.id} ${action.kind} ${action.ref ?? NO_ISSUE} `
      + `— runs ${action.runnableAt} (in ${action.inDays.toFixed(1)}d), filed by ${action.origin}`);
  }
  for (const action of status.blocked) {
    lines.push(`blocked ${action.id} ${action.kind} ${action.ref ?? NO_ISSUE} — ${oneLine(action.lastError)}`);
  }
  for (const action of status.failed) {
    lines.push(`failed ${action.id} ${action.kind} ${action.ref ?? NO_ISSUE} — ${oneLine(action.lastError)}`);
  }
  return lines;
}

/**
 * What one run of the worker did. A run that did not happen says so and nothing
 * else: the tallies of a tick that never started are zeros nobody should read as
 * an empty queue.
 */
export function tickLines(report: TickReport): string[] {
  if (report.skipped !== undefined) {
    const lines = [`skipped: ${report.skipped}`];
    if (report.pausedUntil !== undefined) {
      lines.push(`waiting until ${report.pausedUntil}`);
    }
    return lines;
  }
  const lines = [
    `executed ${String(report.executed)} · done ${String(report.done)} · blocked ${String(report.blocked)}`
    + ` · failed ${String(report.failed)} · requeued ${String(report.requeued)}`
    + ` · unblocked ${String(report.unblocked)} · recovered ${String(report.recovered)}`
    + ` · stale ${String(report.stale)}`,
  ];
  if (report.stoppedBecause !== undefined) {
    lines.push(`stopped: ${report.stoppedBecause}`);
  }
  if (report.pausedUntil !== undefined) {
    lines.push(`waiting until ${report.pausedUntil}`);
  }
  if (report.budget !== undefined) {
    lines.push(`allowance ${report.budget}`);
  }
  return lines;
}

export function boardItemLines(item: BoardItemView): string[] {
  const lines = [`${item.ref} ${item.url}`];
  if (!item.onBoard) {
    lines.push(`not on the board ${item.board}`);
  } else {
    lines.push(`on the board ${item.board} as ${item.itemId ?? 'a row with no id'}`);
    const values = Object.entries(item.values);
    lines.push(values.length === 0
      ? 'every field is empty'
      : values.map(([field, value]) => `${field} → ${value}`).join(', '));
  }
  if (item.budget !== null) {
    lines.push(`allowance ${item.budget}`);
  }
  return lines;
}

/** A stored error may hold several lines; a listing shows the first and stays a listing. */
export function oneLine(text: string | null): string {
  if (text === null) {
    return 'no reason was recorded';
  }
  const [first = ''] = text.split('\n');
  return first;
}
