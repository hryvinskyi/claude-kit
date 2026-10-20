import { needsWriting, withdrawalOf } from '../domain/forge/commit-status.ts';
import type { CommitStatus } from '../domain/forge/commit-status.ts';
import { pullRefOf } from '../domain/forge/pull-requests.ts';
import type { ForgeConfig } from '../domain/sync-config.ts';
import { ForgeStop, sentenceOf } from './forge-calls.ts';
import type { ForgeJob, ForgePassState } from './forge-pass-state.ts';
import type { CommitStatuses, ForgeCoordination, KeptPull, PullLedger, StatusLedger, WantedStatus } from './forge-ports.ts';
import type { Clock, Logger } from './ports.ts';
import type { ForgeRepositoryRun } from './sync-meta.ts';

const HOUR_MS = 60 * 60 * 1000;

export type WriteStatusesDeps = {
  forge: CommitStatuses;
  coordination: ForgeCoordination;
  pulls: PullLedger;
  statuses: StatusLedger;
  settings: ForgeConfig;
  clock: Clock;
  logger: Logger;
};

/**
 * The commit status the coordination server wants on each open pull request of a
 * member, written on the pull request's head.
 *
 * The server decides it — whether the repository wants one at all, its context,
 * its state and its description — and is asked once per base branch per pass. A
 * status is written only on a pull request whose author is a member with a GitHub
 * login, only where the server says the repository wants one, and only when its
 * state or description differs from the last one written for that commit and
 * context.
 *
 * A status this system wrote and no longer stands behind is taken back: when the
 * repository stops wanting one, its context changes, or the author is no longer a
 * member, a head whose last status here was not a success gets one success saying
 * it is no longer checked, and the status is forgotten. Nothing written is left
 * holding a pull request back.
 *
 * Each write counts against GitHub's limit on content created, which the queue's
 * own writes spend too: a pass writes at most a set number, every pass together at
 * most a set number an hour, and the rest wait for a later pass.
 */
export class WriteStatuses implements ForgeJob {
  readonly name = 'commit statuses';
  readonly #forge: CommitStatuses;
  readonly #coordination: ForgeCoordination;
  readonly #pulls: PullLedger;
  readonly #statuses: StatusLedger;
  readonly #perPass: number;
  readonly #perHour: number;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: WriteStatusesDeps) {
    this.#forge = deps.forge;
    this.#coordination = deps.coordination;
    this.#pulls = deps.pulls;
    this.#statuses = deps.statuses;
    this.#perPass = deps.settings.maxStatusWritesPerPass;
    this.#perHour = deps.settings.maxStatusWritesPerHour;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const id = pass.snapshot.repositories.idOf(repo);
    const wanted = new Map<string, WantedStatus | null>();
    for (const pull of await this.#pulls.openPulls(repo)) {
      const byMember = pull.author !== null && pass.snapshot.memberLogins.has(pull.author.toLowerCase());
      let status: CommitStatus | null = null;
      if (byMember && id !== null) {
        let answer = wanted.get(pull.baseRef);
        if (answer === undefined) {
          answer = await this.#wanted(id, repo, pull.baseRef, pass);
          wanted.set(pull.baseRef, answer);
        }
        status = answer !== null && answer.enabled ? answer.status : null;
      }
      await this.#withdraw(pull, status, pass, tally);
      if (status !== null) {
        await this.#write(pull, status, pass, tally);
      }
    }
  }

  async #wanted(id: string, repo: string, base: string, pass: ForgePassState): Promise<WantedStatus | null> {
    try {
      return await pass.calls.coordination(`the status for ${repo} into ${base}`, () =>
        this.#coordination.wantedStatus(id, base));
    } catch (error) {
      if (error instanceof ForgeStop) {
        throw error;
      }
      this.#logger.warn('the status the server wants could not be read', { repo, base, reason: sentenceOf(error) });
      return null;
    }
  }

  /** Takes back every status on the head that is not the one wanted now. */
  async #withdraw(pull: KeptPull, wanted: CommitStatus | null, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    for (const last of await this.#statuses.statusesOn(pull.repo, pull.headSha)) {
      if (wanted !== null && last.context === wanted.context) {
        continue;
      }
      const withdrawal = withdrawalOf(last);
      if (withdrawal !== null) {
        if (!(await this.#send(pull, withdrawal, pass, tally))) {
          continue;
        }
        tally.statusesWithdrawn += 1;
      }
      await this.#statuses.forgetStatus(pull.repo, pull.headSha, last.context);
    }
  }

  async #write(pull: KeptPull, wanted: CommitStatus, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const last = await this.#statuses.lastStatus(pull.repo, pull.headSha, wanted.context);
    if (!needsWriting(last, wanted)) {
      return;
    }
    if (await this.#send(pull, wanted, pass, tally)) {
      tally.statuses += 1;
      await this.#statuses.recordStatus(pull.repo, pull.headSha, wanted, this.#clock.now());
    }
  }

  /** Writes a status if this pass and the hour still have room; answers whether it was written. */
  async #send(pull: KeptPull, status: CommitStatus, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<boolean> {
    const now = this.#clock.now();
    if (pass.statusWrites >= this.#perPass
      || await this.#statuses.statusWritesSince(new Date(now.getTime() - HOUR_MS)) >= this.#perHour) {
      tally.statusesDeferred += 1;
      return false;
    }
    const ref = pullRefOf(pull.repo, pull.number);
    try {
      await pass.calls.github(pull.repo, `the status of ${ref}`, () =>
        this.#forge.writeStatus(pull.repo, pull.headSha, status));
    } catch (error) {
      if (error instanceof ForgeStop) {
        throw error;
      }
      tally.failures += 1;
      this.#logger.warn('a commit status could not be written', { pr: ref, reason: sentenceOf(error) });
      return false;
    }
    pass.statusWrites += 1;
    await this.#statuses.noteStatusWrite(now);
    return true;
  }
}
