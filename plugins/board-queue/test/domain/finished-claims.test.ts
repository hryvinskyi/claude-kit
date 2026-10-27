import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claimMoves, stageOf } from '../../src/domain/sync/finished-claims.ts';
import type { HeldClaim, Sighting, StageStatuses } from '../../src/domain/sync/finished-claims.ts';

const STATUSES: StageStatuses = { handedOn: new Set(['Ready for QA']), ended: new Set(['Done']) };
const TAKEN = '2026-03-02T08:00:00Z';

function heldClaim(item: number, boardStatus: string | null, overrides: Partial<HeldClaim> = {}): HeldClaim {
  return {
    item,
    ref: `gh:example-org/first-repo#${String(item)}`,
    claimedAt: TAKEN,
    boardStatus,
    closed: false,
    areas: ['web:checkout'],
    inReview: false,
    ...overrides,
  };
}

function seen(...entries: readonly (readonly [number, Sighting])[]): Map<number, Sighting> {
  return new Map(entries);
}

const items = (claims: readonly HeldClaim[]): number[] => claims.map((claim) => claim.item);

describe('how far the board says a claim\'s work has gone', () => {
  it('reads a closed issue as ended whatever its status, and an unknown status as still worked on', () => {
    assert.equal(stageOf(heldClaim(41, 'Ready for QA', { closed: true }), STATUSES), 'ended');
    assert.equal(stageOf(heldClaim(41, 'Done'), STATUSES), 'ended');
    assert.equal(stageOf(heldClaim(41, 'Ready for QA'), STATUSES), 'handed-on');
    assert.equal(stageOf(heldClaim(41, null), STATUSES), 'working');
  });
});

describe('which claims the board moved on', () => {
  it('hands on a claim whose issue moved on to QA, and completes one whose issue moved to done', () => {
    const moves = claimMoves(
      [heldClaim(41, 'Ready for QA'), heldClaim(42, 'Done'), heldClaim(43, 'In Progress')],
      seen(
        [41, { claimedAt: TAKEN, stage: 'working' }],
        [42, { claimedAt: TAKEN, stage: 'handed-on' }],
        [43, { claimedAt: TAKEN, stage: 'working' }],
      ),
      STATUSES,
    );

    assert.deepEqual(items(moves.handOn), [41]);
    assert.deepEqual(items(moves.complete), [42]);
    assert.deepEqual(moves.seen.get(41), { claimedAt: TAKEN, stage: 'working' }, 'kept until the call succeeds');
    assert.deepEqual(moves.seen.get(43), { claimedAt: TAKEN, stage: 'working' });
  });

  it('completes a claim whose issue went straight from work to done', () => {
    const moves = claimMoves([heldClaim(41, 'Done')], seen([41, { claimedAt: TAKEN, stage: 'working' }]), STATUSES);

    assert.deepEqual(items(moves.complete), [41]);
    assert.deepEqual(moves.handOn, []);
  });

  it('only remembers a claim it sees for the first time, so work taken up again after QA keeps its areas', () => {
    const moves = claimMoves([heldClaim(41, 'Ready for QA'), heldClaim(42, 'Done')], seen(), STATUSES);

    assert.deepEqual(moves.handOn, []);
    assert.deepEqual(moves.complete, []);
    assert.deepEqual(moves.seen.get(41), { claimedAt: TAKEN, stage: 'handed-on' });
  });

  it('does not hand on again a claim that took its areas back while the issue waits for QA', () => {
    const moves = claimMoves(
      [heldClaim(41, 'Ready for QA')],
      seen([41, { claimedAt: TAKEN, stage: 'handed-on' }]),
      STATUSES,
    );

    assert.deepEqual(moves.handOn, []);
  });

  it('reads a claim taken again as a new claim, whatever the earlier one saw', () => {
    const moves = claimMoves(
      [heldClaim(41, 'Ready for QA', { claimedAt: '2026-03-02T09:30:00Z' })],
      seen([41, { claimedAt: TAKEN, stage: 'working' }]),
      STATUSES,
    );

    assert.deepEqual(moves.handOn, []);
    assert.deepEqual(moves.seen.get(41), { claimedAt: '2026-03-02T09:30:00Z', stage: 'handed-on' });
  });

  it('leaves a claim waiting in review to its merge, and a claim with no areas left to give up as it is', () => {
    const moves = claimMoves(
      [heldClaim(41, 'Done', { inReview: true }), heldClaim(42, 'Ready for QA', { areas: [] })],
      seen([41, { claimedAt: TAKEN, stage: 'working' }], [42, { claimedAt: TAKEN, stage: 'working' }]),
      STATUSES,
    );

    assert.deepEqual(moves.complete, []);
    assert.deepEqual(moves.handOn, []);
    assert.deepEqual(moves.seen.get(42), { claimedAt: TAKEN, stage: 'handed-on' });
  });

  it('forgets the claims no longer held', () => {
    const moves = claimMoves([heldClaim(41, 'In Progress')], seen([43, { claimedAt: TAKEN, stage: 'working' }]), STATUSES);

    assert.deepEqual([...moves.seen.keys()], [41]);
  });
});
