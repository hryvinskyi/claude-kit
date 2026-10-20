import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MirrorClaims } from '../../src/application/mirror-claims.ts';
import { mirrorCursorKey } from '../../src/application/sync-meta.ts';
import { BoardDirectory } from '../../src/domain/board-directory.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import { DibsHttpClient } from '../../src/infrastructure/dibs-http.ts';
import { FakeFetch } from '../fakes/fake-fetch.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { SERVER, syncConfig, syncOf } from '../fixtures/sync.ts';

const SYNC = syncOf();

/**
 * The answers the coordination server gives an integration that follows its log,
 * in its own shapes: a page that shows one claim among events the integration may
 * not see — conversation events it never reads — with the cursor past all of
 * them; a page that shows nothing and still moves the cursor; and the page at the
 * head, where the cursor stays.
 */
const ANSWERS = [
  {
    body: {
      events: [{
        id: 9,
        at: '2026-03-02T09:00:00Z',
        kind: 'claimed',
        payload: { item: 12, member: 7, session: 3, host: 'laptop', areas: ['default:billing'] },
        members: { 7: 'alice' },
      }],
      next: 11,
    },
  },
  {
    body: {
      item: {
        id: 12, ref: 'gh:example-org/first-repo#12', title: 'Refund rounding', status: 'claimed', repo: 'default',
        unlisted_remote: null, priority: 1, areas_hint: ['default:billing'], source_status: 'Todo', closed: false,
        source: 'board', created_by: 'importer', created_at: '2026-03-01T09:00:00Z',
      },
      claim: null,
    },
  },
  {
    body: {
      members: [
        { handle: 'alice', display_name: 'Alice Example', external_login: 'alice-gh', role: 'member' },
        { handle: 'board', display_name: 'Board', external_login: null, role: 'importer' },
      ],
    },
  },
  { body: { events: [], next: 14 } },
  { body: { events: [], next: 14 } },
];

describe('following the real shapes of the coordination server\'s log', () => {
  it('files the one claim it was shown and saves a cursor past everything it was not', async () => {
    const fetcher = new FakeFetch(ANSWERS);
    const repository = new InMemoryActionRepository();
    await repository.setMeta(mirrorCursorKey(SYNC.server, SYNC.project), '6');
    const mirror = SYNC.mirror;
    assert.ok(mirror !== undefined);
    const mirrorClaims = new MirrorClaims({
      feed: new DibsHttpClient({ server: SERVER, token: () => 'dibs_' + 'a'.repeat(40), logger: new RecordingLogger(), fetchImpl: fetcher.fetch }),
      repository,
      kinds: defaultKindRegistry(syncConfig),
      directory: BoardDirectory.of(syncConfig.boards),
      sync: SYNC,
      mirror,
      clock: new FakeClock('2026-03-02T09:05:00.000Z'),
      logger: new RecordingLogger(),
    });

    const report = await mirrorClaims.execute();

    assert.deepEqual(fetcher.calls.map((call) => `${call.method} ${call.url.slice(SERVER.length)}`), [
      'GET /v1/events?after=6&limit=500',
      'GET /v1/items/12',
      'GET /v1/members',
      'GET /v1/events?after=11&limit=500',
      'GET /v1/events?after=14&limit=500',
    ]);
    assert.equal(report.error, null);
    assert.equal(report.cursor, 14);
    assert.equal(report.filed, 2);
    assert.deepEqual((await repository.list({})).map((action) => action.kind), ['board.set-fields', 'issue.assignees']);
  });
});
