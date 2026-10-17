import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardDirectory, boardKeyOf } from '../../src/domain/board-directory.ts';
import type { BoardAssignment } from '../../src/domain/board-directory.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';

const ORG: BoardAssignment = {
  owner: 'Example-Org',
  number: 1,
  ownerType: 'organization',
  repos: ['Example-Org/first-repo', 'example-user/second-repo'],
};
const USER: BoardAssignment = { owner: 'example-user', number: 2, ownerType: 'user', repos: ['example-user/third-repo'] };

describe('BoardDirectory', () => {
  it('sends each repository to the board that names it, however the caller spells it', () => {
    const directory = BoardDirectory.of([ORG, USER]);

    const first = directory.placementOf(IssueRef.parse('example-org/FIRST-REPO#1'));
    const third = directory.placementOf(IssueRef.parse('Example-User/Third-Repo#9'));

    assert.equal(first.name, 'Example-Org/1');
    assert.equal(first.board.ownerType, 'organization');
    assert.equal(third.name, 'example-user/2');
    assert.equal(third.board.ownerType, 'user');
    assert.notEqual(first.key, third.key);
  });

  it('answers the configuration\'s spelling of an issue on either board', () => {
    const directory = BoardDirectory.of([ORG, USER]);

    assert.equal(directory.canonical(IssueRef.parse('EXAMPLE-ORG/first-repo#3')).toString(), 'Example-Org/first-repo#3');
    assert.equal(directory.canonical(IssueRef.parse('EXAMPLE-USER/THIRD-REPO#4')).toString(), 'example-user/third-repo#4');
  });

  it('lists the boards in the order configured, and every repository board by board', () => {
    const directory = BoardDirectory.of([ORG, USER]);

    assert.deepEqual(directory.boards().map((placement) => placement.name), ['Example-Org/1', 'example-user/2']);
    assert.deepEqual(directory.repos(), ['Example-Org/first-repo', 'example-user/second-repo', 'example-user/third-repo']);
  });

  it('refuses a repository no board carries, naming every one that is', () => {
    const directory = BoardDirectory.of([ORG, USER]);

    assert.equal(directory.find('someone/else'), null);
    assert.throws(
      () => directory.placementOf(IssueRef.parse('someone/else#1')),
      (error: unknown) => error instanceof RefusedByRule
        && error.describe().includes('someone/else is not a configured repository')
        && error.describe().includes('Example-Org/first-repo, example-user/second-repo, example-user/third-repo'),
    );
    assert.throws(() => directory.canonical(IssueRef.parse('someone/else#1')), RefusedByRule);
  });

  it('refuses a repository two boards claim, naming the repository and both boards', () => {
    assert.throws(
      () => BoardDirectory.of([ORG, { ...USER, repos: ['example-org/First-Repo'] }]),
      (error: unknown) => error instanceof RefusedByRule
        && error.describe().includes('Example-Org/first-repo is named by Example-Org/1 and example-user/2'),
    );
  });

  it('refuses a board listed twice, and a configuration with no board at all', () => {
    assert.throws(
      () => BoardDirectory.of([ORG, { ...ORG, owner: 'example-org', repos: ['example-org/other'] }]),
      (error: unknown) => error instanceof RefusedByRule && /Example-Org\/1 is configured more than once/.test(error.describe()),
    );
    assert.throws(() => BoardDirectory.of([]), RefusedByRule);
  });

  it('files a board under one key whatever case its owner is written in', () => {
    assert.equal(
      boardKeyOf({ owner: 'Example-Org', number: 1, ownerType: 'organization' }),
      boardKeyOf({ owner: 'example-org', number: 1, ownerType: 'organization' }),
    );
  });
});
