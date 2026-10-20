import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsWriting, withdrawalOf } from '../../src/domain/forge/commit-status.ts';
import type { CommitStatus } from '../../src/domain/forge/commit-status.ts';
import {
  advancedCursor,
  endOf,
  endToReport,
  insideTheWindow,
  isFromItsOwnRepository,
  listingFloor,
  oldestFirst,
  parsePullRef,
  pullRefOf,
  readsPastTheFloor,
} from '../../src/domain/forge/pull-requests.ts';
import { RepositoryMap } from '../../src/domain/forge/repository-map.ts';
import { finishedRunOf, isRunOfFile, runsOf } from '../../src/domain/forge/workflow-runs.ts';
import type { WorkflowRun } from '../../src/domain/forge/workflow-runs.ts';
import { pullRequest } from '../fakes/fake-forge.ts';

const REPO = 'example-org/first-repo';

describe('where a pull request\'s branch lives', () => {
  it('is its own repository, a fork, or gone', () => {
    assert.equal(isFromItsOwnRepository(pullRequest(REPO, 1)), true);
    assert.equal(isFromItsOwnRepository(pullRequest(REPO, 1, { headRepo: 'someone/first-repo' })), false);
    assert.equal(isFromItsOwnRepository(pullRequest(REPO, 1, { headRepo: null })), false);
  });

  it('is handled oldest update first', () => {
    const later = pullRequest(REPO, 1, { updatedAt: new Date('2026-03-02T09:05:00Z') });
    const earlier = pullRequest(REPO, 2, { updatedAt: new Date('2026-03-02T09:01:00Z') });
    assert.deepEqual(oldestFirst([later, earlier]).map((pull) => pull.number), [2, 1]);
  });
});

describe('a status taken back', () => {
  it('is a success saying it is no longer checked, and nothing for a success', () => {
    assert.deepEqual(withdrawalOf({ state: 'failure', description: 'Frozen.', context: 'dibs' }), {
      state: 'success',
      description: 'no longer checked by dibs',
      context: 'dibs',
    });
    assert.equal(withdrawalOf({ state: 'success', description: 'Nothing freezes main.', context: 'dibs' }), null);
  });
});

describe('how a pull request ended', () => {
  it('is nothing while open, a merge with a merge time, and a close without one', () => {
    assert.equal(endOf(pullRequest(REPO, 1)), null);
    assert.equal(endOf(pullRequest(REPO, 2, { state: 'closed', mergedAt: new Date() })), 'merged');
    assert.equal(endOf(pullRequest(REPO, 3, { state: 'closed' })), 'closed');
  });

  it('is to be reported until the server was told that very end', () => {
    const merged = pullRequest(REPO, 2, { state: 'closed', mergedAt: new Date() });
    assert.equal(endToReport(merged, null), 'merged');
    assert.equal(endToReport(merged, 'merged'), null);
    assert.equal(endToReport(merged, 'closed'), 'merged', 'closed, reopened and merged');
    assert.equal(endToReport(pullRequest(REPO, 1), 'closed'), null);
  });
});

describe('a pull request\'s name on the coordination server', () => {
  it('is written in lower case and read back from any case, without leading zeros', () => {
    assert.equal(pullRefOf('Example-Org/First-Repo', 12), 'example-org/first-repo#12');
    assert.deepEqual(parsePullRef('Example-Org/First-Repo#012'), { repo: 'example-org/first-repo', number: 12 });
    assert.equal(parsePullRef('first-repo#12'), null);
    assert.equal(parsePullRef('example-org/first-repo#0'), null);
    assert.equal(parsePullRef('example-org/first-repo'), null);
  });
});

describe('the window a listing reads', () => {
  const cursor = new Date('2026-03-02T09:00:00Z');
  const floor = listingFloor(cursor, 10 * 60 * 1000);

  it('reaches back past the cursor by the overlap', () => {
    assert.equal(floor.toISOString(), '2026-03-02T08:50:00.000Z');
    assert.equal(insideTheWindow(floor, pullRequest(REPO, 1, { updatedAt: new Date('2026-03-02T08:50:00Z') })), true);
    assert.equal(insideTheWindow(floor, pullRequest(REPO, 1, { updatedAt: new Date('2026-03-02T08:49:59Z') })), false);
  });

  it('ends at the first page that reaches past it', () => {
    const recent = pullRequest(REPO, 1, { updatedAt: new Date('2026-03-02T09:01:00Z') });
    const old = pullRequest(REPO, 2, { updatedAt: new Date('2026-03-02T08:00:00Z') });
    assert.equal(readsPastTheFloor(floor, [recent]), false);
    assert.equal(readsPastTheFloor(floor, [recent, old]), true);
  });

  it('moves the cursor to the newest update read, never back', () => {
    const older = pullRequest(REPO, 1, { updatedAt: new Date('2026-03-02T08:55:00Z') });
    const newer = pullRequest(REPO, 2, { updatedAt: new Date('2026-03-02T09:03:00Z') });
    assert.equal(advancedCursor(cursor, [older]).toISOString(), cursor.toISOString());
    assert.equal(advancedCursor(cursor, [older, newer]).toISOString(), '2026-03-02T09:03:00.000Z');
    assert.equal(advancedCursor(cursor, []).toISOString(), cursor.toISOString());
  });
});

describe('a commit status', () => {
  const quiet: CommitStatus = { state: 'success', description: 'Nothing freezes main.', context: 'dibs' };

  it('is written when there is none, or when its state, description or context differs', () => {
    assert.equal(needsWriting(null, quiet), true);
    assert.equal(needsWriting(quiet, { ...quiet }), false);
    assert.equal(needsWriting(quiet, { ...quiet, state: 'failure' }), true);
    assert.equal(needsWriting(quiet, { ...quiet, description: 'Frozen until 14:40.' }), true);
    assert.equal(needsWriting(quiet, { ...quiet, context: 'freeze' }), true);
  });
});

describe('the run a hold waits for', () => {
  const sha = 'abc1234def0000000000000000000000000000000';

  function run(overrides: Partial<WorkflowRun>): WorkflowRun {
    return {
      id: 1,
      path: '.github/workflows/deploy.yml',
      name: 'Deploy',
      status: 'completed',
      conclusion: 'success',
      createdAt: new Date('2026-03-02T09:00:00Z'),
      headSha: sha,
      ...overrides,
    };
  }

  it('belongs to the workflow named by its file or its path, never by a part of one', () => {
    assert.equal(isRunOfFile(run({}), 'deploy.yml'), true);
    assert.equal(isRunOfFile(run({}), '.github/workflows/deploy.yml'), true);
    assert.equal(isRunOfFile(run({ path: '.github/workflows/deploy.yml@refs/heads/main' }), 'deploy.yml'), true);
    assert.equal(isRunOfFile(run({}), 'deploy'), false);
    assert.equal(isRunOfFile(run({ path: null }), 'deploy.yml'), false);
  });

  it('is found by its display name only when no file matches and exactly one workflow carries the name', () => {
    const deploy = run({ id: 1 });
    const again = run({ id: 2 });
    const other = run({ id: 3, path: '.github/workflows/deploy-staging.yml' });
    assert.deepEqual(runsOf([deploy, again], 'Deploy').map((one) => one.id), [1, 2]);
    assert.deepEqual(runsOf([deploy, other], 'Deploy'), [], 'two workflows carry the name');
    assert.deepEqual(runsOf([deploy, run({ id: 4, name: 'deploy.yml', path: '.github/workflows/ci.yml' })], 'deploy.yml')
      .map((one) => one.id), [1], 'the file wins over a name');
  });

  it('ended when the latest run of its own workflow for its commit completed', () => {
    assert.deepEqual(finishedRunOf([run({})], 'deploy.yml', 'abc1234'), { conclusion: 'success' });
    assert.equal(finishedRunOf([run({ status: 'in_progress', conclusion: null })], 'deploy.yml', 'abc1234'), null);
    assert.equal(finishedRunOf([run({ path: '.github/workflows/ci.yml', name: 'CI' })], 'deploy.yml', 'abc1234'), null);
    assert.equal(finishedRunOf([run({ headSha: 'f'.repeat(40) })], 'deploy.yml', 'abc1234'), null);
  });

  it('is not ended by an older run while a later one is still going', () => {
    const runs = [
      run({ id: 1, createdAt: new Date('2026-03-02T09:00:00Z'), conclusion: 'failure' }),
      run({ id: 2, createdAt: new Date('2026-03-02T09:10:00Z'), status: 'queued', conclusion: null }),
    ];
    assert.equal(finishedRunOf(runs, 'deploy.yml', sha), null);
  });
});

describe('which repository of the server a forge repository is', () => {
  it('is matched through the path of its remote, in any case', () => {
    const map = RepositoryMap.of(
      [{ id: 'web', remotePath: 'Example-Org/First-Repo' }, { id: 'api', remotePath: 'example-org/second-repo' }],
      [REPO, 'example-org/third-repo'],
    );

    assert.equal(map.idOf('EXAMPLE-ORG/first-repo'), 'web');
    assert.equal(map.idOf('example-org/second-repo'), null, 'not kept in step');
    assert.equal(map.idOf('example-org/third-repo'), null, 'not listed by the server');
  });

  it('takes the one repository of a project that lists none for the one repository kept in step, and only then', () => {
    assert.equal(RepositoryMap.of([{ id: 'default', remotePath: null }], [REPO]).idOf(REPO), 'default');
    assert.equal(RepositoryMap.of([{ id: 'default', remotePath: null }], [REPO, 'example-org/other']).idOf(REPO), null);
  });
});
