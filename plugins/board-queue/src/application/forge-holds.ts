import { finishedRunOf } from '../domain/forge/workflow-runs.ts';
import { ForgeStop, sentenceOf } from './forge-calls.ts';
import type { ForgeJob, ForgePassState } from './forge-pass-state.ts';
import type { CommitLedger, Commits, ForgeCoordination, ResolvedCommit, RunHold, WorkflowRuns } from './forge-ports.ts';
import type { Logger } from './ports.ts';
import type { ForgeRepositoryRun } from './sync-meta.ts';

export type ReleaseRunHoldsDeps = {
  forge: WorkflowRuns & Commits;
  coordination: ForgeCoordination;
  commits: CommitLedger;
  logger: Logger;
};

/**
 * The slot holds that wait for a forge workflow's run, ended once that run
 * finished.
 *
 * A hold names a workflow and a commit — a short id as often as a full one — and
 * no repository. The commit is resolved once, in the first repository that holds
 * it, and kept: its full id is what GitHub lists runs by, and only that
 * repository is asked for them from then on. Only the latest run of the hold's own
 * workflow for that commit, once completed, ends the hold, and the server is told
 * how it concluded, under the commit as the hold names it. A run that never
 * appears leaves the hold to its expiry.
 */
export class ReleaseRunHolds implements ForgeJob {
  readonly name = 'slot holds';
  readonly #forge: WorkflowRuns & Commits;
  readonly #coordination: ForgeCoordination;
  readonly #commits: CommitLedger;
  readonly #logger: Logger;

  constructor(deps: ReleaseRunHoldsDeps) {
    this.#forge = deps.forge;
    this.#coordination = deps.coordination;
    this.#commits = deps.commits;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    for (const hold of pass.snapshot.runHolds) {
      const key = keyOf(hold);
      if (pass.releasedHolds.has(key)) {
        continue;
      }
      try {
        const commit = await this.#commitOf(hold.sha, repo, pass);
        if (commit === null || commit.repo !== repo) {
          continue;
        }
        const runs = await pass.calls.github(repo, `the runs of ${commit.sha}`, () => this.#forge.runsFor(repo, commit.sha));
        const finished = finishedRunOf(runs, hold.workflow, commit.sha);
        if (finished === null) {
          continue;
        }
        const ended = await pass.calls.coordination(`the end of the run ${hold.slot} waits for`, () =>
          this.#coordination.reportRunFinished(hold, finished.conclusion));
        pass.releasedHolds.add(key);
        if (ended) {
          tally.holdsReleased += 1;
        }
      } catch (error) {
        if (error instanceof ForgeStop) {
          throw error;
        }
        tally.failures += 1;
        this.#logger.warn('the run a slot waits for could not be read', { slot: hold.slot, reason: sentenceOf(error) });
      }
    }
  }

  /** Where a commit lives and its full id: kept, or asked of this repository; nothing when it holds none. */
  async #commitOf(sha: string, repo: string, pass: ForgePassState): Promise<ResolvedCommit | null> {
    const known = pass.commits.get(sha) ?? await this.#commits.resolvedCommit(sha);
    if (known !== null) {
      pass.commits.set(sha, known);
      return known;
    }
    const absent = `${repo}\n${sha}`;
    if (pass.commitsAbsent.has(absent)) {
      return null;
    }
    const full = await pass.calls.github(repo, `the commit ${sha}`, () => this.#forge.resolveCommit(repo, sha));
    if (full === null) {
      pass.commitsAbsent.add(absent);
      return null;
    }
    const resolved: ResolvedCommit = { repo, sha: full };
    await this.#commits.recordResolvedCommit(sha, resolved);
    pass.commits.set(sha, resolved);
    return resolved;
  }
}

function keyOf(hold: RunHold): string {
  return `${hold.slot}\n${hold.workflow}\n${hold.sha}`;
}
