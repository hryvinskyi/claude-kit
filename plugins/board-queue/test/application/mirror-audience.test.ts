import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIRROR_AUDIENCES, OwnMoves, everyone } from '../../src/application/mirror-audience.ts';
import type { LiveClaims, MemberDirectory } from '../../src/application/mirror-audience.ts';
import type { WorkMember } from '../../src/application/sync-ports.ts';
import { collapseClaims } from '../../src/domain/sync/claim-moves.ts';
import type { IssueMove, LiveState } from '../../src/domain/sync/claim-moves.ts';
import { claim } from '../fakes/fake-coordination.ts';

const NOBODY_ASKED: MemberDirectory = { members: () => Promise.reject(new Error('the members are not asked')) };
const NO_LIVE_CLAIMS_ASKED: LiveClaims = { of: () => Promise.reject(new Error('the live claims are not asked')) };

function directory(...members: WorkMember[]): MemberDirectory {
  return { members: () => Promise.resolve(members) };
}

function live(state: LiveState): LiveClaims {
  return { of: () => Promise.resolve(state) };
}

function login(value: string) {
  return { login: () => Promise.resolve(value) };
}

function claimOf(holder: string): IssueMove {
  const [move] = collapseClaims([claim(1, 'claimed', 12, holder)], { claimed: 'Doing', released: 'Todo' });
  if (move === undefined) {
    throw new Error('no move');
  }
  return move;
}

const MEMBERS = [
  { handle: 'alice', login: 'alice-gh' },
  { handle: 'bob', login: 'bob-gh' },
  { handle: 'carol', login: null },
];

describe('whose moves a mirror files', () => {
  it('is everybody\'s for a mirror of the whole team, without asking who anybody is or what the server shows', async () => {
    const answer = await everyone.resolve(NOBODY_ASKED);

    assert.ok(answer.ok);
    assert.equal(answer.audience.filedFor, null);
    assert.equal(answer.audience.shareOf('alice'), 'mine');
    assert.equal(answer.audience.shareOf(null), 'mine');
    assert.ok(await answer.audience.stillStands(claimOf('alice'), NO_LIVE_CLAIMS_ASKED));
  });

  it('is only the member this worker\'s login stands for, on a worker that is not the owner\'s', async () => {
    const answer = await new OwnMoves(login(' BOB-gh '), 'alice-gh').resolve(directory(...MEMBERS));

    assert.ok(answer.ok);
    assert.equal(answer.audience.filedFor, 'bob');
    assert.equal(answer.warning, null);
    assert.equal(answer.audience.shareOf('bob'), 'mine');
    assert.equal(answer.audience.shareOf('alice'), 'others');
    assert.equal(answer.audience.shareOf(null), 'others', 'a move whose author is unnamed is the owner\'s to file');
    assert.equal(answer.audience.shareOf('carol'), 'others');
  });

  it('takes, in the owner\'s worker, the moves no person\'s worker can file', async () => {
    const answer = await new OwnMoves(login('alice-gh'), 'Alice-GH').resolve(directory(...MEMBERS));

    assert.ok(answer.ok);
    assert.equal(answer.audience.shareOf('alice'), 'mine');
    assert.equal(answer.audience.shareOf('bob'), 'others');
    assert.equal(answer.audience.shareOf(null), 'orphan');
    assert.equal(answer.audience.shareOf('carol'), 'orphan', 'a member without a GitHub login has no worker of their own');
    assert.equal(answer.audience.shareOf('removed-since'), 'orphan');
  });

  it('files a move only while the server still shows the state it left', async () => {
    const answer = await new OwnMoves(login('bob-gh'), 'alice-gh').resolve(directory(...MEMBERS));
    assert.ok(answer.ok);

    assert.ok(await answer.audience.stillStands(claimOf('bob'), live({ holder: 'bob', inReview: false })));
    assert.ok(!(await answer.audience.stillStands(claimOf('bob'), live(null))));
    assert.ok(!(await answer.audience.stillStands(claimOf('bob'), live({ holder: 'carol', inReview: false }))));
  });

  it('warns, on a worker that is not the owner\'s, of an owner no member names', async () => {
    const answer = await new OwnMoves(login('bob-gh'), 'alcie-gh').resolve(directory(...MEMBERS));

    assert.ok(answer.ok);
    assert.match(answer.warning ?? '', /no member of the project names alcie-gh, the configured owner, as their GitHub login/);
  });

  it('is the audience each scope of the configuration stands for', async () => {
    assert.equal(MIRROR_AUDIENCES.all(login('bob-gh'), 'alice-gh'), everyone);
    const own = MIRROR_AUDIENCES.own(login('bob-gh'), 'alice-gh');
    assert.ok(own instanceof OwnMoves);
    const answer = await own.resolve(directory(...MEMBERS));
    assert.ok(answer.ok && answer.audience.filedFor === 'bob');
  });
});
