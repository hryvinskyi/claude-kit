import type { z } from 'zod';
import { Action } from '../domain/action.ts';
import type { ActionState } from '../domain/action.ts';
import type { BoardDirectory } from '../domain/board-directory.ts';
import { RefusedByRule } from '../domain/errors.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { ActionKind } from '../domain/kinds/action-kind.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import { catalogWarnings } from './catalog-warnings.ts';
import { isRecord } from './json-values.ts';
import type { ActionRepository, Clock } from './ports.ts';

export type EnqueueRequest = {
  kind: string;
  payload: unknown;
  /** Who asked, in words a person reading the queue will recognise. */
  origin: string;
  /** The work waits on something outside this system until somebody releases it. */
  hold?: boolean;
  /** The work waits until this moment. */
  notBefore?: Date | null;
};

export type EnqueueOutcome = {
  id: string;
  /** Set when the request was folded into an action that was already waiting. */
  coalescedInto?: string;
  /**
   * Where the request ended up: waiting for the next tick, or held until somebody
   * releases it. It is answered here rather than worked out by the caller, so a
   * held request cannot be read as one that is about to run.
   */
  state: ActionState;
  /** What the board, as it was last read, says about the values that were asked for. */
  warnings: string[];
};

/**
 * How often a request tries to fold itself into a waiting action before giving up
 * and becoming one of its own. Every attempt means another enqueuer got there
 * first, which is a race between two sessions filing at the same moment: it
 * happens, and it does not happen three times in a row. Filing a separate action
 * is a correct outcome, not a failure — it costs one more pass over the board.
 */
const FOLD_ATTEMPTS = 3;

/**
 * The furthest ahead a request may be pushed. A moment beyond this is almost
 * always a typo in a date, and there is nothing to notice it: the action sits in
 * the queue, out of every listing that reads as work in hand, until a year from
 * now somebody wonders what happened to it.
 */
const FURTHEST_AHEAD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EnqueueActionDeps = {
  repository: ActionRepository;
  kinds: KindRegistry;
  /** Which repositories may be filed against, and which board carries each. */
  directory: BoardDirectory;
  clock: Clock;
};

/**
 * Filing a piece of outward work. This is the only way anything enters the queue.
 *
 * Nothing here talks to the board: a request is checked against the rules, given
 * the repository's configured spelling, and either folded into a request that is
 * still waiting or written down as its own action. The worker is what meets the
 * API, minutes later and on its own schedule.
 */
export class EnqueueAction {
  readonly #repository: ActionRepository;
  readonly #kinds: KindRegistry;
  readonly #directory: BoardDirectory;
  readonly #clock: Clock;

  constructor(deps: EnqueueActionDeps) {
    this.#repository = deps.repository;
    this.#kinds = deps.kinds;
    this.#directory = deps.directory;
    this.#clock = deps.clock;
  }

  async execute(request: EnqueueRequest): Promise<EnqueueOutcome> {
    const now = this.#clock.now();
    const notBefore = this.#checkedDelay(request.notBefore ?? null, now);
    const kind = this.#kinds.get(request.kind);
    const validated = validate(kind, request.payload);
    const named = kind.issueRefOf(validated);
    const ref = named === null ? null : this.#directory.canonical(named);
    const payload = ref === null ? validated : withRepo(validated, ref.repoFullName());
    const warnings = ref === null ? [] : await this.#warnings(payload, ref);

    const waits = request.hold === true || notBefore !== null;
    if (!waits && ref !== null) {
      // A request that waits on something is never folded into one that does not:
      // the merged values would run at the next tick, and nothing would say so.
      const folded = await this.#foldIntoWaiting(kind, ref, payload, now);
      if (folded !== null) {
        return { id: folded.id, coalescedInto: folded.id, state: folded.state, warnings };
      }
    }

    const action = Action.enqueue({
      id: globalThis.crypto.randomUUID(),
      kind: kind.name,
      payload,
      issueRef: ref,
      origin: request.origin,
      now,
      hold: request.hold === true,
      notBefore,
    });
    await this.#repository.insert(action);
    return { id: action.id, state: action.state, warnings };
  }

  /**
   * The waiting action this request became part of, or nothing.
   *
   * The merge is written as one conditional statement in the store, so a worker
   * claiming that very action in between is answered with "no row changed" and
   * this request becomes an action of its own. Reading the action and writing it
   * back whole would lose the merged values without a word.
   */
  async #foldIntoWaiting(
    kind: ActionKind,
    ref: IssueRef,
    payload: unknown,
    now: Date,
  ): Promise<Action | null> {
    for (let attempt = 0; attempt < FOLD_ATTEMPTS; attempt += 1) {
      const waiting = await this.#repository.findCoalescible(kind.name, ref, now);
      if (waiting === null) {
        return null;
      }
      const merged: unknown = kind.coalesce(waiting.payload, payload);
      if (merged === null || merged === undefined) {
        return null;
      }
      if (await this.#repository.coalesceInto(waiting.id, merged, now, waiting.persistedVersion)) {
        return waiting;
      }
      // The row changed between reading it and writing it: somebody else's values
      // are in it now, and merging on top of what this request read would drop
      // them. The whole merge is worked out again from the row as it stands.
    }
    return null;
  }

  /**
   * The moment this request may first run, refusing one so far off that nothing
   * would ever notice it again.
   */
  #checkedDelay(notBefore: Date | null, now: Date): Date | null {
    if (notBefore === null) {
      return null;
    }
    const furthest = now.getTime() + FURTHEST_AHEAD_DAYS * DAY_MS;
    if (notBefore.getTime() > furthest) {
      throw new RefusedByRule(
        `${notBefore.toISOString()} is more than ${String(FURTHEST_AHEAD_DAYS)} days away; `
        + 'work held back that long is work nobody will see again. File it nearer the time, '
        + 'or file it held and release it when the moment comes.',
      );
    }
    return notBefore;
  }

  /** Measured against the catalog of the board that carries the issue, as that board was last read. */
  async #warnings(payload: unknown, ref: IssueRef): Promise<string[]> {
    const cached = await this.#repository.getCatalog(this.#directory.placementOf(ref).key);
    return cached === null ? [] : catalogWarnings(payload, cached.catalog);
  }
}

/**
 * The payload as the kind defines it, or a refusal a person can act on.
 *
 * A kind's schema carries the rules as well as the shape — the status this system
 * will not write, a field the board does not manage — so a refusal arrives here as
 * an issue on a path and goes back out as the sentence the rule stated.
 */
function validate(kind: ActionKind, payload: unknown): unknown {
  const result = kind.payloadSchema.safeParse(payload);
  if (result.success) {
    const validated: unknown = result.data;
    return validated;
  }
  throw new RefusedByRule(describe(kind.name, result.error));
}

function describe(kindName: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const where = issue.path.join('.');
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
  return `${kindName} cannot take this request — ${issues.join('; ')}`;
}

/** The repository as the configuration spells it, which is the spelling that is stored. */
function withRepo(payload: unknown, repo: string): unknown {
  if (!isRecord(payload) || !('repo' in payload)) {
    return payload;
  }
  return { ...payload, repo };
}
