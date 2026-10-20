import type {
  ClaimAfterReport,
  ClaimBranches,
  FootprintAnswer,
  FootprintReport,
  ForgeCoordination,
  MergeReport,
  PullReportAnswer,
  ReviewClaim,
  RunHold,
  WantedStatus,
} from '../../src/application/forge-ports.ts';
import type { WorkMember } from '../../src/application/sync-ports.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';
import type { CoordinatedRepository } from '../../src/domain/forge/repository-map.ts';

export type ForgeCoordinationCall =
  | 'repositories'
  | 'members'
  | 'reviewClaims'
  | 'claimBranches'
  | 'runHolds'
  | 'wantedStatus'
  | 'reportMerged'
  | 'reportClosed'
  | 'reportMergeable'
  | 'reportFootprint'
  | 'reportRunFinished';

/**
 * The coordination server, as the forge jobs reach it, in memory. A pull request
 * a claim waits for is matched once, as the server matches it: the report that
 * matches takes it off the claim, and every later report of it matches nothing.
 */
export class FakeForgeCoordination implements ForgeCoordination {
  readonly calls: ForgeCoordinationCall[] = [];
  readonly merged: (MergeReport & { answer: PullReportAnswer })[] = [];
  readonly closed: { pr: string; answer: PullReportAnswer }[] = [];
  readonly mergeability: { pr: string; mergeable: boolean }[] = [];
  readonly footprints: { item: number; footprint: FootprintReport }[] = [];
  readonly runsFinished: { hold: RunHold; conclusion: string }[] = [];

  readonly #repositories: CoordinatedRepository[] = [];
  readonly #members: WorkMember[] = [];
  readonly #reviews: { item: number; holder: string; prs: string[]; after: ClaimAfterReport }[] = [];
  readonly #claims: ClaimBranches[] = [];
  readonly #holds: RunHold[] = [];
  readonly #wanted = new Map<string, WantedStatus | null>();
  readonly #scripted = new Map<ForgeCoordinationCall, BoardQueueError[]>();
  footprintAnswer: FootprintAnswer = { stored: true, changed: true };

  repository(id: string, remotePath: string | null): this {
    this.#repositories.push({ id, remotePath });
    return this;
  }

  member(handle: string, login: string | null): this {
    this.#members.push({ handle, login });
    return this;
  }

  /** What removing a member does to the list the server answers. */
  forgetMember(handle: string): this {
    const at = this.#members.findIndex((member) => member.handle === handle);
    if (at >= 0) {
      this.#members.splice(at, 1);
    }
    return this;
  }

  /** A claim in review waiting for these pull requests; a report of its last one leaves it as `after` says. */
  inReview(item: number, holder: string, prs: readonly string[], after: ClaimAfterReport = 'completed'): this {
    this.#reviews.push({ item, holder, prs: [...prs], after });
    return this;
  }

  claim(item: number, holder: string, branches: Readonly<Record<string, string>>): this {
    this.#claims.push({ item, holder, branches });
    return this;
  }

  hold(hold: RunHold): this {
    this.#holds.push(hold);
    return this;
  }

  wants(repo: string, base: string, wanted: WantedStatus | null): this {
    this.#wanted.set(`${repo}\n${base}`, wanted);
    return this;
  }

  fail(call: ForgeCoordinationCall, error: BoardQueueError): this {
    const queued = this.#scripted.get(call) ?? [];
    queued.push(error);
    this.#scripted.set(call, queued);
    return this;
  }

  async repositories(): Promise<CoordinatedRepository[]> {
    this.#answer('repositories');
    return [...this.#repositories];
  }

  async members(): Promise<WorkMember[]> {
    this.#answer('members');
    return [...this.#members];
  }

  async reviewClaims(): Promise<ReviewClaim[]> {
    this.#answer('reviewClaims');
    return Promise.resolve(this.#reviews
      .filter((claim) => claim.prs.length > 0)
      .map((claim) => ({ item: claim.item, holder: claim.holder, prs: [...claim.prs] })));
  }

  async claimBranches(): Promise<ClaimBranches[]> {
    this.#answer('claimBranches');
    return [...this.#claims];
  }

  async runHolds(): Promise<RunHold[]> {
    this.#answer('runHolds');
    return [...this.#holds];
  }

  async wantedStatus(repo: string, base: string): Promise<WantedStatus | null> {
    this.#answer('wantedStatus');
    return this.#wanted.get(`${repo}\n${base}`) ?? null;
  }

  async reportMerged(report: MergeReport): Promise<PullReportAnswer> {
    this.#answer('reportMerged');
    const answer = this.#match(report.pr);
    this.merged.push({ ...report, answer });
    return answer;
  }

  async reportClosed(pr: string): Promise<PullReportAnswer> {
    this.#answer('reportClosed');
    const answer = this.#match(pr);
    this.closed.push({ pr, answer });
    return answer;
  }

  async reportMergeable(pr: string, mergeable: boolean): Promise<boolean> {
    this.#answer('reportMergeable');
    this.mergeability.push({ pr, mergeable });
    return true;
  }

  async reportFootprint(item: number, footprint: FootprintReport): Promise<FootprintAnswer> {
    this.#answer('reportFootprint');
    this.footprints.push({ item, footprint });
    return this.footprintAnswer;
  }

  async reportRunFinished(hold: RunHold, conclusion: string): Promise<boolean> {
    this.#answer('reportRunFinished');
    this.runsFinished.push({ hold, conclusion });
    const at = this.#holds.findIndex((held) =>
      held.slot === hold.slot && held.workflow === hold.workflow && held.sha === hold.sha);
    if (at < 0) {
      return false;
    }
    this.#holds.splice(at, 1);
    return true;
  }

  #match(pr: string): PullReportAnswer {
    for (const claim of this.#reviews) {
      const at = claim.prs.indexOf(pr);
      if (at >= 0) {
        claim.prs.splice(at, 1);
        return { matched: true, item: claim.item, claim: claim.prs.length === 0 ? claim.after : 'in_review' };
      }
    }
    return { matched: false };
  }

  #answer(call: ForgeCoordinationCall): void {
    this.calls.push(call);
    const scripted = this.#scripted.get(call)?.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
  }
}
