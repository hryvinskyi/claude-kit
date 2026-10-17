import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeLastAudit } from '../../src/application/queue-meta.ts';
import { RunTick } from '../../src/application/run-tick.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { SecondaryRateLimited } from '../../src/domain/errors.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { seedItem } from '../fakes/fake-board-gateway.ts';
import { FIRST, graphqlBudget, setFields, tickFixture } from './tick-fixture.ts';
import type { TickFixture } from './tick-fixture.ts';

const twelve = IssueRef.of(FIRST, 12);

function runTick(tick: TickFixture, audit?: () => Promise<void>): RunTick {
  return new RunTick({
    drain: tick.drain,
    repository: tick.repository,
    policy: tick.policy,
    clock: tick.clock,
    logger: tick.logger,
    ...(audit === undefined ? {} : { audit }),
  });
}

async function auditedLongAgo(tick: TickFixture): Promise<void> {
  await writeLastAudit(tick.repository, {
    at: new Date(tick.clock.now().getTime() - 7 * 60 * 60 * 1000),
    notOnBoard: 0,
    emptyFields: 0,
    closedNotDone: 0,
  });
}

describe('RunTick', () => {
  it('drains the queue and then writes the report nobody is waiting for', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await auditedLongAgo(tick);
    let audits = 0;

    const report = await runTick(tick, async (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.equal(report.done, 1);
    assert.equal(audits, 1);
  });

  it('writes no report when the last one is recent enough', async () => {
    const tick = tickFixture();
    await writeLastAudit(tick.repository, {
      at: new Date(tick.clock.now().getTime() - 60 * 60 * 1000),
      notOnBoard: 0,
      emptyFields: 0,
      closedNotDone: 0,
    });
    let audits = 0;

    await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.equal(audits, 0);
  });

  it('writes no report while the allowance is wanted elsewhere', async () => {
    const tick = tickFixture({ budget: graphqlBudget(500) });
    await auditedLongAgo(tick);
    let audits = 0;

    await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.equal(audits, 0);
  });

  it('reads nothing when the writing did not even start', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    const until = new Date(tick.clock.now().getTime() + 60_000);
    await tick.repository.setPause(new QueuePause({ until, reason: 'a burst refusal', consecutiveHits: 1 }));
    let audits = 0;

    const report = await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.match(report.skipped ?? '', /paused/);
    assert.equal(audits, 0);
  });

  it('keeps the account of the work when the report itself fails', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await auditedLongAgo(tick);

    const report = await runTick(tick, () => Promise.reject(new Error('the board listing timed out'))).run();

    assert.equal(report.done, 1);
    assert.ok(tick.logger.lines.some((line) => line.level === 'error' && /timed out/.test(String(line.fields['reason']))));
  });

  it('waits out the whole cadence after a report that could not be written', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    let attempts = 0;
    const failing = (): Promise<void> => {
      attempts += 1;
      return Promise.reject(new Error('the board listing timed out'));
    };

    await runTick(tick, failing).run();
    tick.clock.advanceMinutes(5);
    await runTick(tick, failing).run();

    assert.equal(attempts, 1, 'a report that cannot be written must not be asked for again every tick');

    tick.clock.advanceMinutes(6 * 60);
    await runTick(tick, failing).run();

    assert.equal(attempts, 2, 'and it is asked for again once the cadence has come round');
  });

  it('holds the cadence from the later of the last report and the last attempt', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    let audits = 0;
    const counting = (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    };

    await runTick(tick, counting).run();
    assert.equal(audits, 1);

    // The pass stamped its own summary as well; neither stamp may let the other
    // through early.
    tick.clock.advanceMinutes(5 * 60);
    await runTick(tick, counting).run();
    assert.equal(audits, 1);
  });

  it('reads nothing while a wait somebody else set is still in force', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    let audits = 0;
    // A wait that began after this tick's own work: the allowance the report would
    // spend is exactly the allowance the queue is waiting for.
    const drained = tick.drain.run.bind(tick.drain);
    tick.drain.run = async () => {
      const report = await drained();
      await tick.repository.setPause(new QueuePause({
        until: new Date(tick.clock.now().getTime() + 600_000),
        reason: 'a burst refusal',
        consecutiveHits: 1,
      }));
      return report;
    };

    await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.equal(audits, 0);
  });

  it('reads nothing when the tick it followed ended by putting the queue to sleep', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await auditedLongAgo(tick);
    tick.board.fail('ensureItem', new SecondaryRateLimited(null));
    let audits = 0;

    const report = await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.notEqual(report.pausedUntil, undefined);
    assert.equal(audits, 0);
  });

  it('reads the board under the one lock, so nothing else spends the allowance beside it', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    let heldByTheAudit = false;

    await runTick(tick, async (): Promise<void> => {
      // Another process trying to start a tick at this moment is turned away,
      // which is the whole point: the report is the most expensive read there is.
      heldByTheAudit = (await tick.repository.withTickLock(() => Promise.resolve(true))) === null;
    }).run();

    assert.equal(heldByTheAudit, true);
  });

  it('leaves the board alone when another tick took the lock in between', async () => {
    const tick = tickFixture();
    await auditedLongAgo(tick);
    let audits = 0;
    // Another process starts its own tick in the moment between this one letting
    // the lock go and the report asking for it.
    const drained = tick.drain.run.bind(tick.drain);
    tick.drain.run = async () => {
      const report = await drained();
      tick.repository.pretendAnotherTickHolds = true;
      return report;
    };

    await runTick(tick, (): Promise<void> => {
      audits += 1;
      return Promise.resolve();
    }).run();

    assert.equal(audits, 0);
    assert.ok(tick.logger.lines.some((line) => /another tick holds the lock/.test(line.message)));
  });

  it('runs perfectly well where no report is wired at all', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await auditedLongAgo(tick);

    assert.equal((await runTick(tick).run()).done, 1);
  });
});
