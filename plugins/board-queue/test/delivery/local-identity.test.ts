import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { localIdentity } from '../../src/delivery/local-identity.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { AppIdentity } from '../../src/infrastructure/app-identity.ts';
import { GhCliIdentity } from '../../src/infrastructure/gh-cli-identity.ts';
import { writeAppKey } from '../fixtures/app-key.ts';
import { testDirectory } from '../fixtures/config.ts';
import { FakeFetch } from '../fakes/fake-fetch.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';

const [BOARD] = testDirectory.boards();

describe('whose login a worker is judged by', () => {
  let directory = '';
  let keyPath = '';

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-identity-'));
    keyPath = writeAppKey(directory).path;
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function identityFor(env: Record<string, string | undefined>, fetcher = new FakeFetch(), mirrorOwner = 'alice') {
    if (BOARD === undefined) {
      throw new Error('the test configuration names no board');
    }
    return localIdentity({ env, mirrorOwner, board: BOARD, clock: new FakeClock(), fetchImpl: fetcher.fetch });
  }

  it('is a person\'s command line login unless the environment says otherwise', () => {
    assert.ok(identityFor({}) instanceof GhCliIdentity);
    assert.ok(identityFor({ BOARD_QUEUE_IDENTITY: ' ' }) instanceof GhCliIdentity);
    assert.ok(identityFor({ BOARD_QUEUE_IDENTITY: 'gh' }) instanceof GhCliIdentity);
  });

  it('never stands for an App on a person\'s machine, whatever its command line tool is signed in as', async () => {
    const identity = identityFor({}, new FakeFetch(), 'example-sync[bot]');

    await assert.rejects(() => identity.login(), (error: unknown) => {
      assert.ok(error instanceof RefusedByRule);
      assert.match(error.describe(), /the configured owner, example-sync\[bot\], is a GitHub App; a person's machine never runs as one/);
      return true;
    });
  });

  it('is the App\'s own login, read with its key, when the service says so', async () => {
    const fetcher = new FakeFetch([{ body: { slug: 'example-sync' } }]);
    const identity = identityFor({
      BOARD_QUEUE_IDENTITY: 'app',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    }, fetcher, 'example-sync[bot]');

    assert.ok(identity instanceof AppIdentity);
    assert.equal(await identity.login(), 'example-sync[bot]');
    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/app');
  });

  it('answers nothing it could pass for, on a machine that holds no App key', async () => {
    const identity = identityFor({ BOARD_QUEUE_IDENTITY: 'app' });

    await assert.rejects(() => identity.login(), RefusedByRule);
  });

  it('refuses a source it does not know, by name', () => {
    assert.throws(() => identityFor({ BOARD_QUEUE_IDENTITY: 'service' }), (error: unknown) => {
      assert.ok(error instanceof RefusedByRule);
      assert.match(error.describe(), /BOARD_QUEUE_IDENTITY is "service", which names no identity; it is one of: gh, app/);
      return true;
    });
  });
});
