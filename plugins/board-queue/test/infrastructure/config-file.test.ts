import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { configPath, loadConfig } from '../../src/infrastructure/config-file.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';

const GOOD = {
  boards: [{ owner: 'example-org', number: 7, ownerType: 'organization', repos: ['example-org/first-repo'] }],
  fields: ['Status', 'Severity'],
  refusedStatus: ['Done'],
};

function withFile(contents: string, run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-config-'));
  const file = join(directory, 'config.json');
  writeFileSync(file, contents);
  try {
    run(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'board-queue-home-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('the file that says what this queue may touch', () => {
  it('reads the boards, the repositories each carries and the worker numbers, filling in what was left out', () => {
    withFile(JSON.stringify(GOOD), (file) => {
      const config = loadConfig({ BOARD_QUEUE_CONFIG: file });

      assert.equal(config.boards[0]?.owner, 'example-org');
      assert.equal(config.boards[0]?.number, 7);
      assert.deepEqual(config.boards[0]?.repos, ['example-org/first-repo']);
      assert.equal(config.worker.graphqlFloor, 500);
      assert.equal(config.worker.perTickCap, 40);
    });
  });

  it('looks in the configuration directory when the environment names no file', () => {
    assert.equal(configPath({ HOME: '/home/someone' }), '/home/someone/.config/board-queue/config.json');
    assert.equal(configPath({ HOME: '/home/someone', XDG_CONFIG_HOME: '/etc/xdg-of-someone' }),
      '/etc/xdg-of-someone/board-queue/config.json');
    assert.equal(configPath({ HOME: '/home/someone', XDG_CONFIG_HOME: 'relative/dir' }),
      '/home/someone/.config/board-queue/config.json');
    assert.equal(configPath({ BOARD_QUEUE_CONFIG: '/somewhere/else.json' }), '/somewhere/else.json');
    assert.equal(configPath({ HOME: '/home/someone', BOARD_QUEUE_CONFIG: '  ' }),
      '/home/someone/.config/board-queue/config.json');
  });

  it('reads a configuration left at its previous location once, copies it over and says it moved', () => {
    withHome((home) => {
      const previous = join(home, '.claude', 'tools', 'board-queue', 'config.json');
      const current = join(home, '.config', 'board-queue', 'config.json');
      mkdirSync(dirname(previous), { recursive: true });
      writeFileSync(previous, JSON.stringify(GOOD));
      const said: string[] = [];

      const first = loadConfig({ HOME: home }, (line) => said.push(line));
      const second = loadConfig({ HOME: home }, (line) => said.push(line));

      assert.equal(first.boards[0]?.owner, 'example-org');
      assert.equal(second.boards[0]?.owner, 'example-org');
      assert.equal(readFileSync(current, 'utf8'), JSON.stringify(GOOD));
      assert.equal(said.length, 1, 'only the run that moved it says so');
      const line = said[0] ?? '';
      assert.ok(line.includes(previous) && line.includes(current), line);
      assert.match(line, /moved/);
    });
  });

  it('prefers the current location over a previous one, and says nothing', () => {
    withHome((home) => {
      const previous = join(home, '.claude', 'tools', 'board-queue', 'config.json');
      const current = join(home, '.config', 'board-queue', 'config.json');
      mkdirSync(dirname(previous), { recursive: true });
      mkdirSync(dirname(current), { recursive: true });
      writeFileSync(previous, JSON.stringify({ ...GOOD, boards: [{ ...GOOD.boards[0], number: 99 }] }));
      writeFileSync(current, JSON.stringify(GOOD));
      const said: string[] = [];

      const config = loadConfig({ HOME: home }, (line) => said.push(line));

      assert.equal(config.boards[0]?.number, 7);
      assert.deepEqual(said, []);
    });
  });

  it('reads only the named file when the environment names one, never a previous location', () => {
    withHome((home) => {
      const previous = join(home, '.claude', 'tools', 'board-queue', 'config.json');
      mkdirSync(dirname(previous), { recursive: true });
      writeFileSync(previous, JSON.stringify(GOOD));

      assert.throws(
        () => loadConfig({ HOME: home, BOARD_QUEUE_CONFIG: join(home, 'named.json') }, () => undefined),
        (error: unknown) => error instanceof RefusedByRule && error.describe().includes(join(home, 'named.json')),
      );
      assert.equal(existsSync(join(home, '.config', 'board-queue', 'config.json')), false);
    });
  });

  it('keeps using a previous configuration it cannot copy, and says where it belongs', () => {
    withHome((home) => {
      const previous = join(home, '.claude', 'tools', 'board-queue', 'config.json');
      mkdirSync(dirname(previous), { recursive: true });
      writeFileSync(previous, JSON.stringify(GOOD));
      // A file where the directory should be makes the copy impossible.
      writeFileSync(join(home, '.config'), '');
      const said: string[] = [];

      const config = loadConfig({ HOME: home }, (line) => said.push(line));

      assert.equal(config.boards[0]?.owner, 'example-org');
      assert.equal(said.length, 1);
      assert.match(said[0] ?? '', /could not be copied/);
    });
  });

  it('does not copy a previous configuration that is not usable', () => {
    withHome((home) => {
      const previous = join(home, '.claude', 'tools', 'board-queue', 'config.json');
      mkdirSync(dirname(previous), { recursive: true });
      writeFileSync(previous, '{ not json');

      assert.throws(
        () => loadConfig({ HOME: home }, () => undefined),
        (error: unknown) => error instanceof RefusedByRule && error.describe().includes(previous),
      );
      assert.equal(existsSync(join(home, '.config', 'board-queue', 'config.json')), false);
    });
  });

  it('says what to copy when there is no file at all', () => {
    assert.throws(
      () => loadConfig({ BOARD_QUEUE_CONFIG: '/nowhere/board-queue/config.json' }, () => undefined),
      (error: unknown) => error instanceof RefusedByRule
        && /config\.example\.json/.test(error.describe())
        && error.describe().includes('/nowhere/board-queue/config.json'),
    );
  });

  it('refuses a file that is not readable JSON', () => {
    withFile('{ this is not json', (file) => {
      assert.throws(
        () => loadConfig({ BOARD_QUEUE_CONFIG: file }),
        (error: unknown) => error instanceof RefusedByRule && /not readable JSON/.test(error.describe()),
      );
    });
  });

  it('names what is wrong with a file that is JSON but not a configuration', () => {
    const misnamed = { ...GOOD, boards: [{ ...GOOD.boards[0], repos: ['not-a-repository'] }] };
    withFile(JSON.stringify(misnamed), (file) => {
      assert.throws(
        () => loadConfig({ BOARD_QUEUE_CONFIG: file }),
        (error: unknown) => error instanceof RefusedByRule
          && /boards\.0\.repos\.0: a repository is written owner\/name/.test(error.describe()),
      );
    });
  });

  it('refuses at load a repository that two boards claim, before anything is filed against either', () => {
    const claimedTwice = {
      ...GOOD,
      boards: [
        ...GOOD.boards,
        { owner: 'example-user', number: 3, ownerType: 'user', repos: ['example-org/first-repo'] },
      ],
    };
    withFile(JSON.stringify(claimedTwice), (file) => {
      assert.throws(
        () => loadConfig({ BOARD_QUEUE_CONFIG: file }),
        (error: unknown) => error instanceof RefusedByRule
          && error.describe().includes('boards: example-org/first-repo is named by example-org/7 and example-user/3'),
      );
    });
  });
});
