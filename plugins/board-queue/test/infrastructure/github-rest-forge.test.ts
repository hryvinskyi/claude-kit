import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoAnswer, SecondaryRateLimited, TransientFailure } from '../../src/domain/errors.ts';
import { GitHubHttp } from '../../src/infrastructure/github-http.ts';
import { GitHubRestForge } from '../../src/infrastructure/github-rest-forge.ts';
import { FakeFetch, budgetHeaders, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger, StubTokenProvider } from '../fakes/wire-doubles.ts';

const HEADERS = budgetHeaders(4900, 1789000000, 'core');
const REPO = 'example-org/first-repo';
const API = 'https://api.github.com';

function forgeOf(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const http = new GitHubHttp({ tokens: new StubTokenProvider(), logger: new RecordingLogger(), fetchImpl: fetcher.fetch });
  return { forge: new GitHubRestForge(() => http), fetcher };
}

/** A pull request as GitHub's REST API answers it, with the fields the jobs read and some they do not. */
function pullPayload(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `${API}/repos/${REPO}/pulls/${String(number)}`,
    id: 1000 + number,
    number,
    state: 'open',
    title: `pull request ${String(number)}`,
    user: { login: 'alice-gh', id: 7, type: 'User' },
    created_at: '2026-03-01T08:00:00Z',
    updated_at: '2026-03-02T08:00:00Z',
    closed_at: null,
    merged_at: null,
    head: { label: 'example-org:alice/7-refunds', ref: 'alice/7-refunds', sha: 'a'.repeat(40) },
    base: { label: 'example-org:main', ref: 'main', sha: 'b'.repeat(40) },
    draft: false,
    ...overrides,
  };
}

describe('the pull requests of a repository on GitHub', () => {
  it('lists a page newest update first, conditionally, and says whether another follows', async () => {
    const { forge, fetcher } = forgeOf([{
      headers: { ...HEADERS, etag: '"p1"', link: `<${API}/repos/${REPO}/pulls?page=2>; rel="next"` },
      body: [pullPayload(2, { state: 'closed', merged_at: '2026-03-02T09:02:00Z', updated_at: '2026-03-02T09:02:00Z' })],
    }]);

    const page = await forge.pullPage('Example-Org/First-Repo', 'all', 1, '"p0"');

    assert.equal(
      fetcher.calls[0]?.url,
      `${API}/repos/Example-Org/First-Repo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`,
    );
    assert.equal(fetcher.calls[0]?.headers['if-none-match'], '"p0"');
    assert.ok(page.changed);
    assert.equal(page.etag, '"p1"');
    assert.equal(page.more, true);
    assert.deepEqual(page.pulls, [{
      repo: REPO,
      number: 2,
      state: 'closed',
      mergedAt: new Date('2026-03-02T09:02:00Z'),
      updatedAt: new Date('2026-03-02T09:02:00Z'),
      author: 'alice-gh',
      headRef: 'alice/7-refunds',
      headRepo: null,
      headSha: 'a'.repeat(40),
      baseRef: 'main',
    }]);
    assert.equal(page.servedAt, null);
  });

  it('answers "unchanged" to a page whose tag still holds', async () => {
    const { forge } = forgeOf([{ status: 304, headers: { ...HEADERS, etag: '"p1"' } }]);

    assert.deepEqual(await forge.pullPage(REPO, 'all', 1, '"p1"'), { changed: false });
  });

  it('reads one pull request with whether it merges cleanly, and a ghost author as nobody', async () => {
    const { forge } = forgeOf([{ headers: { ...HEADERS, etag: '"one"' }, body: { ...pullPayload(5, { user: null }), mergeable: false } }]);

    const read = await forge.pull(REPO, 5, null);

    assert.ok(read.changed);
    assert.equal(read.mergeable, false);
    assert.equal(read.pull.author, null);
    assert.equal(read.etag, '"one"');
  });

  it('reads one page of a pull request\'s files, a rename by both its paths', async () => {
    const { forge, fetcher } = forgeOf([{
      headers: { ...HEADERS, link: `<${API}/repos/${REPO}/pulls/5/files?per_page=100&page=3>; rel="next"` },
      body: [
        { filename: 'src/a.ts', status: 'modified' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
      ],
    }]);

    const files = await forge.pullFilesPage(REPO, 5, 2);

    assert.deepEqual(files, { paths: ['src/a.ts', 'src/new.ts', 'src/old.ts'], more: true });
    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}/pulls/5/files?per_page=100&page=2`);
  });

  it('reads the repository a pull request\'s branch lives in, a fork\'s or none', async () => {
    const { forge } = forgeOf([{
      headers: HEADERS,
      body: [
        pullPayload(2, { head: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: 'Someone/First-Repo' } } }),
        pullPayload(3, { head: { ref: 'gone', sha: 'd'.repeat(40), repo: null } }),
        pullPayload(4, { head: { ref: 'own', sha: 'e'.repeat(40), repo: { full_name: 'Example-Org/First-Repo' } } }),
      ],
    }]);

    const page = await forge.pullPage(REPO, 'open', 1, null);

    assert.ok(page.changed);
    assert.deepEqual(page.pulls.map((pull) => pull.headRepo), ['someone/first-repo', null, REPO]);
  });

  it('says when GitHub answered, by its own clock', async () => {
    const { forge } = forgeOf([{ headers: { ...HEADERS, date: 'Mon, 02 Mar 2026 08:59:30 GMT' }, body: [] }]);

    const page = await forge.pullPage(REPO, 'open', 1, null);

    assert.ok(page.changed);
    assert.deepEqual(page.servedAt, new Date('2026-03-02T08:59:30Z'));
  });

  it('resolves a short commit id to its full one, and answers nothing where the repository holds none', async () => {
    const { forge, fetcher } = forgeOf([
      { headers: HEADERS, body: { sha: `abc1234${'0'.repeat(33)}`, commit: { message: 'ship' } } },
      { status: 422, headers: HEADERS, body: { message: 'No commit found for SHA: abc1234' } },
      { status: 404, headers: HEADERS, body: { message: 'Not Found' } },
    ]);

    assert.equal(await forge.resolveCommit(REPO, 'abc1234'), `abc1234${'0'.repeat(33)}`);
    assert.equal(await forge.resolveCommit('example-org/second-repo', 'abc1234'), null);
    assert.equal(await forge.resolveCommit('example-org/third-repo', 'abc1234'), null);
    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}/commits/abc1234`);
  });

  it('refuses an answer of another shape rather than reading half of it', async () => {
    const { forge } = forgeOf([{ headers: HEADERS, body: [{ number: 'two' }] }]);

    await assert.rejects(() => forge.pullPage(REPO, 'open', 1, null), TransientFailure);
  });

  it('tells GitHub not answering apart from GitHub refusing one request', async () => {
    const { forge } = forgeOf([
      { status: 502, headers: HEADERS, body: { message: 'Server Error' } },
      { failWith: new TypeError('fetch failed') },
      { status: 403, headers: HEADERS, body: { message: 'Resource not accessible by integration' } },
      { status: 422, headers: HEADERS, body: { message: 'Validation Failed' } },
    ]);
    const refusedAlone = (error: unknown) => error instanceof TransientFailure && !(error instanceof NoAnswer);

    await assert.rejects(() => forge.pull(REPO, 5, null), NoAnswer);
    await assert.rejects(() => forge.pull(REPO, 5, null), NoAnswer);
    await assert.rejects(() => forge.pull(REPO, 5, null), refusedAlone);
    await assert.rejects(() => forge.writeStatus(REPO, 'a'.repeat(40), { state: 'success', description: 'x', context: 'dibs' }), refusedAlone);
  });

  it('carries a burst refusal as the queue\'s own', async () => {
    const { forge } = forgeOf([{
      status: 403,
      headers: { ...HEADERS, 'retry-after': '60' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    }]);

    await assert.rejects(() => forge.pullPage(REPO, 'all', 1, null), SecondaryRateLimited);
  });
});

describe('the branches of a repository on GitHub', () => {
  const COMPARE = {
    status: 'ahead',
    merge_base_commit: {
      sha: '4f2a91c0'.padEnd(40, '0'),
      commit: { committer: { name: 'A', date: '2026-03-01T08:12:00Z' }, author: { name: 'A', date: '2026-03-01T08:00:00Z' } },
    },
    commits: [],
    files: [{ filename: 'src/billing/refund.ts', status: 'modified' }, { filename: 'docs/a.md', status: 'added' }],
  };

  it('measures a branch from its merge base, escaping what its name holds but its slashes', async () => {
    const { forge, fetcher } = forgeOf([{ headers: { ...HEADERS, etag: '"c1"' }, body: COMPARE }]);

    const answer = await forge.compare(REPO, 'main', 'alice/7-refunds#2', null);

    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}/compare/main...alice/7-refunds%232?per_page=1`);
    assert.deepEqual(answer, {
      kind: 'measured',
      etag: '"c1"',
      measure: {
        baseSha: '4f2a91c0'.padEnd(40, '0'),
        baseAt: new Date('2026-03-01T08:12:00Z'),
        paths: ['src/billing/refund.ts', 'docs/a.md'],
        truncated: false,
      },
    });
  });

  it('says a comparison is unchanged, and that a deleted branch is missing', async () => {
    const { forge, fetcher } = forgeOf([
      { status: 304, headers: { ...HEADERS, etag: '"c1"' } },
      { status: 404, headers: HEADERS, body: { message: 'Not Found' } },
    ]);

    assert.deepEqual(await forge.compare(REPO, 'main', 'alice/7-refunds', '"c1"'), { kind: 'unchanged' });
    assert.deepEqual(await forge.compare(REPO, 'main', 'alice/gone', null), { kind: 'missing' });
    assert.equal(fetcher.calls[0]?.headers['if-none-match'], '"c1"');
  });

  it('counts both paths of a rename, and refuses a comparison that names no files', async () => {
    const renamed = { ...COMPARE, files: [{ filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed' }] };
    const { files: _files, ...withoutFiles } = COMPARE;
    const { forge } = forgeOf([{ headers: HEADERS, body: renamed }, { headers: HEADERS, body: withoutFiles }]);

    const answer = await forge.compare(REPO, 'main', 'rename', null);

    assert.deepEqual(answer.kind === 'measured' ? answer.measure.paths : null, ['b.ts', 'a.ts']);
    await assert.rejects(() => forge.compare(REPO, 'main', 'huge', null), TransientFailure);
  });

  it('says a measure was cut short when GitHub listed as many files as it lists', async () => {
    const files = Array.from({ length: 300 }, (_, at) => ({ filename: `f${String(at)}.ts` }));
    const { forge } = forgeOf([{ headers: HEADERS, body: { ...COMPARE, files } }]);

    const answer = await forge.compare(REPO, 'main', 'wide', null);

    assert.equal(answer.kind === 'measured' && answer.measure.truncated, true);
  });

  it('reads the default branch conditionally', async () => {
    const { forge, fetcher } = forgeOf([
      { headers: { ...HEADERS, etag: '"r1"' }, body: { full_name: REPO, default_branch: 'trunk' } },
      { status: 304, headers: { ...HEADERS, etag: '"r1"' } },
    ]);

    assert.deepEqual(await forge.defaultBranch(REPO, null), { changed: true, etag: '"r1"', name: 'trunk' });
    assert.deepEqual(await forge.defaultBranch(REPO, '"r1"'), { changed: false });
    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}`);
  });
});

describe('workflow runs and commit statuses on GitHub', () => {
  it('lists the runs of one commit', async () => {
    const { forge, fetcher } = forgeOf([{
      headers: HEADERS,
      body: {
        total_count: 1,
        workflow_runs: [{
          id: 77,
          name: 'Deploy',
          path: '.github/workflows/deploy.yml',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-03-02T09:00:00Z',
          head_sha: 'abc1234def',
          head_branch: 'main',
        }],
      },
    }]);

    const runs = await forge.runsFor(REPO, 'abc1234def');

    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}/actions/runs?head_sha=abc1234def&per_page=100`);
    assert.deepEqual(runs, [{
      id: 77,
      path: '.github/workflows/deploy.yml',
      name: 'Deploy',
      status: 'completed',
      conclusion: 'success',
      createdAt: new Date('2026-03-02T09:00:00Z'),
      headSha: 'abc1234def',
    }]);
  });

  it('writes a status on a commit under its context', async () => {
    const { forge, fetcher } = forgeOf([{ status: 201, headers: HEADERS, body: { id: 1, state: 'failure' } }]);

    await forge.writeStatus(REPO, 'a'.repeat(40), {
      state: 'failure',
      description: 'A freezing action is in progress until 14:40 UTC.',
      context: 'dibs',
    });

    assert.equal(fetcher.calls[0]?.method, 'POST');
    assert.equal(fetcher.calls[0]?.url, `${API}/repos/${REPO}/statuses/${'a'.repeat(40)}`);
    assert.deepEqual(fetcher.calls[0]?.body, {
      state: 'failure',
      description: 'A freezing action is in progress until 14:40 UTC.',
      context: 'dibs',
    });
  });

  it('reads what is left of the allowance from the last answer, without asking', async () => {
    const { forge, fetcher } = forgeOf([{ headers: { ...HEADERS, etag: '"r1"' }, body: { default_branch: 'main' } }]);

    assert.equal(forge.remaining(REPO), null);
    await forge.defaultBranch(REPO, null);

    assert.equal(forge.remaining(REPO), 4900);
    assert.equal(fetcher.calls.length, 1);
  });
});
