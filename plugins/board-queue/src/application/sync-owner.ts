import type { SyncConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';
import { writeSyncRefusal } from './sync-meta.ts';
import type { LocalIdentity } from './sync-ports.ts';

export type OwnerVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SyncOwnerDeps = {
  identity: LocalIdentity;
  sync: SyncConfig;
  repository: ActionRepository;
  clock: Clock;
  logger: Logger;
};

/**
 * Whether this worker is the one that keeps the boards in step.
 *
 * Every person runs a worker, and a configuration is easily copied from one
 * machine to the next. Two workers keeping in step would each keep a cursor of
 * their own, file every move twice and spend two allowances racing each other, so
 * only the worker whose login is the configured owner runs either direction. Any
 * other worker says why it declined, at every tick, and drains its own queue as
 * usual; a login that cannot be read at all is a refusal too.
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
    await writeSyncRefusal(
      this.#repository,
      verdict.ok ? null : { at: this.#clock.now().toISOString(), reason: verdict.reason },
    );
    if (!verdict.ok) {
      this.#logger.error('keeping in step with the coordination server was declined', { reason: verdict.reason });
    }
    return verdict;
  }

  async #judge(): Promise<OwnerVerdict> {
    let login: string | null;
    try {
      login = await this.#identity.login();
    } catch (error) {
      return { ok: false, reason: `this worker's GitHub login could not be read: ${describeUnknown(error)}` };
    }
    const owner = this.#sync.mirrorOwner;
    if (login === null || login.trim() === '') {
      return {
        ok: false,
        reason: `this worker's GitHub login could not be read; only ${owner}'s worker keeps in step`,
      };
    }
    if (login.trim().toLowerCase() !== owner.toLowerCase()) {
      return {
        ok: false,
        reason: `this worker runs as ${login.trim()}, and only ${owner}'s worker keeps the boards in step — `
          + 'turn the mirror and the importer off in this configuration',
      };
    }
    return { ok: true };
  }
}
