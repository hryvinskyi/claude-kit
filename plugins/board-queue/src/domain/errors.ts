/**
 * The failures this system knows how to talk about.
 *
 * Every error carries a machine-readable `category` and a one-line `describe()`
 * written for a person reading a queue listing: no stack, no token, no wire
 * payload. The worker decides an action's fate from the category alone, so the
 * set below is the contract between the gateways and the queue.
 */

export type ErrorCategory =
  | 'primary-rate-limited'
  | 'secondary-rate-limited'
  | 'option-not-found'
  | 'ambiguous-option'
  | 'issue-not-found'
  | 'readback-mismatch'
  | 'transient-failure'
  | 'credential-rejected'
  | 'refused-by-rule'
  | 'invalid-issue-ref'
  | 'illegal-transition'
  | 'unknown-kind'
  | 'stale-action';

export class BoardQueueError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.category = category;
    this.name = new.target.name;
  }

  /** One line for a human; never a stack, never a credential. */
  describe(): string {
    return this.message;
  }
}

/** The hourly allowance is spent: nothing may run until the reset. */
export class PrimaryRateLimited extends BoardQueueError {
  readonly resetAt: Date;

  constructor(resetAt: Date) {
    super('primary-rate-limited', `the allowance is exhausted until ${resetAt.toISOString()}`);
    this.resetAt = resetAt;
  }

  override describe(): string {
    return `the API allowance is exhausted; it resets at ${this.resetAt.toISOString()}`;
  }
}

/** The burst limiter refused a call while the hourly allowance still had room. */
export class SecondaryRateLimited extends BoardQueueError {
  readonly retryAfterSec: number | null;

  constructor(retryAfterSec: number | null) {
    super('secondary-rate-limited', 'the burst limiter refused the call');
    this.retryAfterSec = retryAfterSec;
  }

  override describe(): string {
    return this.retryAfterSec === null
      ? 'the burst limiter refused the call and named no waiting time'
      : `the burst limiter refused the call and asked for ${this.retryAfterSec}s`;
  }
}

/** A wanted option text matches nothing the board offers for that field. */
export class OptionNotFound extends BoardQueueError {
  readonly field: string;
  readonly wanted: string;
  readonly accepted: string[];

  constructor(field: string, wanted: string, accepted: readonly string[]) {
    super('option-not-found', `${field} has no option matching "${wanted}"`);
    this.field = field;
    this.wanted = wanted;
    this.accepted = [...accepted];
  }

  override describe(): string {
    return `${this.field} has no option matching "${this.wanted}"; it accepts: ${this.accepted.join(', ')}`;
  }
}

/** A wanted option text is a prefix of several options: guessing is not allowed. */
export class AmbiguousOption extends BoardQueueError {
  readonly field: string;
  readonly wanted: string;
  readonly accepted: string[];
  readonly matches: string[];

  constructor(field: string, wanted: string, accepted: readonly string[], matches: readonly string[]) {
    super('ambiguous-option', `${field} has several options matching "${wanted}"`);
    this.field = field;
    this.wanted = wanted;
    this.accepted = [...accepted];
    this.matches = [...matches];
  }

  override describe(): string {
    return `${this.field} matches "${this.wanted}" in several ways (${this.matches.join(', ')}); `
      + `it accepts: ${this.accepted.join(', ')}`;
  }
}

/** The issue named by an action does not exist (or the token cannot see it). */
export class IssueNotFound extends BoardQueueError {
  readonly ref: string;

  constructor(ref: string) {
    super('issue-not-found', `${ref} does not exist or is not visible`);
    this.ref = ref;
  }
}

/** A write landed but re-reading the row did not show the value that was written. */
export class ReadbackMismatch extends BoardQueueError {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;

  constructor(field: string, expected: string, actual: string) {
    super('readback-mismatch', `${field} reads "${actual}", expected "${expected}"`);
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }

  override describe(): string {
    return `${this.field} reads "${this.actual}" after the write, expected "${this.expected}"`;
  }
}

/** Something that may well work next time: a network error, a 5xx, malformed JSON. */
export class TransientFailure extends BoardQueueError {
  /** Narrows the standard error cause to the sentence this system is willing to show. */
  override readonly cause: string;

  constructor(cause: string) {
    super('transient-failure', cause);
    this.cause = cause;
  }

  override describe(): string {
    return `a retryable failure: ${this.cause}`;
  }
}

/**
 * The credential was refused, and minting a fresh one did not help either.
 *
 * It is kept apart from the retryable failures on purpose: nothing this system
 * writes will get in until somebody fixes the login, so the action that happened
 * to meet it goes back on the queue untouched and the queue itself waits. Spending
 * an action's attempts to prove the same point every few minutes would give up on
 * work that was never wrong.
 */
export class CredentialRejected extends BoardQueueError {
  readonly subject: string;
  /**
   * What was wrong with it, where the answer said more than "no". A credential
   * that is merely missing a permission looks exactly like one that is expired
   * until somebody reads the sentence, and the two are fixed in different places.
   */
  readonly detail: string | null;

  constructor(subject: string, detail: string | null = null) {
    super('credential-rejected', `${subject} was refused: ${detail ?? 'the credential was rejected'}`);
    this.subject = subject;
    this.detail = detail;
  }

  override describe(): string {
    const what = this.detail ?? 'the credential was rejected';
    return `${what}; nothing runs until a working one is available`;
  }
}

/** A request this system refuses on purpose; the text says why. */
export class RefusedByRule extends BoardQueueError {
  readonly text: string;

  constructor(text: string) {
    super('refused-by-rule', text);
    this.text = text;
  }
}

/** The text handed in does not name an issue. */
export class InvalidIssueRef extends BoardQueueError {
  readonly text: string;

  constructor(text: string) {
    super('invalid-issue-ref', `"${text}" is not an issue reference (owner/repo#number)`);
    this.text = text;
  }
}

/** A transition the aggregate does not allow from the state it is in. */
export class IllegalTransition extends BoardQueueError {
  readonly actionId: string;
  readonly from: string;
  readonly transition: string;

  constructor(actionId: string, from: string, transition: string) {
    super('illegal-transition', `an action in state "${from}" cannot ${transition}`);
    this.actionId = actionId;
    this.from = from;
    this.transition = transition;
  }

  override describe(): string {
    return `action ${this.actionId} is "${this.from}" and cannot ${this.transition}`;
  }
}

/** A kind name nobody registered: a caller typo, never a silent no-op. */
export class UnknownKind extends BoardQueueError {
  readonly wanted: string;
  readonly known: string[];

  constructor(wanted: string, known: readonly string[]) {
    super('unknown-kind', `there is no action kind "${wanted}"`);
    this.wanted = wanted;
    this.known = [...known];
  }

  override describe(): string {
    return `there is no action kind "${this.wanted}"; the known kinds are: ${this.known.join(', ')}`;
  }
}

/** A write lost a race: another writer changed the row since it was read. */
export class StaleAction extends BoardQueueError {
  readonly actionId: string;
  readonly expectedVersion: number;

  constructor(actionId: string, expectedVersion: number) {
    super('stale-action', `action ${actionId} changed since it was read at version ${expectedVersion}`);
    this.actionId = actionId;
    this.expectedVersion = expectedVersion;
  }

  override describe(): string {
    return `action ${this.actionId} was changed by another writer since version ${this.expectedVersion} was read; `
      + 'read it again before deciding anything';
  }
}
