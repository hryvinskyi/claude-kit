import type { AuditIssue, AuditReport, RepoAudit } from '../application/audit-board.ts';

/** The widest label below, so every finding's detail starts in the same column. */
const LABEL = 18;
/** Room for an issue number nobody is going to reach. */
const NUMBER = 7;
/** A title longer than this is cut: the number and the address are what you act on. */
const TITLE = 44;

/**
 * The report as a person reads it in a terminal: a short block per repository,
 * one line per finding, and a last line saying that nothing was queued.
 *
 * That last line is not decoration. The pass looks exactly like something that
 * fixes what it finds, and a reader who assumed it had would leave every row it
 * listed alone.
 */
export function auditLines(report: AuditReport): string[] {
  const lines = [`board report ${report.generatedAt} · ${report.budgetAfter ?? 'the allowance was not read'}`];

  const repos = Object.entries(report.repos);
  if (repos.length === 0) {
    lines.push('no repository was read');
  }
  for (const [repo, found] of repos) {
    lines.push('', `${repo} · ${headline(found)}`);
    for (const issue of found.notOnBoard) {
      lines.push(finding('not on the board', issue, ''));
    }
    for (const issue of found.emptyFields) {
      lines.push(finding('fields left blank', issue, issue.missing.join(', ')));
    }
    for (const issue of found.closedNotDone) {
      lines.push(finding('board not followed', issue, issue.status === '' ? 'no status' : issue.status));
    }
  }

  if (report.stoppedBecause !== undefined) {
    lines.push('', `the pass did not finish: ${report.stoppedBecause}`);
  }
  lines.push('', 'nothing was queued: this pass only says what it found');
  return lines;
}

function headline(found: RepoAudit): string {
  const parts = [`${String(found.open)} open`];
  if (found.notOnBoard.length > 0) {
    parts.push(`${String(found.notOnBoard.length)} not on the board`);
  }
  if (found.emptyFields.length > 0) {
    parts.push(`${String(found.emptyFields.length)} with a field left blank`);
  }
  if (found.closedNotDone.length > 0) {
    parts.push(`${String(found.closedNotDone.length)} the board did not follow`);
  }
  return parts.length === 1 ? `${parts[0] ?? ''} · nothing to report` : parts.join(' · ');
}

function finding(label: string, issue: AuditIssue, detail: string): string {
  const line = `  ${label.padEnd(LABEL)} ${`#${String(issue.number)}`.padEnd(NUMBER)} ${shorten(issue.title)}`;
  return detail === '' ? line.trimEnd() : `${line.padEnd(LABEL + NUMBER + TITLE + 4)} ${detail}`;
}

function shorten(title: string): string {
  const text = title.trim();
  return text.length <= TITLE ? text : `${text.slice(0, TITLE - 1).trimEnd()}…`;
}
