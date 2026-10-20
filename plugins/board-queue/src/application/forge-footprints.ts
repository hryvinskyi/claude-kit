import { TransientFailure } from '../domain/errors.ts';
import { isFromItsOwnRepository } from '../domain/forge/pull-requests.ts';
import { ForgeStop, sentenceOf } from './forge-calls.ts';
import type { ForgeJob, ForgePassState } from './forge-pass-state.ts';
import type { BranchLedger, BranchMeasure, Branches, ForgeCoordination, PullLedger } from './forge-ports.ts';
import type { Logger } from './ports.ts';
import type { ForgeRepositoryRun } from './sync-meta.ts';

export type MeasureFootprintsDeps = {
  forge: Branches;
  coordination: ForgeCoordination;
  pulls: PullLedger;
  branches: BranchLedger;
  logger: Logger;
};

/**
 * What each branch of a live claim changes against its base, told to the
 * coordination server as the claim's footprint in that repository.
 *
 * The base is the one the branch's open pull request is merged into — a pull
 * request from the repository's own branch, never a fork's of the same name — or
 * the repository's default branch while it has none. A comparison is asked
 * conditionally, and an unchanged one tells the server the measure kept from the
 * last: the server answers a repeat by changing nothing, and a claim that moved
 * away from a branch and back has lost its footprint there. A branch the forge no
 * longer has — deleted after a merge — is told nothing, so the server keeps the
 * last footprint until the claim ends. A claim a report of this pass ended is not
 * measured; one set aside, or back at work, still is.
 */
export class MeasureFootprints implements ForgeJob {
  readonly name = 'footprints';
  readonly #forge: Branches;
  readonly #coordination: ForgeCoordination;
  readonly #pulls: PullLedger;
  readonly #branches: BranchLedger;
  readonly #logger: Logger;

  constructor(deps: MeasureFootprintsDeps) {
    this.#forge = deps.forge;
    this.#coordination = deps.coordination;
    this.#pulls = deps.pulls;
    this.#branches = deps.branches;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const id = pass.snapshot.repositories.idOf(repo);
    if (id === null) {
      return;
    }
    const open = await this.#pulls.openPulls(repo);
    const measured: { base: string; branch: string }[] = [];
    let whole = true;
    for (const claim of pass.snapshot.claimBranches) {
      const branch = claim.branches[id];
      if (branch === undefined || pass.endedItems.has(claim.item)) {
        continue;
      }
      try {
        const ownPull = open.find((pull) => isFromItsOwnRepository(pull) && pull.headRef === branch);
        const base = ownPull?.baseRef ?? await this.#defaultBranch(repo, pass);
        const measure = await this.#measure(repo, base, branch, pass, tally);
        if (measure === null) {
          continue;
        }
        measured.push({ base, branch });
        const answer = await pass.calls.coordination(`the footprint of ${branch}`, () =>
          this.#coordination.reportFootprint(claim.item, { repo: id, branch, base, measure }));
        tally.footprints += 1;
        if (!answer.stored) {
          this.#logger.info('a footprint was not kept by the server', { item: claim.item, branch, reason: answer.reason });
        }
      } catch (error) {
        if (error instanceof ForgeStop) {
          throw error;
        }
        whole = false;
        tally.failures += 1;
        this.#logger.warn('a claimed branch could not be measured', { repo, branch, reason: sentenceOf(error) });
      }
    }
    if (whole) {
      await this.#branches.forgetMeasuresExcept(repo, measured);
    }
  }

  /** What the branch changes, freshly measured or kept; nothing for a branch the forge no longer has. */
  async #measure(
    repo: string,
    base: string,
    branch: string,
    pass: ForgePassState,
    tally: ForgeRepositoryRun,
  ): Promise<BranchMeasure | null> {
    const kept = await this.#branches.measure(repo, base, branch);
    const answer = await pass.calls.github(repo, `what ${branch} changes against ${base}`, () =>
      this.#forge.compare(repo, base, branch, kept?.etag ?? null));
    if (answer.kind === 'missing') {
      tally.branchesGone += 1;
      return null;
    }
    if (answer.kind === 'unchanged') {
      pass.calls.unchanged();
      if (kept === null) {
        throw new TransientFailure(`${branch} was answered "unchanged" to a request that held no tag`);
      }
      return kept.measure;
    }
    await this.#branches.recordMeasure(repo, base, branch, { etag: answer.etag, measure: answer.measure });
    return answer.measure;
  }

  async #defaultBranch(repo: string, pass: ForgePassState): Promise<string> {
    const known = pass.defaultBranches.get(repo);
    if (known !== undefined) {
      return known;
    }
    const kept = await this.#branches.defaultBranch(repo);
    const read = await pass.calls.github(repo, `the default branch of ${repo}`, () =>
      this.#forge.defaultBranch(repo, kept?.etag ?? null));
    let name: string;
    if (read.changed) {
      name = read.name;
      await this.#branches.recordDefaultBranch(repo, name, read.etag);
    } else {
      pass.calls.unchanged();
      if (kept === null) {
        throw new TransientFailure(`${repo} was answered "unchanged" to a request that held no tag`);
      }
      name = kept.name;
    }
    pass.defaultBranches.set(repo, name);
    return name;
  }
}
