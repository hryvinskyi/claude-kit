import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueuePause } from '../../src/domain/queue-pause.ts';

const now = new Date('2026-09-16T13:00:00.000Z');

describe('QueuePause', () => {
  it('is active until its moment has passed', () => {
    const pause = new QueuePause({ until: new Date(now.getTime() + 1000), reason: 'because', consecutiveHits: 1 });
    assert.ok(pause.isActive(now));
    assert.ok(!pause.isActive(new Date(now.getTime() + 1000)));
    assert.equal(pause.remainingSec(now), 1);
    assert.equal(pause.remainingSec(new Date(now.getTime() + 5000)), 0);
    assert.ok(pause.describe().includes('because'));
  });

  it('waits for the allowance to come back, with a little slack', () => {
    const resetAt = new Date(now.getTime() + 600_000);
    const pause = QueuePause.forPrimary(resetAt);
    assert.equal(pause.until.getTime(), resetAt.getTime() + 5000);
    assert.equal(pause.consecutiveHits, 0);
    assert.ok(pause.reason.includes(resetAt.toISOString()));
  });

  it('doubles the burst wait per consecutive hit and stops at the cap', () => {
    const waits = [0, 1, 2, 3, 4, 5].map(
      (hits) => QueuePause.forSecondaryAfterHits(now, null, hits, 120, 3600).until.getTime() - now.getTime(),
    );
    assert.deepEqual(waits, [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
  });

  it('counts the hit it is pausing for', () => {
    assert.equal(QueuePause.forSecondaryAfterHits(now, null, 0, 120, 3600).consecutiveHits, 1);
    assert.equal(QueuePause.forSecondaryAfterHits(now, null, 3, 120, 3600).consecutiveHits, 4);
  });

  it('waits as long as the API asked when that is longer', () => {
    const asked = QueuePause.forSecondaryAfterHits(now, 300, 0, 120, 3600);
    assert.equal(asked.until.getTime() - now.getTime(), 300_000);
    assert.ok(asked.reason.includes('asked for 300s'));
    const ownCurve = QueuePause.forSecondaryAfterHits(now, 30, 1, 120, 3600);
    assert.equal(ownCurve.until.getTime() - now.getTime(), 240_000);
  });

  it('takes the hit count from the pause it replaces when it is given one', () => {
    const first = QueuePause.forSecondary(now, null, null, 120, 3600);
    const second = QueuePause.forSecondary(now, null, first, 120, 3600);
    assert.equal(first.until.getTime() - now.getTime(), 120_000);
    assert.equal(second.until.getTime() - now.getTime(), 240_000);
    assert.equal(second.consecutiveHits, 2);
  });
});
