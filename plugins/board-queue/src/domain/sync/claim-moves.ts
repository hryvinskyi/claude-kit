import type { ClaimStatuses } from '../sync-config.ts';

/** The claim events that move a row or its assignees; every other event of the log moves nothing. */
export type ClaimEventKind =
  | 'claimed'
  | 'taken_over'
  | 'released'
  | 'force_released'
  | 'review_started'
  | 'review_ended';

/** One claim event as the coordination server's log reports it, its members named by handle. */
export type ClaimEvent = {
  /** Its position in the log; later events have larger ids. */
  readonly id: number;
  readonly kind: ClaimEventKind;
  /** The server's id of the work item the claim is on. */
  readonly item: number;
  /** Who holds — or held — the claim; null when the log did not name them. */
  readonly member: string | null;
  /** For a takeover, whose stale claim ended; null otherwise. */
  readonly previous: string | null;
  /**
   * For a release by an admin, the admin; null otherwise, and for a release the
   * server's operator made from its command line.
   */
  readonly by: string | null;
};

/** Which of the configured statuses an event stands for. */
export type ClaimStatusKey = keyof ClaimStatuses;

/** What a run of events on one item adds up to: the last status, and who is assigned and unassigned. */
export type IssueMove = {
  readonly item: number;
  /** The last event that went into it, which is what names the move once it is filed. */
  readonly lastEventId: number;
  /**
   * Who caused that last event, and so whose move this is: the state the item
   * is left in is the one that member's action left. Null when the log did not
   * name them.
   */
  readonly causedBy: string | null;
  /** The kind of that last event, which says what the server should show for the item now. */
  readonly lastKind: ClaimEventKind;
  /** Who held the claim as of that last event; null when the log did not name them. */
  readonly holder: string | null;
  /** The board status the last event that stands for one asks for, or nothing when none did. */
  readonly status: string | null;
  /** Handles to assign, in the order they were first named. */
  readonly assign: readonly string[];
  /** Handles to unassign. */
  readonly unassign: readonly string[];
};

type Step = (move: IssueMove, event: ClaimEvent, statuses: ClaimStatuses) => IssueMove;

/**
 * What each claim event does to an item's move. A status an event sets replaces
 * the one before it, and an assignment it makes undoes an earlier unassignment of
 * the same person, so a run of events collapses to the state the last of them
 * left behind.
 */
const STEPS: { readonly [K in ClaimEventKind]: Step } = {
  claimed: (move, event, statuses) => assigned(
    withStatus(move, event, boardStatusOf('claimed', statuses)),
    event.member,
  ),
  taken_over: (move, event, statuses) => unassigned(
    assigned(withStatus(move, event, boardStatusOf('takenOver', statuses)), event.member),
    event.previous,
  ),
  released: (move, event, statuses) => unassigned(
    withStatus(move, event, boardStatusOf('released', statuses)),
    event.member,
  ),
  force_released: (move, event, statuses) => unassigned(
    withStatus(move, event, boardStatusOf('released', statuses)),
    event.member,
  ),
  review_started: (move, event, statuses) => withStatus(move, event, boardStatusOf('review', statuses)),
  review_ended: (move, event, statuses) => withStatus(move, event, boardStatusOf('reviewEnded', statuses)),
};

/**
 * Who caused each claim event: the member whose action appended it.
 *
 * - `claimed`: the member who claimed the item.
 * - `taken_over`: the member who took the stale claim over, not the one it was taken from.
 * - `released`: the holder, who put the work down.
 * - `force_released`: the admin who ended the claim. A release the server's
 *   operator made from its command line names no admin; it falls to the holder,
 *   whose row it is, so that somebody's worker still files it.
 * - `review_started`: the holder, who recorded a pull request on the claim.
 * - `review_ended`: the holder of the claim that is worked on again — whether they
 *   dropped the pull request or the forge reported it closed.
 */
const ACTORS: { readonly [K in ClaimEventKind]: (event: ClaimEvent) => string | null } = {
  claimed: (event) => event.member,
  taken_over: (event) => event.member,
  released: (event) => event.member,
  force_released: (event) => event.by ?? event.member,
  review_started: (event) => event.member,
  review_ended: (event) => event.member,
};

/** The member who caused a claim event. */
export function actorOf(event: ClaimEvent): string | null {
  return ACTORS[event.kind](event);
}

/**
 * One move per item, in the order of the last event of each: what a page of the
 * log says each item should look like now, in the board's own statuses. Events
 * must come oldest first, as the log hands them out.
 */
export function collapseClaims(events: readonly ClaimEvent[], statuses: ClaimStatuses): IssueMove[] {
  const moves = new Map<number, IssueMove>();
  for (const event of events) {
    const before = moves.get(event.item) ?? {
      item: event.item,
      lastEventId: event.id,
      causedBy: null,
      lastKind: event.kind,
      holder: null,
      status: null,
      assign: [],
      unassign: [],
    };
    moves.set(event.item, {
      ...STEPS[event.kind](before, event, statuses),
      causedBy: actorOf(event),
      lastKind: event.kind,
      holder: event.member,
    });
  }
  return [...moves.values()].sort((one, other) => one.lastEventId - other.lastEventId);
}

/** An item's live claim on the server now: who holds it and whether its work waits on a review; null for none. */
export type LiveState = { readonly holder: string; readonly inReview: boolean } | null;

const heldBy = (inReview: boolean) => (move: IssueMove, live: LiveState): boolean =>
  live !== null && move.holder !== null && live.holder === move.holder && live.inReview === inReview;

const free = (_move: IssueMove, live: LiveState): boolean => live === null;

/**
 * What the server must still show for a move to be filed: a claim, a takeover or
 * the end of a review stands while the same member holds the item, worked on; the
 * start of a review while that member holds it in review; a release while nobody
 * holds it. Anything else is a later state somebody else's move, or a later move
 * of the same member, files.
 */
const STANDS: { readonly [K in ClaimEventKind]: (move: IssueMove, live: LiveState) => boolean } = {
  claimed: heldBy(false),
  taken_over: heldBy(false),
  review_ended: heldBy(false),
  review_started: heldBy(true),
  released: free,
  force_released: free,
};

/** Whether the state a move leaves an item in is still the item's state on the server. */
export function stillStands(move: IssueMove, live: LiveState): boolean {
  return STANDS[move.lastKind](move, live);
}

/**
 * The board status a move stands for, or nothing when the configuration names
 * none for it. A takeover and the end of a review mean the work is in hand again,
 * so they fall back to the claimed status.
 */
export function boardStatusOf(key: ClaimStatusKey, statuses: ClaimStatuses): string | null {
  const FALLBACK: { readonly [K in ClaimStatusKey]: string | null } = {
    claimed: statuses.claimed,
    released: statuses.released,
    takenOver: statuses.takenOver ?? statuses.claimed,
    review: statuses.review ?? null,
    reviewEnded: statuses.reviewEnded ?? statuses.claimed,
  };
  return FALLBACK[key];
}

/**
 * The statuses a mirrored move may move a row out of: every status the mirror
 * itself writes, and no status at all. A row anywhere else was put there by
 * somebody else, and a late event must not pull it back.
 */
export function statusesTheMirrorOwns(statuses: ClaimStatuses): string[] {
  const owned = [statuses.claimed, statuses.released, statuses.takenOver, statuses.review, statuses.reviewEnded]
    .filter((status): status is string => status !== undefined);
  return [...new Set(owned), ''];
}

/** A status the configuration names none for leaves the one an earlier event asked for. */
function withStatus(move: IssueMove, event: ClaimEvent, status: string | null): IssueMove {
  return { ...move, lastEventId: event.id, status: status ?? move.status };
}

function assigned(move: IssueMove, handle: string | null): IssueMove {
  if (handle === null) {
    return move;
  }
  return {
    ...move,
    assign: move.assign.includes(handle) ? move.assign : [...move.assign, handle],
    unassign: move.unassign.filter((one) => one !== handle),
  };
}

function unassigned(move: IssueMove, handle: string | null): IssueMove {
  if (handle === null) {
    return move;
  }
  return {
    ...move,
    assign: move.assign.filter((one) => one !== handle),
    unassign: move.unassign.includes(handle) ? move.unassign : [...move.unassign, handle],
  };
}
