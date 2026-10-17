import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubGraphqlBoard } from '../../src/infrastructure/github-graphql-board.ts';
import { GitHubHttp } from '../../src/infrastructure/github-http.ts';
import { IssueNotFound, TransientFailure } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';
import { FakeFetch, budgetHeaders, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { MemoryCatalogStore, RecordingLogger, StubTokenProvider } from '../fakes/wire-doubles.ts';

const RESET_SECONDS = 1789000000;
const HEADERS = budgetHeaders(4000, RESET_SECONDS);
const CATALOG_TTL_SEC = 3600;

const CATALOG_ANSWER = {
  data: {
    owner: {
      projectV2: {
        id: 'PVT_board',
        title: 'Delivery',
        fields: {
          nodes: [
            { id: 'F_title', name: 'Title', dataType: 'TITLE' },
            {
              id: 'F_status',
              name: 'Status',
              dataType: 'SINGLE_SELECT',
              options: [{ id: 'o_todo', name: 'Todo' }, { id: 'o_doing', name: 'In progress' }],
            },
            null,
          ],
        },
      },
    },
  },
};

function itemNode(id: string, repo: string, number: number, status: string): unknown {
  return {
    id,
    content: { number, repository: { nameWithOwner: repo } },
    fieldValues: {
      nodes: [
        {},
        { name: status, field: { name: 'Status' } },
        { name: 'S2 · broken · no workaround', field: { name: 'Severity' } },
      ],
    },
  };
}

function snapshotPage(
  nodes: readonly unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
): { data: unknown } {
  return {
    data: {
      owner: {
        projectV2: {
          items: { pageInfo: { hasNextPage, endCursor }, nodes },
        },
      },
    },
  };
}

const FIRST_PAGE = snapshotPage(
  [itemNode('PVTI_one', 'example-org/first-repo', 12, 'Todo'), { id: 'PVTI_draft', content: {} }, null],
  true,
  'cursor-1',
);
const SECOND_PAGE = snapshotPage(
  [itemNode('PVTI_two', 'Example-User/second-repo', 12, 'In progress')],
  false,
  null,
);

const CATALOG: FieldCatalog = {
  projectId: 'PVT_board',
  fields: [{ id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'o_todo', name: 'Todo' }] }],
};

function board(script: readonly ScriptedResponse[], store = new MemoryCatalogStore()) {
  const fetcher = new FakeFetch(script);
  const clock = new FakeClock();
  const http = new GitHubHttp({
    tokens: new StubTokenProvider(),
    logger: new RecordingLogger(),
    fetchImpl: fetcher.fetch,
  });
  const gateway = new GitHubGraphqlBoard({
    http,
    board: { owner: 'example-org', number: 7, ownerType: 'organization' },
    clock,
    catalogStore: store,
    catalogTtlSec: CATALOG_TTL_SEC,
  });
  return { gateway, fetcher, clock, store, http };
}

describe('GitHubGraphqlBoard catalog', () => {
  it('fetches the board vocabulary and keeps it', async () => {
    const { gateway, fetcher, store, clock } = board([{ headers: HEADERS, body: CATALOG_ANSWER }]);
    const catalog = await gateway.catalog();
    assert.equal(catalog.projectId, 'PVT_board');
    assert.deepEqual(catalog.fields.map((field) => field.name), ['Title', 'Status']);
    assert.deepEqual(catalog.fields[1]?.options, [{ id: 'o_todo', name: 'Todo' }, { id: 'o_doing', name: 'In progress' }]);
    assert.deepEqual(catalog.fields[0]?.options, []);
    assert.equal(store.writes, 1);
    assert.equal(fetcher.calls[0]?.operationName, 'BoardCatalog');
    assert.deepEqual(fetcher.calls[0]?.variables, { owner: 'example-org', number: 7 });
    assert.match(fetcher.calls[0]?.query ?? '', /owner: organization\(login: \$owner\)/);
    assert.equal((await store.get())?.fetchedAt.getTime(), clock.now().getTime());
  });

  it('asks the user root when a person owns the board', async () => {
    const { fetcher } = board([{ headers: HEADERS, body: CATALOG_ANSWER }]);
    const clock = new FakeClock();
    const gateway = new GitHubGraphqlBoard({
      http: new GitHubHttp({
        tokens: new StubTokenProvider(),
        logger: new RecordingLogger(),
        fetchImpl: fetcher.fetch,
      }),
      board: { owner: 'example-user', number: 3, ownerType: 'user' },
      clock,
      catalogStore: new MemoryCatalogStore(),
      catalogTtlSec: CATALOG_TTL_SEC,
    });
    await gateway.catalog();
    assert.match(fetcher.calls[0]?.query ?? '', /owner: user\(login: \$owner\)/);
  });

  it('spends nothing while the kept vocabulary is young enough', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([], store);
    assert.equal((await gateway.catalog()).projectId, 'PVT_board');
    assert.equal(fetcher.calls.length, 0);
  });

  it('fetches again once the kept vocabulary is too old', async () => {
    const clock = new FakeClock();
    const stale = new Date(clock.now().getTime() - (CATALOG_TTL_SEC + 1) * 1000);
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: stale });
    const { gateway, fetcher } = board([{ headers: HEADERS, body: CATALOG_ANSWER }], store);
    await gateway.catalog();
    assert.equal(fetcher.calls.length, 1);
  });

  it('fetches again when asked to, however young the kept vocabulary is', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([{ headers: HEADERS, body: CATALOG_ANSWER }], store);
    await gateway.catalog(true);
    assert.equal(fetcher.calls.length, 1);
    assert.equal(store.writes, 1);
  });
});

describe('GitHubGraphqlBoard listing', () => {
  it('walks every page and skips rows that hold no issue', async () => {
    const { gateway, fetcher } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    const snapshot = await gateway.snapshot();
    assert.equal(fetcher.calls.length, 2);
    assert.equal(fetcher.calls[0]?.variables['cursor'], null);
    assert.equal(fetcher.calls[1]?.variables['cursor'], 'cursor-1');
    assert.deepEqual(snapshot.items.map((item) => item.itemId), ['PVTI_one', 'PVTI_two']);
    assert.deepEqual(snapshot.items[0]?.values, {
      Status: 'Todo',
      Severity: 'S2 · broken · no workaround',
    });
  });

  it('tells two rows with the same number apart by their repository', async () => {
    const { gateway } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    const first = await gateway.findItem(IssueRef.of('example-org/first-repo', 12));
    const second = await gateway.findItem(IssueRef.of('example-user/second-repo', 12));
    assert.equal(first?.itemId, 'PVTI_one');
    assert.equal(second?.itemId, 'PVTI_two');
    assert.equal(second?.values['Status'], 'In progress');
  });

  it('answers nothing for an issue that is not on the board', async () => {
    const { gateway } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    assert.equal(await gateway.findItem(IssueRef.of('example-org/first-repo', 99)), null);
  });

  it('reuses one walk for a while and walks again when asked to', async () => {
    const { gateway, fetcher, clock } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    await gateway.snapshot();
    clock.advance(30_000);
    await gateway.snapshot();
    assert.equal(fetcher.calls.length, 2);
    fetcher.push({ headers: HEADERS, body: SECOND_PAGE });
    await gateway.snapshot(true);
    assert.equal(fetcher.calls.length, 3);
  });

  it('walks again once the kept walk is older than a minute', async () => {
    const { gateway, fetcher, clock } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    await gateway.snapshot();
    clock.advance(61_000);
    fetcher.push({ headers: HEADERS, body: SECOND_PAGE });
    await gateway.snapshot();
    assert.equal(fetcher.calls.length, 3);
  });

  it('keeps the rows it could read when the board cannot answer for one of them', async () => {
    // What the board answers for a row whose content the credential cannot reach:
    // the page, the row as an empty node, and one error naming where it was.
    const { gateway } = board([{
      headers: HEADERS,
      body: {
        ...snapshotPage([itemNode('PVTI_one', 'example-org/first-repo', 12, 'Todo'), { id: 'PVTI_hidden' }], false, null),
        errors: [{
          type: 'NOT_FOUND',
          message: 'Could not resolve to a node with the global id of …',
          path: ['owner', 'projectV2', 'items', 'nodes', 1, 'content'],
        }],
      },
    }]);

    const snapshot = await gateway.snapshot();

    assert.deepEqual(snapshot.items.map((item) => item.ref.toString()), ['example-org/first-repo#12']);
  });

  it('still refuses a listing that failed for a reason of its own', async () => {
    const { gateway } = board([{
      headers: HEADERS,
      body: {
        ...snapshotPage([], false, null),
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2', path: ['owner', 'projectV2'] }],
      },
    }]);

    await assert.rejects(() => gateway.snapshot(), TransientFailure);
  });

  it('answers which of several issues are on the board from one walk', async () => {
    const { gateway, fetcher } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
    ]);
    const found = await gateway.membership([
      IssueRef.of('example-org/first-repo', 12),
      IssueRef.of('example-org/first-repo', 99),
    ]);
    assert.equal(fetcher.calls.length, 2);
    assert.equal(found.get('example-org/first-repo#12') === 'missing', false);
    assert.equal(found.get('example-org/first-repo#99'), 'missing');
  });
});

describe('GitHubGraphqlBoard writes', () => {
  it('adds the issue to the board every time and answers the row it names', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([
      { headers: HEADERS, body: { data: { repository: { issue: { id: 'I_kwabc' } } } } },
      { headers: HEADERS, body: { data: { addProjectV2ItemById: { item: { id: 'PVTI_one' } } } } },
    ], store);
    const itemId = await gateway.ensureItem(IssueRef.of('example-org/first-repo', 12));
    assert.equal(itemId, 'PVTI_one');
    assert.equal(fetcher.calls.length, 2);
    assert.equal(fetcher.calls[0]?.operationName, 'IssueNodeId');
    assert.deepEqual(fetcher.calls[0]?.variables, { owner: 'example-org', repo: 'first-repo', number: 12 });
    assert.equal(fetcher.calls[1]?.operationName, 'AddBoardItem');
    assert.deepEqual(fetcher.calls[1]?.variables, { projectId: 'PVT_board', contentId: 'I_kwabc' });
  });

  it('refuses to add an issue that does not exist', async () => {
    const { gateway } = board([{ headers: HEADERS, body: { data: { repository: { issue: null } } } }]);
    await assert.rejects(
      () => gateway.ensureItem(IssueRef.of('example-org/first-repo', 404)),
      (error: unknown) => {
        assert.ok(error instanceof IssueNotFound);
        assert.equal(error.ref, 'example-org/first-repo#404');
        return true;
      },
    );
  });

  it('forgets the walk it is holding as soon as it writes to the board', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([
      { headers: HEADERS, body: FIRST_PAGE },
      { headers: HEADERS, body: SECOND_PAGE },
      { headers: HEADERS, body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_one' } } } } },
      { headers: HEADERS, body: snapshotPage([itemNode('PVTI_one', 'example-org/first-repo', 12, 'Done')], false, null) },
    ], store);
    await gateway.findItem(IssueRef.of('example-org/first-repo', 12));

    await gateway.setSingleSelect('PVTI_one', 'F_status', 'o_todo');
    const after = await gateway.findItem(IssueRef.of('example-org/first-repo', 12));

    assert.equal(after?.values['Status'], 'Done', 'a read after a write must not answer out of the walk before it');
    assert.equal(fetcher.calls.length, 4);
  });

  it('forgets it when it adds a row too', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([
      { headers: HEADERS, body: snapshotPage([], false, null) },
      { headers: HEADERS, body: { data: { repository: { issue: { id: 'I_kwabc' } } } } },
      { headers: HEADERS, body: { data: { addProjectV2ItemById: { item: { id: 'PVTI_one' } } } } },
      { headers: HEADERS, body: snapshotPage([itemNode('PVTI_one', 'example-org/first-repo', 12, 'Todo')], false, null) },
    ], store);
    assert.equal(await gateway.findItem(IssueRef.of('example-org/first-repo', 12)), null);

    await gateway.ensureItem(IssueRef.of('example-org/first-repo', 12));

    assert.equal((await gateway.findItem(IssueRef.of('example-org/first-repo', 12)))?.itemId, 'PVTI_one');
    assert.equal(fetcher.calls.length, 4);
  });

  it('reads a known row by its own id', async () => {
    const { gateway, fetcher } = board([{
      headers: HEADERS,
      body: { data: { node: itemNode('PVTI_one', 'example-org/first-repo', 12, 'In progress') } },
    }]);
    const item = await gateway.readItemById('PVTI_one');
    assert.equal(item.itemId, 'PVTI_one');
    assert.equal(item.ref.toString(), 'example-org/first-repo#12');
    assert.equal(item.values['Status'], 'In progress');
    assert.deepEqual(fetcher.calls[0]?.variables, { itemId: 'PVTI_one' });
  });

  it('writes one option on one field of one row', async () => {
    const clock = new FakeClock();
    const store = new MemoryCatalogStore({ catalog: CATALOG, fetchedAt: clock.now() });
    const { gateway, fetcher } = board([{
      headers: HEADERS,
      body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_one' } } } },
    }], store);
    await gateway.setSingleSelect('PVTI_one', 'F_status', 'o_todo');
    assert.equal(fetcher.calls[0]?.operationName, 'SetBoardSingleSelect');
    assert.deepEqual(fetcher.calls[0]?.variables, {
      projectId: 'PVT_board',
      itemId: 'PVTI_one',
      fieldId: 'F_status',
      optionId: 'o_todo',
    });
  });
});

describe('GitHubGraphqlBoard allowance probe', () => {
  it('asks what is left and remembers the answer', async () => {
    const { gateway, http } = board([{
      body: {
        data: {
          rateLimit: {
            remaining: 4321,
            limit: 5000,
            used: 679,
            resetAt: '2026-09-16T13:55:00.000Z',
            cost: 1,
          },
        },
      },
    }]);
    const budget = await gateway.probeBudget();
    assert.equal(budget.resource, 'graphql');
    assert.equal(budget.remaining, 4321);
    assert.equal(budget.resetAt.toISOString(), '2026-09-16T13:55:00.000Z');
    assert.equal(http.lastBudget('graphql')?.remaining, 4321);
    assert.equal(gateway.lastBudget()?.remaining, 4321);
  });
});
