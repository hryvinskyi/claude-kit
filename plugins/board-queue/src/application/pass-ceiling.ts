/**
 * How long one pass may go on taking work, counted from the moment it started.
 *
 * Every call a pass makes has a deadline of its own, but a pass makes many, and
 * it holds the tick lock while it does: the scheduled passes behind it find the
 * lock taken and skip. Past its ceiling a pass claims no action after the
 * drain's first, and starts no further job, and ends the way it would have ended
 * anyway, which is what hands the lock on.
 *
 * The second half of the pass belongs to the queue: work somebody filed must not
 * wait forever behind the job that ends finished claims, which runs before the
 * drain, so that job starts only while half the ceiling is still to come. The
 * mirror, which runs first, is not held to the half.
 */
export class PassCeiling {
  readonly #endsAt: number;
  readonly #halfwayAt: number;
  readonly #limitMs: number;

  /** A pass that started at `startedAt` and may take work for `limitMs`; an infinite limit never ends it. */
  constructor(startedAt: Date, limitMs: number) {
    this.#limitMs = limitMs;
    this.#endsAt = startedAt.getTime() + limitMs;
    this.#halfwayAt = startedAt.getTime() + limitMs / 2;
  }

  /** Whether half the pass is gone, so the job that ends finished claims starts no more. */
  halfGone(now: Date): boolean {
    return now.getTime() >= this.#halfwayAt;
  }

  /** Why a job before the drain did not start, in the words a report uses. */
  halfGoneReason(): string {
    return `half of the pass's ceiling of ${this.#seconds()} s is gone; the rest is the queue's, `
      + 'so this job waits for the next pass';
  }

  /** Whether the pass has had its time, so takes no more work. */
  reached(now: Date): boolean {
    return now.getTime() >= this.#endsAt;
  }

  /** Why the pass took no more work, in the words a report uses. */
  reason(): string {
    return `the pass reached its ceiling of ${this.#seconds()} s, `
      + 'so it took no more work and ended; the next pass carries on';
  }

  #seconds(): string {
    return String(Math.round(this.#limitMs / 1000));
  }
}
