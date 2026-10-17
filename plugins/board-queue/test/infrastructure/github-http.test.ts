import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BudgetLedger, GitHubHttp } from '../../src/infrastructure/github-http.ts';
import {
  CredentialRejected,
  IssueNotFound,
  PrimaryRateLimited,
  SecondaryRateLimited,
  TransientFailure,
} from '../../src/domain/errors.ts';
import { FakeFetch, budgetHeaders, type ScriptedResponse } from '../fakes/fake-fetch.ts';
import { RecordingLogger, StubTokenProvider } from '../fakes/wire-doubles.ts';

const RESET_SECONDS = 1789000000;
const PROBE = 'query Probe { rateLimit { remaining } }';
const FIRST_TOKEN = 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_TOKEN = 'ghs_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function wire(script: readonly ScriptedResponse[]) {
  const fetcher = new FakeFetch(script);
  const logger = new RecordingLogger();
  const tokens = new StubTokenProvider([FIRST_TOKEN, SECOND_TOKEN]);
  const http = new GitHubHttp({ tokens, logger, fetchImpl: fetcher.fetch });
  return { http, fetcher, logger, tokens };
}

describe('GitHubHttp allowance reading', () => {
  it('reads the allowance off every answer and counts the reset in seconds', async () => {
    const { http } = wire([{ headers: budgetHeaders(4321, RESET_SECONDS), body: { data: { ok: true } } }]);
    await http.graphql(PROBE, {});
    const budget = http.lastBudget('graphql');
    assert.ok(budget !== null);
    assert.equal(budget.remaining, 4321);
    assert.equal(budget.resetAt.getTime(), RESET_SECONDS * 1000);
    assert.equal(http.lastBudget('core'), null);
  });

  it('treats an answer with nothing left as the success it is', async () => {
    const { http } = wire([{ headers: budgetHeaders(0, RESET_SECONDS), body: { data: { ok: true } } }]);
    assert.deepEqual(await http.graphql(PROBE, {}), { ok: true });
    assert.equal(http.lastBudget('graphql')?.remaining, 0);
  });

  it('keeps the two allowances apart', async () => {
    const { http } = wire([
      { headers: budgetHeaders(10, RESET_SECONDS, 'core'), body: { number: 1 } },
      { headers: budgetHeaders(4000, RESET_SECONDS), body: { data: { ok: true } } },
    ]);
    await http.rest('GET', '/repos/example-org/first-repo/issues/1');
    await http.graphql(PROBE, {});
    assert.equal(http.lastBudget('core')?.remaining, 10);
    assert.equal(http.lastBudget('graphql')?.remaining, 4000);
  });
});

describe('GitHubHttp allowance shared between transports', () => {
  it('lets every transport of one account read the allowance whichever of them heard it last', async () => {
    const ledger = new BudgetLedger();
    const logger = new RecordingLogger();
    const organisation = new GitHubHttp({
      tokens: new StubTokenProvider([FIRST_TOKEN]),
      logger,
      ledger,
      fetchImpl: new FakeFetch([{ headers: budgetHeaders(4000, RESET_SECONDS), body: { data: { ok: true } } }]).fetch,
    });
    const person = new GitHubHttp({
      tokens: new StubTokenProvider([SECOND_TOKEN]),
      logger,
      ledger,
      fetchImpl: new FakeFetch([{ headers: budgetHeaders(3990, RESET_SECONDS), body: { data: { ok: true } } }]).fetch,
    });

    await organisation.graphql(PROBE, {});
    assert.equal(person.lastBudget('graphql')?.remaining, 4000);
    await person.graphql(PROBE, {});
    assert.equal(organisation.lastBudget('graphql')?.remaining, 3990);
    assert.equal(ledger.last('graphql')?.remaining, 3990);
  });
});

describe('GitHubHttp refusal classification', () => {
  it('calls a refusal with nothing left an exhausted allowance', async () => {
    const { http } = wire([{
      status: 403,
      headers: { ...budgetHeaders(0, RESET_SECONDS) },
      body: { message: 'API rate limit exceeded for installation ID 1.' },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof PrimaryRateLimited);
      assert.equal(error.resetAt.getTime(), RESET_SECONDS * 1000);
      return true;
    });
  });

  it('calls the same refusal with allowance left a burst refusal', async () => {
    const { http } = wire([{
      headers: budgetHeaders(4200, RESET_SECONDS),
      body: {
        errors: [{ type: 'RATE_LIMIT', code: 'graphql_rate_limit', message: 'API rate limit exceeded' }],
      },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof SecondaryRateLimited);
      assert.equal(error.retryAfterSec, null);
      return true;
    });
  });

  it('reads the waiting time a burst refusal asks for', async () => {
    const { http } = wire([{
      status: 429,
      headers: { ...budgetHeaders(4200, RESET_SECONDS), 'retry-after': '73' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof SecondaryRateLimited);
      assert.equal(error.retryAfterSec, 73);
      return true;
    });
  });

  it('recognises a burst refusal that names no waiting time and no allowance', async () => {
    const { http } = wire([{
      status: 403,
      body: { message: 'You have triggered an abuse detection mechanism.' },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof SecondaryRateLimited);
      assert.equal(error.retryAfterSec, null);
      return true;
    });
  });

  it('does not read a burst refusal as exhaustion when the allowance happens to be spent', async () => {
    const { http } = wire([{
      status: 403,
      headers: { ...budgetHeaders(0, RESET_SECONDS), 'retry-after': '60' },
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof SecondaryRateLimited);
      assert.equal(error.retryAfterSec, 60);
      return true;
    });
  });

  it('names a missing subject when the graph cannot resolve the issue a call named', async () => {
    const { http } = wire([{
      headers: budgetHeaders(4000, RESET_SECONDS),
      body: {
        data: { repository: null },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }],
      },
    }]);
    await assert.rejects(
      () => http.graphql(PROBE, {}, 'example-org/first-repo#7', { scope: 'issue' }),
      (error: unknown) => {
        assert.ok(error instanceof IssueNotFound);
        assert.equal(error.ref, 'example-org/first-repo#7');
        return true;
      },
    );
  });

  it('does not read a call that named no issue as a missing issue', async () => {
    // The board answers this for a row whose content the credential cannot reach.
    // Blaming the issue the caller was working on would block work that is fine,
    // and blocked work waits for a person with nothing to fix.
    const { http } = wire([{
      headers: budgetHeaders(4000, RESET_SECONDS),
      body: { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}, 'the board listing'), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /Could not resolve to a node/);
      return true;
    });
  });

  it('names a missing subject when the rest answer for one issue is 404', async () => {
    const { http } = wire([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(
      () => http.rest('GET', '/repos/example-org/first-repo/issues/9', undefined, undefined, { scope: 'issue' }),
      (error: unknown) => {
        assert.ok(error instanceof IssueNotFound);
        assert.match(error.message, /\/repos\/example-org\/first-repo\/issues\/9/);
        return true;
      },
    );
  });

  it('calls a 404 on a listing retryable rather than a missing issue', async () => {
    const { http } = wire([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(
      () => http.rest('GET', '/repos/example-org/first-repo/issues?state=open'),
      (error: unknown) => {
        assert.ok(error instanceof TransientFailure);
        assert.match(error.message, /404/);
        return true;
      },
    );
  });

  it('calls a credential without the permission a call needs a rejected credential', async () => {
    const { http } = wire([{
      headers: budgetHeaders(4000, RESET_SECONDS),
      body: {
        errors: [{
          type: 'INSUFFICIENT_SCOPES',
          message: "Your token has not been granted the required scopes: ['read:project'].",
        }],
      },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}, 'the board catalog'), (error: unknown) => {
      assert.ok(error instanceof CredentialRejected);
      assert.match(error.describe(), /read:project/);
      assert.match(error.describe(), /nothing runs until/);
      return true;
    });
  });

  it('reads the same refusal out of a rest body that talks about scopes, and quotes it', async () => {
    const { http } = wire([{
      status: 403,
      body: { message: 'Resource not accessible: the token is missing the required scopes' },
    }]);
    await assert.rejects(
      () => http.rest('GET', '/repos/example-org/first-repo/issues/9', undefined, undefined, { scope: 'issue' }),
      (error: unknown) => {
        assert.ok(error instanceof CredentialRejected);
        assert.match(error.describe(), /missing the required scopes/);
        return true;
      },
    );
  });

  it('calls a server fault retryable', async () => {
    const { http } = wire([{ status: 502, bodyText: '<html>bad gateway</html>' }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /502/);
      return true;
    });
  });

  it('calls an answer that is not JSON retryable', async () => {
    const { http } = wire([{ headers: budgetHeaders(4000, RESET_SECONDS), bodyText: '{ not json' }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      return true;
    });
  });

  it('carries the first sentence of any other refusal', async () => {
    const { http } = wire([{
      headers: budgetHeaders(4000, RESET_SECONDS),
      body: { errors: [{ message: 'Field "nope" does not exist' }] },
    }]);
    await assert.rejects(() => http.graphql(PROBE, {}, 'the board catalog'), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /Field "nope" does not exist/);
      return true;
    });
  });

  it('calls a call that never arrived retryable', async () => {
    const { http } = wire([{ failWith: new Error('getaddrinfo ENOTFOUND api.github.com') }]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /ENOTFOUND/);
      return true;
    });
  });
});

describe('GitHubHttp carrying on with part of an answer', () => {
  const page = {
    headers: budgetHeaders(4000, RESET_SECONDS),
    body: {
      data: { owner: { projectV2: { items: { nodes: [{ id: 'item-1' }, null] } } } },
      errors: [{
        type: 'NOT_FOUND',
        message: 'Could not resolve to a node with the global id of …',
        path: ['owner', 'projectV2', 'items', 'nodes', 1, 'content'],
      }],
    },
  };

  it('answers with the data when every error is one the caller said it could do without', async () => {
    const { http, logger } = wire([page]);

    const answered = await http.graphql(PROBE, {}, 'the board listing', {
      tolerates: (error) => error.path?.includes('content') === true,
    });

    assert.deepEqual(answered, page.body.data);
    assert.ok(logger.lines.some((line) => line.level === 'warn' && /skipped/.test(line.message)));
  });

  it('still refuses when one of the errors is not one of those', async () => {
    const { http } = wire([page]);

    await assert.rejects(
      () => http.graphql(PROBE, {}, 'the board listing', { tolerates: () => false }),
      TransientFailure,
    );
  });
});

describe('GitHubHttp following a page it was handed', () => {
  it('will not send the credential to an address that is not the API', async () => {
    const { http, fetcher } = wire([]);

    await assert.rejects(
      () => http.rest('GET', 'https://example.invalid/repositories/1/issues?page=2'),
      (error: unknown) => {
        assert.ok(error instanceof TransientFailure);
        assert.match(error.message, /another host/);
        return true;
      },
    );
    assert.equal(fetcher.calls.length, 0, 'nothing was sent at all');
  });

  it('follows one that is', async () => {
    const { http } = wire([{ headers: budgetHeaders(100, RESET_SECONDS, 'core'), body: [{ number: 2 }] }]);

    const result = await http.rest('GET', 'https://api.github.com/repositories/1/issues?page=2');

    assert.deepEqual(result.data, [{ number: 2 }]);
  });
});

describe('GitHubHttp credential handling', () => {
  it('drops a rejected credential and tries once more', async () => {
    const { http, fetcher, tokens } = wire([
      { status: 401, body: { message: 'Bad credentials' } },
      { headers: budgetHeaders(4000, RESET_SECONDS), body: { data: { ok: true } } },
    ]);
    assert.deepEqual(await http.graphql(PROBE, {}), { ok: true });
    assert.equal(tokens.invalidations, 1);
    assert.equal(fetcher.calls.length, 2);
    assert.equal(fetcher.calls[0]?.headers['authorization'], `Bearer ${FIRST_TOKEN}`);
    assert.equal(fetcher.calls[1]?.headers['authorization'], `Bearer ${SECOND_TOKEN}`);
  });

  it('gives up after a second rejection without blaming the work', async () => {
    const { http, fetcher, tokens } = wire([
      { status: 401, body: { message: 'Bad credentials' } },
      { status: 401, body: { message: 'Bad credentials' } },
    ]);
    await assert.rejects(() => http.graphql(PROBE, {}), (error: unknown) => {
      assert.ok(error instanceof CredentialRejected);
      assert.match(error.message, /credential/);
      return true;
    });
    assert.equal(tokens.invalidations, 1);
    assert.equal(fetcher.calls.length, 2);
  });

  it('never lets the credential reach a log line', async () => {
    const { http, logger } = wire([{ headers: budgetHeaders(4000, RESET_SECONDS), body: { data: { ok: true } } }]);
    await http.graphql(PROBE, {});
    const written = JSON.stringify(logger.lines);
    assert.equal(written.includes(FIRST_TOKEN), false);
    assert.match(written, /"operation":"Probe"/);
    assert.match(written, /"remaining":4000/);
  });
});

describe('GitHubHttp requests', () => {
  it('sends the query, its variables and its name', async () => {
    const { http, fetcher } = wire([{ headers: budgetHeaders(4000, RESET_SECONDS), body: { data: { ok: true } } }]);
    await http.graphql('query BoardCatalog($owner: String!) { owner: organization(login: $owner) { id } }', {
      owner: 'example-org',
    });
    const call = fetcher.calls[0];
    assert.equal(call?.operationName, 'BoardCatalog');
    assert.deepEqual(call?.variables, { owner: 'example-org' });
    assert.match(call?.query ?? '', /projectV2|organization/);
  });

  it('answers the address of the next page when the answer offers one', async () => {
    const { http } = wire([{
      headers: {
        ...budgetHeaders(100, RESET_SECONDS, 'core'),
        link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"',
      },
      body: [{ number: 1 }],
    }]);
    const result = await http.rest('GET', '/repos/example-org/first-repo/issues');
    assert.equal(result.nextPageUrl, 'https://api.github.com/repositories/1/issues?page=2');
  });

  it('answers nothing for a body-less success', async () => {
    const { http } = wire([{ status: 204, headers: budgetHeaders(100, RESET_SECONDS, 'core') }]);
    const result = await http.rest('DELETE', '/repos/example-org/first-repo/issues/1/labels/bug');
    assert.equal(result.data, null);
    assert.equal(result.nextPageUrl, null);
  });
});
