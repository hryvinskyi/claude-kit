export type QueuePauseProps = {
  until: Date;
  reason: string;
  consecutiveHits: number;
};

/**
 * A stop sign on the whole queue, not on one action.
 *
 * A rate-limit refusal says nothing about the action that met it, so the action
 * goes back on the queue untouched and the queue itself waits. Two limiters ask
 * for two shapes of wait: the hourly allowance names the moment it comes back,
 * while the burst limiter names nothing, so the wait after it doubles per
 * consecutive hit up to a cap.
 */
export class QueuePause {
  readonly until: Date;
  readonly reason: string;
  readonly consecutiveHits: number;

  constructor(props: QueuePauseProps) {
    this.until = new Date(props.until.getTime());
    this.reason = props.reason;
    this.consecutiveHits = props.consecutiveHits;
  }

  isActive(now: Date): boolean {
    return now.getTime() < this.until.getTime();
  }

  remainingSec(now: Date): number {
    return Math.max(0, Math.ceil((this.until.getTime() - now.getTime()) / 1000));
  }

  describe(): string {
    return `paused until ${this.until.toISOString()}: ${this.reason}`;
  }

  /**
   * Until the hourly allowance comes back, plus a few seconds of slack so the
   * first call after the pause is not racing the reset itself.
   */
  static forPrimary(resetAt: Date, slackSec = 5): QueuePause {
    return new QueuePause({
      until: new Date(resetAt.getTime() + slackSec * 1000),
      reason: `the API allowance is exhausted; it resets at ${resetAt.toISOString()}`,
      consecutiveHits: 0,
    });
  }

  /**
   * The burst limiter's wait: `base × 2^hits` capped, or the waiting time the
   * API asked for when that is longer. `hits` is how many consecutive refusals
   * came before this one, so the first pause is the base.
   */
  static forSecondaryAfterHits(
    now: Date,
    retryAfterSec: number | null,
    hits: number,
    baseSec: number,
    capSec: number,
  ): QueuePause {
    const doubled = Math.min(baseSec * Math.pow(2, Math.max(0, hits)), capSec);
    const seconds = Math.max(doubled, retryAfterSec ?? 0);
    const asked = retryAfterSec === null ? '' : ` (asked for ${String(retryAfterSec)}s)`;
    return new QueuePause({
      until: new Date(now.getTime() + seconds * 1000),
      reason: `the burst limiter refused the last call; waiting ${String(seconds)}s${asked}`,
      consecutiveHits: hits + 1,
    });
  }

  /**
   * The same wait, counted from the pause that is being replaced. The hit count
   * is read from the previous pause only when the caller keeps one; a caller that
   * clears an expired pause before running must count the hits itself and use
   * `forSecondaryAfterHits`, or the doubling never happens.
   */
  static forSecondary(
    now: Date,
    retryAfterSec: number | null,
    previous: QueuePause | null,
    baseSec: number,
    capSec: number,
  ): QueuePause {
    return QueuePause.forSecondaryAfterHits(
      now,
      retryAfterSec,
      previous === null ? 0 : previous.consecutiveHits,
      baseSec,
      capSec,
    );
  }
}
