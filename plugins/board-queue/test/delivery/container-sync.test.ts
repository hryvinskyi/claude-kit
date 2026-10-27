import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { buildContainer } from '../../src/delivery/container.ts';
import type { ContainerOverrides } from '../../src/delivery/container.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { enqueueLines, statusLines } from '../../src/delivery/human-text.ts';
import { FakeBoardGateway, catalogField, catalogOf, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination, claim } from '../fakes/fake-coordination.ts';
import { FakeDependencyReader } from '../fakes/fake-dependencies.ts';
import { FakeForge, pullRequest } from '../fakes/fake-forge.ts';
import { FakeForgeCoordination } from '../fakes/fake-forge-coordination.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { FakeFetch } from '../fakes/fake-fetch.ts';
import { writeAppKey } from '../fixtures/app-key.ts';
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

function containerFor(
  t: TestContext,
  config: Config,
  overrides: ContainerOverrides,
  env?: Record<string, string | undefined>,
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'board-queue-sync-'));
  const container = buildContainer({ config, stateDir, overrides, ...(env === undefined ? {} : { env }) });
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

  it('assigns the person who files a move into the claimed status, and the worker applies both', async (t) => {
    const it_ = world('bob-gh');
    const container = containerFor(t, syncConfig, it_.overrides);

    const outcome = await container.enqueue.execute({
      kind: 'board.set-fields',
      payload: { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress' } },
      origin: 'a session',
    });
    await container.drain.run();

    assert.equal(outcome.assignment?.login, 'bob-gh');
    assert.deepEqual(it_.board.valuesOf(TWELVE), { Status: 'In Progress' });
    assert.ok(it_.issues.assigneesOf(TWELVE).includes('bob-gh'));
    assert.deepEqual(enqueueLines(outcome).slice(1), [`assigns bob-gh, who starts the work: ${outcome.assignment?.id ?? ''}`]);
  });

  it('assigns nobody through a move when the mirror assigns nobody', async (t) => {
    const it_ = world('bob-gh');
    const sync = syncConfig.dibs;
    assert.ok(sync?.mirror !== undefined);
    const config = ConfigSchema.parse({ ...syncConfig, dibs: { ...sync, mirror: { ...sync.mirror, assignees: false } } });
    const container = containerFor(t, config, it_.overrides);

    const outcome = await container.enqueue.execute({
      kind: 'board.set-fields',
      payload: { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress' } },
      origin: 'a session',
    });

    assert.equal(outcome.assignment, undefined);
    assert.deepEqual((await container.list.execute({})).map((action) => action.kind), ['board.set-fields']);
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

  it('gives up its own person\'s areas when the issue moves on to QA, on a worker that is not the owner', async (t) => {
    const it_ = world('bob-gh');
    it_.coordination.tokenHolder = 'bob';
    const held = {
      item: 45,
      ref: 'gh:example-org/first-repo#13',
      claimedAt: '2026-03-02T08:00:00Z',
      closed: false,
      areas: ['web:checkout'],
      inReview: false,
    };
    it_.coordination.heldBy('bob', { ...held, boardStatus: 'In Progress' });
    const config = ConfigSchema.parse({
      ...syncConfig,
      dibs: { ...syncConfig.dibs, finish: { enabled: true, handOn: ['Ready for QA'], complete: ['Done'] } },
    });
    const container = containerFor(t, config, it_.overrides);

    await container.tick.run();
    it_.coordination.heldBy('bob', { ...held, boardStatus: 'Ready for QA' });
    const report = await container.tick.run();
    const status = await container.status.execute();

    assert.equal(report.sync?.refusal, 'not-the-owner', 'the owner\'s jobs are left to alice\'s worker');
    assert.deepEqual(it_.coordination.givenUp, [[45, ['web:checkout']]]);
    assert.deepEqual(it_.coordination.completed, [], 'the item stays held, so QA can send the work back');
    assert.deepEqual(status.sync?.finish.lastRun?.handedOn, ['gh:example-org/first-repo#13']);
    assert.ok(statusLines(status).some((line) => line.includes('claims let go (areas given up at Ready for QA')));
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

  it('builds no forge pass unless the configuration turns it on', async (t) => {
    const it_ = world('alice');
    const forge = new FakeForge();
    const dibs = new FakeForgeCoordination();
    const container = containerFor(t, syncConfig, { ...it_.overrides, forge, forgeCoordination: dibs });

    const report = await container.tick.run();

    assert.equal(report.sync?.forge, undefined);
    assert.deepEqual(dibs.calls, []);
    assert.equal((await container.status.execute()).sync?.forge.enabled, false);
  });

  it('runs the forge pass on the queue\'s own file when it is on, and says so in its status', async (t) => {
    const it_ = world('alice');
    const forge = new FakeForge().put(pullRequest('example-org/first-repo', 5));
    const dibs = new FakeForgeCoordination().repository('web', 'example-org/first-repo').member('alice', 'alice-gh')
      .wants('web', 'main', { enabled: true, status: { state: 'success', description: 'Nothing freezes main.', context: 'dibs' } });
    const config = ConfigSchema.parse({
      ...testConfig,
      dibs: { ...syncConfig.dibs, mirror: undefined, importer: { enabled: false }, forge: { enabled: true } },
    });
    const container = containerFor(t, config, {
      ...it_.overrides,
      forge,
      forgeCoordination: dibs,
      forgeIdentity: { usesAppIdentity: () => true },
    });

    const report = await container.tick.run();
    const status = await container.status.execute();

    const forged = report.sync?.forge;
    assert.ok(forged !== undefined && 'run' in forged);
    assert.equal(forged.run.repos[0]?.seeded, true);
    assert.equal(forge.statuses.length, 1);
    assert.equal(status.sync?.forge.lastRun?.requests, forged.run.requests);
    assert.ok(statusLines(status).some((line) => line.startsWith('forge example-org/first-repo: started with 1 open')));
  });

  it('declines the forge pass on a worker whose calls would go out under a person\'s credential, and says so', async (t) => {
    const it_ = world('alice');
    const forge = new FakeForge();
    const dibs = new FakeForgeCoordination();
    const config = ConfigSchema.parse({
      ...testConfig,
      dibs: { ...syncConfig.dibs, mirror: undefined, importer: { enabled: false }, forge: { enabled: true } },
    });
    const container = containerFor(t, config, {
      ...it_.overrides,
      forge,
      forgeCoordination: dibs,
      forgeIdentity: { usesAppIdentity: () => false },
    });

    const report = await container.tick.run();
    const status = await container.status.execute();

    assert.match(JSON.stringify(report.sync?.forge), /only under an App/);
    assert.deepEqual(dibs.calls, []);
    assert.deepEqual(forge.asked, []);
    assert.ok(statusLines(status).some((line) => /^forge .* — declined: the forge jobs run only under an App/.test(line)));
  });

  it('runs the forge pass under a person\'s credential only where the configuration allows it', async (t) => {
    const it_ = world('alice');
    const dibs = new FakeForgeCoordination();
    const config = ConfigSchema.parse({
      ...testConfig,
      dibs: {
        ...syncConfig.dibs,
        mirror: undefined,
        importer: { enabled: false },
        forge: { enabled: true, allowPersonalToken: true },
      },
    });
    const container = containerFor(t, config, {
      ...it_.overrides,
      forge: new FakeForge(),
      forgeCoordination: dibs,
      forgeIdentity: { usesAppIdentity: () => false },
    });

    const report = await container.tick.run();

    const forged = report.sync?.forge;
    assert.ok(forged !== undefined && 'run' in forged);
    assert.ok(dibs.calls.includes('repositories'));
  });

  it('runs as the service when the GitHub App it holds the key of is the configured owner', async (t) => {
    const it_ = world('unused');
    const keyDir = mkdtempSync(join(tmpdir(), 'board-queue-sync-key-'));
    t.after(() => {
      rmSync(keyDir, { recursive: true, force: true });
    });
    const app = new FakeFetch([{ body: { slug: 'example-sync' } }]);
    const config = ConfigSchema.parse({ ...syncConfig, dibs: { ...syncConfig.dibs, mirrorOwner: 'example-sync[bot]' } });
    const { identity: _personal, ...withoutIdentity } = it_.overrides;
    const container = containerFor(t, config, { ...withoutIdentity, appFetch: app.fetch }, {
      BOARD_QUEUE_IDENTITY: 'app',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY_PATH: writeAppKey(keyDir).path,
    });

    const report = await container.tick.run();

    assert.equal(report.sync?.refused, undefined);
    assert.equal(report.done, 2);
    assert.deepEqual(it_.board.valuesOf(TWELVE), { Status: 'In Progress' });
    assert.deepEqual(app.calls.map((call) => call.url), ['https://api.github.com/app']);
  });

  it('runs none of the owner\'s jobs on a person\'s machine handed the service\'s configuration, quietly', async (t) => {
    const it_ = world('bob');
    const config = ConfigSchema.parse({ ...syncConfig, dibs: { ...syncConfig.dibs, mirrorOwner: 'example-sync[bot]' } });
    const { identity: _personal, ...withoutIdentity } = it_.overrides;
    const laptop = containerFor(t, config, it_.overrides, {});
    const pretending = containerFor(t, config, withoutIdentity, { BOARD_QUEUE_IDENTITY: 'app' });

    const fromGh = await laptop.tick.run();
    const fromNoKey = await pretending.tick.run();

    // A person's login never ends in [bot]: such a worker is simply not the owner's.
    assert.equal(fromGh.sync?.refused, 'this worker runs as bob, and only example-sync[bot]\'s worker runs '
      + 'the claim mirror and the importer');
    assert.equal(fromGh.sync?.refusal, 'not-the-owner');
    assert.match(fromNoKey.sync?.refused ?? '', /runs as its GitHub App, and the environment names none/);
    assert.equal(fromNoKey.sync?.refusal, 'identity-unreadable');
    assert.deepEqual(it_.coordination.calls, []);
  });

  it('mirrors its own person\'s moves on every worker, and leaves the owner\'s jobs to the owner\'s, quietly', async (t) => {
    const it_ = world('bob-gh');
    it_.coordination.member('bob', 'bob-gh').log(claim(4, 'claimed', 45, 'bob')).item(45, 'gh:example-org/first-repo#13')
      .holds(45, 'bob');
    const config = ConfigSchema.parse({
      ...syncConfig,
      dibs: { ...syncConfig.dibs, mirror: { ...syncConfig.dibs?.mirror, scope: 'own' } },
    });
    const container = containerFor(t, config, it_.overrides);

    const report = await container.tick.run();
    const status = await container.status.execute();

    assert.deepEqual(it_.board.valuesOf(TWELVE), { Status: 'Todo' }, 'alice\'s claim is left to alice\'s worker');
    const filed = await container.list.execute({});
    assert.deepEqual(filed.map((action) => [action.kind, action.ref]), [
      ['board.set-fields', 'example-org/first-repo#13'],
      ['issue.assignees', 'example-org/first-repo#13'],
    ]);
    assert.equal(status.sync?.mirror.lastRun?.filedFor, 'bob');
    assert.equal(status.sync?.mirror.lastRun?.othersMoves, 1);
    assert.equal(report.sync?.refusal, 'not-the-owner');
    assert.equal(it_.coordination.batches.length, 0, 'the importer runs only in alice\'s worker');
    const lines = statusLines(status);
    assert.ok(lines.includes('not run here — this worker runs as bob-gh, and only alice\'s worker runs the importer'));
    assert.ok(lines.some((line) => line.endsWith('mirror on, each person\'s own moves · importer on · forge off · importer only in alice\'s worker')));
  });

  it('reaches the server with the token the dibs tool stored, and never writes it down', async (t) => {
    const it_ = world('bob-gh');
    const loginDir = mkdtempSync(join(tmpdir(), 'board-queue-sync-login-'));
    t.after(() => {
      rmSync(loginDir, { recursive: true, force: true });
    });
    const token = 'dibs_storedstoredstoredstoredstoredstored';
    writeFileSync(join(loginDir, 'credentials.toml'),
      `[[credential]]\nserver = "https://dibs.example.com"\nproject = "widgets"\ntoken = "${token}"\n`);
    chmodSync(join(loginDir, 'credentials.toml'), 0o600);
    const server = new FakeFetch([
      { body: { members: [{ handle: 'bob', display_name: 'Bob', external_login: 'bob-gh', role: 'member' }] } },
      { body: { events: [], next: null } },
      { body: { claims: [{ item: 41, holder: 'bob', state: 'working', branches: {} }] } },
      { body: { item: { id: 41, ref: 'gh:example-org/first-repo#12' } } },
    ]);
    const config = ConfigSchema.parse({
      ...syncConfig,
      dibs: {
        ...syncConfig.dibs,
        token: { from: 'dibs-login' },
        mirror: { ...syncConfig.dibs?.mirror, scope: 'own' },
        importer: { enabled: false },
      },
    });
    const { coordination: _fake, ...overrides } = it_.overrides;
    const container = containerFor(t, config, { ...overrides, dibsFetch: server.fetch }, { DIBS_CONFIG_DIR: loginDir });

    const report = await container.tick.run();

    assert.equal(report.done, 2);
    assert.deepEqual(it_.issues.assigneesOf(TWELVE), ['bob-gh']);
    assert.deepEqual(server.calls.map((call) => call.url), [
      'https://dibs.example.com/v1/members',
      'https://dibs.example.com/v1/events?after=0&limit=500',
      'https://dibs.example.com/v1/claims',
      'https://dibs.example.com/v1/items/41',
    ]);
    assert.ok(server.calls.every((call) => call.headers['authorization'] === `Bearer ${token}`));
    assert.equal(report.sync?.refused, undefined, 'no job here waits for the owner\'s worker');
    assert.ok(!readFileSync(join(container.stateDir, 'worker.log'), 'utf8').includes(token));
  });
});
