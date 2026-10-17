import type { ReadItemResult } from '../domain/catalog.ts';
import type { Config } from '../domain/config.ts';
import { STATUS_FIELD, namesRefusedStatus } from '../domain/field-request.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import type { BoardLane, BoardRouter } from './board-router.ts';
import type { BudgetPolicy } from './budget-policy.ts';
import { LimiterWait } from './limiter-wait.ts';
import { writeLastAudit } from './queue-meta.ts';
import type { ActionRepository, Clock, IssueSummary, Logger } from './ports.ts';

/** How far back the pass looks for issues that were closed and left behind. */
const CLOSED_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An issue as the report names it: enough to open it, nothing more. */
export type AuditIssue = {
  number: number;
  title: string;
  url: string;
};

/** An issue whose board row exists but leaves some of the managed fields blank. */
export type AuditIssueWithGaps = AuditIssue & {
  /** The field names the row says nothing for, in the order the configuration lists them. */
  missing: string[];
};

/** A closed issue whose board row was never carried to a finished status. */
export type AuditClosedIssue = AuditIssue & {
  /** What the row says instead; empty when it says nothing at all. */
  status: string;
};

export type RepoAudit = {
  /** How many open issues the repository has, which is what the rest is measured against. */
  open: number;
  notOnBoard: AuditIssue[];
  emptyFields: AuditIssueWithGaps[];
  closedNotDone: AuditClosedIssue[];
};

export type AuditReport = {
  generatedAt: string;
  /** What the last answer said was left of the account's allowance, or nothing when none was read. */
  budgetAfter: string | null;
  /** Present only when the pass did not finish, saying what stopped it and where. */
  stoppedBecause?: string;
  /** Keyed by `owner/name`, as the configuration spells it; a repository the pass never reached is absent. */
  repos: Record<string, RepoAudit>;
};

/**
 * Where a finished report is left for a person to read. The pass states what it
 * needs — somewhere to put one report — and knows nothing about files, so the
 * same pass serves a command that prints it and a schedule that stores it.
 */
export interface AuditReportSink {
  save(report: AuditReport): Promise<void>;
}

export type AuditBoardDeps = {
  config: Config;
  repository: ActionRepository;
  /** Every board, each with the repositories it carries and the gateways that reach them. */
  boards: BoardRouter;
  policy: BudgetPolicy;
  clock: Clock;
  logger: Logger;
  reports: AuditReportSink;
};

/**
 * What the boards do not say, said once.
 *
 * The pass reads three cheap things per repository — the open issues over REST,
 * one walk of the whole board that carries it, and the issues closed lately — and
 * writes down
 * three disagreements: an open issue with no row, a row with a managed field left
 * blank, and a closed issue whose row never followed. Matching is on repository
 * *and* number, because the board carries several repositories whose numbers
 * collide and a number alone names nothing.
 *
 * It queues nothing, ever. Which module an issue belongs to, and how badly it
 * hurts, is a judgement this pass has no way to make; a value guessed here would
 * route triage wrongly and look exactly like a value somebody chose. So the
 * finding is the whole product: a person reads it and decides.
 *
 * A refusal from the allowance or the burst limiter ends the pass where it stands.
 * What was already found is still written down — the findings are true, they are
 * simply not all of them — but the summary the schedule reads is left alone, so
 * an hour that could not be finished is looked at again rather than counted as
 * done.
 */
export class AuditBoard {
  readonly #config: Config;
  readonly #repository: ActionRepository;
  readonly #boards: BoardRouter;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #reports: AuditReportSink;
  readonly #wait: LimiterWait;

  constructor(deps: AuditBoardDeps) {
    this.#config = deps.config;
    this.#repository = deps.repository;
    this.#boards = deps.boards;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#reports = deps.reports;
    this.#wait = new LimiterWait({
      repository: deps.repository,
      policy: deps.policy,
      logger: deps.logger,
    });
  }

  async execute(): Promise<AuditReport> {
    const startedAt = this.#clock.now();
    const repos: Record<string, RepoAudit> = {};
    let stoppedBecause: string | undefined;

    const visits = this.#boards.lanes().flatMap((lane) => lane.placement.repos.map((repo) => ({ lane, repo })));
    for (const { lane, repo } of visits) {
      try {
        await this.#look(lane, repo, repos, startedAt);
      } catch (error) {
        const pause = await this.#wait.after(error, this.#clock.now());
        if (pause === null) {
          throw error;
        }
        stoppedBecause = `${pause.reason}; the pass stopped at ${repo}`;
        break;
      }
    }

    const report: AuditReport = {
      generatedAt: startedAt.toISOString(),
      budgetAfter: this.#boards.lastBudget()?.describe() ?? null,
      repos,
    };
    if (stoppedBecause !== undefined) {
      report.stoppedBecause = stoppedBecause;
    }
    await this.#record(report, startedAt, stoppedBecause === undefined);
    return report;
  }

  /**
   * Keeps the report, and stamps the summary a status listing shows.
   *
   * A pass that was refused before it read a single repository has found nothing
   * to say, and saying it would replace a report that still holds — so nothing is
   * written at all. A partial pass writes its report and leaves the summary: the
   * summary is what decides when the next pass runs, and counts taken from half a
   * board would postpone the other half by hours.
   */
  async #record(report: AuditReport, at: Date, complete: boolean): Promise<void> {
    const names = Object.keys(report.repos);
    if (names.length === 0) {
      this.#logger.warn('the board was not read at all', { reason: report.stoppedBecause ?? 'nothing answered' });
      return;
    }
    await this.#reports.save(report);
    const totals = names.reduce((sum, name) => {
      const found = report.repos[name];
      return found === undefined ? sum : {
        notOnBoard: sum.notOnBoard + found.notOnBoard.length,
        emptyFields: sum.emptyFields + found.emptyFields.length,
        closedNotDone: sum.closedNotDone + found.closedNotDone.length,
      };
    }, { notOnBoard: 0, emptyFields: 0, closedNotDone: 0 });
    if (complete) {
      await writeLastAudit(this.#repository, { at, ...totals });
    }
    this.#logger.info('the board was read', { repos: names.length, complete, ...totals });
  }

  /**
   * One repository, in the order that spends least: the open issues first, then
   * one walk of the board that carries it for all of them at once, then the issues
   * closed lately.
   * The entry appears in the report only once the open issues are known, so a
   * repository the pass was refused on is absent rather than reported as empty.
   */
  async #look(lane: BoardLane, repo: string, repos: Record<string, RepoAudit>, now: Date): Promise<void> {
    const open = await lane.issues.listOpen(repo);
    const found: RepoAudit = { open: open.length, notOnBoard: [], emptyFields: [], closedNotDone: [] };
    repos[repo] = found;

    const onBoard = await membership(lane, repo, open);
    for (const issue of open) {
      const row = onBoard.get(IssueRef.of(repo, issue.number).key());
      if (row === undefined || row === 'missing') {
        found.notOnBoard.push(viewOf(issue));
        continue;
      }
      const missing = this.#config.fields.filter((field) => blank(valueOf(row, field)));
      if (missing.length > 0) {
        found.emptyFields.push({ ...viewOf(issue), missing });
      }
    }

    if (this.#config.refusedStatus.length === 0) {
      // Which statuses the board sets on its own is exactly the set this queue
      // refuses to write. Where the configuration names none, there is nothing to
      // hold a closed issue's row against, and inventing one would report every
      // closed issue as a problem.
      this.#logger.warn('closed issues were not checked', {
        reason: 'the configuration names no status the board sets on its own',
      });
      return;
    }

    const since = new Date(now.getTime() - CLOSED_WINDOW_DAYS * DAY_MS);
    const closed = await lane.issues.listClosedSince(repo, since);
    const rows = await membership(lane, repo, closed);
    for (const issue of closed) {
      const row = rows.get(IssueRef.of(repo, issue.number).key());
      if (row === undefined || row === 'missing') {
        // An issue that was closed without ever reaching the board is not what
        // this looks for: the board's own automation had no row to carry.
        continue;
      }
      const status = valueOf(row, STATUS_FIELD) ?? '';
      if (!namesRefusedStatus(status, this.#config.refusedStatus)) {
        found.closedNotDone.push({ ...viewOf(issue), status });
      }
    }
  }

}

/** Which of these issues have a row on the board that carries their repository, from one walk of it. */
async function membership(
  lane: BoardLane,
  repo: string,
  issues: readonly IssueSummary[],
): Promise<Map<string, ReadItemResult | 'missing'>> {
  if (issues.length === 0) {
    return new Map();
  }
  return lane.board.membership(issues.map((issue) => IssueRef.of(repo, issue.number)));
}

function viewOf(issue: IssueSummary): AuditIssue {
  return { number: issue.number, title: issue.title, url: issue.url };
}

/** The row's value for a board field, whatever case the board spells the field in. */
function valueOf(row: ReadItemResult, field: string): string | undefined {
  const needle = field.trim().toLowerCase();
  for (const [name, value] of Object.entries(row.values)) {
    if (name.trim().toLowerCase() === needle) {
      return value;
    }
  }
  return undefined;
}

/** A field the row says nothing for, and a field it says only spaces for, are both blank. */
function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}
