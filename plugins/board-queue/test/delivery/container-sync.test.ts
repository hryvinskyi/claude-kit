import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { buildContainer } from '../../src/delivery/container.ts';
import type { ContainerOverrides } from '../../src/delivery/container.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { statusLines } from '../../src/delivery/human-text.ts';
import { FakeBoardGateway, catalogField, catalogOf, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination, claim } from '../fakes/fake-coordination.ts';
import { FakeDependencyReader } from '../fakes/fake-dependencies.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { testConfig } from '../fixtures/config.ts';
import { syncConfig } from '../fixtures/sync.ts';

const TWELVE = IssueRef.of('example-org/first-repo', 12);

type World = {
  board: FakeBoardGateway;
  issues: FakeIssueGateway;
  coordination: FakeCoordination;
  overrides: ContainerOverrides;
};

function world(login: string): World {
  const board = new FakeBoardGateway({
    catalog: catalogOf(catalogField('Status', ['Todo', 'In Progress', 'In Review', 'Ready for QA'])),
    items: [{
      ...seedItem(TWELVE, 'item-12', { Status: 'Todo' }),
      issue: {
        title: 'Refund rounding',
        state: 'open',
        createdAt: new Date('2026-03-01T09:00:00Z'),
        updatedAt: new Date('2026-03-01T10:00:00Z'),
        blockedByTotal: 0,
        subIssuesTotal: 0,
      },
    }],
  });
  const issues = new FakeIssueGateway([{ ref: TWELVE }]);
  const coordination = new FakeCoordination()
    .item(41, 'gh:example-org/first-repo#12')
    .member('alice', 'alice-gh')
    .log(claim(3, 'claimed', 41, 'alice'))
    .holds(41, 'alice');
  const clock = new FakeClock('2026-03-02T09:00:00.000Z');
  return {
    board,
    issues,
    coordination,
    overrides: {
      lanes: () => ({ board, issues }),
      clock,
      sleeper: new FakeSleeper(clock),
      coordination,
      dependencies: new FakeDependencyReader(),
      identity: { login: () => Promise.resolve(login) },
    },
  };
}

function containerFor(t: TestContext, config: Config, overrides: ContainerOverrides) {
  const stateDir = mkdtempSync(join(tmpdir(), 'board-queue-sync-'));
  const container = buildContainer({ config, stateDir, overrides });
  t.after(() => {
    container.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return container;
}

describe('a worker that keeps the board in step, on a real queue file', () => {
  it('mirrors a claim, drains it, reports the board\'s work and says so in its status', async (t) => {
    const it_ = world('alice');
    const container = containerFor(t, syncConfig, it_.overrides);

    const report = await container.tick.run();
    const status = await container.status.execute();

    assert.equal(report.done, 2);
    assert.deepEqual(it_.board.valuesOf(TWELVE), { Status: 'In Progress' });
    assert.deepEqual(it_.issues.assigneesOf(TWELVE), ['alice-gh']);
    assert.equal(it_.coordination.batches.length, 1);
    assert.equal(it_.coordination.batches[0]?.complete, true);
    assert.equal(status.sync?.mirror.lastRun?.filed, 2);
    assert.equal(status.sync?.importer.lastRun?.complete, true);
    assert.ok(statusLines(status).some((line) => line.startsWith('mirror 2026-03-02T09:00:00.000Z — 0 events read, 2 filed')));
    assert.ok(statusLines(status).some((line) => line.startsWith('mirror started from the head at event 3')));
  });

  it('files nothing a second time when the same events are read again after a restart', async (t) => {
    const it_ = world('alice');
    const container = containerFor(t, syncConfig, it_.overrides);
    await container.tick.run();
    await container.repository.setMeta('mirror.cursor:https://dibs.example.com:widgets', '0');

    const again = await container.tick.run();

    assert.equal(again.executed, 0);
    assert.equal((await container.list.execute({})).length, 2);
  });

  it('asks nothing of the server on a worker that is not the owner', async (t) => {
    const it_ = world('bob');
    const container = containerFor(t, syncConfig, it_.overrides);

    const report = await container.tick.run();
    const status = await container.status.execute();

    assert.deepEqual(it_.coordination.calls, []);
    assert.match(report.sync?.refused ?? '', /runs as bob/);
    assert.match(status.sync?.refused?.reason ?? '', /runs as bob/);
  });

  it('builds nothing that reaches the server while both directions are off', async (t) => {
    const it_ = world('alice');
    const quiet = ConfigSchema.parse({
      ...testConfig,
      dibs: { ...syncConfig.dibs, mirror: undefined, importer: { enabled: false } },
    });
    const container = containerFor(t, quiet, it_.overrides);

    const report = await container.tick.run();

    assert.equal(report.sync, undefined);
    assert.deepEqual(it_.coordination.calls, []);
    assert.deepEqual((await container.status.execute()).sync?.mirror.enabled, false);
  });
});
