import { RefusedByRule } from './errors.ts';
import type { IssueRef } from './issue-ref.ts';

/** A board lives under an organisation or under a user, and the API asks for each differently. */
export type BoardOwnerType = 'organization' | 'user';

/** Which board: the account that owns it and its number under that account. */
export type BoardIdentity = {
  readonly owner: string;
  readonly number: number;
  readonly ownerType: BoardOwnerType;
};

/** One board and the repositories whose issues are written to it, as the configuration spells them. */
export type BoardAssignment = BoardIdentity & {
  readonly repos: readonly string[];
};

declare const boardKeyBrand: unique symbol;

/** Lower-cased `owner/number`: the one spelling of a board that anything kept per board is filed under. */
export type BoardKey = string & { readonly [boardKeyBrand]: 'BoardKey' };

/** A board as the directory hands it out: who it is, what it is called, what it carries. */
export type BoardPlacement = {
  readonly board: BoardIdentity;
  readonly key: BoardKey;
  /** `owner/number` as the configuration spells it, for a person to read. */
  readonly name: string;
  readonly repos: readonly string[];
};

/** A repository named by more than one board, and the boards that named it. */
export type DuplicateRepository = {
  readonly repo: string;
  readonly boards: readonly string[];
};

/**
 * Which board carries which repository.
 *
 * Every issue is written to exactly one board, the one whose configuration names
 * its repository, so a repository named twice would leave the answer to whichever
 * board happened to be listed first. That is refused when the directory is built
 * rather than discovered on the board. Names compare case-insensitively, because
 * GitHub treats owners and repositories so; the spelling handed back is always
 * the configuration's.
 */
export class BoardDirectory {
  readonly #placements: readonly BoardPlacement[];
  readonly #byRepo: ReadonlyMap<string, BoardPlacement>;

  private constructor(placements: readonly BoardPlacement[]) {
    this.#placements = placements;
    const byRepo = new Map<string, BoardPlacement>();
    for (const placement of placements) {
      for (const repo of placement.repos) {
        byRepo.set(repo.toLowerCase(), placement);
      }
    }
    this.#byRepo = byRepo;
  }

  /** Refuses no boards, a board listed twice, and a repository two boards claim. */
  static of(assignments: readonly BoardAssignment[]): BoardDirectory {
    if (assignments.length === 0) {
      throw new RefusedByRule('no board is configured; name at least one board and the repositories it carries');
    }
    const boards = duplicateBoards(assignments);
    if (boards.length > 0) {
      throw new RefusedByRule(`${boards.join(', ')} is configured more than once; list each board once`);
    }
    const repos = duplicateRepositories(assignments);
    if (repos.length > 0) {
      throw new RefusedByRule(repos.map(describeDuplicate).join('; '));
    }
    return new BoardDirectory(assignments.map(placementOf));
  }

  /** Every board, in the order the configuration lists them. */
  boards(): readonly BoardPlacement[] {
    return this.#placements;
  }

  /** Every configured repository, board by board. */
  repos(): readonly string[] {
    return this.#placements.flatMap((placement) => placement.repos);
  }

  /** The board that carries this repository, or nothing when no board does. */
  find(repoFullName: string): BoardPlacement | null {
    return this.#byRepo.get(repoFullName.trim().toLowerCase()) ?? null;
  }

  /** The board that carries this issue; a repository no board carries is refused, naming the ones that are. */
  placementOf(ref: IssueRef): BoardPlacement {
    const placement = this.find(ref.repoFullName());
    if (placement === null) {
      throw new RefusedByRule(
        `${ref.repoFullName()} is not a configured repository; this queue writes to ${this.repos().join(', ')}`,
      );
    }
    return placement;
  }

  /** The same issue, spelled the way the configuration spells its repository. */
  canonical(ref: IssueRef): IssueRef {
    return ref.canonical(this.repos());
  }
}

/** The same key for every spelling of one board. */
export function boardKeyOf(board: BoardIdentity): BoardKey {
  const key = boardNameOf(board).toLowerCase();
  return key as BoardKey;
}

/** `owner/number`, spelled as given. */
export function boardNameOf(board: BoardIdentity): string {
  return `${board.owner}/${String(board.number)}`;
}

/** Every repository more than one board names, with the boards that name it. */
export function duplicateRepositories(assignments: readonly BoardAssignment[]): DuplicateRepository[] {
  const named = new Map<string, { repo: string; boards: string[] }>();
  for (const assignment of assignments) {
    for (const repo of assignment.repos) {
      const key = repo.toLowerCase();
      const entry = named.get(key) ?? { repo, boards: [] };
      entry.boards.push(boardNameOf(assignment));
      named.set(key, entry);
    }
  }
  return [...named.values()].filter((entry) => entry.boards.length > 1);
}

/** Every board listed more than once, named once each. */
export function duplicateBoards(assignments: readonly BoardAssignment[]): string[] {
  const counted = new Map<BoardKey, { name: string; times: number }>();
  for (const assignment of assignments) {
    const key = boardKeyOf(assignment);
    const entry = counted.get(key) ?? { name: boardNameOf(assignment), times: 0 };
    entry.times += 1;
    counted.set(key, entry);
  }
  return [...counted.values()].filter((entry) => entry.times > 1).map((entry) => entry.name);
}

export function describeDuplicate(duplicate: DuplicateRepository): string {
  return `${duplicate.repo} is named by ${duplicate.boards.join(' and ')}; a repository belongs to exactly one board`;
}

function placementOf(assignment: BoardAssignment): BoardPlacement {
  const board: BoardIdentity = {
    owner: assignment.owner,
    number: assignment.number,
    ownerType: assignment.ownerType,
  };
  return { board, key: boardKeyOf(board), name: boardNameOf(board), repos: [...assignment.repos] };
}
