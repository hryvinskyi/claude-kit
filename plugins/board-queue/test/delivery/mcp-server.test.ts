import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { buildContainer } from '../../src/delivery/container.ts';
import type { Container } from '../../src/delivery/container.ts';
import { createMcpServer } from '../../src/delivery/mcp-server.ts';
import { OptionNotFound } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { catalogField, catalogOf, FakeBoardGateway, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { TEST_BOARD, THIRD, testConfig, testRepos, twoBoardConfig } from '../fixtures/config.ts';

const NOW = '2026-01-10T09:00:00.000Z';
const FIRST = 'example-org/first-repo';

/** What a tool answered, in the two parts a caller reads: the text and whether it refused. */
const Answer = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const Filed = z.object({
  id: z.string(),
  state: z.string(),
  coalescedInto: z.string().optional(),
  warnings: z.array(z.string()),
});

const Listed = z.array(z.object({
  id: z.string(),
  kind: z.string(),
  ref: z.string().nullable(),
  state: z.string(),
  payload: z.unknown(),
}));

const Status = z.object({
  counts: z.record(z.string(), z.number()),
  pause: z.unknown(),
  held: z.array(z.object({ id: z.string(), ageDays: z.number(), origin: z.string() })),
  blocked: z.array(z.object({ id: z.string(), lastError: z.string().nullable() })),
});

const Moved = z.object({ id: z.string(), state: z.string(), attempts: z.number() });

const Row = z.object({
  ref: z.string(),
  onBoard: z.boolean(),
  itemId: z.string().nullable(),
  values: z.record(z.string(), z.string()),
  budget: z.string().nullable(),
});

type Spoken = { refused: boolean; text: string };

type Harness = {
  client: Client;
  container: Container;
  board: FakeBoardGateway;
  clock: FakeClock;
  stop: () => Promise<void>;
};

const boardCatalog = catalogOf(
  catalogField('Status', ['Triage', 'In progress', 'Done']),
  catalogField('Severity', ['S1 · blocking', 'S2 · broken · no workaround']),
);

/**
 * A session talking to the queue exactly as one does in the field: over the
 * protocol, against a real database in a directory of its own, with only the two
 * gateways that reach the network standing in.
 */
async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-mcp-'));
  const clock = new FakeClock(NOW);
  const board = new FakeBoardGateway({
    clock,
    catalog: boardCatalog,
    items: [seedItem(IssueRef.of(FIRST, 12), 'item-12', { Status: 'In progress' })],
  });
  const issues = new FakeIssueGateway();
  const container = buildContainer({
    config: testConfig,
    stateDir: directory,
    overrides: { lanes: () => ({ board, issues }), clock, sleeper: new FakeSleeper() },
  });
  const server = createMcpServer(container);
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'a session under test', version: '0.0.0' });
  await Promise.all([server.connect(serverEnd), client.connect(clientEnd)]);
  return {
    client,
    container,
    board,
    clock,
    stop: async () => {
      await client.close();
      await server.close();
      container.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function withHarness(run: (harnessed: Harness) => Promise<void>): Promise<void> {
  const harnessed = await harness();
  try {
    await run(harnessed);
  } finally {
    await harnessed.stop();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Spoken> {
  const answer = Answer.parse(await client.callTool({ name, arguments: args }));
  return {
    refused: answer.isError === true,
    text: answer.content.map((part) => part.text ?? '').join('\n'),
  };
}

function bodyOf(spoken: Spoken): unknown {
  assert.equal(spoken.refused, false, `the tool refused: ${spoken.text}`);
  return JSON.parse(spoken.text) as unknown;
}

function fields(severity: string, issue = 12): Record<string, unknown> {
  return { repo: FIRST, issue, fields: { severity } };
}

describe('the queue as a session sees it', () => {
  it('offers every tool by name', async () => {
    await withHarness(async ({ client }) => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'board_cancel',
        'board_enqueue',
        'board_queue',
        'board_release',
        'board_retry',
        'board_show',
        'board_status',
      ]);
    });
  });

  it('teaches the caller the rules in the description of the tool that files work', async () => {
    await withHarness(async ({ client }) => {
      const tools = await client.listTools();
      const enqueue = tools.tools.find((tool) => tool.name === 'board_enqueue');
      const description = enqueue?.description ?? '';
      for (const kind of ['board.set-fields', 'board.verify', 'issue.comment', 'issue.close']) {
        assert.ok(description.includes(kind), `the description does not mention ${kind}`);
      }
      for (const repo of testRepos) {
        assert.ok(description.includes(repo), `the description does not mention ${repo}`);
      }
      assert.match(description, /Done/);
      assert.match(description, /board_release/);
      assert.match(description, /board_retry/);
      assert.match(description, /five minutes/);
    });
  });

  it('files an action and answers where it ended up', async () => {
    await withHarness(async ({ client, container }) => {
      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
        origin: 'a session in the first checkout',
      })));

      assert.equal(filed.state, 'queued');
      assert.equal(filed.coalescedInto, undefined);
      assert.deepEqual(filed.warnings, []);
      const stored = await container.repository.get(filed.id);
      assert.equal(stored?.origin, 'a session in the first checkout');
      assert.equal(stored?.issueRef?.toString(), `${FIRST}#12`);
    });
  });

  it('names the directory it runs in when the caller names no origin', async () => {
    await withHarness(async ({ client, container }) => {
      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));

      assert.equal((await container.repository.get(filed.id))?.origin, process.cwd());
    });
  });

  it('folds a second request on the same issue into the one already waiting', async () => {
    await withHarness(async ({ client, container }) => {
      const first = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));
      const second = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: { repo: FIRST, issue: 12, fields: { status: 'In progress' } },
      })));

      assert.equal(second.coalescedInto, first.id);
      assert.equal(second.id, first.id);
      assert.equal(second.state, 'queued');
      assert.equal((await container.repository.counts()).queued, 1);
      assert.deepEqual((await container.repository.get(first.id))?.payload, {
        repo: FIRST,
        issue: 12,
        fields: { severity: 'S2', status: 'In progress' },
      });
    });
  });

  it('keeps a held request apart from the one that is already waiting', async () => {
    await withHarness(async ({ client, container }) => {
      const waiting = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));
      const held = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: { repo: FIRST, issue: 12, fields: { status: 'In progress' } },
        hold: true,
      })));

      assert.notEqual(held.id, waiting.id);
      assert.equal(held.coalescedInto, undefined);
      assert.equal(held.state, 'held');
      const counts = await container.repository.counts();
      assert.equal(counts.queued, 1);
      assert.equal(counts.held, 1);
    });
  });

  it('files work that waits for a moment, and refuses a moment that is not one', async () => {
    await withHarness(async ({ client, container }) => {
      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
        notBefore: '2026-01-10T18:00:00.000Z',
      })));

      assert.equal(filed.state, 'queued');
      assert.equal(
        (await container.repository.get(filed.id))?.notBefore?.toISOString(),
        '2026-01-10T18:00:00.000Z',
      );

      const spoken = await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2', 14),
        notBefore: 'tomorrow afternoon',
      });
      assert.equal(spoken.refused, true);
    });
  });

  it('refuses the status the board would act on before the evidence exists', async () => {
    await withHarness(async ({ client, container }) => {
      const spoken = await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: { repo: FIRST, issue: 12, fields: { status: 'Done' } },
      });

      assert.equal(spoken.refused, true);
      assert.match(spoken.text, /auto-close/);
      assert.equal((await container.repository.counts()).queued, 0);
    });
  });

  it('refuses a repository nobody configured', async () => {
    await withHarness(async ({ client, container }) => {
      const spoken = await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: { repo: 'example-org/somewhere-else', issue: 12, fields: { severity: 'S2' } },
      });

      assert.equal(spoken.refused, true);
      assert.match(spoken.text, /not a configured repository/);
      assert.equal((await container.repository.counts()).queued, 0);
    });
  });

  it('refuses a kind nobody registered', async () => {
    await withHarness(async ({ client }) => {
      const spoken = await call(client, 'board_enqueue', {
        kind: 'issue.invent',
        payload: fields('S2'),
      });

      assert.equal(spoken.refused, true);
    });
  });

  it('warns about an option the board did not offer when it was last read', async () => {
    await withHarness(async ({ client, container, clock }) => {
      await container.repository.putCatalog(TEST_BOARD, boardCatalog, clock.now());

      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('urgent'),
      })));

      assert.equal(filed.state, 'queued');
      assert.equal(filed.warnings.length, 1);
      assert.match(filed.warnings[0] ?? '', /Severity has no option matching "urgent"/);
    });
  });

  it('lists the queue and narrows it by what the caller asks for', async () => {
    await withHarness(async ({ client }) => {
      const onTwelve = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));
      const onThirteen = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'issue.comment',
        payload: { repo: FIRST, issue: 13, body: 'the fix is on staging' },
      })));

      const all = Listed.parse(bodyOf(await call(client, 'board_queue')));
      assert.deepEqual(all.map((action) => action.id), [onTwelve.id, onThirteen.id]);

      const byIssue = Listed.parse(bodyOf(await call(client, 'board_queue', { issue: 13 })));
      assert.deepEqual(byIssue.map((action) => action.id), [onThirteen.id]);

      const byKind = Listed.parse(bodyOf(await call(client, 'board_queue', { kind: 'board.set-fields' })));
      assert.deepEqual(byKind.map((action) => action.id), [onTwelve.id]);

      const byState = Listed.parse(bodyOf(await call(client, 'board_queue', { states: ['done'] })));
      assert.deepEqual(byState, []);

      const byRepo = Listed.parse(bodyOf(await call(client, 'board_queue', { repo: FIRST, limit: 1 })));
      assert.deepEqual(byRepo.map((action) => action.id), [onTwelve.id]);
    });
  });

  it('refuses a state nobody can be in', async () => {
    await withHarness(async ({ client }) => {
      const spoken = await call(client, 'board_queue', { states: ['asleep'] });

      assert.equal(spoken.refused, true);
    });
  });

  it('reports the counts, and how long each held action has been waiting', async () => {
    await withHarness(async ({ client, clock }) => {
      const held = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
        origin: 'a session waiting for a deploy',
        hold: true,
      })));
      await call(client, 'board_enqueue', {
        kind: 'issue.comment',
        payload: { repo: FIRST, issue: 13, body: 'the fix is on staging' },
      });
      clock.advanceDays(3);

      const status = Status.parse(bodyOf(await call(client, 'board_status')));

      assert.equal(status.counts['held'], 1);
      assert.equal(status.counts['queued'], 1);
      assert.equal(status.counts['blocked'], 0);
      assert.equal(status.pause, null);
      assert.deepEqual(status.held.map((action) => action.id), [held.id]);
      assert.equal(status.held[0]?.ageDays, 3);
      assert.equal(status.held[0]?.origin, 'a session waiting for a deploy');
    });
  });

  it('releases a held action, and refuses to release anything else', async () => {
    await withHarness(async ({ client }) => {
      const held = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
        hold: true,
      })));

      const released = Moved.parse(bodyOf(await call(client, 'board_release', { id: held.id })));
      assert.equal(released.state, 'queued');

      const again = await call(client, 'board_release', { id: held.id });
      assert.equal(again.refused, true);
    });
  });

  it('cancels an action, and says so when the id names nothing', async () => {
    await withHarness(async ({ client }) => {
      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));

      const cancelled = Moved.parse(bodyOf(await call(client, 'board_cancel', { id: filed.id })));
      assert.equal(cancelled.state, 'cancelled');

      const unknown = await call(client, 'board_cancel', { id: 'nothing-like-this' });
      assert.equal(unknown.refused, true);
      assert.match(unknown.text, /no action with the id/);
    });
  });

  it('puts a blocked action back on the queue with its attempts reset', async () => {
    await withHarness(async ({ client, container, clock }) => {
      const filed = Filed.parse(bodyOf(await call(client, 'board_enqueue', {
        kind: 'board.set-fields',
        payload: fields('S2'),
      })));
      const action = await container.repository.get(filed.id);
      assert.ok(action !== null);
      action.start(clock.now());
      action.block(clock.now(), new OptionNotFound('Severity', 'urgent', ['S1 · blocking']));
      await container.repository.update(action);

      const blocked = Status.parse(bodyOf(await call(client, 'board_status')));
      assert.deepEqual(blocked.blocked.map((stuck) => stuck.id), [filed.id]);
      assert.match(blocked.blocked[0]?.lastError ?? '', /Severity has no option matching "urgent"/);

      const retried = Moved.parse(bodyOf(await call(client, 'board_retry', { id: filed.id })));
      assert.equal(retried.state, 'queued');
      assert.equal(retried.attempts, 0);
    });
  });

  it('reads one row of the board and what the last answer left of the allowance', async () => {
    await withHarness(async ({ client, board }) => {
      const row = Row.parse(bodyOf(await call(client, 'board_show', { repo: FIRST, issue: 12 })));

      assert.equal(row.ref, `${FIRST}#12`);
      assert.equal(row.onBoard, true);
      assert.equal(row.itemId, 'item-12');
      assert.deepEqual(row.values, { Status: 'In progress' });
      assert.equal(row.budget, board.budget.describe());
      assert.equal(board.snapshotFetches, 1);
    });
  });

  it('says an issue is not on the board rather than inventing a row', async () => {
    await withHarness(async ({ client }) => {
      const row = Row.parse(bodyOf(await call(client, 'board_show', { repo: FIRST, issue: 99 })));

      assert.equal(row.onBoard, false);
      assert.equal(row.itemId, null);
      assert.deepEqual(row.values, {});
    });
  });

  it('refuses to look up an issue in a repository nobody configured', async () => {
    await withHarness(async ({ client }) => {
      const spoken = await call(client, 'board_show', { repo: 'example-org/somewhere-else', issue: 12 });

      assert.equal(spoken.refused, true);
      assert.match(spoken.text, /not a configured repository/);
    });
  });
});

describe('the server process and its own output', () => {
  it('speaks nothing but the protocol on its output, and tells a session which board carries which repository',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'board-queue-mcp-process-'));
      const configFile = join(directory, 'config.json');
      writeFileSync(configFile, JSON.stringify(twoBoardConfig));
      try {
        const lines = await converse(configFile, join(directory, 'state'), [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a test', version: '0' } },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ], 2);

        const messages = lines.map((line) => RpcMessage.parse(JSON.parse(line)));
        assert.ok(messages.length >= 2, 'both requests were answered');
        const listed = ToolsList.parse(messages.find((message) => message.id === 2)?.result);
        const enqueue = listed.tools.find((tool) => tool.name === 'board_enqueue')?.description ?? '';
        assert.match(enqueue, /board example-org\/7 carries example-org\/first-repo, Example-User\/second-repo/);
        assert.match(enqueue, new RegExp(`board example-user/3 carries ${THIRD}`));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
});

const RpcMessage = z.object({ jsonrpc: z.literal('2.0'), id: z.number().optional(), result: z.unknown().optional() });

const ToolsList = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() })) });

/**
 * Runs the server as a session starts it, says the given messages on its input,
 * and answers every line it wrote on its output once the answer to `lastId` came.
 * Anything on that stream that is not a protocol message fails the caller's parse.
 */
function converse(configFile: string, stateDirectory: string, messages: readonly unknown[], lastId: number): Promise<string[]> {
  const entry = fileURLToPath(new URL('../../bin/board-queue-mcp.ts', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, BOARD_QUEUE_CONFIG: configFile, BOARD_QUEUE_STATE_DIR: stateDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise<string[]>((resolve, reject) => {
    let output = '';
    let errors = '';
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`the server answered nothing in time; it said on its error stream: ${errors}`));
    }, 15_000);
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const lines = output.split('\n').filter((line) => line.trim() !== '');
      if (lines.some((line) => line.includes(`"id":${String(lastId)}`))) {
        clearTimeout(deadline);
        child.stdin.end();
        child.kill();
        resolve(lines);
      }
    });
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}
