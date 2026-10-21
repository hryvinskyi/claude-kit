import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CursorExpired, RefusedByRule, TransientFailure } from '../../src/domain/errors.ts';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DibsHttpClient, tokenFromEnvironment } from '../../src/infrastructure/dibs-http.ts';
import { FakeFetch, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';

const SERVER = 'https://dibs.example.com';
const TOKEN = 'dibs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function client(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const logger = new RecordingLogger();
  const dibs = new DibsHttpClient({ server: `${SERVER}/`, token: () => TOKEN, logger, fetchImpl: fetcher.fetch });
  return { dibs, fetcher, logger };
}

describe('reading the coordination server\'s log', () => {
  it('asks after the cursor with the token, and keeps only the claim events, named by handle', async () => {
    const { dibs, fetcher } = client([{
      body: {
        events: [
          { id: 3, at: '2026-03-02T09:00:00Z', kind: 'claimed',
            payload: { item: 12, member: 7, session: 9, host: 'laptop', areas: ['default:billing'] },
            members: { 7: 'alice' } },
          { id: 4, at: '2026-03-02T09:01:00Z', kind: 'message_posted', payload: { thread: 1, message: 2 }, members: {} },
          { id: 5, at: '2026-03-02T09:02:00Z', kind: 'taken_over',
            payload: { item: 12, member: 8, previous: 7, session: 10, host: 'desk', areas: [] },
            members: { 7: 'alice', 8: 'bob' } },
        ],
        next: 5,
      },
    }]);

    const page = await dibs.page(2, 500);

    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/events?after=2&limit=500`);
    assert.equal(fetcher.calls[0]?.headers['authorization'], `Bearer ${TOKEN}`);
    assert.deepEqual(page, {
      claims: [
        { id: 3, kind: 'claimed', item: 12, member: 'alice', previous: null },
        { id: 5, kind: 'taken_over', item: 12, member: 'bob', previous: 'alice' },
      ],
      shown: 3,
      next: 5,
    });
  });

  it('reads a pull request dropped from a claim, or merged and set aside, as no move of the claim', async () => {
    const { dibs } = client([{
      body: {
        events: [
          { id: 6, at: '2026-03-02T09:00:00Z', kind: 'pr_dropped', payload: { item: 12, member: 7, pr: 'acme/api#3' },
            members: { 7: 'alice' } },
          { id: 7, at: '2026-03-02T09:01:00Z', kind: 'pr_merged', payload: { item: 12, member: 7, pr: 'acme/api#4' },
            members: { 7: 'alice' } },
        ],
        next: 7,
      },
    }]);

    const page = await dibs.page(5, 500);

    assert.deepEqual(page, { claims: [], shown: 2, next: 7 });
  });

  it('passes over a claim event it cannot read, says so, and keeps the rest', async () => {
    const { dibs, logger } = client([{
      body: { events: [{ id: 3, kind: 'released', payload: { item: 'twelve' }, members: {} }], next: 3 },
    }]);

    const page = await dibs.page(0, 500);

    assert.deepEqual(page.claims, []);
    assert.equal(page.shown, 1);
    assert.ok(logger.lines.some((line) => line.level === 'warn' && line.fields['event'] === 3));
  });

  it('names where to go on from when the cursor is behind what the log keeps', async () => {
    const { dibs } = client([{
      status: 410,
      body: { error: { code: 'cursor_expired', message: 'The log no longer keeps that.', details: { pruned_through: 41 } } },
    }]);

    await assert.rejects(
      () => dibs.page(2, 500),
      (error: unknown) => error instanceof CursorExpired && error.prunedThrough === 41,
    );
  });

  it('calls a server it cannot reach a moment\'s fault, without repeating the token', async () => {
    const { dibs } = client([{ failWith: new Error(`connect ECONNREFUSED with ${TOKEN}`) }]);

    await assert.rejects(
      () => dibs.page(0, 500),
      (error: unknown) => error instanceof TransientFailure
        && /could not be reached/.test(error.describe())
        && !error.describe().includes(TOKEN),
    );
  });

  it('names the server\'s code for a refusal, and nothing of its text', async () => {
    const { dibs } = client([{
      status: 403,
      body: { error: { code: 'forbidden', message: 'Integrations may not read this.' } },
    }]);

    await assert.rejects(
      () => dibs.members(),
      (error: unknown) => error instanceof TransientFailure
        && /403 \(forbidden\)/.test(error.describe())
        && !error.describe().includes('Integrations'),
    );
  });

  it('gives up on a call the server does not answer within its deadline', async () => {
    const fetcher = {
      fetch: (_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      }),
    };
    const dibs = new DibsHttpClient({
      server: SERVER,
      token: () => TOKEN,
      logger: new RecordingLogger(),
      fetchImpl: fetcher.fetch,
      timeoutMs: 5,
    });

    await assert.rejects(
      () => dibs.page(0, 500),
      (error: unknown) => error instanceof TransientFailure && /within the deadline/.test(error.describe()),
    );
  });
});

describe('the coordination server\'s members and items', () => {
  it('reads each member\'s GitHub login, or none', async () => {
    const { dibs, fetcher } = client([{
      body: { members: [
        { handle: 'alice', display_name: 'Alice', external_login: 'alice-gh', role: 'admin' },
        { handle: 'importer', display_name: 'Board', external_login: null, role: 'importer' },
      ] },
    }]);

    assert.deepEqual(await dibs.members(), [
      { handle: 'alice', login: 'alice-gh' },
      { handle: 'importer', login: null },
    ]);
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/members`);
  });

  it('reads an item\'s outside reference, and answers none for an item that is gone', async () => {
    const { dibs } = client([
      { body: { item: { id: 12, ref: 'gh:acme/widgets#7', title: 'Refunds' }, claim: null } },
      { status: 404, body: { error: { code: 'not_found', message: 'No such item.' } } },
    ]);

    assert.equal(await dibs.itemRef(12), 'gh:acme/widgets#7');
    assert.equal(await dibs.itemRef(13), null);
  });
});

describe('importing the board\'s work', () => {
  it('sends the batch in the server\'s own spelling and reads what it did', async () => {
    const { dibs, fetcher } = client([{
      body: {
        items: [
          { ref: 'gh:acme/widgets#41', outcome: 'created', id: 52, dropped_hints: [{ area: 'billing', reason: 'undeclared' }] },
          { ref: 'gh:acme/api#9', outcome: 'unchanged', id: 51, dropped_hints: [] },
        ],
        closed: [47],
        edges_added: 1,
        edges_removed: 0,
        refused_edges: [{ item: 'gh:acme/widgets#41', blocked_by: 'gh:acme/api#9', reason: 'dependency_cycle',
          message: 'The two would wait for each other.' }],
      },
    }]);

    const answer = await dibs.putItems({
      source: 'board',
      complete: true,
      items: [
        { ref: 'gh:acme/widgets#41', title: 'Refund rounding', closed: false,
          listing: { priority: 1, areasHint: ['billing'], sourceStatus: 'Todo', blockedBy: ['gh:acme/api#9'] } },
        { ref: 'gh:acme/api#9', title: 'Rate table', closed: false, listing: null },
        { ref: 'gh:acme/widgets#42', title: 'Untouched', closed: true,
          listing: { priority: 2, areasHint: [], sourceStatus: null, blockedBy: [] } },
      ],
    });

    assert.equal(fetcher.calls[0]?.method, 'PUT');
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/items`);
    assert.deepEqual(fetcher.calls[0]?.body, {
      source: 'board',
      complete: true,
      items: [
        { ref: 'gh:acme/widgets#41', title: 'Refund rounding', closed: false, priority: 1,
          areas_hint: ['billing'], blocked_by: ['gh:acme/api#9'], source_status: 'Todo' },
        { ref: 'gh:acme/api#9', title: 'Rate table', closed: false, blocker: true },
        { ref: 'gh:acme/widgets#42', title: 'Untouched', closed: true, priority: 2, areas_hint: [], blocked_by: [] },
      ],
    });
    assert.deepEqual(answer, {
      outcomes: { created: 1, unchanged: 1 },
      closed: 1,
      refusedEdges: [{ item: 'gh:acme/widgets#41', blockedBy: 'gh:acme/api#9', reason: 'dependency_cycle' }],
      droppedHints: [{ ref: 'gh:acme/widgets#41', area: 'billing', reason: 'undeclared' }],
    });
  });
});

describe('the integration\'s token', () => {
  it('is read from the variable the configuration names, when a call needs it', () => {
    assert.equal(tokenFromEnvironment({ DIBS_TOKEN: ` ${TOKEN} ` }, 'DIBS_TOKEN')(), TOKEN);
  });

  it('is read from the file its _FILE twin names, which must be this account\'s alone', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'board-queue-token-file-'));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const owned = join(directory, 'token');
    writeFileSync(owned, `${TOKEN}\n`, { mode: 0o400 });
    chmodSync(owned, 0o400);
    const shared = join(directory, 'shared');
    writeFileSync(shared, `${TOKEN}\n`, { mode: 0o644 });
    chmodSync(shared, 0o644);
    const empty = join(directory, 'empty');
    writeFileSync(empty, '\n', { mode: 0o600 });

    assert.equal(tokenFromEnvironment({ DIBS_TOKEN_FILE: owned }, 'DIBS_TOKEN')(), TOKEN);
    assert.throws(() => tokenFromEnvironment({ DIBS_TOKEN_FILE: shared }, 'DIBS_TOKEN')(), (error: unknown) =>
      error instanceof RefusedByRule && /DIBS_TOKEN_FILE is mode 644/.test(error.describe())
      && !error.describe().includes(directory) && !error.describe().includes(TOKEN));
    assert.throws(() => tokenFromEnvironment({ DIBS_TOKEN_FILE: empty }, 'DIBS_TOKEN')(), /holds no token/);
  });

  it('is refused when both the variable and its _FILE twin are set', () => {
    assert.throws(
      () => tokenFromEnvironment({ DIBS_TOKEN: TOKEN, DIBS_TOKEN_FILE: '/run/secrets/token' }, 'DIBS_TOKEN')(),
      (error: unknown) => error instanceof RefusedByRule
        && error.describe() === 'both DIBS_TOKEN and DIBS_TOKEN_FILE are set; set one of them',
    );
  });

  it('is refused by the variable\'s name when the variable is empty', () => {
    assert.throws(
      () => tokenFromEnvironment({}, 'DIBS_TOKEN')(),
      (error: unknown) => error instanceof RefusedByRule && /DIBS_TOKEN holds no token/.test(error.describe()),
    );
  });
});
