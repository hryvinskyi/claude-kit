import { BoardQueueError } from '../domain/errors.ts';
import { finishedClaims } from '../domain/sync/finished-claims.ts';
import type { FinishConfig, SyncConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';
import { finishSightingsKey, readSightings, writeFinishRun, writeSightings } from './sync-meta.ts';
import type { FinishRun } from './sync-meta.ts';
import type { OwnClaims } from './sync-ports.ts';

/** What one run did, in the words a log line and a status report use. */
export type FinishReport = FinishRun;

export type FinishClaimsDeps = {
  claims: OwnClaims;
  repository: ActionRepository;
  sync: SyncConfig;
  finish: FinishConfig;
  clock: Clock;
  logger: Logger;
};

/**
 * Ends the claims of this worker's own person whose work the board calls
 * finished: the issue moved into one of the configured statuses while the claim
 * was held. A person who moves a ticket on to QA has finished the code, and the
 * areas the claim holds are what keeps everybody else out of those files.
 *
 * Each run reads the claims the member the token speaks for holds, compares the
 * status each issue shows with what the last run saw, completes the claims whose
 * issues moved into a finished status, and keeps what it saw for the next run.
 * The rule of what counts as finished is the domain's; this only reads, completes
 * and remembers.
 *
 * A claim that cannot be completed this run keeps the sighting it had, so the next
 * run tries it again; one its holder no longer held is counted and forgotten. A
 * token that speaks for an integration rather than a person ends nothing, and
 * says so.
 */
export class FinishClaims {
  readonly #claims: OwnClaims;
  readonly #repository: ActionRepository;
  readonly #finish: FinishConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #sightingsKey: string;

  constructor(deps: FinishClaimsDeps) {
    this.#claims = deps.claims;
    this.#repository = deps.repository;
    this.#finish = deps.finish;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#sightingsKey = finishSightingsKey(deps.sync.server, deps.sync.project);
  }

  async execute(): Promise<FinishReport> {
    const report: FinishReport = {
      at: this.#clock.now().toISOString(),
      holder: null,
      held: 0,
      completed: [],
      gone: 0,
      declined: null,
      error: null,
    };
    try {
      await this.#run(report);
    } catch (error) {
      report.error = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
      this.#logger.warn('finished claims were not ended', { reason: report.error });
    }
    await writeFinishRun(this.#repository, report);
    this.#logger.info('finished claims ended', { ...report });
    return report;
  }

  async #run(report: FinishReport): Promise<void> {
    const holder = await this.#claims.holder();
    if (holder === null) {
      report.declined = 'the coordination server\'s token speaks for an integration, not a person, '
        + 'so it holds no claims to end';
      return;
    }
    report.holder = holder;
    const held = await this.#claims.held(holder);
    report.held = held.length;
    const decision = finishedClaims(
      held,
      await readSightings(this.#repository, this.#sightingsKey),
      new Set(this.#finish.statuses),
    );
    const seen = new Map(decision.seen);
    try {
      for (const claim of decision.finished) {
        const named = claim.ref ?? String(claim.item);
        if (await this.#claims.complete(claim.item)) {
          report.completed.push(named);
          this.#logger.info('a claim whose work the board calls finished was completed', {
            item: named,
            status: claim.boardStatus,
          });
        } else {
          report.gone += 1;
        }
        seen.delete(claim.item);
      }
    } finally {
      await writeSightings(this.#repository, this.#sightingsKey, seen);
    }
  }
}
