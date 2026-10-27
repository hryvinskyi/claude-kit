/**
 * What the board says about the work of a claim, and what that does to the claim.
 *
 * Two kinds of move count. A move into a status that hands the work on — waiting
 * for QA — means the code is written: the claim gives up its areas, so nobody is
 * kept out of those files, and keeps its item, so the holder can take the areas
 * up again when QA sends the work back. A move into a status that ends the work —
 * done — or the issue's close, means nothing more will be written: the claim is
 * completed. Completing is for good, because a completed item can never be
 * claimed again; handing on is what may be undone.
 *
 * A move is what counts, not a status. An issue already in such a status when a
 * pass first sees the claim is work taken up again after it was handed on — a
 * fix that QA sent back — and that claim keeps its areas until its holder lets
 * them go. So every pass remembers the status each held claim's issue showed, and
 * the next pass compares: the claim taken at the same moment, seen before short
 * of a status, seen now in it, has moved. A claim taken again is a new claim and
 * starts with no sighting. A claim in review is left alone: the merge of its pull
 * request ends it.
 */

/** A claim the worker's own member holds, live or stale, and where its issue stands now. */
export type HeldClaim = {
  readonly item: number;
  /** The item's outside reference, for the log; null for an item that has none. */
  readonly ref: string | null;
  /** When the claim was taken; it tells this claim from an earlier one on the same item. */
  readonly claimedAt: string;
  /** The issue's status on the board, as the coordination server last heard it; null when it heard none. */
  readonly boardStatus: string | null;
  /** Whether the tracker closed the issue. */
  readonly closed: boolean;
  /** The areas the claim holds, as the server writes them. */
  readonly areas: readonly string[];
  readonly inReview: boolean;
};

/** How far the work of a claim has gone, as the board says it. */
export type Stage = 'working' | 'handed-on' | 'ended';

/** What a pass saw of one held claim: which claim, and how far its issue had gone. */
export type Sighting = {
  readonly claimedAt: string;
  readonly stage: Stage;
};

/** The board statuses each stage beyond working is read from. */
export type StageStatuses = {
  readonly handedOn: ReadonlySet<string>;
  readonly ended: ReadonlySet<string>;
};

export type ClaimMoves = {
  /** Claims whose work ended: to complete. */
  readonly complete: readonly HeldClaim[];
  /** Claims whose work was handed on and that still hold areas: to give those areas up. */
  readonly handOn: readonly HeldClaim[];
  /**
   * What the next pass compares with: a sighting for every claim this pass saw. A
   * claim to complete or hand on keeps the sighting it had, so a call that fails
   * is made again; the caller records the new stage once the call succeeds.
   */
  readonly seen: ReadonlyMap<number, Sighting>;
};

const RANK: { readonly [K in Stage]: number } = { working: 0, 'handed-on': 1, ended: 2 };

/** The stage an issue's status and close put a claim's work at. */
export function stageOf(claim: HeldClaim, statuses: StageStatuses): Stage {
  if (claim.closed || (claim.boardStatus !== null && statuses.ended.has(claim.boardStatus))) {
    return 'ended';
  }
  return claim.boardStatus !== null && statuses.handedOn.has(claim.boardStatus) ? 'handed-on' : 'working';
}

/** The claims whose issues moved on since the last pass, and what this pass saw. */
export function claimMoves(
  held: readonly HeldClaim[],
  before: ReadonlyMap<number, Sighting>,
  statuses: StageStatuses,
): ClaimMoves {
  const complete: HeldClaim[] = [];
  const handOn: HeldClaim[] = [];
  const seen = new Map<number, Sighting>();
  for (const claim of held) {
    const stage = stageOf(claim, statuses);
    const previous = before.get(claim.item);
    const moved = previous !== undefined && previous.claimedAt === claim.claimedAt
      && RANK[stage] > RANK[previous.stage] && !claim.inReview;
    if (moved && stage === 'ended') {
      complete.push(claim);
      seen.set(claim.item, previous);
      continue;
    }
    if (moved && stage === 'handed-on' && claim.areas.length > 0) {
      handOn.push(claim);
      seen.set(claim.item, previous);
      continue;
    }
    seen.set(claim.item, { claimedAt: claim.claimedAt, stage });
  }
  return { complete, handOn, seen };
}
