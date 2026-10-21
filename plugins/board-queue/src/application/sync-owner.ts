import { ownerJobsOf } from '../domain/sync-config.ts';
import type { OwnerJob, SyncConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';
import { readSyncRefusal, writeSyncRefusal } from './sync-meta.ts';
import type { OwnerRefusal } from './sync-meta.ts';
import type { LocalIdentity } from './sync-ports.ts';

export type { OwnerRefusal } from './sync-meta.ts';

export type OwnerVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly refusal: OwnerRefusal };

export type SyncOwnerDeps = {
  identity: LocalIdentity;
  sync: SyncConfig;
  repository: ActionRepository;
  clock: Clock;
  logger: Logger;
};

/**
 * Whether this worker is the one that runs the jobs kept for the owner's worker:
 * the importer, the forge jobs, and a mirror of everybody's moves.
 *
 * Every person runs a worker, and one configuration is copied to every machine.
 * Two workers running those jobs would each keep a cursor of their own, file every
 * move twice and spend two allowances racing each other, so only the worker whose
 * login is the configured owner runs them. Any other worker is not refused
 * anything it was meant to do: it records why those jobs are not its own, says so
 * in its log only when that changes, and drains its own queue as usual. A login
 * that cannot be read at all is a fault, and is logged at every tick.
 */
export class SyncOwner {
  readonly #identity: LocalIdentity;
  readonly #sync: SyncConfig;
  readonly #repository: ActionRepository;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: SyncOwnerDeps) {
    this.#identity = deps.identity;
    this.#sync = deps.sync;
    this.#repository = deps.repository;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  async verdict(): Promise<OwnerVerdict> {
    const verdict = await this.#judge();
    const before = await readSyncRefusal(this.#repository);
    await writeSyncRefusal(
      this.#repository,
      verdict.ok ? null : { at: this.#clock.now().toISOString(), reason: verdict.reason, refusal: verdict.refusal },
    );
    if (verdict.ok) {
      return verdict;
    }
    if (verdict.refusal === 'identity-unreadable') {
      this.#logger.error('keeping in step with the coordination server was declined', { reason: verdict.reason });
    } else if (before?.reason !== verdict.reason) {
      this.#logger.info('the jobs kept for the owner\'s worker do not run on this one', { reason: verdict.reason });
    }
    return verdict;
  }

  /** Forgets why an earlier tick declined, when no job this worker runs waits for the owner's worker any more. */
  async notNeeded(): Promise<void> {
    if (await readSyncRefusal(this.#repository) !== null) {
      await writeSyncRefusal(this.#repository, null);
    }
  }

  async #judge(): Promise<OwnerVerdict> {
    let login: string | null;
    try {
      login = await this.#identity.login();
    } catch (error) {
      return {
        ok: false,
        reason: `this worker's GitHub login could not be read: ${describeUnknown(error)}`,
        refusal: 'identity-unreadable',
      };
    }
    const owner = this.#sync.mirrorOwner;
    if (login === null || login.trim() === '') {
      return {
        ok: false,
        reason: `this worker's GitHub login could not be read; only ${owner}'s worker keeps in step`,
        refusal: 'identity-unreadable',
      };
    }
    if (login.trim().toLowerCase() !== owner.toLowerCase()) {
      return {
        ok: false,
        reason: `this worker runs as ${login.trim()}, and only ${owner}'s worker runs ${ownerJobs(this.#sync)}`,
        refusal: 'not-the-owner',
      };
    }
    return { ok: true };
  }
}

const JOB_WORDS = {
  mirror: 'the claim mirror',
  importer: 'the importer',
  forge: 'the forge jobs',
} as const satisfies Record<OwnerJob, string>;

/** The jobs switched on that run only in the owner's worker, in words. */
function ownerJobs(sync: SyncConfig): string {
  const named = ownerJobsOf(sync).map((job) => JOB_WORDS[job]);
  const last = named.pop();
  if (last === undefined) {
    return 'the jobs that keep the boards in step';
  }
  return named.length === 0 ? last : `${named.join(', ')} and ${last}`;
}
