import type { LaneFactory, LaneGateways } from '../../src/application/board-router.ts';
import type { BoardKey } from '../../src/domain/board-directory.ts';

/** Hands each configured board the gateways a test set aside for it, and fails loudly for a board it did not. */
export function lanesByBoard(lanes: ReadonlyMap<BoardKey, LaneGateways>): LaneFactory {
  return (placement) => {
    const lane = lanes.get(placement.key);
    if (lane === undefined) {
      throw new Error(`the test set no gateways aside for the board ${placement.name}`);
    }
    return lane;
  };
}
