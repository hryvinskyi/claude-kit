import { describeUnknown } from './drain-queue.ts';
import type { Clock } from './ports.ts';
import { firstBeat, passEnded, passStarted, stopped } from './service-beat.ts';
import type { PassOutcome, ServiceBeat } from './service-beat.ts';

/** One pass of the worker, given up on when the signal aborts. */
export interface PassRunner {
  run(abandon: AbortSignal): Promise<PassOutcome>;
}

/** Where the service keeps its heartbeat. */
export interface BeatStore {
  write(beat: ServiceBeat): void;
}

/** Waiting that ends early, without failing, the moment the signal aborts. */
export interface Waiter {
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

/** One line for whoever reads the service's output. */
export interface ServiceLog {
  line(text: string): void;
}

export type ServiceSchedule = {
  /** From the start of one pass to the start of the next. */
  intervalMs: number;
  /** The longest a pass may run before it is given up on. */
  passDeadlineMs: number;
  /** How long a running pass may go on once the service is told to stop. */
  shutdownGraceMs: number;
};

/**
 * How the schedule ended: told to stop, or because a pass could not be ended at
 * all, which leaves a process this one cannot clear and must be restarted from
 * outside.
 */
export type ServiceEnd = { beat: ServiceBeat; mustRestart: boolean };

export type ServiceLoopDeps = {
  pass: PassRunner;
  beats: BeatStore;
  waiter: Waiter;
  clock: Clock;
  log: ServiceLog;
  schedule: ServiceSchedule;
  pid: number;
};

/**
 * The worker's schedule when it runs as a service rather than from a person's
 * scheduler: a pass at start, then one every interval, timed from the start of
 * the last, and never two at once — a pass that runs past its slot delays the
 * next one rather than overlapping it.
 *
 * Telling it to stop ends the wait at once. A pass that is running is given the
 * shutdown grace to finish and is then abandoned; so is a pass that outlives its
 * deadline. A pass that is killed and still does not end stops the schedule, so
 * whatever runs the service starts it afresh. Nothing a pass leaves half done is
 * lost by abandoning it: the queue
 * writes each action, cursor and report in the transaction that records it, and
 * the next pass puts back whatever a killed one held.
 */
export class ServiceLoop {
  readonly #deps: ServiceLoopDeps;

  constructor(deps: ServiceLoopDeps) {
    this.#deps = deps;
  }

  /** Runs until the signal aborts or a pass cannot be ended, and answers how it ended. */
  async run(stop: AbortSignal): Promise<ServiceEnd> {
    const { clock, schedule, beats, log, waiter } = this.#deps;
    let beat = firstBeat({
      pid: this.#deps.pid,
      at: clock.now(),
      intervalMs: schedule.intervalMs,
      passDeadlineMs: schedule.passDeadlineMs,
    });
    beats.write(beat);
    let mustRestart = false;
    while (!stop.aborted) {
      const startedAt = clock.now();
      beat = passStarted(beat, startedAt);
      beats.write(beat);
      const outcome = await this.#onePass(stop);
      const endedAt = clock.now();
      beat = passEnded(beat, outcome, endedAt, stop.aborted);
      beats.write(beat);
      log.line(`pass ${String(beat.passes)} ended ${beat.outcome ?? ''} after ${seconds(endedAt, startedAt)}`
        + (beat.detail === null ? '' : `: ${beat.detail}`));
      if (outcome.kind === 'stuck') {
        mustRestart = true;
        break;
      }
      if (stop.aborted) {
        break;
      }
      const untilNext = startedAt.getTime() + schedule.intervalMs - clock.now().getTime();
      await waiter.wait(Math.max(0, untilNext), stop);
    }
    beat = stopped(beat, clock.now());
    beats.write(beat);
    log.line(mustRestart ? 'stopped: a pass could not be ended, so this service must be started afresh' : 'stopped');
    return { beat, mustRestart };
  }

  /**
   * One pass, abandoned at its deadline, or once the service has been told to
   * stop and the grace has run out — whichever comes first.
   */
  async #onePass(stop: AbortSignal): Promise<PassOutcome> {
    const { pass, waiter, schedule } = this.#deps;
    const abandon = new AbortController();
    const done = new AbortController();
    const giveUp = (reason: string): void => {
      if (!done.signal.aborted) {
        abandon.abort(reason);
      }
    };
    const deadline = waiter.wait(schedule.passDeadlineMs, done.signal).then(() => {
      giveUp(`it ran past its deadline of ${String(Math.round(schedule.passDeadlineMs / 1000))} s`);
    });
    let grace: Promise<void> = Promise.resolve();
    const onStop = (): void => {
      grace = waiter.wait(schedule.shutdownGraceMs, done.signal).then(() => {
        giveUp('the service was told to stop and the pass did not finish in time');
      });
    };
    if (stop.aborted) {
      onStop();
    } else {
      stop.addEventListener('abort', onStop, { once: true });
    }
    try {
      return await pass.run(abandon.signal);
    } catch (error) {
      // A pass that could not even report how it ended is recorded as such; the
      // schedule goes on, because the next pass may well start.
      return { kind: 'unstarted', reason: describeUnknown(error) };
    } finally {
      done.abort();
      stop.removeEventListener('abort', onStop);
      await Promise.all([deadline, grace]);
    }
  }
}

function seconds(later: Date, earlier: Date): string {
  return `${((later.getTime() - earlier.getTime()) / 1000).toFixed(1)} s`;
}
