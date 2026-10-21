import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { ConfigSchema } from '../../src/domain/config.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { dibsToken } from '../../src/infrastructure/dibs-token.ts';
import { syncConfig, syncOf } from '../fixtures/sync.ts';

const TOKEN = 'dibs_tokentokentokentokentokentokentoken';

function withToken(token: unknown) {
  return syncOf(ConfigSchema.parse({ ...syncConfig, dibs: { ...syncConfig.dibs, token } }));
}

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-dibs-token-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

describe('the coordination server\'s token, from the source the configuration names', () => {
  it('is the variable the older tokenEnv names', () => {
    assert.equal(dibsToken(syncOf(), { DIBS_TEST_TOKEN: TOKEN })(), TOKEN);
  });

  it('is the variable an env source names, or the file its _FILE twin names', (t) => {
    const directory = scratch(t);
    const file = join(directory, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    chmodSync(file, 0o600);
    const sync = withToken({ from: 'env', env: 'DIBS_LAPTOP_TOKEN' });

    assert.equal(dibsToken(sync, { DIBS_LAPTOP_TOKEN: TOKEN })(), TOKEN);
    assert.equal(dibsToken(sync, { DIBS_LAPTOP_TOKEN_FILE: file })(), TOKEN);
  });

  it('is the login the dibs tool stored for the configured server and project', (t) => {
    const directory = scratch(t);
    const file = join(directory, 'credentials.toml');
    writeFileSync(file, `[[credential]]\nserver = "https://dibs.example.com"\nproject = "widgets"\ntoken = "${TOKEN}"\n`);
    chmodSync(file, 0o600);

    assert.equal(dibsToken(withToken({ from: 'dibs-login' }), { DIBS_CONFIG_DIR: directory })(), TOKEN);
  });

  it('is asked for only when a call needs it', () => {
    const read = dibsToken(withToken({ from: 'dibs-login' }), { DIBS_CONFIG_DIR: '/nowhere' });

    assert.throws(read, RefusedByRule);
  });
});
