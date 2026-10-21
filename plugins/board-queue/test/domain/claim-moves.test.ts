import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actorOf, boardStatusOf, collapseClaims, statusesTheMirrorOwns, stillStands } from '../../src/domain/sync/claim-moves.ts';
import type { ClaimStatuses } from '../../src/domain/sync-config.ts';
import { claim, forcedRelease } from '../fakes/fake-coordination.ts';

const STATUSES: ClaimStatuses = { claimed: 'In Progress', released: 'Todo', review: 'Code Review' };

describe('collapsing claim events', () => {
  it('turns a claim into the claimed status and an assignment of its holder', () => {
    assert.deepEqual(collapseClaims([claim(3, 'claimed', 12, 'alice')], STATUSES), [
      {
        item: 12,
        lastEventId: 3,
        causedBy: 'alice',
        lastKind: 'claimed',
        holder: 'alice',
        status: 'In Progress',
        assign: ['alice'],
        unassign: [],
      },
    ]);
  });

  it('collapses successive events on one item to the state the last of them left', () => {
    const moves = collapseClaims([
      claim(1, 'claimed', 12, 'alice'),
      claim(2, 'released', 12, 'alice'),
      claim(3, 'claimed', 12, 'bob'),
    ], STATUSES);

    assert.deepEqual(moves, [
      {
        item: 12,
        lastEventId: 3,
        causedBy: 'bob',
        lastKind: 'claimed',
        holder: 'bob',
        status: 'In Progress',
        assign: ['bob'],
        unassign: ['alice'],
      },
    ]);
  });

  it('assigns the new holder of a taken-over claim and unassigns the one it was taken from', () => {
    const [move] = collapseClaims([claim(9, 'taken_over', 12, 'bob', 'alice')], STATUSES);

    assert.deepEqual(move, {
      item: 12,
      lastEventId: 9,
      causedBy: 'bob',
      lastKind: 'taken_over',
      holder: 'bob',
      status: 'In Progress',
      assign: ['bob'],
      unassign: ['alice'],
    });
  });

  it('reads a release by an admin as a release', () => {
    const [move] = collapseClaims([claim(4, 'force_released', 12, 'alice')], STATUSES);

    assert.equal(move?.status, 'Todo');
    assert.deepEqual(move?.unassign, ['alice']);
  });

  it('moves a claim in review to the review status and back when the review ends', () => {
    assert.equal(collapseClaims([claim(5, 'review_started', 12, 'alice')], STATUSES)[0]?.status, 'Code Review');
    assert.equal(collapseClaims([
      claim(5, 'review_started', 12, 'alice'),
      claim(6, 'review_ended', 12, 'alice'),
    ], STATUSES)[0]?.status, 'In Progress');
  });

  it('keeps the earlier status when the configuration names none for the later event', () => {
    const withoutReview: ClaimStatuses = { claimed: 'In Progress', released: 'Todo' };
    const [move] = collapseClaims([
      claim(1, 'claimed', 12, 'alice'),
      claim(2, 'review_started', 12, 'alice'),
    ], withoutReview);

    assert.equal(move?.status, 'In Progress');
    assert.equal(move?.lastEventId, 2);
  });

  it('keeps items apart and orders them by the last event of each', () => {
    const moves = collapseClaims([
      claim(1, 'claimed', 12, 'alice'),
      claim(2, 'claimed', 13, 'bob'),
      claim(3, 'released', 12, 'alice'),
    ], STATUSES);

    assert.deepEqual(moves.map((move) => [move.item, move.lastEventId]), [[13, 2], [12, 3]]);
  });

  it('assigns nobody for an event that names no member', () => {
    const [move] = collapseClaims([{ id: 1, kind: 'claimed', item: 12, member: null, previous: null, by: null }], STATUSES);

    assert.deepEqual(move?.assign, []);
    assert.equal(move?.status, 'In Progress');
  });
});

describe('who caused a claim event', () => {
  it('is the member who claimed, released, or started and ended a review', () => {
    for (const kind of ['claimed', 'released', 'review_started', 'review_ended'] as const) {
      assert.equal(actorOf(claim(1, kind, 12, 'alice')), 'alice', kind);
    }
  });

  it('is the member who took a stale claim over, not the one it was taken from', () => {
    assert.equal(actorOf(claim(1, 'taken_over', 12, 'bob', 'alice')), 'bob');
  });

  it('is the admin who ended a claim, and the holder when the server\'s operator did', () => {
    assert.equal(actorOf(forcedRelease(1, 12, 'alice', 'carol')), 'carol');
    assert.equal(actorOf(forcedRelease(1, 12, 'alice', null)), 'alice');
  });

  it('makes a move the move of whoever caused the last event of the item', () => {
    const [move] = collapseClaims([
      claim(1, 'claimed', 12, 'alice'),
      forcedRelease(2, 12, 'alice', 'carol'),
    ], STATUSES);

    assert.equal(move?.causedBy, 'carol');
    assert.equal(move?.status, 'Todo');
    assert.deepEqual(move?.unassign, ['alice']);
  });
});

describe('whether a move still stands on the server', () => {
  const only = (event: ReturnType<typeof claim>) => {
    const [move] = collapseClaims([event], STATUSES);
    if (move === undefined) {
      throw new Error('no move');
    }
    return move;
  };

  it('stands for a claim, a takeover or the end of a review while the same member works on it', () => {
    for (const move of [only(claim(1, 'claimed', 12, 'bob')), only(claim(1, 'taken_over', 12, 'bob', 'alice')),
      only(claim(1, 'review_ended', 12, 'bob'))]) {
      assert.ok(stillStands(move, { holder: 'bob', inReview: false }), move.lastKind);
      assert.ok(!stillStands(move, { holder: 'bob', inReview: true }), move.lastKind);
      assert.ok(!stillStands(move, { holder: 'carol', inReview: false }), move.lastKind);
      assert.ok(!stillStands(move, null), move.lastKind);
    }
  });

  it('stands for the start of a review while the same member holds the item in review', () => {
    const move = only(claim(1, 'review_started', 12, 'bob'));

    assert.ok(stillStands(move, { holder: 'bob', inReview: true }));
    assert.ok(!stillStands(move, { holder: 'bob', inReview: false }));
  });

  it('stands for a release, by its holder or an admin, only while nobody holds the item', () => {
    for (const move of [only(claim(1, 'released', 12, 'bob')), only(forcedRelease(1, 12, 'bob', 'carol'))]) {
      assert.ok(stillStands(move, null), move.lastKind);
      assert.ok(!stillStands(move, { holder: 'bob', inReview: false }), move.lastKind);
      assert.ok(!stillStands(move, { holder: 'dave', inReview: false }), move.lastKind);
    }
  });
});

describe('the statuses the mirror writes', () => {
  it('falls back to the claimed status for a takeover and the end of a review', () => {
    assert.equal(boardStatusOf('takenOver', STATUSES), 'In Progress');
    assert.equal(boardStatusOf('reviewEnded', STATUSES), 'In Progress');
    assert.equal(boardStatusOf('review', { claimed: 'In Progress', released: 'Todo' }), null);
  });

  it('owns every status it writes and an empty one, and nothing else', () => {
    assert.deepEqual(statusesTheMirrorOwns(STATUSES), ['In Progress', 'Todo', 'Code Review', '']);
  });
});
