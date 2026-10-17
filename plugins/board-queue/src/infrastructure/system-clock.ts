import { setTimeout as delay } from 'node:timers/promises';
import type { Clock, Sleeper } from '../application/ports.ts';

/**
 * The machine's own clock.
 *
 * Everything that asks what time it is asks a clock rather than the language, so
 * a scenario about waiting a quarter of an hour runs in a millisecond and the one
 * place that reads the real time is this class.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Waiting by waiting. The worker paces its writes with this; a test substitutes a
 * sleeper that only writes down what it was asked for.
 */
export class RealSleeper implements Sleeper {
  sleep(ms: number): Promise<void> {
    return delay(ms);
  }
}
