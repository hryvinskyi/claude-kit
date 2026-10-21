import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AuditReport } from '../../src/application/audit-board.ts';
import { Flags, commands } from '../../src/delivery/cli.ts';
import { buildContainer } from '../../src/delivery/container.ts';
import type { Container } from '../../src/delivery/container.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { FakeBoardGateway, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { testConfig, testRepos } from '../fixtures/config.ts';

const FIRST = 'example-org/first-repo';
const unfiled = IssueRef.of(FIRST, 10);
const closedTooSoon = IssueRef.of(FIRST, 21);

/** A container whose gateways answer from memory, on a queue in a temporary directory. */
function wiredTo(directory: string): Container {
  const clock = new FakeClock();
  return buildContainer({
    config: testConfig,
    stateDir: directory,
    overrides: {
      clock,
      sleeper: new FakeSleeper(),
      lanes: () => ({
        board: new FakeBoardGateway({
          clock,
          items: [seedItem(closedTooSoon, 'item-21', { Status: 'In Progress' })],
        }),
        issues: new FakeIssueGateway([
          { ref: unfiled, title: 'the login form forgets the e-mail field' },
          { ref: closedTooSoon, state: 'closed', title: 'the search box swallowed the query' },
        ]),
      }),
    },
  });
}

async function audit(container: Container, argv: readonly string[]): Promise<string[]> {
  const command = commands['audit'];
  assert.ok(command !== undefined, 'the command line offers no audit');
  const lines: string[] = [];
  await command.run({
    positionals: [],
    flags: new Flags(argv.includes('--json') ? { json: true } : {}, command.usage),
    out: (line) => {
      lines.push(line);
    },
    err: (line) => {
      lines.push(line);
    },
    container: () => container,
    stdin: () => Promise.resolve(''),
    home: tmpdir(),
    cwd: tmpdir(),
    nodePath: process.execPath,
    configHome: null,
  });
  return lines;
}

describe('board-queue audit', () => {
  it('prints a short table a person can act on', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-cli-audit-'));
    const container = wiredTo(directory);
    try {
      const lines = await audit(container, []);

      assert.match(lines.join('\n'), new RegExp(`${FIRST} · 1 open · 1 not on the board · 1 the board did not follow`));
      assert.ok(lines.some((line) => /not on the board\s+#10\s+the login form forgets the e-mail field/.test(line)));
      assert.ok(lines.some((line) => /board not followed\s+#21\s+.+In Progress/.test(line)));
      assert.equal(lines.at(-1), 'nothing was queued: this pass only says what it found');
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives the whole report to whatever asked for JSON', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-cli-audit-'));
    const container = wiredTo(directory);
    try {
      const lines = await audit(container, ['--json']);

      assert.equal(lines.length, 1);
      const report = JSON.parse(lines[0] ?? '') as AuditReport;
      assert.deepEqual(Object.keys(report.repos), testRepos);
      assert.deepEqual(report.repos[FIRST]?.notOnBoard.map((issue) => issue.number), [10]);
      assert.equal(report.repos[FIRST]?.closedNotDone[0]?.status, 'In Progress');
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('queues nothing, whatever it found', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-cli-audit-'));
    const container = wiredTo(directory);
    try {
      await audit(container, []);

      assert.deepEqual(await container.list.execute({}), []);
    } finally {
      container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
