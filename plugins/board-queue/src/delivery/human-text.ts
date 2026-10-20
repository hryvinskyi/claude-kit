import { ACTION_STATES } from '../application/action-states.ts';
import type { TickReport } from '../application/drain-queue.ts';
import type { SyncTickReport, WorkerReport } from '../application/run-tick.ts';
import type { EnqueueOutcome } from '../application/enqueue-action.ts';
import type { ActionView } from '../application/list-actions.ts';
import type { QueueStatusView, SyncView } from '../application/queue-status.ts';
import type { ForgeRepositoryRun, ForgeRun } from '../application/sync-meta.ts';
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
  if (outcome.duplicateOf !== undefined) {
    lines.push(`already filed as ${outcome.duplicateOf}; nothing new was filed`);
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
  if (status.sync !== null) {
    lines.push(...syncStatusLines(status.sync));
  }
  return lines;
}

/** What keeping in step with the coordination server looks like from this worker. */
export function syncStatusLines(sync: SyncView): string[] {
  const on = (enabled: boolean): string => (enabled ? 'on' : 'off');
  const lines = [
    `in step with ${sync.server} (${sync.project}): mirror ${on(sync.mirror.enabled)} · `
    + `importer ${on(sync.importer.enabled)} · forge ${on(sync.forge.enabled)} · only in ${sync.owner}'s worker`,
  ];
  if (sync.refused !== null) {
    lines.push(`declined ${sync.refused.at} — ${sync.refused.reason}`);
  }
  const mirror = sync.mirror.lastRun;
  if (mirror !== null) {
    lines.push(`mirror ${mirror.at} — ${String(mirror.events)} events read, ${String(mirror.filed)} filed, `
      + `${String(mirror.duplicates)} already filed, cursor ${String(mirror.cursor)}`
      + (mirror.error === null ? '' : ` — stopped: ${mirror.error}`));
    if (mirror.cursorExpired !== null) {
      lines.push(`mirror lost events: the log was pruned through ${String(mirror.cursorExpired.prunedThrough)} `
        + `before they were read (${mirror.cursorExpired.at}); the live claims are filed in their place next`);
    }
    if (mirror.startedFromHead !== null) {
      lines.push(`mirror started from the head at event ${String(mirror.startedFromHead.event)} `
        + `(${mirror.startedFromHead.at}) because ${mirror.startedFromHead.because}`);
    }
    if (mirror.unresolved > 0) {
      lines.push(`mirror passed over ${String(mirror.unresolved)} moves whose item could not be read; see the log`);
    }
  }
  const imported = sync.importer.lastRun;
  if (imported !== null) {
    lines.push(`import ${imported.at} — ${String(imported.items)} items in ${String(imported.batches)} batches, `
      + `${imported.complete ? 'complete' : `not complete: ${imported.incompleteBecause ?? 'no reason recorded'}`}, `
      + `${String(imported.requests)} dependency requests (${String(imported.notModified)} unchanged), `
      + `read cost ${imported.readCost === null ? 'unknown' : String(imported.readCost)}`
      + (imported.stoppedBecause === null ? '' : ` — stopped: ${imported.stoppedBecause}`));
  }
  const forge = sync.forge.lastRun;
  if (forge !== null) {
    lines.push(...forgeRunLines(forge));
  }
  return lines;
}

/** The last forge pass: what it asked GitHub, what it did per repository, and why it stopped. */
function forgeRunLines(forge: ForgeRun): string[] {
  if (forge.refused !== null) {
    return [`forge ${forge.at} — declined: ${forge.refused}`];
  }
  const lines = [`forge ${forge.at} — ${String(forge.requests)} requests (${String(forge.notModified)} unchanged)`
    + (forge.pruned.statuses + forge.pruned.pulls > 0
      ? ` · forgot ${String(forge.pruned.statuses)} statuses and ${String(forge.pruned.pulls)} pull requests`
      : '')
    + (forge.stoppedBecause === null ? '' : ` — stopped: ${forge.stoppedBecause}`)];
  for (const repo of forge.repos) {
    lines.push(forgeRepositoryLine(repo));
    if (!repo.listedByServer) {
      lines.push(`forge ${repo.repo}: the coordination server does not list it, so it gets no status and no footprint`);
    }
  }
  return lines;
}

function forgeRepositoryLine(repo: ForgeRepositoryRun): string {
  const counted = (count: number, what: string): string => (count > 0 ? ` (${String(count)} ${what})` : '');
  return `forge ${repo.repo}: `
    + (repo.seeded ? `started with ${String(repo.listed)} open` : `${String(repo.listed)} listed`)
    + ` · cursor ${repo.cursor ?? 'none'} · ${String(repo.merged)} merged`
    + counted(repo.mergesWithoutFiles, 'without their files')
    + ` · ${String(repo.closed)} closed`
    + counted(repo.refusedReports, 'refused by the server')
    + ` · ${String(repo.mergeability)} mergeability · ${String(repo.statuses)} statuses`
    + counted(repo.statusesWithdrawn, 'taken back')
    + counted(repo.statusesDeferred, 'left for a later pass')
    + ` · ${String(repo.footprints)} footprints`
    + counted(repo.branchesGone, 'branches gone')
    + ` · ${String(repo.holdsReleased)} holds released`
    + (repo.failures > 0 ? ` · ${String(repo.failures)} failed, see the log` : '')
    + (repo.listingError === null ? '' : ` · listing not read: ${repo.listingError}`)
    + (repo.stoppedBecause === null ? '' : ` · stopped: ${repo.stoppedBecause}`);
}

/**
 * What one run of the worker did. A run that did not happen says so and nothing
 * else: the tallies of a tick that never started are zeros nobody should read as
 * an empty queue.
 */
export function tickLines(report: WorkerReport): string[] {
  return [...queueTickLines(report), ...(report.sync === undefined ? [] : syncTickLines(report.sync))];
}

function queueTickLines(report: TickReport): string[] {
  if (report.skipped !== undefined) {
    const lines = [`skipped: ${report.skipped}`];
    if (report.pausedUntil !== undefined) {
      lines.push(`waiting until ${report.pausedUntil}`);
    }
    return lines;
  }
  const lines = [
    `executed ${String(report.executed)} · done ${String(report.done)} · blocked ${String(report.blocked)}`
    + ` · failed ${String(report.failed)} · not applied ${String(report.notApplied)}`
    + ` · requeued ${String(report.requeued)}`
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

/** What a tick did about keeping in step, a line per direction. */
function syncTickLines(sync: SyncTickReport): string[] {
  const lines: string[] = [];
  if (sync.refused !== undefined) {
    lines.push(`in step: declined — ${sync.refused}`);
  }
  const mirror = sync.mirror;
  if (mirror !== undefined) {
    lines.push('skipped' in mirror
      ? `mirror: skipped — ${mirror.skipped}`
      : `mirror: ${String(mirror.events)} events · ${String(mirror.filed)} filed`
        + (mirror.error === null ? '' : ` · stopped: ${mirror.error}`));
  }
  const imported = sync.import;
  if (imported !== undefined) {
    lines.push('skipped' in imported
      ? `import: skipped — ${imported.skipped}`
      : `import: ${String(imported.run.items)} items · ${imported.run.complete ? 'complete' : 'not complete'}`
        + ` · ${String(imported.run.requests)} requests`
        + (imported.run.stoppedBecause === null ? '' : ` · stopped: ${imported.run.stoppedBecause}`));
  }
  const forge = sync.forge;
  if (forge !== undefined) {
    lines.push('skipped' in forge
      ? `forge: skipped — ${forge.skipped}`
      : `forge: ${String(forge.run.requests)} requests · ${String(forge.run.repos.length)} repositories`
        + (forge.run.stoppedBecause === null ? '' : ` · stopped: ${forge.run.stoppedBecause}`));
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
