import type { BoardSnapshot } from '../domain/catalog.ts';
import { BoardQueueError } from '../domain/errors.ts';
import { STATUS_FIELD } from '../domain/field-request.ts';
import { BOARD_FIELD_OF } from '../domain/kinds/fields.ts';
import type { ImporterConfig, SyncConfig } from '../domain/sync-config.ts';
import { planImport } from '../domain/sync/ready-work.ts';
import type { Blocker, BoardWork, ImportPlan, PlannedBatch } from '../domain/sync/ready-work.ts';
import type { BoardLane, BoardRouter } from './board-router.ts';
import type { BudgetPolicy } from './budget-policy.ts';
import { describeUnknown } from './drain-queue.ts';
import type { LimiterWait } from './limiter-wait.ts';
import type { ActionRepository, Clock, Logger, Sleeper } from './ports.ts';
import { readLastBudget } from './queue-meta.ts';
import {
  IMPORT_LAST_COMPLETE_OPEN,
  readCount,
  readImportAttemptAt,
  writeImportAttemptAt,
  writeImportRun,
} from './sync-meta.ts';
import type { ImportRun } from './sync-meta.ts';
import type {
  DependencyCache,
  DependencyFetch,
  DependencyList,
  DependencyReader,
  ImportBatch,
  WorkImport,
} from './sync-ports.ts';

/** What one import did, or why it did not run. */
export type ImportReport = { skipped: string } | { run: ImportRun };

export type ImportReadyWorkDeps = {
  boards: BoardRouter;
  dependencies: DependencyReader;
  cache: DependencyCache;
  target: WorkImport;
  /** Read for the allowance, the wait in force and the import's own notes; no action is ever written to it. */
  repository: ActionRepository;
  wait: LimiterWait;
  policy: BudgetPolicy;
  sync: SyncConfig;
  importer: ImporterConfig;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
};

/** One dependency list of one issue that may be asked for, and what was kept of it. */
type Candidate = {
  readonly work: BoardWork;
  readonly list: DependencyList;
  readonly cached: DependencyFetch | null;
};

type Spending = {
  requests: number;
  notModified: number;
  stoppedBecause: string | null;
};

/** What a summary on the row says a list holds, per list. */
const SUMMARY_OF: { readonly [L in DependencyList]: (work: BoardWork) => number | null } = {
  blocked_by: (work) => work.issue.blockedByTotal,
  sub_issues: (work) => work.issue.subIssuesTotal,
};

/** Which issues of a list block the issue that names them: every blocker, and only the open sub-issues. */
const BLOCKING_OF: { readonly [L in DependencyList]: (issues: readonly Blocker[]) => readonly Blocker[] } = {
  blocked_by: (issues) => issues,
  sub_issues: (issues) => issues.filter((issue) => issue.state === 'open'),
};

const LISTS: readonly DependencyList[] = ['blocked_by', 'sub_issues'];

/**
 * The board's work, reported to the coordination server: every issue of the
 * repositories kept in step, with its title, its status, the areas its Module
 * stands for, the priority its Severity stands for, and what blocks it.
 *
 * It reads GitHub and nothing else, and it writes to GitHub nothing at all: the
 * board is read through the same walk the rest of this system reads it with, and
 * what blocks each issue through the REST dependency lists — asked conditionally,
 * paced, capped per run and round-robin by the oldest answer, and only for an
 * issue whose row says it has any. It files no action in the queue, so an import
 * never sets off a write of its own; what it sends changes no claim on the server
 * either, so it sets off nothing there that would come back as a move.
 *
 * A refusal from a limiter ends the reading where it stands and puts the queue to
 * sleep, as any refusal does; what was read is still sent, from the answers kept
 * from earlier runs. A batch says it names every open item only when every row of
 * every board was read in this run.
 */
export class ImportReadyWork {
  readonly #boards: BoardRouter;
  readonly #dependencies: DependencyReader;
  readonly #cache: DependencyCache;
  readonly #target: WorkImport;
  readonly #repository: ActionRepository;
  readonly #wait: LimiterWait;
  readonly #policy: BudgetPolicy;
  readonly #importer: ImporterConfig;
  readonly #clock: Clock;
  readonly #sleeper: Sleeper;
  readonly #logger: Logger;
  readonly #repos: ReadonlySet<string>;

  constructor(deps: ImportReadyWorkDeps) {
    this.#boards = deps.boards;
    this.#dependencies = deps.dependencies;
    this.#cache = deps.cache;
    this.#target = deps.target;
    this.#repository = deps.repository;
    this.#wait = deps.wait;
    this.#policy = deps.policy;
    this.#importer = deps.importer;
    this.#clock = deps.clock;
    this.#sleeper = deps.sleeper;
    this.#logger = deps.logger;
    this.#repos = new Set(deps.sync.repos.map((repo) => repo.toLowerCase()));
  }

  async execute(): Promise<ImportReport> {
    const notYet = await this.#notYet();
    if (notYet !== null) {
      return { skipped: notYet };
    }
    const startedAt = this.#clock.now();
    // Stamped before the reading rather than after it, so a run that fails — or
    // that the machine interrupts — still holds the cadence instead of reading the
    // board again at the next tick.
    await writeImportAttemptAt(this.#repository, startedAt);

    const read = await this.#readBoards();
    const spending: Spending = { requests: 0, notModified: 0, stoppedBecause: read.stoppedBecause };
    if (spending.stoppedBecause === null) {
      await this.#refreshDependencies(read.work, spending);
    }
    const plan = planImport({
      work: read.work,
      blockers: await this.#blockersOf(read.work),
      boardsReadWhole: read.whole,
      unreadBecause: read.unreadBecause,
      lastCompleteOpen: await readCount(this.#repository, IMPORT_LAST_COMPLETE_OPEN),
      vocabulary: {
        source: this.#importer.source,
        modules: this.#importer.modules,
        priorities: this.#importer.priorities,
        statusField: STATUS_FIELD,
        moduleField: BOARD_FIELD_OF['module'] ?? 'Module',
        severityField: BOARD_FIELD_OF['severity'] ?? 'Severity',
      },
    });
    const sent = await this.#send(plan);
    const run: ImportRun = {
      at: startedAt.toISOString(),
      items: sent.items,
      batches: sent.batches,
      complete: sent.complete,
      open: plan.open,
      incompleteBecause: sent.complete ? null : sent.incompleteBecause,
      requests: spending.requests,
      notModified: spending.notModified,
      readCost: read.cost,
      refusedEdges: sent.refusedEdges,
      stoppedBecause: sent.stoppedBecause ?? spending.stoppedBecause,
    };
    if (run.complete) {
      await this.#repository.setMeta(IMPORT_LAST_COMPLETE_OPEN, String(plan.open));
    }
    await writeImportRun(this.#repository, run);
    this.#logger.info('the board\'s work was reported', { ...run });
    return { run };
  }

  /** Why this is not a moment to read the board, or nothing when it is. */
  async #notYet(): Promise<string | null> {
    const now = this.#clock.now();
    const pause = await this.#repository.getPause();
    if (pause !== null && pause.isActive(now)) {
      return `the queue is waiting out a refusal until ${pause.until.toISOString()}`;
    }
    const budget = await readLastBudget(this.#repository);
    const due = this.#policy.shouldImport(await readImportAttemptAt(this.#repository), now, budget, this.#importer);
    if (due) {
      return null;
    }
    if (budget === null || budget.remaining < this.#importer.minRemaining) {
      return `the allowance is below the import's reserve of ${String(this.#importer.minRemaining)}`;
    }
    return `the last import was less than ${String(this.#importer.everyMinutes)} minutes ago`;
  }

  /** Every row of the repositories kept in step, from one walk of each board that carries them. */
  async #readBoards(): Promise<{
    work: BoardWork[];
    whole: boolean;
    unreadBecause: string | null;
    stoppedBecause: string | null;
    cost: number | null;
  }> {
    const work: BoardWork[] = [];
    let whole = true;
    let unreadBecause: string | null = null;
    let stoppedBecause: string | null = null;
    let cost: number | null = null;
    for (const lane of this.#lanesKeptInStep()) {
      let snapshot: BoardSnapshot;
      try {
        snapshot = await lane.board.readWork();
      } catch (error) {
        whole = false;
        const pause = await this.#wait.after(error, this.#clock.now());
        unreadBecause = `the board ${lane.placement.name} could not be read: ${sentenceOf(error)}`;
        this.#logger.warn('a board was not read for the import', { board: lane.placement.name, reason: unreadBecause });
        if (pause !== null) {
          stoppedBecause = pause.reason;
          break;
        }
        continue;
      }
      if (snapshot.cost !== null) {
        cost = (cost ?? 0) + snapshot.cost;
      }
      if (snapshot.unreadable > 0) {
        whole = false;
        unreadBecause = `${String(snapshot.unreadable)} rows of ${lane.placement.name} could not be read`;
      }
      for (const row of snapshot.items) {
        if (!this.#repos.has(row.ref.repoFullName().toLowerCase())) {
          continue;
        }
        if (row.issue === undefined) {
          whole = false;
          unreadBecause = `a row of ${lane.placement.name} answered without the issue's facts`;
          continue;
        }
        work.push({ ref: row.ref, issue: row.issue, values: row.values });
      }
    }
    return { work, whole, unreadBecause, stoppedBecause, cost };
  }

  #lanesKeptInStep(): BoardLane[] {
    return this.#boards.lanes().filter((lane) =>
      lane.placement.repos.some((repo) => this.#repos.has(repo.toLowerCase())));
  }

  /**
   * Asks again for the dependency lists most in need of it, at most the per-run cap
   * of them, one at a time and paced. A list the row's summary says is empty is
   * never asked for. One whose answer carried no tag is asked for again only once
   * the issue changed, because asking would cost a request every time.
   */
  async #refreshDependencies(work: readonly BoardWork[], spending: Spending): Promise<void> {
    const due = (await this.#candidates(work))
      .filter((candidate) => isDue(candidate))
      .sort((one, other) => fetchedAt(one) - fetchedAt(other))
      .slice(0, this.#importer.maxRequestsPerTick);
    for (const candidate of due) {
      if (spending.requests > 0) {
        await this.#sleeper.sleep(this.#importer.paceMs);
      }
      spending.requests += 1;
      try {
        await this.#fetch(candidate, spending);
      } catch (error) {
        const pause = await this.#wait.after(error, this.#clock.now());
        if (pause !== null) {
          spending.stoppedBecause = pause.reason;
          this.#logger.warn('the import stopped asking what blocks the issues', { reason: pause.reason });
          return;
        }
        this.#logger.warn('what blocks an issue could not be read', {
          ref: candidate.work.ref.toString(),
          list: candidate.list,
          reason: sentenceOf(error),
        });
      }
    }
  }

  async #candidates(work: readonly BoardWork[]): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const one of work) {
      if (one.issue.state !== 'open') {
        continue;
      }
      for (const list of LISTS) {
        if (SUMMARY_OF[list](one) === 0) {
          continue;
        }
        candidates.push({ work: one, list, cached: await this.#cache.get(list, one.ref) });
      }
    }
    return candidates;
  }

  async #fetch(candidate: Candidate, spending: Spending): Promise<void> {
    const { work, list, cached } = candidate;
    const answer = await this.#dependencies.read(list, work.ref, cached?.etag ?? null);
    const now = this.#clock.now();
    if (!answer.changed) {
      spending.notModified += 1;
    }
    await this.#cache.put(list, work.ref, {
      etag: answer.etag,
      issues: answer.changed ? answer.issues : cached?.issues ?? [],
      fetchedAt: now,
      issueUpdatedAt: work.issue.updatedAt,
    });
  }

  /**
   * What blocks each open issue, from the answers kept: a list the row's summary
   * says is empty blocks nothing, whatever an older answer said.
   */
  async #blockersOf(work: readonly BoardWork[]): Promise<Map<string, Blocker[]>> {
    const blockers = new Map<string, Blocker[]>();
    for (const one of work) {
      if (one.issue.state !== 'open') {
        continue;
      }
      const found: Blocker[] = [];
      for (const list of LISTS) {
        if (SUMMARY_OF[list](one) === 0) {
          continue;
        }
        const kept = await this.#cache.get(list, one.ref);
        found.push(...BLOCKING_OF[list](kept?.issues ?? []));
      }
      blockers.set(one.ref.key(), found);
    }
    return blockers;
  }

  /**
   * Sends the batches in order and stops at the first one the server could not
   * take: the batch that says it is complete goes last, and must never go after a
   * batch that did not land.
   */
  async #send(plan: ImportPlan): Promise<{
    items: number;
    batches: number;
    complete: boolean;
    incompleteBecause: string | null;
    refusedEdges: number;
    stoppedBecause: string | null;
  }> {
    let items = 0;
    let batches = 0;
    let refusedEdges = 0;
    let complete = false;
    for (const batch of plan.batches) {
      try {
        const answer = await this.#target.putItems(this.#batchOf(batch));
        items += batch.items.length;
        batches += 1;
        complete = batch.complete;
        refusedEdges += answer.refusedEdges.length;
        for (const edge of answer.refusedEdges) {
          this.#logger.warn('the server would not record an edge', { ...edge });
        }
        for (const hint of answer.droppedHints) {
          this.#logger.info('the server left an area hint out', { ...hint });
        }
      } catch (error) {
        const reason = `the work could not be reported: ${sentenceOf(error)}`;
        this.#logger.warn('an import batch was not taken', { reason, sent: batches, of: plan.batches.length });
        return { items, batches, complete: false, incompleteBecause: reason, refusedEdges, stoppedBecause: reason };
      }
    }
    return {
      items,
      batches,
      complete,
      incompleteBecause: plan.incompleteBecause,
      refusedEdges,
      stoppedBecause: null,
    };
  }

  #batchOf(batch: PlannedBatch): ImportBatch {
    return { source: this.#importer.source, complete: batch.complete, items: batch.items };
  }
}

/**
 * Whether a list is worth a request now: never asked; asked with a tag, which costs
 * nothing when it still holds; or asked without one and the issue changed since.
 */
function isDue(candidate: Candidate): boolean {
  const cached = candidate.cached;
  if (cached === null || cached.etag !== null) {
    return true;
  }
  return cached.issueUpdatedAt === null || cached.issueUpdatedAt.getTime() !== candidate.work.issue.updatedAt.getTime();
}

/** Oldest answer first; a list never asked for comes before every one that was. */
function fetchedAt(candidate: Candidate): number {
  return candidate.cached?.fetchedAt.getTime() ?? Number.NEGATIVE_INFINITY;
}

function sentenceOf(error: unknown): string {
  return error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
}
