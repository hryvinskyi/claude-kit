import { BoardQueueError, NoAnswer } from '../domain/errors.ts';
import type { ForgeConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ForgeAllowance } from './forge-ports.ts';
import type { LimiterWait } from './limiter-wait.ts';
import type { Clock, Logger, Sleeper } from './ports.ts';

/** GitHub not answering this many requests of one job in a row is GitHub not answering that repository. */
const UNANSWERED_IN_A_ROW = 3;

const MINUTE_MS = 60 * 1000;

/**
 * Thrown to end part of a pass where it stands. Every job lets it through; what
 * it ends is said by its kind, and its reason was recorded before it was thrown.
 */
export class ForgeStop extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = new.target.name;
    this.reason = reason;
  }
}

/** The whole pass ends: a limiter refused, the server did not answer, the pass ran out of time or allowance. */
export class ForgePassStopped extends ForgeStop {}

/** The jobs of one repository end; the pass goes on with the next repository. */
export class ForgeRepositoryStopped extends ForgeStop {}

export type ForgeCallsDeps = {
  allowance: ForgeAllowance;
  wait: LimiterWait;
  settings: ForgeConfig;
  clock: Clock;
  sleeper: Sleeper;
  logger: Logger;
};

/**
 * Every request one forge pass makes, one at a time.
 *
 * Requests to GitHub are paced, and asked only while the pass is inside its time
 * and the allowance above its reserve. A refusal from a limiter, or a credential
 * GitHub will not take, puts the queue to sleep as any refusal does and ends the
 * pass. GitHub not answering — a network failure, a timeout, a 5xx — three
 * requests of one job in a row ends that repository's jobs, and the pass goes on
 * with the next repository. Any other failure is an answer about one thing, a 4xx
 * or an answer of the wrong shape, and is the caller's to record before it goes
 * on.
 *
 * Requests to the coordination server are not paced — it is the deployment's own
 * service. The server not answering ends the pass: what was not kept is sent
 * again by the next one, and nothing is sent past an answer that did not come. A
 * refusal of one report is the caller's to record.
 */
export class ForgeCalls {
  readonly #allowance: ForgeAllowance;
  readonly #wait: LimiterWait;
  readonly #settings: ForgeConfig;
  readonly #clock: Clock;
  readonly #sleeper: Sleeper;
  readonly #logger: Logger;
  readonly #startedAt: Date;
  #requests = 0;
  #notModified = 0;
  #unansweredInARow = 0;
  #stoppedBecause: string | null = null;

  constructor(deps: ForgeCallsDeps) {
    this.#allowance = deps.allowance;
    this.#wait = deps.wait;
    this.#settings = deps.settings;
    this.#clock = deps.clock;
    this.#sleeper = deps.sleeper;
    this.#logger = deps.logger;
    this.#startedAt = deps.clock.now();
  }

  get requests(): number {
    return this.#requests;
  }

  get notModified(): number {
    return this.#notModified;
  }

  get stoppedBecause(): string | null {
    return this.#stoppedBecause;
  }

  /** When the pass started, by this machine's clock. */
  get startedAt(): Date {
    return new Date(this.#startedAt.getTime());
  }

  /** A job of a repository starts: requests GitHub did not answer are counted afresh. */
  enter(): void {
    this.#unansweredInARow = 0;
  }

  /** Counts an answer that said "unchanged", which costs nothing against the hourly allowance. */
  unchanged(): void {
    this.#notModified += 1;
  }

  /** One request to GitHub about `repo`, paced and guarded; `what` names it in the log. */
  async github<T>(repo: string, what: string, call: () => Promise<T>): Promise<T> {
    this.#refuseOnceStopped();
    if (this.#requests > 0) {
      await this.#sleeper.sleep(this.#settings.paceMs);
    }
    // Asked at the moment the request would go out, after the wait.
    if (this.#clock.now().getTime() - this.#startedAt.getTime() >= this.#settings.maxPassMinutes * MINUTE_MS) {
      this.#stopPass(`the pass ran for ${String(this.#settings.maxPassMinutes)} minutes, as long as one pass may`);
    }
    const remaining = this.#allowance.remaining(repo);
    if (remaining !== null && remaining < this.#settings.minRemaining) {
      this.#stopPass(`the REST allowance is ${String(remaining)}, below the reserve of ${String(this.#settings.minRemaining)}`);
    }
    this.#requests += 1;
    try {
      const answer = await call();
      this.#unansweredInARow = 0;
      return answer;
    } catch (error) {
      const pause = await this.#wait.after(error, this.#clock.now());
      if (pause !== null) {
        this.#stopPass(pause.reason);
      }
      if (!(error instanceof NoAnswer)) {
        // GitHub answered, if only to refuse this one request.
        this.#unansweredInARow = 0;
        throw error;
      }
      this.#unansweredInARow += 1;
      if (this.#unansweredInARow >= UNANSWERED_IN_A_ROW) {
        const reason = `GitHub did not answer ${String(UNANSWERED_IN_A_ROW)} requests in a row, the last ${what}: `
          + sentenceOf(error);
        this.#logger.warn('the forge jobs of a repository stopped', { repo, reason });
        throw new ForgeRepositoryStopped(reason);
      }
      throw error;
    }
  }

  /**
   * One call to the coordination server. Not answering ends the pass; a refusal is
   * thrown for the caller to record, except for a read the pass cannot do without.
   */
  async coordination<T>(what: string, call: () => Promise<T>, essential = false): Promise<T> {
    this.#refuseOnceStopped();
    try {
      return await call();
    } catch (error) {
      if (essential || error instanceof NoAnswer) {
        this.#stopPass(`the coordination server did not answer ${what}: ${sentenceOf(error)}`);
      }
      throw error;
    }
  }

  #refuseOnceStopped(): void {
    if (this.#stoppedBecause !== null) {
      throw new ForgePassStopped(this.#stoppedBecause);
    }
  }

  #stopPass(reason: string): never {
    this.#stoppedBecause = reason;
    this.#logger.warn('the forge pass stopped', { reason });
    throw new ForgePassStopped(reason);
  }
}

/** A failure as a sentence a log line or a status report can hold. */
export function sentenceOf(error: unknown): string {
  return error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
}
