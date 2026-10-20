import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import { loadConfig } from '../../src/infrastructure/config-file.ts';

const examplePath = fileURLToPath(new URL('../../config.example.json', import.meta.url));

const ORG = { owner: 'example-org', number: 1, ownerType: 'organization', repos: ['example-org/first-repo'] };
const USER = { owner: 'example-user', number: 3, ownerType: 'user', repos: ['example-user/third-repo'] };

/** Every sentence the schema refused with. */
function refusalsOf(input: unknown): string[] {
  const parsed = ConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('ConfigSchema', () => {
  it('lets the example the package ships be copied and used as it stands', () => {
    const config = loadConfig({ BOARD_QUEUE_CONFIG: examplePath });
    assert.ok(BoardDirectory.of(config.boards).repos().length >= 1);
  });

  it('fills in the worker numbers nobody stated', () => {
    const parsed = ConfigSchema.parse({ boards: [USER], fields: ['Status'] });
    assert.deepEqual(parsed.refusedStatus, []);
    assert.equal(parsed.worker.graphqlFloor, 500);
    assert.equal(parsed.worker.paceMs, 1500);
    assert.equal(parsed.worker.maxAttempts, 5);
  });

  it('keeps each board with the repositories it carries', () => {
    const parsed = ConfigSchema.parse({ boards: [ORG, USER], fields: ['Status'] });
    assert.deepEqual(parsed.boards.map((board) => [board.owner, board.ownerType, board.repos]), [
      ['example-org', 'organization', ['example-org/first-repo']],
      ['example-user', 'user', ['example-user/third-repo']],
    ]);
  });

  it('refuses a configuration that would send writes somewhere unintended', () => {
    const base = { boards: [ORG], fields: ['Status'] };
    assert.ok(ConfigSchema.safeParse(base).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, boards: [{ ...ORG, repos: ['first-repo'] }] }).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, boards: [{ ...ORG, repos: [] }] }).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, boards: [] }).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, boards: [{ ...ORG, ownerType: 'team' }] }).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, boards: [{ ...ORG, number: 0 }] }).success);
    assert.ok(!ConfigSchema.safeParse({ ...base, extra: true }).success);
  });

  it('refuses the single-board shape it no longer reads, rather than guessing which board was meant', () => {
    assert.ok(!ConfigSchema.safeParse({
      board: { owner: 'example-org', number: 1, ownerType: 'organization' },
      repos: ['example-org/first-repo'],
      fields: ['Status'],
    }).success);
  });

  it('refuses a repository two boards claim, naming it and both boards', () => {
    const refusals = refusalsOf({
      boards: [ORG, { ...USER, repos: ['Example-Org/First-Repo', 'example-user/third-repo'] }],
      fields: ['Status'],
    });
    assert.deepEqual(refusals, [
      'example-org/first-repo is named by example-org/1 and example-user/3; a repository belongs to exactly one board',
    ]);
  });

  it('refuses a board listed twice', () => {
    const refusals = refusalsOf({ boards: [ORG, { ...ORG, owner: 'Example-Org', repos: ['example-org/other'] }], fields: ['Status'] });
    assert.deepEqual(refusals, ['example-org/1 is configured more than once; list each board once']);
  });
});

describe('keeping in step with a coordination server', () => {
  const dibs = {
    server: 'https://dibs.example.com/',
    project: 'widgets',
    tokenEnv: 'DIBS_TOKEN',
    mirrorOwner: 'alice',
    repos: ['example-org/first-repo'],
  };

  it('keeps both directions off unless the configuration turns one on', () => {
    const parsed = ConfigSchema.parse({ boards: [ORG], fields: ['Status'], dibs });
    assert.equal(parsed.dibs?.mirror, undefined);
    assert.equal(parsed.dibs?.importer.enabled, false);
    assert.equal(parsed.dibs?.server, 'https://dibs.example.com', 'the address is kept without its trailing slash');
  });

  it('fills in the importer\'s pacing and its Severity table', () => {
    const parsed = ConfigSchema.parse({ boards: [ORG], fields: ['Status'], dibs });
    assert.equal(parsed.dibs?.importer.everyMinutes, 15);
    assert.equal(parsed.dibs?.importer.maxRequestsPerTick, 100);
    assert.equal(parsed.dibs?.importer.paceMs, 1000);
    assert.deepEqual(parsed.dibs?.importer.priorities, { S1: 0, S2: 1, S3: 2, S4: 3 });
  });

  it('refuses a server address that carries a user or a password', () => {
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: { ...dibs, server: 'https://bot:secret@dibs.example.com' } })
      .some((message) => message.includes('without a user or password')));
  });

  it('refuses a repository no board carries', () => {
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: { ...dibs, repos: ['example-user/third-repo'] } })
      .some((message) => message.includes('no board carries it')));
  });

  it('refuses a configuration that names no owner, and a token written in place of its variable', () => {
    const { mirrorOwner: _owner, ...ownerless } = dibs;
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: ownerless }).length > 0);
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: { ...dibs, tokenEnv: 'dibs_abcdef' } }).length > 0);
  });

  it('refuses a mirror that names no claimed or released status', () => {
    const mirror = { enabled: true, status: { claimed: 'In Progress' } };
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: { ...dibs, mirror } }).length > 0);
  });

  it('refuses an import cadence that would read the board more often than every quarter of an hour', () => {
    assert.ok(refusalsOf({ boards: [ORG], fields: ['Status'], dibs: { ...dibs, importer: { everyMinutes: 5 } } })
      .length > 0);
  });
});
