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
