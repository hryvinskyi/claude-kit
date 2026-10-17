import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSecondaryHits } from '../../src/application/queue-meta.ts';
import {
  CredentialRejected,
  PrimaryRateLimited,
  SecondaryRateLimited,
  TransientFailure,
} from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { marker } from '../../src/domain/kinds/posts.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { seedItem } from '../fakes/fake-board-gateway.ts';
import { FIRST, RESET, graphqlBudget, setFields, tickFixture } from './tick-fixture.ts';

const twelve = IssueRef.of(FIRST, 12);
const thirteen = IssueRef.of(FIRST, 13);
const fourteen = IssueRef.of(FIRST, 14);

describe('DrainQueue writing board fields', () => {
  it('writes every wanted value, reads the row back by its own id and records what it says', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' })] });
    await tick.file({ id: 'a-1', payload: setFields(12, { status: 'In Pro', severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal(report.executed, 1);
    assert.deepEqual(tick.board.valuesOf(twelve), {
      Status: 'In Progress',
      Severity: 'S2 · broken · no workaround',
    });
    const action = await tick.stored('a-1');
    assert.equal(action.state, 'done');
    assert.match(action.result ?? '', /example-org\/first-repo#12: Status → In Progress/);
    assert.match(action.result ?? '', /"Severity":"S2 · broken · no workaround"/);
    assert.ok(tick.board.calls.includes('readItemById'));
  });

  it('adds the row every time and writes to the one that was already there', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    await tick.drain.run();

    assert.deepEqual(tick.board.ensured, ['example-org/first-repo#12']);
    assert.equal(tick.board.written[0]?.itemId, 'item-7');
  });

  it('paces every mutation, the row being added included', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { status: 'Todo', severity: 'S2' }) });

    await tick.drain.run();

    // One gap before each value written, the row having been added just before the
    // first of them; no trailing gap, because no second action followed.
    assert.deepEqual(tick.sleeper.slept, [1500, 1500]);
  });

  it('asks the board once more for an option it does not know, then blocks with the list it accepts',
    async () => {
      const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
      await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S4' }) });

      const report = await tick.drain.run();

      assert.equal(report.blocked, 1);
      assert.equal(tick.board.forcedCatalogFetches, 1);
      assert.equal(tick.board.catalogFetches, 2);
      const action = await tick.stored('a-1');
      assert.equal(action.state, 'blocked');
      assert.equal(action.blockedReason, 'option-not-found');
      assert.match(action.lastError ?? '', /S1 · blocking, S2 · broken · no workaround, S3 · cosmetic/);
      assert.equal(tick.board.written.length, 0);
    });

  it('blocks a text that fits several options rather than guessing between them', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S' }) });

    await tick.drain.run();

    const action = await tick.stored('a-1');
    assert.equal(action.blockedReason, 'ambiguous-option');
    assert.match(action.lastError ?? '', /S1 · blocking, S2 · broken · no workaround, S3 · cosmetic/);
  });

  it('blocks a write the board did not keep, naming both what was written and what it reads', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Severity: 'S1 · blocking' })] });
    tick.board.swallowWrites.add('Severity');
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.blocked, 1);
    const action = await tick.stored('a-1');
    assert.equal(action.blockedReason, 'readback-mismatch');
    assert.match(action.lastError ?? '', /S2 · broken · no workaround/);
    assert.match(action.lastError ?? '', /S1 · blocking/);
  });
});

describe('DrainQueue spending the allowance', () => {
  it('runs no more actions than one tick may, and says so', async () => {
    const tick = tickFixture({
      worker: { perTickCap: 1 },
      items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})],
    });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.executed, 1);
    assert.equal(report.done, 1);
    assert.match(report.stoppedBecause ?? '', /1/);
    assert.equal((await tick.stored('a-2')).state, 'queued');
  });

  it('starts nothing below the floor, naming what is left and what the floor is', async () => {
    const tick = tickFixture({ budget: graphqlBudget(50), items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.executed, 0);
    assert.match(report.stoppedBecause ?? '', /50/);
    assert.match(report.stoppedBecause ?? '', /100/);
    assert.equal((await tick.stored('a-1')).state, 'queued');
  });

  it('keeps a success whose answer left nothing, and starts nothing after it', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})] });
    tick.board.onCall = (call): void => {
      if (call === 'readItemById') {
        tick.board.budget = graphqlBudget(0);
      }
    };
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal(report.executed, 1);
    assert.equal((await tick.stored('a-1')).state, 'done');
    assert.equal((await tick.stored('a-2')).state, 'queued');
    assert.match(report.stoppedBecause ?? '', /0/);
    assert.match(report.stoppedBecause ?? '', /100/);
  });
});

describe('DrainQueue meeting a limiter', () => {
  it('puts the action back untouched, waits for the reset and stops the tick', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})] });
    tick.board.fail('ensureItem', new PrimaryRateLimited(RESET));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.requeued, 1);
    assert.equal(report.executed, 1);
    const action = await tick.stored('a-1');
    assert.equal(action.state, 'queued');
    assert.equal(action.attempts, 0);
    const pause = await tick.repository.getPause();
    assert.equal(pause?.until.getTime(), RESET.getTime() + 5000);
    assert.equal((await tick.stored('a-2')).state, 'queued');
    assert.equal(report.pausedUntil, pause?.until.toISOString());
  });

  it('doubles the burst wait on the next tick, though the first wait was cleared in between', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('ensureItem', new SecondaryRateLimited(null));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    await tick.drain.run();
    const first = await tick.repository.getPause();
    assert.equal((first?.until.getTime() ?? 0) - tick.clock.now().getTime(), 120_000);
    assert.equal(await readSecondaryHits(tick.repository), 1);

    tick.clock.advance(121_000);
    tick.board.fail('ensureItem', new SecondaryRateLimited(null));
    await tick.drain.run();

    const second = await tick.repository.getPause();
    assert.equal((second?.until.getTime() ?? 0) - tick.clock.now().getTime(), 240_000);
    assert.equal(second?.consecutiveHits, 2);
    assert.equal(await readSecondaryHits(tick.repository), 2);
  });

  it('forgets the burst refusals as soon as a tick gets something through', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('ensureItem', new SecondaryRateLimited(null));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    await tick.drain.run();
    assert.equal(await readSecondaryHits(tick.repository), 1);

    tick.clock.advance(121_000);
    await tick.drain.run();

    assert.equal((await tick.stored('a-1')).state, 'done');
    assert.equal(await readSecondaryHits(tick.repository), 0);
  });

  it('keeps the refusal a later action earned when an earlier one got through', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S1' }) });
    // The first action goes through; the second meets the burst limiter. The
    // proof that the limiter let go is only good until the moment it says no
    // again, and the wait after this refusal has to be the first of a new run.
    let writes = 0;
    tick.board.onCall = (call): void => {
      if (call !== 'setSingleSelect') {
        return;
      }
      writes += 1;
      if (writes === 2) {
        throw new SecondaryRateLimited(null);
      }
    };

    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal(await readSecondaryHits(tick.repository), 1);
  });

  it('waits a quarter of an hour when the credential itself was refused', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('ensureItem', new CredentialRejected('the board'));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.drain.run();

    const pause = await tick.repository.getPause();
    assert.equal((pause?.until.getTime() ?? 0) - tick.clock.now().getTime(), 15 * 60 * 1000);
    assert.equal(report.requeued, 1);
    assert.equal((await tick.stored('a-1')).attempts, 0);
  });

  it('waits when the allowance probe itself is refused, and runs nothing', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('probeBudget', new PrimaryRateLimited(RESET));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.match(report.skipped ?? '', /allowance/);
    assert.equal(report.executed, 0);
    assert.equal((await tick.repository.getPause())?.until.getTime(), RESET.getTime() + 5000);
  });

  it('spends nothing while it cannot see what is left', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('probeBudget', new TransientFailure('the API was unreachable'));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.executed, 0);
    assert.match(report.stoppedBecause ?? '', /unknown/);
    assert.equal(await tick.repository.getPause(), null);
  });
});

describe('DrainQueue meeting a failure that may pass', () => {
  it('waits exactly the curve the policy names, then gives up once the attempts are used', async () => {
    const tick = tickFixture({ worker: { maxAttempts: 2 }, items: [seedItem(twelve, 'item-7', {})] });
    tick.board.fail('ensureItem', new TransientFailure('the API answered 502'));
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const at = tick.clock.now();
    const first = await tick.drain.run();

    assert.equal(first.requeued, 1);
    const waiting = await tick.stored('a-1');
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.attempts, 1);
    assert.equal(waiting.notBefore?.getTime(), at.getTime() + tick.policy.backoffSec(1) * 1000);

    tick.clock.advance(31_000);
    tick.board.fail('ensureItem', new TransientFailure('the API answered 502'));
    const second = await tick.drain.run();

    assert.equal(second.failed, 1);
    const given = await tick.stored('a-1');
    assert.equal(given.state, 'failed');
    assert.equal(given.attempts, 2);
    assert.equal(given.notBefore, null);
  });

  it('reads anything it has no name for as a failure worth another go', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    tick.board.onCall = (call): void => {
      if (call === 'ensureItem') {
        throw new TypeError('undefined is not a function');
      }
    };
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    await tick.drain.run();

    const action = await tick.stored('a-1');
    assert.equal(action.state, 'queued');
    assert.match(action.lastError ?? '', /undefined is not a function/);
  });
});

describe('DrainQueue and the one lock', () => {
  it('does nothing at all while another tick holds the lock', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });

    const report = await tick.repository.withTickLock(() => tick.drain.run());

    assert.match(report?.skipped ?? '', /lock/);
    assert.equal((await tick.stored('a-1')).state, 'queued');
  });

  it('does nothing while the queue is serving a wait', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    const until = new Date(tick.clock.now().getTime() + 60_000);
    await tick.repository.setPause(new QueuePause({ until, reason: 'a burst refusal', consecutiveHits: 1 }));

    const report = await tick.drain.run();

    assert.match(report.skipped ?? '', /paused until/);
    assert.equal(tick.board.calls.length, 0);
  });

  it('clears a wait that has run out and gets on with the work', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    const until = new Date(tick.clock.now().getTime() - 1000);
    await tick.repository.setPause(new QueuePause({ until, reason: 'a burst refusal', consecutiveHits: 1 }));

    const report = await tick.drain.run();

    assert.equal(report.skipped, undefined);
    assert.equal(report.done, 1);
    assert.equal(await tick.repository.getPause(), null);
    assert.equal(await readSecondaryHits(tick.repository), 0);
  });

  it('counts an action another writer changed under it, and carries on with the next', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S2' }) });
    let changed = false;
    tick.board.onCall = (call): void => {
      if (call === 'ensureItem' && !changed) {
        changed = true;
        tick.repository.changeBehindTheBackOf('a-1');
      }
    };

    const report = await tick.drain.run();

    assert.equal(report.stale, 1);
    assert.equal(report.done, 1);
    assert.equal(report.executed, 2);
    assert.equal((await tick.stored('a-2')).state, 'done');
  });
});

describe('DrainQueue and a run that died holding something', () => {
  it('puts back what an earlier run left running, and gives the attempt back with it', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    const filed = await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    // What a tick that was killed mid-action leaves behind: a row that says
    // running, with nobody running it.
    filed.start(tick.clock.now());
    await tick.repository.update(filed);

    const report = await tick.drain.run();

    assert.equal(report.recovered, 1);
    assert.equal(report.done, 1);
    const action = await tick.stored('a-1');
    assert.equal(action.state, 'done');
    assert.equal(action.attempts, 1, 'the attempt the dead run charged was given back before this one charged it');
    assert.ok(tick.logger.lines.some((line) => line.message === 'an unfinished action from an earlier run was put back'));
  });

  it('frees the later actions on the same issue that the abandoned one was holding up', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    const filed = await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({
      id: 'a-2',
      kind: 'issue.comment',
      payload: { repo: FIRST, issue: 12, body: 'and the evidence' },
      createdAt: new Date(tick.clock.now().getTime() + 1000),
    });
    tick.issues.seed({ ref: twelve });
    filed.start(tick.clock.now());
    await tick.repository.update(filed);

    const report = await tick.drain.run();

    assert.equal(report.recovered, 1);
    assert.equal((await tick.stored('a-1')).state, 'done');
    assert.equal((await tick.stored('a-2')).state, 'done');
  });

  it('recovers an action whose verdict never reached the queue at all', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    // Not a lost race — a write that never landed. The tick cannot pretend it
    // did, so it gives up; what it leaves behind is the row it could not finish.
    tick.repository.failNextUpdateWith = new Error('the queue file could not be written');

    await assert.rejects(() => tick.drain.run(), /could not be written/);
    assert.equal((await tick.stored('a-1')).state, 'running');

    const report = await tick.drain.run();

    assert.equal(report.recovered, 1);
    assert.equal((await tick.stored('a-1')).state, 'done');
  });

  it('reports what it put back even when the queue is waiting and nothing else runs', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    const filed = await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    filed.start(tick.clock.now());
    await tick.repository.update(filed);
    await tick.repository.setPause(new QueuePause({
      until: new Date(tick.clock.now().getTime() + 60_000),
      reason: 'a burst refusal',
      consecutiveHits: 1,
    }));

    const report = await tick.drain.run();

    assert.match(report.skipped ?? '', /paused/);
    assert.equal(report.recovered, 1);
    assert.equal((await tick.stored('a-1')).state, 'queued');
  });
});

describe('DrainQueue and a board that caught up', () => {
  it('gives back only the actions waiting for an option the fresh catalog now has', async () => {
    const tick = tickFixture({
      items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {}), seedItem(fourteen, 'item-9', {})],
    });
    await tick.file({ id: 'waiting', payload: setFields(12, { severity: 'S4' }) });
    await tick.file({ id: 'still-waiting', payload: setFields(13, { severity: 'S9' }) });
    await tick.drain.run();
    assert.equal((await tick.stored('waiting')).state, 'blocked');
    assert.equal((await tick.stored('still-waiting')).state, 'blocked');

    tick.board.addOption('Severity', { id: 'option-severity-s4', name: 'S4 · trivial' });
    tick.clock.advance(tick.config.worker.catalogTtlSec * 1000 + 1000);
    await tick.file({ id: 'a-3', payload: setFields(14, { severity: 'S2' }) });

    const report = await tick.drain.run();

    assert.equal(report.unblocked, 1);
    assert.equal((await tick.stored('waiting')).state, 'queued');
    assert.equal((await tick.stored('waiting')).attempts, 0);
    assert.equal((await tick.stored('still-waiting')).state, 'blocked');
    assert.ok(tick.logger.lines.some((line) => line.message.includes('requeued')));
  });

  it('leaves a blocked action alone while the board still cannot answer for it', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S4' }) });

    await tick.drain.run();
    const report = await tick.drain.run();

    assert.equal(report.unblocked, 0);
    assert.equal((await tick.stored('a-1')).state, 'blocked');
  });
});

describe('DrainQueue and the issues', () => {
  it('posts the comment in one tick and closes the issue in the next, in the order they were filed',
    async () => {
      const tick = tickFixture({ worker: { perTickCap: 1 }, issues: [{ ref: twelve }] });
      await tick.file({ id: 'c-1', kind: 'issue.comment', payload: { repo: FIRST, issue: 12, body: 'the fix is live' } });
      await tick.file({ id: 'c-2', kind: 'issue.close', payload: { repo: FIRST, issue: 12, reason: 'completed' } });

      const first = await tick.drain.run();

      assert.equal(first.done, 1);
      assert.equal(tick.issues.posted.length, 1);
      assert.equal(tick.issues.closed.length, 0);
      assert.equal((await tick.stored('c-2')).state, 'queued');

      const second = await tick.drain.run();

      assert.equal(second.done, 1);
      assert.deepEqual(tick.issues.closed, [{ ref: 'example-org/first-repo#12', reason: 'completed' }]);
      assert.ok(tick.issues.calls.indexOf('comment') < tick.issues.calls.indexOf('close'));
    });

  it('adopts the comment a failed run had already posted instead of posting it again', async () => {
    const tick = tickFixture({ issues: [{ ref: twelve }] });
    const filed = tick.clock.now();
    await tick.file({ id: 'c-1', kind: 'issue.comment', payload: { repo: FIRST, issue: 12, body: 'the fix is live' } });
    tick.issues.seed({
      ref: twelve,
      comments: [{ body: `the fix is live${marker('c-1')}`, createdAt: filed }],
    });

    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal(tick.issues.posted.length, 0);
    assert.match((await tick.stored('c-1')).result ?? '', /already there/);
  });

  it('leaves an issue that is already closed alone', async () => {
    const tick = tickFixture({ issues: [{ ref: twelve, state: 'closed' }] });
    await tick.file({ id: 'c-1', kind: 'issue.close', payload: { repo: FIRST, issue: 12, reason: 'completed' } });

    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal(tick.issues.closed.length, 0);
    assert.deepEqual(tick.issues.calls, ['get']);
  });

  it('blocks on an issue nothing can be written to', async () => {
    const tick = tickFixture();
    await tick.file({ id: 'c-1', kind: 'issue.comment', payload: { repo: FIRST, issue: 99, body: 'anybody there' } });

    const report = await tick.drain.run();

    assert.equal(report.blocked, 1);
    assert.equal((await tick.stored('c-1')).blockedReason, 'issue-not-found');
  });

  it('leaves one pacing gap between two actions and none after the last', async () => {
    const tick = tickFixture({ issues: [{ ref: twelve }, { ref: thirteen }] });
    await tick.file({ id: 'c-1', kind: 'issue.comment', payload: { repo: FIRST, issue: 12, body: 'one' } });
    await tick.file({ id: 'c-2', kind: 'issue.comment', payload: { repo: FIRST, issue: 13, body: 'two' } });

    await tick.drain.run();

    assert.deepEqual(tick.sleeper.slept, [1500]);
  });
});
