import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAST_BUDGET, writeLastAudit, writeLastBudget, writeLastTickAt } from '../../src/application/queue-meta.ts';
import { QueueStatus } from '../../src/application/queue-status.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { fixture } from './queue-fixture.ts';

describe('what the queue is doing', () => {
  it('counts every state, whether or not anything is in it', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'one', state: 'queued', issue: 1 });
    await file({ id: 'two', state: 'queued', issue: 2 });
    await file({ id: 'three', state: 'done', issue: 3 });

    const status = await new QueueStatus(repository, clock).execute();

    assert.deepEqual(status.counts, {
      queued: 2,
      held: 0,
      running: 0,
      done: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
      cancelled: 0,
    });
    assert.equal(status.pause, null);
    assert.equal(status.lastTickAt, null);
    assert.equal(status.lastBudget, null);
    assert.equal(status.lastAudit, null);
    assert.deepEqual(status.blocked, []);
    assert.deepEqual(status.held, []);
    assert.deepEqual(status.delayed, []);
  });

  it('names the queued work that no tick will touch yet, and when it comes round', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'now', state: 'queued', issue: 1 });
    await file({
      id: 'later',
      state: 'queued',
      issue: 2,
      notBefore: new Date(clock.now().getTime() + 3 * 24 * 60 * 60 * 1000),
    });
    await file({
      id: 'much-later',
      state: 'queued',
      issue: 3,
      notBefore: new Date(clock.now().getTime() + 10 * 24 * 60 * 60 * 1000),
    });

    const status = await new QueueStatus(repository, clock).execute();

    assert.deepEqual(status.delayed.map((action) => action.id), ['later', 'much-later']);
    assert.equal(status.delayed[0]?.runnableAt, '2026-01-13T09:00:00.000Z');
    assert.equal(status.delayed[0]?.inDays, 3);
    assert.equal(status.counts.queued, 3, 'it is still queued work; the wait is what the count cannot say');
  });

  it('says nothing about a wait that has already run out', async () => {
    const { repository, clock, file } = fixture();
    await file({
      id: 'over',
      state: 'queued',
      issue: 1,
      notBefore: new Date(clock.now().getTime() - 1000),
    });

    assert.deepEqual((await new QueueStatus(repository, clock).execute()).delayed, []);
  });

  it('shows how long each held action has been waiting, the oldest first', async () => {
    const { repository, clock, file } = fixture();
    await file({
      id: 'recent',
      state: 'held',
      issue: 2,
      origin: 'a session in the first repository',
      createdAt: new Date('2026-01-08T21:00:00.000Z'),
    });
    await file({
      id: 'forgotten',
      state: 'held',
      issue: 1,
      origin: 'a session nobody came back to',
      createdAt: new Date('2026-01-03T09:00:00.000Z'),
    });

    const status = await new QueueStatus(repository, clock).execute();

    assert.deepEqual(status.held.map((action) => action.id), ['forgotten', 'recent']);
    assert.equal(status.held[0]?.ageDays, 7);
    assert.equal(status.held[0]?.origin, 'a session nobody came back to');
    assert.equal(status.held[1]?.ageDays, 1.5);
    assert.equal(status.held[0]?.ref, 'example-org/first-repo#1');
  });

  it('names the actions that are waiting for a person, with what stopped them', async () => {
    const { repository, clock, file } = fixture();
    await file({ id: 'blocked-one', state: 'blocked', issue: 1 });
    await file({ id: 'failed-one', state: 'failed', issue: 2 });

    const status = await new QueueStatus(repository, clock).execute();

    assert.equal(status.blocked.length, 1);
    assert.equal(status.blocked[0]?.id, 'blocked-one');
    assert.match(status.blocked[0]?.lastError ?? '', /has no option matching "urgent"/);
    assert.equal(status.failed[0]?.id, 'failed-one');
    assert.match(status.failed[0]?.lastError ?? '', /unreachable/);
  });

  it('reports the pause, the last tick, the last allowance and the last audit', async () => {
    const { repository, clock } = fixture();
    await repository.setPause(new QueuePause({
      until: new Date('2026-01-10T09:02:00.000Z'),
      reason: 'the burst limiter refused the last call',
      consecutiveHits: 2,
    }));
    await writeLastTickAt(repository, new Date('2026-01-10T08:55:00.000Z'));
    await writeLastBudget(repository, new RateBudget({
      resource: 'graphql',
      remaining: 4200,
      limit: 5000,
      used: 800,
      resetAt: new Date('2026-01-10T09:55:00.000Z'),
    }));
    await writeLastAudit(repository, {
      at: new Date('2026-01-10T06:00:00.000Z'),
      notOnBoard: 3,
      emptyFields: 5,
      closedNotDone: 1,
    });

    const status = await new QueueStatus(repository, clock).execute();

    assert.equal(status.pause?.remainingSec, 120);
    assert.equal(status.pause?.consecutiveHits, 2);
    assert.equal(status.lastTickAt, '2026-01-10T08:55:00.000Z');
    assert.equal(status.lastBudget?.remaining, 4200);
    assert.equal(status.lastBudget?.resource, 'graphql');
    assert.equal(status.lastBudget?.resetAt, '2026-01-10T09:55:00.000Z');
    assert.deepEqual(status.lastAudit, {
      at: '2026-01-10T06:00:00.000Z',
      notOnBoard: 3,
      emptyFields: 5,
      closedNotDone: 1,
    });
  });

  it('reports a note it cannot make sense of as no note at all', async () => {
    const { repository, clock } = fixture();
    await repository.setMeta(LAST_BUDGET, 'whatever an older version wrote here');

    const status = await new QueueStatus(repository, clock).execute();

    assert.equal(status.lastBudget, null);
  });
});
