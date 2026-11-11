import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CancelAction } from '../../src/application/cancel-action.ts';
import { RetryAction } from '../../src/application/retry-action.ts';
import { BoardRouter } from '../../src/application/board-router.ts';
import { DrainQueue } from '../../src/application/drain-queue.ts';
import type { TickReport } from '../../src/application/drain-queue.ts';
import type { IssueCommentView } from '../../src/application/ports.ts';
import { EnqueueAction } from '../../src/application/enqueue-action.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { readLastTickAt, readSecondaryHits } from '../../src/application/queue-meta.ts';
import type { Config } from '../../src/domain/config.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import {
  CredentialRejected,
  IssueNotFound,
  OptionNotFound,
  PrimaryRateLimited,
  SecondaryRateLimited,
  TransientFailure,
} from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { marker } from '../../src/domain/kinds/posts.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { Action } from '../../src/domain/action.ts';
import type { ProcessTable } from '../../src/infrastructure/process-table.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { seedItem } from '../fakes/fake-board-gateway.ts';
import { FIRST, RESET, graphqlBudget, setFields, tickFixture } from './tick-fixture.ts';
import type { TickFixture } from './tick-fixture.ts';

const twelve = IssueRef.of(FIRST, 12);

/** This process, seen as having started at the moment given. */
function table(startOf: () => string): ProcessTable {
  return { here: () => 'host:pid:[1]', startOf };
}

/** Issues whose comment listing lets something else happen after it answers, once. */
class ListingThenWaiting extends FakeIssueGateway {
  afterListing: (() => Promise<void>) | null = null;

  override async listComments(ref: IssueRef, since: Date | null): Promise<IssueCommentView[]> {
    const seen = await super.listComments(ref, since);
    const after = this.afterListing;
    this.afterListing = null;
    if (after !== null) {
      await after();
    }
    return seen;
  }
}
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

  it('stops without writing once another pass took the lock, and puts the action it claimed back', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    await tick.file({ id: 'a-2', payload: setFields(13, { severity: 'S2' }) });
    // The pass reads before it writes; another pass takes the lock in between.
    tick.board.onCall = (call): void => {
      if (call === 'catalog') {
        tick.repository.takeTheLockAway();
      }
    };

    const report = await tick.drain.run();

    assert.deepEqual(tick.board.ensured, [], 'nothing was written after the lock was lost');
    assert.deepEqual(tick.board.written, []);
    assert.match(report.stoppedBecause ?? '', /lock/);
    assert.equal(report.done, 0);
    const claimed = await tick.stored('a-1');
    assert.equal(claimed.state, 'queued', 'the action goes back for the pass that holds the lock now');
    assert.equal(claimed.attempts, 0, 'the attempt the claim charged is given back');
    assert.equal((await tick.stored('a-2')).state, 'queued', 'nothing more is claimed');
  });

  it('claims nothing at all once the lock is gone before the first action', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', {})] });
    await tick.file({ id: 'a-1', payload: setFields(12, { severity: 'S2' }) });
    tick.board.onCall = (call): void => {
      if (call === 'probeBudget') {
        tick.repository.takeTheLockAway();
      }
    };

    const report = await tick.drain.run();

    assert.equal(report.executed, 0);
    assert.match(report.stoppedBecause ?? '', /lock/);
    const waiting = await tick.stored('a-1');
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.version, 1, 'the action was never claimed');
  });

  it('posts one comment when a second pass takes the lock from a live first one mid-action', async (t) => {
    const tick = tickFixture({ issues: [{ ref: twelve }] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-queue-lease-'));
    const file = path.join(dir, 'queue.db');
    // The second pass sees the first one's process as started at another moment —
    // as a reading of the start in another locale did — and takes the lock from it.
    const first = new SqliteActionRepository(file, { clock: tick.clock, processes: table(() => '1000') });
    const second = new SqliteActionRepository(file, { clock: tick.clock, processes: table(() => '2000') });
    t.after(() => {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const issues = new ListingThenWaiting([{ ref: twelve }]);
    const passOn = (repository: SqliteActionRepository): DrainQueue => new DrainQueue({
      repository,
      boards: new BoardRouter(BoardDirectory.of(tick.config.boards), () => ({ board: tick.board, issues })),
      kinds: defaultKindRegistry(tick.config),
      policy: tick.policy,
      clock: tick.clock,
      sleeper: tick.sleeper,
      logger: tick.logger,
      config: tick.config,
    });
    const kind = defaultKindRegistry(tick.config).get('issue.comment');
    const payload = { repo: FIRST, issue: 12, body: 'the fix is live' };
    await first.insert(Action.enqueue({
      id: 'c-1',
      kind: kind.name,
      payload,
      issueRef: kind.issueRefOf(payload),
      origin: 'a session',
      now: tick.clock.now(),
    }));
    const reports: { second: TickReport | null } = { second: null };
    // The first pass has looked for its comment and found none; before it posts,
    // the second pass starts, puts the action back, looks, finds none and posts it.
    issues.afterListing = async (): Promise<void> => {
      reports.second = await passOn(second).run();
    };

    const firstReport = await passOn(first).run();

    assert.equal(reports.second?.done, 1, 'the pass that took the lock did the work');
    assert.equal(issues.posted.length, 1, 'the comment was posted once');
    assert.match(firstReport.stoppedBecause ?? '', /lock/);
    assert.equal((await second.get('c-1'))?.state, 'done');
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
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
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
    assert.deepEqual((await tick.stored('waiting')).payload, setFields(12, { status: 'In Progress', severity: 'S4' }));
    assert.deepEqual((await tick.stored('waiting')).writeGuard, { status: { name: '', optionId: null } });
    assert.equal((await tick.stored('still-waiting')).state, 'blocked');
    assert.ok(tick.logger.lines.some((line) => line.message.includes('requeued')));
  });

  it('writes the status nobody touched beside the value the board lacked, reading nothing to release it', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Review', severity: 'S4' }) });
    await tick.drain.run();
    assert.equal((await tick.stored('waiting')).state, 'blocked');
    assert.deepEqual((await tick.stored('waiting')).rowAtBlock, {
      status: { name: 'Todo', optionId: 'option-status-todo' },
    });

    tick.board.addOption('Severity', { id: 'option-S4', name: 'S4 · trivial' });
    tick.clock.advance(tick.config.worker.catalogTtlSec * 1000 + 1000);
    await tick.file({ id: 'teaching-14', payload: setFields(14, { severity: 'S2' }) });
    const readsBefore = tick.board.calls.filter((call) => call === 'readItemById').length;
    await tick.drain.run();
    const readsByTheTick = tick.board.calls.filter((call) => call === 'readItemById').length - readsBefore;
    assert.equal(readsByTheTick, 1, 'the one read confirms the teaching write; the release reads nothing');
    assert.equal((await tick.stored('waiting')).state, 'queued');
    await tick.drain.run();

    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Review', Severity: 'S4 · trivial' });
    const replayed = await tick.stored('waiting');
    assert.equal(replayed.state, 'done');
    assert.match(replayed.result ?? '', /runs again with status "In Review", severity "S4"; status only if the row still reads/);
    assert.doesNotMatch(replayed.result ?? '', /was not (written|set)/);
  });

  it('never writes a status a person moved the row to before the release, and says so', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();
    assert.equal((await tick.stored('waiting')).state, 'blocked');

    tick.board.setByHand(twelve, 'Status', 'In Review');
    await teach(tick, [['Severity', 'S4 · trivial']]);
    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Review', Severity: 'S4 · trivial' });
    const replayed = await tick.stored('waiting');
    assert.equal(replayed.state, 'done');
    assert.match(
      replayed.result ?? '',
      /Status was not set to "In Progress": it has been changed on the board since \(from "Todo" to "In Review"\)/,
    );
  });

  it('never writes a status a person moved the row to after the release, before the write', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();

    await teach(tick, [['Severity', 'S4 · trivial']]);
    assert.equal((await tick.stored('waiting')).state, 'queued');
    tick.board.setByHand(twelve, 'Status', 'In Review');
    await tick.drain.run();

    assert.equal((await tick.stored('waiting')).state, 'done');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Review', Severity: 'S4 · trivial' });
  });

  it('writes a status whose option was only renamed since the action blocked', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Review', severity: 'S4' }) });
    await tick.drain.run();

    tick.board.renameOption('Status', 'Todo', 'Backlog');
    await teach(tick, [['Severity', 'S4 · trivial']]);
    await tick.drain.run();

    assert.equal((await tick.stored('waiting')).state, 'done');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Review', Severity: 'S4 · trivial' });
  });

  it('keeps the first guard when a released action blocks again, for the value it lacked as well', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'In Progress' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4', type: 'Chore' }) });
    await tick.drain.run();
    assert.deepEqual((await tick.stored('waiting')).missingOptions, ['severity', 'type']);

    // The board learns one of the two values; what a first release and a second
    // block on the other leave on the action is set down by hand, readings and all.
    await teach(tick, [['Severity', 'S4 · trivial']]);
    assert.equal((await tick.stored('waiting')).state, 'blocked');
    const first = await tick.stored('waiting');
    first.retry(tick.clock.now());
    first.start(tick.clock.now());
    first.block(tick.clock.now(), new OptionNotFound('Defect type', 'Chore', ['Bug']), ['type'], {
      status: { name: 'In Progress', optionId: 'option-status-in-progress' },
      severity: { name: '', optionId: null },
    });
    first.resumeWith(tick.clock.now(), first.payload, 'note', {
      type: { name: '', optionId: null },
      status: { name: 'In Progress', optionId: 'option-status-in-progress' },
    });
    first.start(tick.clock.now());
    first.block(tick.clock.now(), new OptionNotFound('Defect type', 'Chore', ['Bug']), ['type'], {
      status: { name: 'In Progress', optionId: 'option-status-in-progress' },
      severity: { name: '', optionId: null },
    });
    await tick.repository.update(first);

    tick.board.setByHand(twelve, 'Defect type', 'Bug');
    tick.board.setByHand(twelve, 'Status', 'Done');
    await teach(tick, [['Defect type', 'Chore']], 15);
    await tick.drain.run();

    const values = tick.board.valuesOf(twelve);
    assert.equal(values?.['Defect type'], 'Bug', 'the type it lacked was guarded by the first release, and was moved');
    assert.equal(values?.['Status'], 'Done', 'nothing writes over the move to Done');
    assert.equal(values?.['Severity'], 'S4 · trivial');
  });

  it('files a later request on its own rather than folding it into a guarded action', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Review', severity: 'S4' }) });
    await tick.drain.run();
    await teach(tick, [['Severity', 'S4 · trivial']]);
    assert.notEqual((await tick.stored('waiting')).writeGuard, null);

    const enqueue = new EnqueueAction({
      repository: tick.repository,
      kinds: defaultKindRegistry(tick.config),
      directory: BoardDirectory.of(tick.config.boards),
      clock: tick.clock,
    });
    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields(12, { module: 'Checkout' }),
      origin: 'a session',
    });

    assert.equal(outcome.coalescedInto, undefined);
    assert.deepEqual((await tick.stored('waiting')).payload, setFields(12, { status: 'In Review', severity: 'S4' }));
  });

  it('tries again later, writing nothing, when the row cannot be read right before the guarded write', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();
    await teach(tick, [['Severity', 'S4 · trivial']]);

    tick.board.fail('readItemById', new TransientFailure('the API answered 502'));
    await tick.drain.run();
    const waiting = await tick.stored('waiting');
    assert.equal(waiting.state, 'queued', 'a fault of the moment, not a dropped value');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo' });

    tick.clock.advance(3600 * 1000);
    await tick.drain.run();
    assert.equal((await tick.stored('waiting')).state, 'done');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Progress', Severity: 'S4 · trivial' });
  });

  it('puts the action back and waits when reading the row as it blocks is refused by a limit', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(thirteen, 'item-8', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.file({ id: 'next', payload: setFields(13, { severity: 'S2' }) });
    tick.board.fail('snapshot', new SecondaryRateLimited(60));

    const report = await tick.drain.run();

    assert.equal(report.executed, 1, 'nothing more is spent once the limit refused');
    assert.ok(report.pausedUntil !== undefined);
    const waiting = await tick.stored('waiting');
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.attempts, 0);
    assert.equal((await tick.stored('next')).state, 'queued');
  });

  it('reads no row when a verification blocks, since its release asks the whole question again', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' })] });
    await tick.file({
      id: 'question',
      kind: 'board.verify',
      payload: { repo: FIRST, issue: 12, expect: { status: 'Todo', severity: 'S4' } },
    });

    await tick.drain.run();

    assert.equal((await tick.stored('question')).state, 'blocked');
    assert.deepEqual((await tick.stored('question')).missingOptions, ['severity']);
    assert.deepEqual(
      tick.board.calls.filter((call) => call === 'readItemById' || call === 'snapshot'),
      ['snapshot'],
      'the verification\'s own walk, and nothing read for the block',
    );
  });

  it('writes only the value the board lacked when the row could not be read as the action blocked, and says so',
    async () => {
      const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
      await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
      tick.board.fail('readItemById', new TransientFailure('the API answered 502'));
      await tick.drain.run();
      assert.equal((await tick.stored('waiting')).state, 'blocked');
      assert.equal((await tick.stored('waiting')).rowAtBlock, null);

      await teach(tick, [['Severity', 'S4 · trivial']]);
      await tick.drain.run();

      assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo', Severity: 'S4 · trivial' });
      assert.match(
        (await tick.stored('waiting')).result ?? '',
        /status "In Progress" was not written: the row could not be read when the action blocked/,
      );
    });

  it('releases on what the replay asks, leaving out a value the board no longer offers', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({
      id: 'waiting',
      payload: setFields(12, { status: 'In Progress', module: 'Checkout', severity: 'S4' }),
    });
    await tick.drain.run();
    assert.equal((await tick.stored('waiting')).state, 'blocked');

    tick.board.renameOption('Status', 'In Progress', 'Doing');
    await teach(tick, [['Severity', 'S4 · trivial']]);
    assert.equal((await tick.stored('waiting')).state, 'queued');
    await tick.drain.run();

    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo', Module: 'Checkout', Severity: 'S4 · trivial' });
    const replayed = await tick.stored('waiting');
    assert.equal(replayed.state, 'done');
    assert.match(replayed.result ?? '', /status "In Progress" was not written: the board no longer offers it in Status/);
  });

  it('releases what is left when the configuration has come to refuse a value the release leaves out', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();
    tick.board.renameOption('Status', 'In Progress', 'Doing');
    const changed = drainUnder(tick, { ...tick.config, refusedStatus: ['Done', 'In Progress'] });

    await teach(tick, [['Severity', 'S4 · trivial']], 14, changed);
    await changed.run();

    assert.equal((await tick.stored('waiting')).state, 'done');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo', Severity: 'S4 · trivial' });
  });

  it('keeps for a person an action whose guarded value the configuration has come to refuse', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();
    const changed = drainUnder(tick, { ...tick.config, refusedStatus: ['Done', 'In Progress'] });

    await teach(tick, [['Severity', 'S4 · trivial']], 14, changed);

    const kept = await tick.stored('waiting');
    assert.equal(kept.state, 'blocked');
    assert.match(kept.lastError ?? '', /could not be released/);
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo' });
  });

  it('keeps for a person an action the configuration no longer lets run, and still frees the next one', async () => {
    const tick = tickFixture({
      items: [seedItem(twelve, 'item-7', {}), seedItem(thirteen, 'item-8', {}), seedItem(fourteen, 'item-9', {})],
    });
    await tick.file({ id: 'unmanaged-now', payload: setFields(12, { severity: 'S4' }) });
    await tick.file({ id: 'still-fine', payload: setFields(13, { module: 'Billing' }) });
    await tick.drain.run();
    assert.equal((await tick.stored('unmanaged-now')).state, 'blocked');
    assert.equal((await tick.stored('still-fine')).state, 'blocked');
    const changed = drainUnder(tick, {
      ...tick.config,
      fields: tick.config.fields.filter((field) => field !== 'Severity'),
    });

    tick.board.addOption('Module', { id: 'option-module-billing', name: 'Billing' });
    await teach(tick, [['Severity', 'S4 · trivial']], 14, changed, { status: 'Todo' });

    const kept = await tick.stored('unmanaged-now');
    assert.equal(kept.state, 'blocked');
    assert.deepEqual(kept.missingOptions, []);
    assert.match(kept.lastError ?? '', /could not be released/);
    assert.match(kept.lastError ?? '', /Severity/);
    assert.equal((await tick.stored('still-fine')).state, 'queued');
    assert.deepEqual(await readLastTickAt(tick.repository), tick.clock.now());
    assert.ok(tick.logger.lines.some((line) => line.message.includes('could not be released')));

    const later = await changed.run();
    assert.equal(later.unblocked, 0);
    assert.equal((await tick.stored('unmanaged-now')).state, 'blocked');
  });

  it('replays every value the board lacked, once it offers all of them', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4', type: 'Chore' }) });
    await tick.drain.run();
    tick.board.setByHand(twelve, 'Status', 'In Review');

    await teach(tick, [['Severity', 'S4 · trivial']]);
    assert.equal((await tick.stored('waiting')).state, 'blocked', 'one of the two values is still missing');
    await teach(tick, [['Defect type', 'Chore']], 15);
    await tick.drain.run();

    assert.deepEqual(tick.board.valuesOf(twelve), {
      Status: 'In Review',
      Severity: 'S4 · trivial',
      'Defect type': 'Chore',
    });
  });

  it('leaves for a person an action blocked without a record of the values the board lacked', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' }), seedItem(fourteen, 'item-9', {})] });
    const filed = await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    // What a queue file kept from before the block recorded which values were missing.
    filed.start(tick.clock.now());
    filed.block(tick.clock.now(), new OptionNotFound('Severity', 'S4', ['S1 · blocking']));
    await tick.repository.update(filed);

    await teach(tick, [['Severity', 'S4 · trivial']]);
    const report = await tick.drain.run();

    assert.equal(report.executed, 0);
    assert.equal((await tick.stored('waiting')).state, 'blocked');
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'Todo' });
  });

  it('replays the whole action when a person retries it, the status they asked for included', async () => {
    const tick = tickFixture({ items: [seedItem(twelve, 'item-7', { Status: 'Todo' })] });
    await tick.file({ id: 'waiting', payload: setFields(12, { status: 'In Progress', severity: 'S4' }) });
    await tick.drain.run();
    tick.board.setByHand(twelve, 'Status', 'In Review');
    tick.board.addOption('Severity', { id: 'option-severity-s4', name: 'S4 · trivial' });

    await new RetryAction(tick.repository, tick.clock).execute('waiting');
    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.deepEqual(tick.board.valuesOf(twelve), { Status: 'In Progress', Severity: 'S4 · trivial' });
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

  it('leaves the close queued, tick after tick, behind an evidence comment that failed', async () => {
    const tick = await commentThenClose();
    await failTheComment(tick);

    const comment = await tick.stored('c-1');
    assert.equal(comment.state, 'failed');
    assert.equal(comment.attempts, 5);
    for (let more = 0; more < 3; more += 1) {
      tick.clock.advanceMinutes(60);
      const report = await tick.drain.run();
      assert.equal(report.executed, 0, 'nothing on the issue runs past the failed comment');
    }
    assert.equal((await tick.stored('c-2')).state, 'queued');
    assert.equal(tick.issues.stateOf(twelve), 'open');
    assert.equal(tick.issues.commentsOn(twelve).length, 0);
    assert.deepEqual(tick.issues.closed, []);
  });

  it('posts the comment and then closes the issue once the failed comment is retried', async () => {
    const tick = await commentThenClose();
    await failTheComment(tick);

    await new RetryAction(tick.repository, tick.clock).execute('c-1');
    const report = await tick.drain.run();

    assert.equal(report.done, 2);
    assert.equal((await tick.stored('c-1')).state, 'done');
    assert.equal((await tick.stored('c-2')).state, 'done');
    assert.equal(tick.issues.commentsOn(twelve).length, 1);
    assert.equal(tick.issues.stateOf(twelve), 'closed');
    assert.ok(tick.issues.calls.lastIndexOf('comment') < tick.issues.calls.lastIndexOf('close'));
  });

  it('closes the issue once the failed comment in front of it is cancelled', async () => {
    const tick = await commentThenClose();
    await failTheComment(tick);

    await new CancelAction(tick.repository, tick.clock).execute('c-1');
    const report = await tick.drain.run();

    assert.equal(report.done, 1);
    assert.equal((await tick.stored('c-2')).state, 'done');
    assert.equal(tick.issues.stateOf(twelve), 'closed');
    assert.equal(tick.issues.commentsOn(twelve).length, 0);
  });

  it('leaves the close queued behind an evidence comment that is blocked', async () => {
    const tick = await commentThenClose();
    tick.issues.fail('comment', new IssueNotFound(twelve.toString()));

    const first = await tick.drain.run();

    assert.equal(first.blocked, 1);
    assert.equal(first.executed, 1);
    assert.equal((await tick.stored('c-1')).state, 'blocked');
    tick.clock.advanceMinutes(60);
    assert.equal((await tick.drain.run()).executed, 0);
    assert.equal((await tick.stored('c-2')).state, 'queued');
    assert.equal(tick.issues.stateOf(twelve), 'open');
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

/** An open issue with an evidence comment filed on it and the close filed after it. */
async function commentThenClose(): Promise<TickFixture> {
  const tick = tickFixture({ issues: [{ ref: twelve }] });
  await tick.file({ id: 'c-1', kind: 'issue.comment', payload: { repo: FIRST, issue: 12, body: 'the fix is live' } });
  await tick.file({
    id: 'c-2',
    kind: 'issue.close',
    payload: { repo: FIRST, issue: 12, reason: 'completed' },
    createdAt: new Date(tick.clock.now().getTime() + 1000),
  });
  return tick;
}

/** Refuses the comment on every attempt it has, a tick per attempt, until it fails for good. */
async function failTheComment(tick: TickFixture): Promise<void> {
  for (let attempt = 1; attempt <= tick.config.worker.maxAttempts; attempt += 1) {
    tick.issues.fail('comment', new TransientFailure('the API answered 502'));
    const report = await tick.drain.run();
    assert.equal(report.executed, 1, `only the comment runs on attempt ${String(attempt)}`);
    tick.clock.advanceMinutes(60);
  }
}

/**
 * Somebody adds options in the board's own interface, and the next tick that has
 * work on another issue reads the catalog afresh once the cached one has aged out.
 */
async function teach(
  tick: TickFixture,
  options: readonly [string, string][],
  otherIssue = 14,
  drain: DrainQueue = tick.drain,
  otherWork: Record<string, string> = { severity: 'S2' },
): Promise<void> {
  for (const [field, name] of options) {
    tick.board.addOption(field, { id: `option-${name}`, name });
  }
  tick.clock.advance(tick.config.worker.catalogTtlSec * 1000 + 1000);
  await tick.file({ id: `teaching-${String(otherIssue)}`, payload: setFields(otherIssue, otherWork) });
  await drain.run();
}

/** The same queue and board, worked by a worker that reads a configuration changed since. */
function drainUnder(tick: TickFixture, config: Config): DrainQueue {
  return new DrainQueue({
    repository: tick.repository,
    boards: tick.boards,
    kinds: defaultKindRegistry(config),
    policy: tick.policy,
    clock: tick.clock,
    sleeper: tick.sleeper,
    logger: tick.logger,
    config,
  });
}
