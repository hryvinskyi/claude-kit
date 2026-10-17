import type { BoardDirectory, BoardKey, BoardPlacement } from '../domain/board-directory.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { RateBudget } from '../domain/rate-budget.ts';
import type { BoardGateway, IssueGateway } from './ports.ts';

/** The two gateways that reach one board and the issues of the repositories it carries. */
export type LaneGateways = {
  readonly board: BoardGateway;
  readonly issues: IssueGateway;
};

/** One board with the gateways that reach it, as everything that works on a board is handed it. */
export type BoardLane = LaneGateways & {
  readonly placement: BoardPlacement;
};

/** Builds the gateways for one configured board; asked once per board, when the router is built. */
export type LaneFactory = (placement: BoardPlacement) => LaneGateways;

/**
 * Sends the work on an issue to the board that carries its repository.
 *
 * Each board has gateways of its own — its own catalog, its own listing, and the
 * credential of the account that owns it — so the question "which board?" is
 * answered once, here, from the directory, and nothing downstream ever asks it
 * again or compares an owner by name.
 *
 * The allowance is the one thing the boards do not divide: they are spent from one
 * account's hourly budget, so asking it is asking any of them, and the first board
 * the configuration lists is asked.
 */
export class BoardRouter {
  readonly directory: BoardDirectory;
  readonly #lanes: ReadonlyMap<BoardKey, BoardLane>;

  constructor(directory: BoardDirectory, laneOf: LaneFactory) {
    this.directory = directory;
    const lanes = new Map<BoardKey, BoardLane>();
    for (const placement of directory.boards()) {
      lanes.set(placement.key, { placement, ...laneOf(placement) });
    }
    this.#lanes = lanes;
  }

  /** Every board with its gateways, in the order the configuration lists them. */
  lanes(): readonly BoardLane[] {
    return [...this.#lanes.values()];
  }

  /** The board that carries this issue; a repository no board carries is refused, naming the ones that are. */
  laneOf(ref: IssueRef): BoardLane {
    return this.#laneAt(this.directory.placementOf(ref));
  }

  /** Asks the account's allowance through the first board. */
  probeBudget(): Promise<RateBudget> {
    return this.#first().board.probeBudget();
  }

  /** What the last answer on any board said of the account's allowance, without spending anything. */
  lastBudget(): RateBudget | null {
    for (const lane of this.#lanes.values()) {
      const budget = lane.board.lastBudget();
      if (budget !== null) {
        return budget;
      }
    }
    return null;
  }

  #first(): BoardLane {
    const [first] = this.#lanes.values();
    if (first === undefined) {
      throw new Error('a board router was built over a directory with no board');
    }
    return first;
  }

  #laneAt(placement: BoardPlacement): BoardLane {
    const lane = this.#lanes.get(placement.key);
    if (lane === undefined) {
      throw new Error(`the board ${placement.name} has no gateways; the router was built over another directory`);
    }
    return lane;
  }
}
