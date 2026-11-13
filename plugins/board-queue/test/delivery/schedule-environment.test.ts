import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { carriedEnvironment, disk, installSearchPath } from '../../src/delivery/schedule-environment.ts';
import type { PlaceProbe } from '../../src/delivery/schedule-environment.ts';

const INSTALLED_FROM = '/home/acme/work';

/** Every value below is made of two literals so that nothing scanning for secrets sees a whole one. */
const GH_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_TEXT = '-----BEGIN' + ' RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
/** A key as the variable usually carries one: its text in base64, which looks like a relative path. */
const KEY_BASE64 = 'LS0tLS1CRUdJTiBSU0Eg' + 'UFJJVkFURSBLRVktLS0tLQ';

/** A disk that holds exactly these files and directories. */
function holding(files: readonly string[], directories: readonly string[] = []): PlaceProbe {
  return {
    isFile: (file) => files.includes(file),
    isDirectory: (directory) => directories.includes(directory),
  };
}

const KEY_FILE = '/home/acme/keys/app.pem';
const TOKEN_FILE = '/home/acme/secrets/dibs-token';
const SECRETS = holding([KEY_FILE, TOKEN_FILE, '/home/acme/work/keys/app.pem']);

function refusedNaming(name: string, hidden: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RefusedByRule);
    assert.match(error.describe(), new RegExp(name));
    assert.equal(error.describe().includes(hidden), false, 'the refusal repeats what the variable holds');
    return true;
  };
}

describe('the environment an install hands to its scheduled pass', () => {
  it('carries every variable that says where the configuration, the queue and the credentials are', () => {
    const carried = carriedEnvironment({
      BOARD_QUEUE_CONFIG: '/home/acme/boards/config.json',
      BOARD_QUEUE_STATE_DIR: '/home/acme/state/second',
      BOARD_QUEUE_ENV: '/home/acme/secrets/board-queue.env',
      BOARD_QUEUE_IDENTITY: 'app',
      XDG_CONFIG_HOME: '/home/acme/xdg',
      DIBS_CONFIG_DIR: '/home/acme/dibs',
      GH_CONFIG_DIR: '/home/acme/gh',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '678',
      GITHUB_APP_PRIVATE_KEY_PATH: KEY_FILE,
      HOME: '/home/acme',
      PATH: '/usr/bin',
    }, INSTALLED_FROM, [], SECRETS);

    assert.deepEqual(carried, [
      ['BOARD_QUEUE_CONFIG', '/home/acme/boards/config.json'],
      ['BOARD_QUEUE_ENV', '/home/acme/secrets/board-queue.env'],
      ['BOARD_QUEUE_IDENTITY', 'app'],
      ['BOARD_QUEUE_STATE_DIR', '/home/acme/state/second'],
      ['DIBS_CONFIG_DIR', '/home/acme/dibs'],
      ['GH_CONFIG_DIR', '/home/acme/gh'],
      ['GITHUB_APP_ID', '12345'],
      ['GITHUB_APP_INSTALLATION_ID', '678'],
      ['GITHUB_APP_PRIVATE_KEY_PATH', KEY_FILE],
      ['XDG_CONFIG_HOME', '/home/acme/xdg'],
    ]);
  });

  it('carries nothing for a variable that is unset or empty', () => {
    assert.deepEqual(carriedEnvironment({ BOARD_QUEUE_CONFIG: '  ', XDG_CONFIG_HOME: '' }, INSTALLED_FROM), []);
  });

  it('resolves a relative path against the directory the install ran in, which the job does not start in', () => {
    const carried = carriedEnvironment({ BOARD_QUEUE_CONFIG: 'boards/config.json' }, INSTALLED_FROM);

    assert.deepEqual(carried, [['BOARD_QUEUE_CONFIG', '/home/acme/work/boards/config.json']]);
  });

  it('leaves out a relative configuration home, which the pass would not honour either', () => {
    assert.deepEqual(carriedEnvironment({ XDG_CONFIG_HOME: 'xdg' }, INSTALLED_FROM), []);
  });

  it('never carries a variable that holds a token', () => {
    const carried = carriedEnvironment({
      GH_TOKEN,
      GITHUB_TOKEN: GH_TOKEN,
      DIBS_LAPTOP_TOKEN: GH_TOKEN,
      DIBS_LAPTOP_TOKEN_FILE: TOKEN_FILE,
    }, INSTALLED_FROM, ['DIBS_LAPTOP_TOKEN_FILE'], SECRETS);

    assert.deepEqual(carried, [['DIBS_LAPTOP_TOKEN_FILE', TOKEN_FILE]]);
  });

  it('holds every token file variable the configuration names to a file, whatever its name says', () => {
    const named = carriedEnvironment({ DIBS_SECRET_FILE: TOKEN_FILE }, INSTALLED_FROM, ['DIBS_SECRET_FILE'], SECRETS);

    assert.deepEqual(named, [['DIBS_SECRET_FILE', TOKEN_FILE]]);
    assert.throws(
      () => carriedEnvironment({ DIBS_SECRET_FILE: GH_TOKEN }, INSTALLED_FROM, ['DIBS_SECRET_FILE'], SECRETS),
      refusedNaming('DIBS_SECRET_FILE', GH_TOKEN),
    );
  });

  it('carries the older key variable while it names a file, as the pass reads it', () => {
    const carried = carriedEnvironment({ GITHUB_APP_PRIVATE_KEY: 'keys/app.pem' }, INSTALLED_FROM, [], SECRETS);

    assert.deepEqual(carried, [['GITHUB_APP_PRIVATE_KEY', '/home/acme/work/keys/app.pem']]);
  });

  it('refuses a key variable that holds the key itself, and does not repeat it', () => {
    for (const name of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH']) {
      assert.throws(() => carriedEnvironment({ [name]: KEY_TEXT }, INSTALLED_FROM, [], SECRETS),
        refusedNaming(name, 'MIIEow'));
    }
  });

  it('refuses a key held as base64, which names no file, and never writes it anywhere', () => {
    for (const name of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH']) {
      assert.throws(() => carriedEnvironment({ [name]: KEY_BASE64 }, INSTALLED_FROM, [], SECRETS),
        refusedNaming(name, KEY_BASE64));
    }
  });

  it('refuses a token file variable that names no file, since the pass could read no token from it', () => {
    assert.throws(
      () => carriedEnvironment({ DIBS_LAPTOP_TOKEN_FILE: GH_TOKEN }, INSTALLED_FROM, ['DIBS_LAPTOP_TOKEN_FILE'], SECRETS),
      refusedNaming('DIBS_LAPTOP_TOKEN_FILE', GH_TOKEN),
    );
  });

  it('asks the disk itself whether a key names a file, and a directory is not one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-environment-'));
    try {
      const key = join(directory, 'app.pem');
      writeFileSync(key, 'not a real key', 'utf8');
      mkdirSync(join(directory, 'keys'));

      assert.deepEqual(carriedEnvironment({ GITHUB_APP_PRIVATE_KEY: 'app.pem' }, directory),
        [['GITHUB_APP_PRIVATE_KEY', key]]);
      assert.throws(() => carriedEnvironment({ GITHUB_APP_PRIVATE_KEY: 'keys' }, directory), RefusedByRule);
      assert.throws(() => carriedEnvironment({ GITHUB_APP_PRIVATE_KEY: 'missing.pem' }, directory), RefusedByRule);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the search path an install hands to its scheduled pass', () => {
  it('keeps the absolute directories that exist, each once, in the order the install had them', () => {
    const directories = holding([], ['/home/acme/.local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin']);

    const kept = installSearchPath(
      '/home/acme/.local/bin:bin:/nowhere:/home/linuxbrew/.linuxbrew/bin::/home/acme/.local/bin:/usr/bin',
      directories,
    );

    assert.deepEqual(kept, ['/home/acme/.local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin']);
  });

  it('keeps nothing when the install had no search path', () => {
    assert.deepEqual(installSearchPath(undefined, holding([], ['/usr/bin'])), []);
  });

  it('asks the disk whether each directory is there', () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-search-path-'));
    try {
      const file = join(directory, 'not-a-directory');
      writeFileSync(file, '', 'utf8');

      assert.deepEqual(installSearchPath(`${directory}:${file}:${join(directory, 'gone')}`, disk), [directory]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
