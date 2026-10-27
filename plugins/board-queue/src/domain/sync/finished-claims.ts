/**
 * When a claim's work is finished as far as the board is concerned: its issue
 * moved into a status the deployment names as the end of the work — waiting for
 * QA, or done — while the claim was held.
 *
 * A move is what counts, not a status. An issue already in such a status when a
 * pass first sees the claim is work taken up again after it was handed on — a
 * fix that QA sent back — and that claim ends when its holder ends it. So every
 * pass remembers the status each held claim's issue showed, and the next pass
 * compares: the claim taken at the same moment, seen before in another status,
 * seen now in a finished one, is finished. A claim taken again is a new claim and
 * starts with no sighting. A claim in review is never finished here: the merge of
 * its pull request ends it.
 */

/** A claim the worker's own member holds, live or stale, and the board status its issue shows now. */
export type HeldClaim = {
  readonly item: number;
  /** The item's outside reference, for the log; null for an item that has none. */
  readonly ref: string | null;
  /** When the claim was taken; it tells this claim from an earlier one on the same item. */
  readonly claimedAt: string;
  /** The issue's status on the board, as the coordination server last heard it; null when it heard none. */
  readonly boardStatus: string | null;
  readonly inReview: boolean;
};

/** What a pass saw of one held claim: which claim, and the status its issue showed. */
export type Sighting = {
  readonly claimedAt: string;
  readonly boardStatus: string | null;
};

export type FinishedClaims = {
  /** The claims to complete, in the order they were held. */
  readonly finished: readonly HeldClaim[];
  /**
   * What the next pass compares with: a sighting for every claim this pass saw.
   * A finished claim keeps the sighting it had, so a completion that fails is
   * tried again; once it succeeds, its sighting is dropped.
   */
  readonly seen: ReadonlyMap<number, Sighting>;
};

/** The claims whose issues moved into a finished status since the last pass, and what this pass saw. */
export function finishedClaims(
  held: readonly HeldClaim[],
  before: ReadonlyMap<number, Sighting>,
  finishedStatuses: ReadonlySet<string>,
): FinishedClaims {
  const isFinished = (status: string | null): boolean => status !== null && finishedStatuses.has(status);
  const finished: HeldClaim[] = [];
  const seen = new Map<number, Sighting>();
  for (const claim of held) {
    const previous = before.get(claim.item);
    const sameClaim = previous !== undefined && previous.claimedAt === claim.claimedAt;
    if (sameClaim && !claim.inReview && !isFinished(previous.boardStatus) && isFinished(claim.boardStatus)) {
      finished.push(claim);
      seen.set(claim.item, previous);
      continue;
    }
    seen.set(claim.item, { claimedAt: claim.claimedAt, boardStatus: claim.boardStatus });
  }
  return { finished, seen };
}
