import { z } from 'zod';
import type {
  ClaimBranches,
  FootprintAnswer,
  FootprintReport,
  ForgeCoordination,
  MergeReport,
  PullReportAnswer,
  ReviewClaim,
  RunHold,
  WantedStatus,
} from '../application/forge-ports.ts';
import type { WorkMember } from '../application/sync-ports.ts';
import { TransientFailure } from '../domain/errors.ts';
import type { CoordinatedRepository } from '../domain/forge/repository-map.ts';
import { DibsTransport } from './dibs-transport.ts';
import type { DibsHttpDeps } from './dibs-transport.ts';

const NOT_FOUND = 404;

const MeAnswer = z.object({
  repos: z.array(z.object({ id: z.string(), remote: z.string().nullable() })),
});

const MembersAnswer = z.object({
  members: z.array(z.object({ handle: z.string(), external_login: z.string().nullable().optional() })),
});

const Branches = z.record(z.string(), z.string()).default({});

const ReviewClaimsAnswer = z.object({
  claims: z.array(z.object({
    item: z.object({ id: z.number().int().positive() }),
    holder: z.string(),
    prs: z.array(z.string()),
  })),
});

const ClaimsAnswer = z.object({
  claims: z.array(z.object({
    item: z.number().int().positive(),
    holder: z.string(),
    branches: Branches,
  })),
});

/** How a hold stays alive; only one kept until a workflow run is of use here, the rest are read as "another mode". */
const Liveness = z.union([
  z.object({ mode: z.literal('until_run'), workflow: z.string(), sha: z.string() }),
  z.object({ mode: z.string() }),
]);

const SlotsAnswer = z.object({
  slots: z.array(z.object({
    name: z.string(),
    hold: z.object({ slot: z.string(), liveness: Liveness }).nullable(),
  })),
});

const PrStatusAnswer = z.object({
  enabled: z.boolean(),
  context: z.string(),
  state: z.enum(['success', 'failure']),
  description: z.string(),
});

const ReportAnswer = z.object({
  matched: z.boolean(),
  item: z.number().int().positive().optional(),
  claim: z.enum(['in_review', 'set_aside', 'working', 'completed']).optional(),
});

const RecordedAnswer = z.object({ recorded: z.boolean() });

const FootprintAnswerSchema = z.object({
  stored: z.boolean(),
  changed: z.boolean().optional(),
  reason: z.string().optional(),
});

const MatchedAnswer = z.object({ matched: z.boolean() });

/**
 * The coordination server, as the forge jobs read it and report to it: its
 * repositories and members, the claims in review and the claimed branches, the
 * holds that wait for a workflow run, the status it wants on pull requests, and
 * the reports of merges, closes, mergeability, footprints and finished runs.
 *
 * Its answers are a foreign model and stop here. Every report is one the server
 * answers again the same way, so sending one twice is never a fault: a report that
 * matched nothing, and a footprint the server did not keep, are answers too.
 */
export class DibsForgeClient implements ForgeCoordination {
  readonly #http: DibsTransport;

  constructor(deps: DibsHttpDeps) {
    this.#http = new DibsTransport(deps);
  }

  async repositories(): Promise<CoordinatedRepository[]> {
    const me = await this.#http.read('GET', '/v1/me', 'the project\'s repositories', MeAnswer);
    return me.repos.map((repo) => ({ id: repo.id, remotePath: repo.remote === null ? null : pathOf(repo.remote) }));
  }

  async members(): Promise<WorkMember[]> {
    const answer = await this.#http.read('GET', '/v1/members', 'the members', MembersAnswer);
    return answer.members.map((member) => ({ handle: member.handle, login: member.external_login ?? null }));
  }

  async reviewClaims(): Promise<ReviewClaim[]> {
    const answer = await this.#http.read('GET', '/v1/review-claims', 'the claims in review', ReviewClaimsAnswer);
    return answer.claims.map((claim) => ({ item: claim.item.id, holder: claim.holder, prs: claim.prs }));
  }

  async claimBranches(): Promise<ClaimBranches[]> {
    const answer = await this.#http.read('GET', '/v1/claims', 'the live claims', ClaimsAnswer);
    return answer.claims.map((claim) => ({ item: claim.item, holder: claim.holder, branches: claim.branches }));
  }

  async runHolds(): Promise<RunHold[]> {
    const answer = await this.#http.read('GET', '/v1/slots', 'the slots', SlotsAnswer);
    // A group's hold is shown on every slot of the group, naming the one it holds.
    const holds = new Map<string, RunHold>();
    for (const slot of answer.slots) {
      const liveness = slot.hold?.liveness;
      if (slot.hold !== null && liveness !== undefined && 'workflow' in liveness) {
        holds.set(slot.hold.slot, { slot: slot.hold.slot, workflow: liveness.workflow, sha: liveness.sha });
      }
    }
    return [...holds.values()];
  }

  async wantedStatus(repo: string, base: string): Promise<WantedStatus | null> {
    const subject = `the status for ${repo} into ${base}`;
    const query = new URLSearchParams({ repo, base });
    const answer = await this.#http.call('GET', `/v1/pr-status?${query.toString()}`, subject);
    if (answer.status === NOT_FOUND) {
      return null;
    }
    const wanted = this.#http.decode(PrStatusAnswer, this.#http.ok(answer, subject), subject);
    return {
      enabled: wanted.enabled,
      status: { state: wanted.state, description: wanted.description, context: wanted.context },
    };
  }

  async reportMerged(report: MergeReport): Promise<PullReportAnswer> {
    const subject = `the merge of ${report.pr}`;
    // A field left out is one the server fills in from what it kept: the merged
    // branch's footprint stands for unread files, and a fork's branch is no head.
    const body: Record<string, unknown> = { pr: report.pr, base: report.base, merged_at: report.mergedAt.toISOString() };
    if (report.head !== null) {
      body['head'] = report.head;
    }
    if (report.files !== null) {
      body['files'] = [...report.files];
    }
    return reportAnswerOf(await this.#http.read('POST', '/v1/prs/merged', subject, ReportAnswer, body), subject);
  }

  async reportClosed(pr: string): Promise<PullReportAnswer> {
    const subject = `the close of ${pr}`;
    return reportAnswerOf(await this.#http.read('POST', '/v1/prs/closed', subject, ReportAnswer, { pr }), subject);
  }

  async reportMergeable(pr: string, mergeable: boolean): Promise<boolean> {
    const subject = `whether ${pr} merges cleanly`;
    return (await this.#http.read('POST', '/v1/prs/state', subject, RecordedAnswer, { pr, mergeable })).recorded;
  }

  async reportFootprint(item: number, footprint: FootprintReport): Promise<FootprintAnswer> {
    const subject = `the footprint of ${footprint.branch} on the work item ${String(item)}`;
    const body = {
      repo: footprint.repo,
      branch: footprint.branch,
      base: footprint.base,
      base_sha: footprint.measure.baseSha,
      base_at: footprint.measure.baseAt.toISOString(),
      paths: [...footprint.measure.paths],
      truncated: footprint.measure.truncated,
    };
    const answer = await this.#http.read(
      'PUT',
      `/v1/items/${String(item)}/footprint`,
      subject,
      FootprintAnswerSchema,
      body,
    );
    return answer.stored
      ? { stored: true, changed: answer.changed ?? false }
      : { stored: false, reason: answer.reason ?? 'not stated' };
  }

  async reportRunFinished(hold: RunHold, conclusion: string): Promise<boolean> {
    const subject = `the end of the run ${hold.slot} waits for`;
    const body = { workflow: hold.workflow, sha: hold.sha, conclusion };
    const path = `/v1/slots/${encodeURIComponent(hold.slot)}/run-finished`;
    return (await this.#http.read('POST', path, subject, MatchedAnswer, body)).matched;
  }
}

/** A match names the item and where its claim stands; an answer that says it matched and names neither is not one. */
function reportAnswerOf(answer: z.infer<typeof ReportAnswer>, subject: string): PullReportAnswer {
  if (!answer.matched) {
    return { matched: false };
  }
  if (answer.item === undefined || answer.claim === undefined) {
    throw new TransientFailure(`${subject} answered a match without its item or its claim`);
  }
  return { matched: true, item: answer.item, claim: answer.claim };
}

/** `host/owner/name` as the server writes a remote → `owner/name`. */
function pathOf(remote: string): string {
  const slash = remote.indexOf('/');
  return slash < 0 ? remote : remote.slice(slash + 1);
}
