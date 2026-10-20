import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoAnswer, TransientFailure } from '../../src/domain/errors.ts';
import { DibsForgeClient } from '../../src/infrastructure/dibs-forge-http.ts';
import { FakeFetch, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';

const SERVER = 'https://dibs.example.com';
const TOKEN = 'dibs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function client(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const dibs = new DibsForgeClient({ server: `${SERVER}/`, token: () => TOKEN, logger: new RecordingLogger(), fetchImpl: fetcher.fetch });
  return { dibs, fetcher };
}

const HOLD = {
  slot: 'deploy',
  holder: 'bob',
  purpose: 'ship 2.4',
  item: null,
  session_id: 9,
  host: 'desk',
  liveness: { mode: 'until_run', workflow: 'deploy.yml', sha: 'abc1234def' },
  taken_at: '2026-03-02T09:00:00Z',
  expires_at: '2026-03-02T09:30:00Z',
  last_seen: '2026-03-02T09:00:00Z',
  stalled: false,
};

function slot(name: string, hold: unknown) {
  return {
    name,
    group: 'release',
    max_hold: '30m',
    offer_for: '5m',
    max_wait: '2h',
    run_only: false,
    freezes: ['web:refs/heads/main'],
    note: null,
    hold,
    queue: [],
    offer: null,
  };
}

describe('reading the coordination server for the forge jobs', () => {
  it('names each repository by the path of its remote, and the one of a project that lists none by nothing', async () => {
    const { dibs, fetcher } = client([{
      body: {
        member: { handle: 'board', display_name: 'Board', external_login: null, role: 'importer' },
        project: { slug: 'widgets' },
        repos: [{ id: 'web', remote: 'github.com/example-org/first-repo' }, { id: 'default', remote: null }],
        settings: { stale_after: '1d' },
      },
    }]);

    assert.deepEqual(await dibs.repositories(), [
      { id: 'web', remotePath: 'example-org/first-repo' },
      { id: 'default', remotePath: null },
    ]);
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/me`);
    assert.equal(fetcher.calls[0]?.headers['authorization'], `Bearer ${TOKEN}`);
  });

  it('reads the holds that wait for a run once each, however many slots of their group show them', async () => {
    const { dibs } = client([{
      body: {
        slots: [
          slot('deploy', HOLD),
          slot('release', HOLD),
          slot('db', { ...HOLD, slot: 'db', liveness: { mode: 'run', run: 7 } }),
          slot('qa', null),
        ],
      },
    }]);

    assert.deepEqual(await dibs.runHolds(), [{ slot: 'deploy', workflow: 'deploy.yml', sha: 'abc1234def' }]);
  });

  it('takes a repository or base the server does not know as wanting no status', async () => {
    const { dibs, fetcher } = client([
      { status: 404, body: { error: { code: 'not_found', message: 'No such repository.' } } },
    ]);

    assert.equal(await dibs.wantedStatus('web', 'release/2'), null);
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/pr-status?repo=web&base=release%2F2`);
  });

  it('refuses a refusal of another kind, naming the server\'s code', async () => {
    const { dibs } = client([{ status: 403, body: { error: { code: 'forbidden', message: 'Your role does not allow this.' } } }]);

    await assert.rejects(() => dibs.reviewClaims(), (error: unknown) =>
      error instanceof TransientFailure && /403 \(forbidden\)/.test(error.message));
  });
});

describe('reporting to the coordination server', () => {
  it('sends a merge with its head, base, time and files, and reads a claim set aside as live', async () => {
    const { dibs, fetcher } = client([{ body: { matched: true, item: 7, claim: 'set_aside' } }]);

    const answer = await dibs.reportMerged({
      pr: 'example-org/first-repo#2',
      base: 'feature/base',
      head: 'alice/7-refunds',
      mergedAt: new Date('2026-03-02T09:02:00Z'),
      files: ['src/a.ts'],
    });

    assert.deepEqual(answer, { matched: true, item: 7, claim: 'set_aside' });
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/prs/merged`);
    assert.deepEqual(fetcher.calls[0]?.body, {
      pr: 'example-org/first-repo#2',
      base: 'feature/base',
      head: 'alice/7-refunds',
      merged_at: '2026-03-02T09:02:00.000Z',
      files: ['src/a.ts'],
    });
  });

  it('leaves out the head of a fork\'s branch and files it could not read', async () => {
    const { dibs, fetcher } = client([{ body: { matched: false } }]);

    await dibs.reportMerged({ pr: 'example-org/first-repo#2', base: 'main', head: null, mergedAt: new Date('2026-03-02T09:02:00Z'), files: null });

    assert.deepEqual(fetcher.calls[0]?.body, { pr: 'example-org/first-repo#2', base: 'main', merged_at: '2026-03-02T09:02:00.000Z' });
  });

  it('tells a refusal of one report apart from a server that does not answer', async () => {
    const { dibs } = client([
      { status: 422, body: { error: { code: 'invalid_request', message: 'No.' } } },
      { status: 503, body: { error: { code: 'timeout', message: 'Later.' } } },
      { failWith: new TypeError('fetch failed') },
    ]);

    await assert.rejects(() => dibs.reportClosed('example-org/first-repo#3'), (error: unknown) =>
      error instanceof TransientFailure && !(error instanceof NoAnswer));
    await assert.rejects(() => dibs.reportClosed('example-org/first-repo#3'), NoAnswer);
    await assert.rejects(() => dibs.reportClosed('example-org/first-repo#3'), NoAnswer);
  });

  it('reads a report that matched nothing as an answer', async () => {
    const { dibs } = client([{ body: { matched: false } }]);

    assert.deepEqual(await dibs.reportClosed('example-org/first-repo#3'), { matched: false });
  });

  it('refuses a match that names no item', async () => {
    const { dibs } = client([{ body: { matched: true } }]);

    await assert.rejects(() => dibs.reportClosed('example-org/first-repo#3'), TransientFailure);
  });

  it('sends a footprint in the server\'s spelling, and takes one not kept as an answer', async () => {
    const { dibs, fetcher } = client([{ body: { stored: false, reason: 'other_branch' } }]);

    const answer = await dibs.reportFootprint(12, {
      repo: 'web',
      branch: 'alice/7-refunds',
      base: 'main',
      measure: { baseSha: '4f2a91c0', baseAt: new Date('2026-03-02T08:12:00Z'), paths: ['src/a.ts'], truncated: false },
    });

    assert.deepEqual(answer, { stored: false, reason: 'other_branch' });
    assert.equal(fetcher.calls[0]?.method, 'PUT');
    assert.equal(fetcher.calls[0]?.url, `${SERVER}/v1/items/12/footprint`);
    assert.deepEqual(fetcher.calls[0]?.body, {
      repo: 'web',
      branch: 'alice/7-refunds',
      base: 'main',
      base_sha: '4f2a91c0',
      base_at: '2026-03-02T08:12:00.000Z',
      paths: ['src/a.ts'],
      truncated: false,
    });
  });

  it('reports mergeability and a finished run at their own addresses', async () => {
    const { dibs, fetcher } = client([{ body: { recorded: false } }, { body: { matched: true } }]);

    assert.equal(await dibs.reportMergeable('example-org/first-repo#5', false), false);
    assert.equal(await dibs.reportRunFinished({ slot: 'db staging', workflow: 'deploy.yml', sha: 'abc1234def' }, 'success'), true);

    assert.deepEqual(fetcher.calls.map((call) => [call.method, call.url.slice(SERVER.length), call.body]), [
      ['POST', '/v1/prs/state', { pr: 'example-org/first-repo#5', mergeable: false }],
      ['POST', '/v1/slots/db%20staging/run-finished', { workflow: 'deploy.yml', sha: 'abc1234def', conclusion: 'success' }],
    ]);
  });
});
