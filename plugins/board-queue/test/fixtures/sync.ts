import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';
import type { SyncConfig } from '../../src/domain/sync-config.ts';
import { testConfig } from './config.ts';

export const SERVER = 'https://dibs.example.com';
export const OWNER = 'alice';

/**
 * The test configuration with both directions of keeping in step switched on, for
 * one of its two repositories, run by alice's worker.
 */
export const syncConfig: Config = ConfigSchema.parse({
  ...testConfig,
  dibs: {
    server: `${SERVER}/`,
    project: 'widgets',
    tokenEnv: 'DIBS_TEST_TOKEN',
    mirrorOwner: OWNER,
    repos: ['example-org/first-repo'],
    mirror: {
      enabled: true,
      status: { claimed: 'In Progress', released: 'Todo', review: 'In Review' },
    },
    importer: {
      enabled: true,
      modules: { Checkout: ['checkout'], Catalog: ['web:catalog', 'api:catalog'] },
    },
  },
});

export function syncOf(config: Config = syncConfig): SyncConfig {
  const sync = config.dibs;
  if (sync === undefined) {
    throw new Error('the configuration keeps nothing in step');
  }
  return sync;
}
