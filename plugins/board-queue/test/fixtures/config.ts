import { BoardDirectory } from '../../src/domain/board-directory.ts';
import type { BoardKey } from '../../src/domain/board-directory.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';

const WORKER = {
  graphqlFloor: 100,
  perTickCap: 40,
  paceMs: 1500,
  secondaryBaseSec: 120,
  secondaryCapSec: 3600,
  maxAttempts: 5,
  catalogTtlSec: 3600,
  auditEveryHours: 6,
  auditMinRemaining: 1000,
};

const FIELDS = ['Status', 'Severity', 'Module', 'Environment', 'Defect type'];

/**
 * A configuration for the tests alone: placeholder names, one board, and one
 * repository deliberately spelled with capitals so the case rules have something
 * to prove.
 */
export const testConfig: Config = ConfigSchema.parse({
  boards: [{
    owner: 'example-org',
    number: 7,
    ownerType: 'organization',
    repos: ['example-org/first-repo', 'Example-User/second-repo'],
  }],
  fields: FIELDS,
  refusedStatus: ['Done'],
  worker: WORKER,
});

export const testDirectory: BoardDirectory = BoardDirectory.of(testConfig.boards);

/** Every configured repository of the single-board configuration, in the order it lists them. */
export const testRepos: readonly string[] = testDirectory.repos();

/** The key the single board's catalog is kept under. */
export const TEST_BOARD: BoardKey = boardKeyAt(testDirectory, 0);

/** A repository the second board of the two-board configuration carries. */
export const THIRD = 'Example-User/third-repo';

/**
 * Two boards owned by two kinds of account, each carrying its own repositories:
 * what routing has to tell apart.
 */
export const twoBoardConfig: Config = ConfigSchema.parse({
  boards: [
    {
      owner: 'example-org',
      number: 7,
      ownerType: 'organization',
      repos: ['example-org/first-repo', 'Example-User/second-repo'],
    },
    { owner: 'example-user', number: 3, ownerType: 'user', repos: [THIRD] },
  ],
  fields: FIELDS,
  refusedStatus: ['Done'],
  worker: WORKER,
});

export const twoBoardDirectory: BoardDirectory = BoardDirectory.of(twoBoardConfig.boards);

export const ORG_BOARD: BoardKey = boardKeyAt(twoBoardDirectory, 0);
export const USER_BOARD: BoardKey = boardKeyAt(twoBoardDirectory, 1);

function boardKeyAt(directory: BoardDirectory, index: number): BoardKey {
  const placement = directory.boards()[index];
  if (placement === undefined) {
    throw new Error(`the fixture has no board at ${String(index)}`);
  }
  return placement.key;
}
