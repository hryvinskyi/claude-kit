import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IssueNotFound, SecondaryRateLimited } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { GitHubHttp } from '../../src/infrastructure/github-http.ts';
import { GitHubRestDependencies } from '../../src/infrastructure/github-rest-dependencies.ts';
import { FakeFetch, budgetHeaders, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger, StubTokenProvider } from '../fakes/wire-doubles.ts';

const HEADERS = budgetHeaders(4900, 1789000000, 'core');
const REF = IssueRef.of('acme/widgets', 41);

function reader(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const http = new GitHubHttp({ tokens: new StubTokenProvider(), logger: new RecordingLogger(), fetchImpl: fetcher.fetch });
  return { dependencies: new GitHubRestDependencies(() => http), fetcher };
}

function linked(number: number, repo: string, state: 'open' | 'closed'): unknown {
  return {
    number,
    title: `issue ${String(number)}`,
    state,
    repository_url: `https://api.github.com/repos/${repo}`,
    html_url: `https://github.com/${repo}/issues/${String(number)}`,
  };
}

describe('reading what blocks an issue', () => {
  it('reads the blockers, each in its own repository, with the tag the answer carried', async () => {
    const { dependencies, fetcher } = reader([{
      headers: { ...HEADERS, etag: '"b1"' },
      body: [linked(40, 'acme/widgets', 'open'), linked(9, 'acme/api', 'closed')],
    }]);

    const answer = await dependencies.read('blocked_by', REF, null);

    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/repos/acme/widgets/issues/41/dependencies/blocked_by?per_page=100');
    assert.equal(fetcher.calls[0]?.headers['if-none-match'], undefined);
    assert.ok(answer.changed);
    assert.equal(answer.etag, '"b1"');
    assert.deepEqual(answer.issues.map((issue) => [issue.ref.toString(), issue.state]), [
      ['acme/widgets#40', 'open'],
      ['acme/api#9', 'closed'],
    ]);
  });

  it('reads the sub-issues at their own address', async () => {
    const { dependencies, fetcher } = reader([{ headers: HEADERS, body: [linked(50, 'acme/widgets', 'open')] }]);

    await dependencies.read('sub_issues', REF, null);

    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/repos/acme/widgets/issues/41/sub_issues?per_page=100');
  });

  it('asks with the tag it holds and answers "unchanged" when it still holds', async () => {
    const { dependencies, fetcher } = reader([{ status: 304, headers: { ...HEADERS, etag: '"b1"' } }]);

    const answer = await dependencies.read('blocked_by', REF, '"b1"');

    assert.equal(fetcher.calls[0]?.headers['if-none-match'], '"b1"');
    assert.deepEqual(answer, { changed: false, etag: '"b1"' });
  });

  it('reads every page of a list that changed', async () => {
    const { dependencies } = reader([
      {
        headers: { ...HEADERS, link: '<https://api.github.com/repos/acme/widgets/issues/41/sub_issues?page=2>; rel="next"' },
        body: [linked(50, 'acme/widgets', 'open')],
      },
      { headers: HEADERS, body: [linked(51, 'acme/widgets', 'open')] },
    ]);

    const answer = await dependencies.read('sub_issues', REF, null);

    assert.ok(answer.changed);
    assert.deepEqual(answer.issues.map((issue) => issue.ref.number), [50, 51]);
  });

  it('reports a missing issue as the issue that is missing', async () => {
    const { dependencies } = reader([{ status: 404, headers: HEADERS, body: { message: 'Not Found' } }]);

    await assert.rejects(() => dependencies.read('blocked_by', REF, null), IssueNotFound);
  });

  it('reports a burst refusal as the queue\'s own', async () => {
    const { dependencies } = reader([{
      status: 403,
      headers: { ...HEADERS, 'retry-after': '60' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    }]);

    await assert.rejects(() => dependencies.read('blocked_by', REF, null), SecondaryRateLimited);
  });
});
