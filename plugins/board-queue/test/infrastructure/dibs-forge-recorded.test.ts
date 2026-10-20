import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BudgetPolicy } from '../../src/application/budget-policy.ts';
import { ForgePass } from '../../src/application/forge-pass.ts';
import { LimiterWait } from '../../src/application/limiter-wait.ts';
import { WorkerConfigSchema } from '../../src/domain/config.ts';
import { SyncConfigSchema } from '../../src/domain/sync-config.ts';
import { DibsForgeClient } from '../../src/infrastructure/dibs-forge-http.ts';
import { SqliteActionRepository } from '../../src/infrastructure/sqlite-action-repository.ts';
import { SqliteForgeLedger } from '../../src/infrastructure/sqlite-forge-ledger.ts';
import { FakeFetch } from '../fakes/fake-fetch.ts';
import { FakeForge, pullRequest } from '../fakes/fake-forge.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';
import { SERVER } from '../fixtures/sync.ts';

const FIRST = 'example-org/first-repo';
const SHA = 'abc1234def';

const ITEM_SEVEN = { id: 7, ref: `gh:${FIRST}#41`, title: 'Refund rounding', link: `https://github.com/${FIRST}/issues/41` };

/**
 * The answers the coordination server gives an integration on one forge pass, in
 * its own shapes, in the order the pass asks: who it is and the project's
 * repositories, the members, the claims in review, the live claims with their
 * branches, the slots — one hold kept until a workflow run, shown on both slots of
 * its group — and then the reports.
 */
const ANSWERS = [
  {
    body: {
      member: { handle: 'board', display_name: 'Board', external_login: null, role: 'importer' },
      project: { slug: 'widgets' },
      repos: [{ id: 'web', remote: `github.com/${FIRST}` }],
      settings: { stale_after: '1d', heartbeat_every: '1m', edit_policy: 'require-claim' },
    },
  },
  {
    body: {
      members: [
        { handle: 'alice', display_name: 'Alice Example', external_login: 'alice-gh', role: 'member' },
        { handle: 'board', display_name: 'Board', external_login: null, role: 'importer' },
        { handle: 'bob', display_name: 'Bob Example', external_login: 'bob-gh', role: 'admin' },
      ],
    },
  },
  {
    body: {
      claims: [{
        item: ITEM_SEVEN,
        holder: 'alice',
        prs: [`${FIRST}#2`],
        since: '2026-03-02T08:00:00Z',
        more: false,
        branches: { web: 'alice/7-refunds' },
      }],
    },
  },
  {
    body: {
      claims: [
        { item: 7, holder: 'alice', state: 'in_review', branches: { web: 'alice/7-refunds' } },
        { item: 8, holder: 'bob', state: 'working', branches: { web: 'bob/8-search' } },
        { item: 9, holder: 'bob', state: 'working', branches: {} },
      ],
    },
  },
  {
    body: {
      slots: ['deploy', 'release'].map((name) => ({
        name,
        group: 'ship',
        max_hold: '30m',
        offer_for: '5m',
        max_wait: '2h',
        run_only: false,
        freezes: ['web:refs/heads/main'],
        note: null,
        hold: {
          slot: 'deploy',
          holder: 'bob',
          purpose: 'ship 2.4',
          item: null,
          session_id: 9,
          host: 'desk',
          liveness: { mode: 'until_run', workflow: 'deploy.yml', sha: SHA },
          taken_at: '2026-03-02T08:50:00Z',
          expires_at: '2026-03-02T09:20:00Z',
          last_seen: '2026-03-02T08:50:00Z',
          stalled: false,
        },
        queue: [],
        offer: null,
      })),
    },
  },
  { body: { matched: true, item: 7, claim: 'completed' } },
  { body: { recorded: true } },
  { body: { enabled: true, context: 'dibs', state: 'failure', description: 'A freezing action is in progress until 09:20 UTC.' } },
  { body: { stored: true, changed: true } },
  { body: { matched: true } },
];

describe('one forge pass against the real shapes of the coordination server\'s answers', () => {
  it('reads them, reports in the server\'s spelling, and records what it did', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'board-queue-forge-recorded-'));
    const file = join(dir, 'queue.db');
    const clock = new FakeClock('2026-03-02T09:00:00.000Z');
    const logger = new RecordingLogger();
    const repository = new SqliteActionRepository(file, { clock });
    const ledger = new SqliteForgeLedger(file);
    t.after(() => {
      ledger.close();
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const fetcher = new FakeFetch(ANSWERS);
    const forge = new FakeForge()
      .put(pullRequest(FIRST, 5, { author: 'alice-gh', headRef: 'alice/5-search' }), false)
      .put(
        pullRequest(FIRST, 2, { state: 'closed', mergedAt: new Date('2026-03-02T08:30:00Z'), headRef: 'alice/7-refunds' }),
        null,
        ['src/billing/refund.ts'],
      )
      .branch(FIRST, 'main', 'bob/8-search', {
        baseSha: '4f2a91c0'.padEnd(40, '0'),
        baseAt: new Date('2026-03-01T08:12:00Z'),
        paths: ['src/search/index.ts'],
        truncated: false,
      })
      .run(FIRST, {
        id: 77,
        path: '.github/workflows/deploy.yml',
        name: 'Deploy',
        status: 'completed',
        conclusion: 'success',
        createdAt: new Date('2026-03-02T08:55:00Z'),
        headSha: SHA,
      });
    const sync = SyncConfigSchema.parse({
      server: SERVER,
      project: 'widgets',
      tokenEnv: 'DIBS_TEST_TOKEN',
      mirrorOwner: 'alice',
      repos: [FIRST],
      forge: { enabled: true },
    });
    const pass = new ForgePass({
      forge,
      identity: { usesAppIdentity: () => true },
      coordination: new DibsForgeClient({
        server: SERVER,
        token: () => `dibs_${'a'.repeat(40)}`,
        logger,
        fetchImpl: fetcher.fetch,
      }),
      ledger,
      repository,
      wait: new LimiterWait({ repository, policy: new BudgetPolicy(WorkerConfigSchema.parse({})), logger }),
      sync,
      settings: sync.forge,
      clock,
      sleeper: new FakeSleeper(clock),
      logger,
    });

    const report = await pass.execute();

    assert.deepEqual(fetcher.calls.map((call) => `${call.method} ${call.url.slice(SERVER.length)}`), [
      'GET /v1/me',
      'GET /v1/members',
      'GET /v1/review-claims',
      'GET /v1/claims',
      'GET /v1/slots',
      'POST /v1/prs/merged',
      'POST /v1/prs/state',
      'GET /v1/pr-status?repo=web&base=main',
      'PUT /v1/items/8/footprint',
      'POST /v1/slots/deploy/run-finished',
    ]);
    assert.deepEqual(fetcher.calls[5]?.body, {
      pr: `${FIRST}#2`,
      base: 'main',
      head: 'alice/7-refunds',
      merged_at: '2026-03-02T08:30:00.000Z',
      files: ['src/billing/refund.ts'],
    });
    assert.deepEqual(fetcher.calls[6]?.body, { pr: `${FIRST}#5`, mergeable: false });
    assert.deepEqual(fetcher.calls[8]?.body, {
      repo: 'web',
      branch: 'bob/8-search',
      base: 'main',
      base_sha: '4f2a91c0'.padEnd(40, '0'),
      base_at: '2026-03-01T08:12:00.000Z',
      paths: ['src/search/index.ts'],
      truncated: false,
    });
    assert.deepEqual(fetcher.calls[9]?.body, { workflow: 'deploy.yml', sha: SHA, conclusion: 'success' });
    assert.deepEqual(forge.statuses.map((written) => [written.sha, written.status]), [[
      pullRequest(FIRST, 5).headSha,
      { state: 'failure', description: 'A freezing action is in progress until 09:20 UTC.', context: 'dibs' },
    ]]);
    assert.ok('run' in report);
    assert.equal(report.run.stoppedBecause, null);
    assert.deepEqual(report.run.repos.map((repo) => [repo.merged, repo.mergeability, repo.statuses, repo.footprints, repo.holdsReleased]), [
      [1, 1, 1, 1, 1],
    ]);
  });
});
