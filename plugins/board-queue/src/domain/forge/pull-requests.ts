/**
 * Pull requests as the forge lists them, in the terms the forge jobs decide by:
 * whether one has ended and how, how it is named to the coordination server, and
 * how far back a listing sorted by the last update has to read.
 */

export type PullState = 'open' | 'closed';

/** How a pull request that is no longer open ended. */
export type PullEnd = 'merged' | 'closed';

export type ForgePull = {
  /** `owner/name`, in lower case: the forge's names are case-insensitive. */
  readonly repo: string;
  readonly number: number;
  readonly state: PullState;
  /** When it was merged; null for one that is open or was closed without a merge. */
  readonly mergedAt: Date | null;
  readonly updatedAt: Date;
  /** The login of whoever opened it; null when the forge no longer names one. */
  readonly author: string | null;
  /** The branch it is merged from. */
  readonly headRef: string;
  /**
   * The repository that branch lives in, `owner/name` in lower case: the pull
   * request's own for a branch pushed there, a fork's otherwise, and null when the
   * fork is gone.
   */
  readonly headRepo: string | null;
  /** The commit at the tip of that branch. */
  readonly headSha: string;
  /** The branch it is merged into. */
  readonly baseRef: string;
};

/**
 * Whether its branch lives in the pull request's own repository. A fork's branch
 * of the same name is another branch: it is never matched to a claim's branch, and
 * a merge does not name it as the branch that was merged.
 */
export function isFromItsOwnRepository(pull: ForgePull): boolean {
  return pull.headRepo !== null && pull.headRepo === pull.repo.toLowerCase();
}

/** How a pull request ended, or nothing while it is open. */
export function endOf(pull: ForgePull): PullEnd | null {
  if (pull.state === 'open') {
    return null;
  }
  return pull.mergedAt === null ? 'closed' : 'merged';
}

/**
 * The end still to be reported, given the end that was reported already: none for
 * an open pull request, none for one whose end the server was told, and the end
 * itself otherwise.
 */
export function endToReport(pull: ForgePull, reported: PullEnd | null): PullEnd | null {
  const end = endOf(pull);
  return end !== null && end !== reported ? end : null;
}

/**
 * A pull request as the coordination server writes it: `owner/name#number`, in
 * lower case, which is the one form it compares.
 */
export function pullRefOf(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${String(number)}`;
}

const PULL_REF = /^([^/\s#]+)\/([^/\s#]+)#0*([1-9]\d*)$/;

/** The repository and number a pull request reference names, or nothing for a text that names none. */
export function parsePullRef(text: string): { readonly repo: string; readonly number: number } | null {
  const match = PULL_REF.exec(text.trim());
  if (match === null) {
    return null;
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) {
    return null;
  }
  return { repo: `${match[1] ?? ''}/${match[2] ?? ''}`.toLowerCase(), number };
}

/**
 * The oldest update a listing still reads: the cursor, less an overlap. The
 * listing has no "since", its clock is not this machine's, and an update can land
 * while a pass is reading, so the window reaches back past the cursor and what it
 * reads twice is recognised by what was already reported.
 */
export function listingFloor(cursor: Date, overlapMs: number): Date {
  return new Date(cursor.getTime() - overlapMs);
}

/** Whether a page sorted newest first reached past the floor, so no later page can hold anything newer. */
export function readsPastTheFloor(floor: Date, page: readonly ForgePull[]): boolean {
  return page.some((pull) => pull.updatedAt.getTime() < floor.getTime());
}

/** Whether a pull request was updated inside the window the listing reads. */
export function insideTheWindow(floor: Date, pull: ForgePull): boolean {
  return pull.updatedAt.getTime() >= floor.getTime();
}

/** The cursor after a listing: the newest update it read, never earlier than the cursor it started from. */
export function advancedCursor(previous: Date, read: readonly ForgePull[]): Date {
  let newest = previous.getTime();
  for (const pull of read) {
    newest = Math.max(newest, pull.updatedAt.getTime());
  }
  return new Date(newest);
}

/**
 * The pull requests of a window in the order they are handled: oldest update
 * first, so the cursor can stand at the last one handled whenever a pass stops.
 */
export function oldestFirst(pulls: readonly ForgePull[]): ForgePull[] {
  return [...pulls].sort((one, other) =>
    one.updatedAt.getTime() - other.updatedAt.getTime() || one.number - other.number);
}
