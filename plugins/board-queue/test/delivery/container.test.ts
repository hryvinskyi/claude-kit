import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildContainer } from '../../src/delivery/container.ts';
import type { TokenProvider } from '../../src/application/ports.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { FakeBoardGateway } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { lanesByBoard } from '../fakes/lanes.ts';
import { ORG_BOARD, THIRD, USER_BOARD, testConfig, testRepos, twoBoardConfig } from '../fixtures/config.ts';

const FIRST = 'example-org/first-repo';

/** Counts the moments a credential was actually asked for. */
class CountingTokenProvider implements TokenProvider {
  mints = 0;

  async token(): Promise<string> {
    this.mints += 1;
    return 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  }

  invalidate(): void {
    // Nothing is held, so there is nothing to drop.
  }
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'board-queue-container-'));
}

describe('what the composition root hands out', () => {
  it('files and lists work with the gateways that reach the network in place, asking for no credential', async () => {
    const directory = temporaryDirectory();
    const tokens = new CountingTokenProvider();
    const container = buildContainer({ config: testConfig, stateDir: directory, overrides: { tokens } });
    try {
      const filed = await container.enqueue.execute({
        kind: 'issue.comment',
        payload: { repo: FIRST, issue: 12, body: 'the fix is on staging' },
        origin: 'a session with no way to reach anything',
      });
      const listed = await container.list.execute({});
      const status = await container.status.execute();

      assert.equal(filed.state, 'queued');
      assert.deepEqual(listed.map((action) => action.id), [filed.id]);
      assert.equal(status.counts.queued, 1);
      // The gateways are the real ones here; nothing asked them anything, so
      // nothing asked for a credential either.
      assert.equal(tokens.mints, 0);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the queue and the log in the directory it was given', async () => {
    const directory = temporaryDirectory();
    const container = buildContainer({
      config: testConfig,
      stateDir: directory,
      overrides: {
        lanes: () => ({ board: new FakeBoardGateway(), issues: new FakeIssueGateway() }),
        clock: new FakeClock(),
      },
    });
    try {
      container.logger.info('a line worth keeping');
      await container.status.execute();

      assert.ok(existsSync(join(directory, 'queue.db')));
      assert.ok(existsSync(join(directory, 'worker.log')));
      assert.equal(container.stateDir, directory);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the board on the same schedule as it writes it, and leaves the report in the state directory', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock();
    const container = buildContainer({
      config: testConfig,
      stateDir: directory,
      overrides: {
        lanes: () => ({
          board: new FakeBoardGateway({ clock }),
          issues: new FakeIssueGateway([{ ref: IssueRef.of(FIRST, 12), title: 'nobody filed this one' }]),
        }),
        clock,
        sleeper: new FakeSleeper(),
      },
    });
    try {
      const report = await container.tick.run();

      assert.equal(report.executed, 0);
      const written: unknown = JSON.parse(readFileSync(join(directory, 'audit.json'), 'utf8'));
      assert.match(JSON.stringify(written), /nobody filed this one/);
      assert.equal((await container.status.execute()).lastAudit?.notOnBoard, 1);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sends filed work to the board that carries its repository, and only there', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock();
    const organisation = { board: new FakeBoardGateway({ clock }), issues: new FakeIssueGateway() };
    const person = {
      board: new FakeBoardGateway({ clock }),
      issues: new FakeIssueGateway([{ ref: IssueRef.of(THIRD, 5), title: 'on the second board' }]),
    };
    const container = buildContainer({
      config: twoBoardConfig,
      stateDir: directory,
      overrides: {
        lanes: lanesByBoard(new Map([[ORG_BOARD, organisation], [USER_BOARD, person]])),
        clock,
        sleeper: new FakeSleeper(),
      },
    });
    try {
      await container.enqueue.execute({
        kind: 'issue.comment',
        payload: { repo: THIRD, issue: 5, body: 'seen on staging' },
        origin: 'a session',
      });

      const report = await container.tick.run();

      assert.equal(report.done, 1);
      assert.deepEqual(person.issues.posted.map((post) => post.ref), [`${THIRD}#5`]);
      assert.deepEqual(organisation.issues.posted, []);
      assert.deepEqual(container.directory.boards().map((board) => board.name), ['example-org/7', 'example-user/3']);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds two boards\' gateways without asking either account for a credential', async () => {
    const directory = temporaryDirectory();
    const tokens = new CountingTokenProvider();
    const container = buildContainer({ config: twoBoardConfig, stateDir: directory, overrides: { tokens } });
    try {
      await container.enqueue.execute({
        kind: 'issue.comment',
        payload: { repo: THIRD, issue: 5, body: 'seen on staging' },
        origin: 'a session with no way to reach anything',
      });

      assert.equal(container.boards.lanes().length, 2);
      assert.equal(tokens.mints, 0);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('offers the same pass on its own, for whoever asks for one out of turn', async () => {
    const directory = temporaryDirectory();
    const clock = new FakeClock();
    const container = buildContainer({
      config: testConfig,
      stateDir: directory,
      overrides: {
        lanes: () => ({ board: new FakeBoardGateway({ clock }), issues: new FakeIssueGateway() }),
        clock,
        sleeper: new FakeSleeper(),
      },
    });
    try {
      const report = await container.audit.execute();

      assert.deepEqual(Object.keys(report.repos), testRepos);
      assert.ok(existsSync(join(directory, 'audit.json')));
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
