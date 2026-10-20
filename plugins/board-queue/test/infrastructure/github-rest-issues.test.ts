import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubHttp } from '../../src/infrastructure/github-http.ts';
import { GitHubRestIssues } from '../../src/infrastructure/github-rest-issues.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { FakeFetch, budgetHeaders, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger, StubTokenProvider } from '../fakes/wire-doubles.ts';

const HEADERS = budgetHeaders(4900, 1789000000, 'core');
const REF = IssueRef.of('example-org/first-repo', 12);

function issues(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const http = new GitHubHttp({
    tokens: new StubTokenProvider(),
    logger: new RecordingLogger(),
    fetchImpl: fetcher.fetch,
  });
  return { gateway: new GitHubRestIssues(http), fetcher, http };
}

function issuePayload(number: number, state: 'open' | 'closed', extra: Record<string, unknown> = {}): unknown {
  return {
    number,
    state,
    title: `issue ${String(number)}`,
    html_url: `https://github.com/example-org/first-repo/issues/${String(number)}`,
    ...extra,
  };
}

describe('GitHubRestIssues writes', () => {
  it('posts a comment and answers where it landed', async () => {
    const { gateway, fetcher } = issues([{
      status: 201,
      headers: HEADERS,
      body: { id: 5, body: 'hello', html_url: 'https://github.com/example-org/first-repo/issues/12#issuecomment-5', created_at: '2026-09-16T10:00:00Z' },
    }]);
    const url = await gateway.comment(REF, 'hello');
    assert.equal(url, 'https://github.com/example-org/first-repo/issues/12#issuecomment-5');
    const call = fetcher.calls[0];
    assert.equal(call?.method, 'POST');
    assert.equal(call?.url, 'https://api.github.com/repos/example-org/first-repo/issues/12/comments');
    assert.deepEqual(call?.body, { body: 'hello' });
  });

  it('closes an issue with the reason it was given', async () => {
    const { gateway, fetcher } = issues([{ headers: HEADERS, body: issuePayload(12, 'closed') }]);
    await gateway.close(REF, 'not_planned');
    const call = fetcher.calls[0];
    assert.equal(call?.method, 'PATCH');
    assert.equal(call?.url, 'https://api.github.com/repos/example-org/first-repo/issues/12');
    assert.deepEqual(call?.body, { state: 'closed', state_reason: 'not_planned' });
  });

  it('reads one issue', async () => {
    const { gateway } = issues([{ headers: HEADERS, body: issuePayload(12, 'open') }]);
    assert.deepEqual(await gateway.get(REF), {
      number: 12,
      state: 'open',
      title: 'issue 12',
      url: 'https://github.com/example-org/first-repo/issues/12',
      assignees: [],
    });
  });

  it('reads who an issue is assigned to', async () => {
    const { gateway } = issues([{
      headers: HEADERS,
      body: issuePayload(12, 'open', { assignees: [{ login: 'alice' }, { login: 'bob' }] }),
    }]);
    assert.deepEqual((await gateway.get(REF)).assignees, ['alice', 'bob']);
  });

  it('assigns and unassigns through the issue\'s own assignees address', async () => {
    const { gateway, fetcher } = issues([
      { status: 201, headers: HEADERS, body: issuePayload(12, 'open', { assignees: [{ login: 'alice' }] }) },
      { headers: HEADERS, body: issuePayload(12, 'open', { assignees: [] }) },
    ]);
    await gateway.addAssignees(REF, ['alice']);
    await gateway.removeAssignees(REF, ['alice']);
    const [added, removed] = fetcher.calls;
    assert.equal(added?.method, 'POST');
    assert.equal(added?.url, 'https://api.github.com/repos/example-org/first-repo/issues/12/assignees');
    assert.deepEqual(added?.body, { assignees: ['alice'] });
    assert.equal(removed?.method, 'DELETE');
    assert.equal(removed?.url, 'https://api.github.com/repos/example-org/first-repo/issues/12/assignees');
    assert.deepEqual(removed?.body, { assignees: ['alice'] });
  });

  it('reports the allowance the last answer named', async () => {
    const { gateway } = issues([{ headers: HEADERS, body: issuePayload(12, 'open') }]);
    await gateway.get(REF);
    assert.equal(gateway.lastBudget()?.remaining, 4900);
    assert.equal(gateway.lastBudget()?.resource, 'core');
  });
});

describe('GitHubRestIssues listings', () => {
  it('asks only for comments written since a moment', async () => {
    const { gateway, fetcher } = issues([{
      headers: HEADERS,
      body: [
        { id: 1, body: 'first', html_url: 'https://example.invalid/1', created_at: '2026-09-16T10:00:00Z' },
        { id: 2, body: null, html_url: 'https://example.invalid/2', created_at: '2026-09-16T11:00:00Z' },
      ],
    }]);
    const since = new Date('2026-09-16T09:00:00.000Z');
    const comments = await gateway.listComments(REF, since);
    assert.equal(fetcher.calls[0]?.url.includes('since=2026-09-16T09%3A00%3A00.000Z'), true);
    assert.equal(fetcher.calls[0]?.url.includes('per_page=100'), true);
    assert.deepEqual(comments.map((comment) => comment.id), [1, 2]);
    assert.equal(comments[1]?.body, '');
    assert.equal(comments[0]?.createdAt.toISOString(), '2026-09-16T10:00:00.000Z');
  });

  it('asks for every comment when no moment is given', async () => {
    const { gateway, fetcher } = issues([{ headers: HEADERS, body: [] }]);
    await gateway.listComments(REF, null);
    assert.equal(fetcher.calls[0]?.url.includes('since='), false);
  });

  it('follows the pages the answer points at and leaves pull requests out', async () => {
    const { gateway, fetcher } = issues([
      {
        headers: {
          ...HEADERS,
          link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"',
        },
        body: [
          issuePayload(12, 'open'),
          issuePayload(13, 'open', { pull_request: { url: 'https://api.github.invalid/pulls/13' } }),
        ],
      },
      { headers: HEADERS, body: [issuePayload(14, 'open')] },
    ]);
    const open = await gateway.listOpen('example-org/first-repo');
    assert.deepEqual(open.map((issue) => issue.number), [12, 14]);
    assert.equal(fetcher.calls.length, 2);
    assert.equal(fetcher.calls[0]?.url.includes('state=open'), true);
    assert.equal(fetcher.calls[1]?.url, 'https://api.github.com/repositories/1/issues?page=2');
  });

  it('asks for closed issues touched since a moment', async () => {
    const { gateway, fetcher } = issues([{ headers: HEADERS, body: [issuePayload(12, 'closed')] }]);
    const closed = await gateway.listClosedSince('example-org/first-repo', new Date('2026-09-02T00:00:00.000Z'));
    assert.deepEqual(closed.map((issue) => issue.state), ['closed']);
    const url = fetcher.calls[0]?.url ?? '';
    assert.equal(url.includes('state=closed'), true);
    assert.equal(url.includes('since=2026-09-02T00%3A00%3A00.000Z'), true);
  });
});
