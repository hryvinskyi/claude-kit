/** GitHub bills GraphQL and REST against separate allowances. */
export type RateResource = 'graphql' | 'core';

export type RateBudgetProps = {
  resource: RateResource;
  remaining: number;
  limit: number;
  used: number;
  resetAt: Date;
};

/**
 * What the last response said about the allowance.
 *
 * The response headers are the only honest source — the dedicated rate-limit
 * endpoint was measured answering stale numbers — so every call refreshes this
 * and the worker decides from it whether another action may start.
 */
export class RateBudget {
  readonly resource: RateResource;
  readonly remaining: number;
  readonly limit: number;
  readonly used: number;
  readonly resetAt: Date;

  constructor(props: RateBudgetProps) {
    this.resource = props.resource;
    this.remaining = props.remaining;
    this.limit = props.limit;
    this.used = props.used;
    this.resetAt = new Date(props.resetAt.getTime());
  }

  isExhausted(): boolean {
    return this.remaining <= 0;
  }

  belowFloor(floor: number): boolean {
    return this.remaining < floor;
  }

  describe(): string {
    return `${this.resource} ${String(this.remaining)}/${String(this.limit)} until ${this.resetAt.toISOString()}`;
  }

  /**
   * Reads the rate-limit headers through a getter rather than a response object,
   * so this stays a value object and names no transport type.
   *
   * Answers null when the headers do not carry a usable allowance — a missing
   * remaining count, or a missing reset time, means "unknown", and an unknown
   * budget stops the worker rather than licensing it.
   */
  static fromHeaders(get: (name: string) => string | null): RateBudget | null {
    const remaining = numeric(get('x-ratelimit-remaining'));
    const resetSeconds = numeric(get('x-ratelimit-reset'));
    if (remaining === null || resetSeconds === null) {
      return null;
    }
    const limit = numeric(get('x-ratelimit-limit')) ?? remaining;
    const used = numeric(get('x-ratelimit-used')) ?? Math.max(0, limit - remaining);
    const label = (get('x-ratelimit-resource') ?? '').trim().toLowerCase();
    return new RateBudget({
      resource: label === 'graphql' ? 'graphql' : 'core',
      remaining,
      limit,
      used,
      // The reset header counts seconds since the epoch, not milliseconds.
      resetAt: new Date(resetSeconds * 1000),
    });
  }
}

function numeric(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
