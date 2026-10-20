import type { BoardQueueError } from './errors.ts';
import { IllegalTransition } from './errors.ts';
import type { IssueRef } from './issue-ref.ts';

export type ActionState =
  | 'queued'
  | 'held'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled';

export type ActionProps = {
  id: string;
  kind: string;
  payload: unknown;
  issueRef: IssueRef | null;
  state: ActionState;
  attempts: number;
  notBefore: Date | null;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  result: string | null;
  version: number;
  blockedReason: string | null;
  /**
   * What makes this action the one copy of a piece of work, when its filer says
   * so: a second action carrying the same key is never written.
   */
  dedupeKey: string | null;
};

export type EnqueueInput = {
  id: string;
  kind: string;
  payload: unknown;
  issueRef: IssueRef | null;
  origin: string;
  now: Date;
  hold?: boolean;
  notBefore?: Date | null;
  dedupeKey?: string | null;
};

/**
 * One unit of outward work, and the only thing that decides what may happen to it.
 *
 * Two processes write this table — the worker and every editor session — so an
 * action carries a version: a transition raises it, and a store that finds a
 * different version refuses the write instead of overwriting somebody else's
 * decision. `persistedVersion` is the value to guard a write with; `version` is
 * the value that write stores.
 *
 * Every transition below states which states it comes from and refuses the rest,
 * so a state machine mistake is loud rather than a row that quietly reads "done".
 */
export class Action {
  readonly id: string;
  readonly kind: string;
  readonly issueRef: IssueRef | null;
  readonly origin: string;
  readonly createdAt: Date;
  readonly dedupeKey: string | null;

  #payload: unknown;
  #state: ActionState;
  #attempts: number;
  #notBefore: Date | null;
  #updatedAt: Date;
  #lastError: string | null;
  #result: string | null;
  #version: number;
  #persistedVersion: number;
  #blockedReason: string | null;

  constructor(props: ActionProps) {
    this.id = props.id;
    this.kind = props.kind;
    this.issueRef = props.issueRef;
    this.origin = props.origin;
    this.createdAt = props.createdAt;
    this.dedupeKey = props.dedupeKey;
    this.#payload = props.payload;
    this.#state = props.state;
    this.#attempts = props.attempts;
    this.#notBefore = props.notBefore;
    this.#updatedAt = props.updatedAt;
    this.#lastError = props.lastError;
    this.#result = props.result;
    this.#version = props.version;
    this.#persistedVersion = props.version;
    this.#blockedReason = props.blockedReason;
  }

  /**
   * A new action. It starts held when the caller says the work waits on something
   * outside this system (a deploy, say) — a held action runs only once somebody
   * releases it.
   */
  static enqueue(input: EnqueueInput): Action {
    return new Action({
      id: input.id,
      kind: input.kind,
      payload: input.payload,
      issueRef: input.issueRef,
      state: input.hold === true ? 'held' : 'queued',
      attempts: 0,
      notBefore: input.notBefore ?? null,
      origin: input.origin,
      createdAt: input.now,
      updatedAt: input.now,
      lastError: null,
      result: null,
      version: 1,
      blockedReason: null,
      dedupeKey: input.dedupeKey ?? null,
    });
  }

  get payload(): unknown {
    return this.#payload;
  }

  get state(): ActionState {
    return this.#state;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get notBefore(): Date | null {
    return this.#notBefore;
  }

  get updatedAt(): Date {
    return this.#updatedAt;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get result(): string | null {
    return this.#result;
  }

  get version(): number {
    return this.#version;
  }

  /** The version a store must find to accept this aggregate's next write. */
  get persistedVersion(): number {
    return this.#persistedVersion;
  }

  /**
   * Why this action is blocked, as a category rather than a sentence, so a later
   * pass can gather every action blocked for the same cause without reading prose.
   */
  get blockedReason(): string | null {
    return this.#blockedReason;
  }

  /** Called by a store once its write landed; the guard moves up to the stored version. */
  markPersisted(): void {
    this.#persistedVersion = this.#version;
  }

  props(): ActionProps {
    return {
      id: this.id,
      kind: this.kind,
      payload: this.#payload,
      issueRef: this.issueRef,
      state: this.#state,
      attempts: this.#attempts,
      notBefore: this.#notBefore,
      origin: this.origin,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      lastError: this.#lastError,
      result: this.#result,
      version: this.#version,
      blockedReason: this.#blockedReason,
      dedupeKey: this.dedupeKey,
    };
  }

  /** Queued, and its waiting time (if any) has passed. */
  isRunnable(now: Date): boolean {
    return this.#state === 'queued'
      && (this.#notBefore === null || this.#notBefore.getTime() <= now.getTime());
  }

  /**
   * A later request may fold into this one only while it is still waiting to run:
   * once a worker has claimed it, the merged values would never reach the board.
   * A held or delayed action is deliberately not a candidate — folding a request
   * into it would make it run at a moment nobody asked for.
   */
  isCoalescible(now: Date): boolean {
    return this.isRunnable(now);
  }

  /** Taken by a worker. The attempt is counted here, before the outward call. */
  start(now: Date): void {
    this.#require(['queued'], 'start');
    this.#state = 'running';
    this.#attempts += 1;
    this.#touch(now);
  }

  succeed(now: Date, result: string): void {
    this.#require(['running'], 'succeed');
    this.#state = 'done';
    this.#result = append(this.#result, result);
    this.#blockedReason = null;
    this.#touch(now);
  }

  /**
   * A failure that may pass: the action waits exactly as long as the caller says
   * (the retry curve lives in one place, and it is not here) and is given up on
   * once it has used its attempts.
   */
  failTransient(now: Date, error: string, maxAttempts: number, backoffSec: number): void {
    this.#require(['running'], 'fail');
    this.#lastError = error;
    if (this.#attempts >= maxAttempts) {
      this.#state = 'failed';
      this.#notBefore = null;
    } else {
      this.#state = 'queued';
      this.#notBefore = new Date(now.getTime() + backoffSec * 1000);
    }
    this.#touch(now);
  }

  /** A failure a retry will not fix. It waits for a person, and keeps the reason. */
  block(now: Date, error: BoardQueueError): void {
    this.#require(['running'], 'block');
    this.#state = 'blocked';
    this.#lastError = error.describe();
    this.#blockedReason = error.category;
    this.#touch(now);
  }

  /**
   * The work no longer applies: what it was conditional on did not hold when it
   * ran. It is an ending, not a failure, so nothing retries it and nobody is asked
   * to fix anything; the reason is kept as its result.
   */
  skip(now: Date, reason: string): void {
    this.#require(['running'], 'be skipped');
    this.#state = 'skipped';
    this.#result = append(this.#result, reason);
    this.#blockedReason = null;
    this.#touch(now);
  }

  /** The thing it was waiting for happened. */
  release(now: Date): void {
    this.#require(['held'], 'be released');
    this.#state = 'queued';
    this.#touch(now);
  }

  /**
   * The way back from a dead end: the cause was fixed outside this system (an
   * option added to the board, a repository that came back), so the action gets
   * its attempts back. The error it failed with is kept — it is the record of
   * what was fixed.
   */
  retry(now: Date): void {
    this.#require(['blocked', 'failed'], 'be retried');
    this.#state = 'queued';
    this.#attempts = 0;
    this.#notBefore = null;
    this.#blockedReason = null;
    this.#touch(now);
  }

  cancel(now: Date): void {
    this.#require(['queued', 'held', 'blocked', 'failed'], 'be cancelled');
    this.#state = 'cancelled';
    this.#blockedReason = null;
    this.#touch(now);
  }

  /**
   * Put back untouched. Used when something other than this action stopped it —
   * a rate limit belongs to the queue, not to the work — so the attempt the claim
   * counted is given back. Without that, a busy afternoon of refusals would spend
   * an action's whole allowance of tries on failures it had no part in, and the
   * first real one would be its last.
   */
  requeue(now: Date): void {
    this.#require(['running'], 'be requeued');
    this.#state = 'queued';
    this.#attempts = Math.max(0, this.#attempts - 1);
    this.#touch(now);
  }

  /**
   * Records a part of the work that has already landed, so a later failure does
   * not lose it and a retry can see what not to do twice.
   */
  note(now: Date, text: string): void {
    this.#require(['running'], 'take a note');
    this.#result = append(this.#result, text);
    this.#touch(now);
  }

  #require(allowed: readonly ActionState[], transition: string): void {
    if (!allowed.includes(this.#state)) {
      throw new IllegalTransition(this.id, this.#state, transition);
    }
  }

  #touch(now: Date): void {
    this.#updatedAt = now;
    this.#version += 1;
  }
}

function append(existing: string | null, text: string): string {
  return existing === null || existing === '' ? text : `${existing}\n${text}`;
}
