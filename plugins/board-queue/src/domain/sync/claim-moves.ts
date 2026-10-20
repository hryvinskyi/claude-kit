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
};

/** Which of the configured statuses an event stands for. */
export type ClaimStatusKey = keyof ClaimStatuses;

/** What a run of events on one item adds up to: the last status, and who is assigned and unassigned. */
export type IssueMove = {
  readonly item: number;
  /** The last event that went into it, which is what names the move once it is filed. */
  readonly lastEventId: number;
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
      status: null,
      assign: [],
      unassign: [],
    };
    moves.set(event.item, STEPS[event.kind](before, event, statuses));
  }
  return [...moves.values()].sort((one, other) => one.lastEventId - other.lastEventId);
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
