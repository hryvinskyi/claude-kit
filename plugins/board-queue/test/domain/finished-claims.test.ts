import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finishedClaims } from '../../src/domain/sync/finished-claims.ts';
import type { HeldClaim, Sighting } from '../../src/domain/sync/finished-claims.ts';

const FINISHED = new Set(['Ready for QA', 'Done']);
const TAKEN = '2026-03-02T08:00:00Z';

function heldClaim(item: number, boardStatus: string | null, overrides: Partial<HeldClaim> = {}): HeldClaim {
  return { item, ref: `gh:example-org/first-repo#${String(item)}`, claimedAt: TAKEN, boardStatus, inReview: false, ...overrides };
}

function seen(...entries: readonly (readonly [number, Sighting])[]): Map<number, Sighting> {
  return new Map(entries);
}

describe('which claims the board calls finished', () => {
  it('finishes a claim whose issue moved into a finished status while it was held', () => {
    const decision = finishedClaims(
      [heldClaim(41, 'Ready for QA'), heldClaim(42, 'Done')],
      seen([41, { claimedAt: TAKEN, boardStatus: 'In Progress' }], [42, { claimedAt: TAKEN, boardStatus: 'Ready for QA' }]),
      FINISHED,
    );

    assert.deepEqual(decision.finished.map((claim) => claim.item), [41], 'a move between two finished statuses ends nothing');
    assert.deepEqual(decision.seen.get(41), { claimedAt: TAKEN, boardStatus: 'In Progress' }, 'kept until it is completed');
    assert.deepEqual(decision.seen.get(42), { claimedAt: TAKEN, boardStatus: 'Done' });
  });

  it('only remembers a claim it sees for the first time, even in a finished status', () => {
    const decision = finishedClaims([heldClaim(41, 'Ready for QA'), heldClaim(42, 'In Progress')], seen(), FINISHED);

    assert.deepEqual(decision.finished, [], 'work taken up again after QA sent it back is its holder\'s to end');
    assert.deepEqual([...decision.seen.keys()], [41, 42]);
  });

  it('reads a claim taken again as a new claim, whatever the earlier one saw', () => {
    const decision = finishedClaims(
      [heldClaim(41, 'Ready for QA', { claimedAt: '2026-03-02T09:30:00Z' })],
      seen([41, { claimedAt: TAKEN, boardStatus: 'In Progress' }]),
      FINISHED,
    );

    assert.deepEqual(decision.finished, []);
    assert.deepEqual(decision.seen.get(41), { claimedAt: '2026-03-02T09:30:00Z', boardStatus: 'Ready for QA' });
  });

  it('leaves a claim waiting in review to the merge of its pull request', () => {
    const decision = finishedClaims(
      [heldClaim(41, 'Ready for QA', { inReview: true })],
      seen([41, { claimedAt: TAKEN, boardStatus: 'Code Review' }]),
      FINISHED,
    );

    assert.deepEqual(decision.finished, []);
  });

  it('counts an issue the server heard no status for as unfinished, and forgets claims no longer held', () => {
    const decision = finishedClaims(
      [heldClaim(41, 'Done')],
      seen([41, { claimedAt: TAKEN, boardStatus: null }], [43, { claimedAt: TAKEN, boardStatus: 'In Progress' }]),
      FINISHED,
    );

    assert.deepEqual(decision.finished.map((claim) => claim.item), [41]);
    assert.deepEqual([...decision.seen.keys()], [41]);
  });
});
