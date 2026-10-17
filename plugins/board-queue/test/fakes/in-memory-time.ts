import type { Clock, Sleeper } from '../../src/application/ports.ts';

/** A clock a test moves by hand, so a scenario about waiting takes no time to run. */
export class FakeClock implements Clock {
  #moment: Date;

  constructor(moment: Date | string = '2026-01-01T09:00:00.000Z') {
    this.#moment = toDate(moment);
  }

  now(): Date {
    return new Date(this.#moment.getTime());
  }

  set(moment: Date | string): void {
    this.#moment = toDate(moment);
  }

  advance(ms: number): void {
    this.#moment = new Date(this.#moment.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60 * 1000);
  }

  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }
}

/** Records what it was asked to wait for and moves the clock instead of waiting. */
export class FakeSleeper implements Sleeper {
  readonly slept: number[] = [];
  readonly #clock: FakeClock | null;

  constructor(clock: FakeClock | null = null) {
    this.#clock = clock;
  }

  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.#clock?.advance(ms);
    return Promise.resolve();
  }

  get totalMs(): number {
    return this.slept.reduce((sum, ms) => sum + ms, 0);
  }
}

function toDate(moment: Date | string): Date {
  return typeof moment === 'string' ? new Date(moment) : new Date(moment.getTime());
}
