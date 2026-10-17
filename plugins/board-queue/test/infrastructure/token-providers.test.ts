import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { after, before, describe, it } from 'node:test';
import type { TokenProvider } from '../../src/application/ports.ts';
import { RefusedByRule, TransientFailure } from '../../src/domain/errors.ts';
import {
  AccountCredentials,
  AppTokenProvider,
  CachingTokenProvider,
  FallbackTokenProvider,
  GhCliTokenProvider,
} from '../../src/infrastructure/token-providers.ts';
import { FakeFetch } from '../fakes/fake-fetch.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { RecordingLogger } from '../fakes/wire-doubles.ts';

const INSTALLATION_TOKEN = 'ghs_cccccccccccccccccccccccccccccccccccc';

/** Counts how often it was asked and what it was asked to forget. */
class CountingProvider implements TokenProvider {
  mints = 0;
  invalidations = 0;

  async token(): Promise<string> {
    this.mints += 1;
    return `token-${String(this.mints)}`;
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

class RefusingProvider implements TokenProvider {
  async token(): Promise<string> {
    throw new TransientFailure('`gh auth token` failed with exit code 1');
  }

  invalidate(): void {
    // Nothing is held.
  }
}

describe('GhCliTokenProvider', () => {
  it('answers the credential the command prints', async () => {
    const provider = new GhCliTokenProvider((command, args) => {
      assert.equal(command, 'gh');
      assert.deepEqual([...args], ['auth', 'token']);
      return `${INSTALLATION_TOKEN}\n`;
    });
    assert.equal(await provider.token(), INSTALLATION_TOKEN);
  });

  it('names the exit code of a failed run and never what it printed', async () => {
    const provider = new GhCliTokenProvider(() => {
      throw Object.assign(new Error('Command failed'), {
        status: 3,
        stderr: 'not logged in',
        stdout: INSTALLATION_TOKEN,
      });
    });
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /`gh auth token` failed with exit code 3/);
      assert.equal(error.message.includes('not logged in'), false);
      assert.equal(error.message.includes(INSTALLATION_TOKEN), false);
      return true;
    });
  });

  it('refuses an empty answer', async () => {
    const provider = new GhCliTokenProvider(() => '\n');
    await assert.rejects(() => provider.token(), TransientFailure);
  });
});

describe('AppTokenProvider', () => {
  let directory = '';
  let keyPath = '';
  let publicKey = '';

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-app-'));
    keyPath = join(directory, 'app.private-key.pem');
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKey = pair.publicKey;
    writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('is not built when the deployment names no App', () => {
    const board = { owner: 'example-org', ownerType: 'organization' as const };
    assert.equal(AppTokenProvider.fromEnv({}, board), null);
    assert.equal(AppTokenProvider.fromEnv({ GITHUB_APP_ID: '123' }, board), null);
    assert.equal(AppTokenProvider.fromEnv({ GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/key.pem' }, board), null);
    assert.equal(
      AppTokenProvider.fromEnv({ GITHUB_APP_ID: ' ', GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/key.pem' }, board),
      null,
    );
    assert.notEqual(
      AppTokenProvider.fromEnv({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/key.pem' }, board),
      null,
    );
  });

  it('still reads the older variable while it holds what it always should have', () => {
    const board = { owner: 'example-org', ownerType: 'organization' as const };
    assert.notEqual(
      AppTokenProvider.fromEnv({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: '/tmp/key.pem' }, board),
      null,
    );
  });

  it('refuses the key itself by naming the variable, never what is in it', () => {
    const board = { owner: 'example-org', ownerType: 'organization' as const };
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----';

    assert.throws(
      () => AppTokenProvider.fromEnv({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: key }, board),
      (error: unknown) => {
        assert.ok(error instanceof RefusedByRule);
        assert.match(error.describe(), /GITHUB_APP_PRIVATE_KEY_PATH/);
        assert.match(error.describe(), /chmod 600/);
        assert.equal(error.describe().includes('MIIEowIBAAKCAQEAsecret'), false);
        assert.equal(error.describe().includes('BEGIN RSA'), false);
        return true;
      },
    );
  });

  it('signs an assertion the App key can be checked against, then swaps it for a credential', async () => {
    const clock = new FakeClock(new Date('2026-09-16T12:00:00.000Z'));
    const fetcher = new FakeFetch([
      { body: { id: 4242 } },
      { status: 201, body: { token: INSTALLATION_TOKEN, expires_at: '2026-09-16T13:00:00Z' } },
    ]);
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: keyPath,
      owner: 'example-org',
      ownerType: 'organization',
      fetchImpl: fetcher.fetch,
      clock,
    });

    assert.equal(await provider.token(), INSTALLATION_TOKEN);

    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/orgs/example-org/installation');
    assert.equal(fetcher.calls[0]?.method, 'GET');
    assert.equal(fetcher.calls[1]?.url, 'https://api.github.com/app/installations/4242/access_tokens');
    assert.equal(fetcher.calls[1]?.method, 'POST');

    const assertion = (fetcher.calls[0]?.headers['authorization'] ?? '').replace('Bearer ', '');
    const [header = '', claims = '', signature = ''] = assertion.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { alg: 'RS256', typ: 'JWT' });
    const seconds = Math.floor(clock.now().getTime() / 1000);
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')), {
      iat: seconds - 60,
      exp: seconds + 9 * 60,
      iss: '123456',
    });
    // The assertion itself is the second credential in play and must be as hidden as the first.
    assert.equal(fetcher.calls[1]?.headers['authorization'], `Bearer ${assertion}`);
  });

  it('skips the lookup when the installation is already known', async () => {
    const fetcher = new FakeFetch([{ status: 201, body: { token: INSTALLATION_TOKEN } }]);
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: keyPath,
      installationId: '99',
      owner: 'example-org',
      ownerType: 'organization',
      fetchImpl: fetcher.fetch,
      clock: new FakeClock(),
    });
    assert.equal(await provider.token(), INSTALLATION_TOKEN);
    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/app/installations/99/access_tokens');
  });

  it('looks a person-owned installation up in the other place', async () => {
    const fetcher = new FakeFetch([{ body: { id: 7 } }, { status: 201, body: { token: INSTALLATION_TOKEN } }]);
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: keyPath,
      owner: 'example-user',
      ownerType: 'user',
      fetchImpl: fetcher.fetch,
      clock: new FakeClock(),
    });
    await provider.token();
    assert.equal(fetcher.calls[0]?.url, 'https://api.github.com/users/example-user/installation');
  });

  it('names the variable, not the path, when the App key is not where it should be', async () => {
    const fetcher = new FakeFetch([]);
    const secretish = join(directory, 'absent-org-production.pem');
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: secretish,
      owner: 'example-org',
      ownerType: 'organization',
      fetchImpl: fetcher.fetch,
      clock: new FakeClock(),
    });
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /the file named by GITHUB_APP_PRIVATE_KEY_PATH could not be read/);
      assert.equal(error.message.includes(secretish), false, 'the configured value is never repeated');
      return true;
    });
    assert.equal(fetcher.calls.length, 0);
  });

  it('names the step when a call is refused', async () => {
    const fetcher = new FakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: keyPath,
      owner: 'example-org',
      ownerType: 'organization',
      fetchImpl: fetcher.fetch,
      clock: new FakeClock(),
    });
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /looking up the App installation on example-org answered 404/);
      return true;
    });
  });

  it('names the step when an answer cannot be read', async () => {
    const fetcher = new FakeFetch([{ bodyText: 'not json at all' }]);
    const provider = new AppTokenProvider({
      appId: '123456',
      privateKeyPath: keyPath,
      owner: 'example-org',
      ownerType: 'organization',
      fetchImpl: fetcher.fetch,
      clock: new FakeClock(),
    });
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /looking up the App installation on example-org answered something that is not JSON/);
      return true;
    });
  });
});

describe('AccountCredentials', () => {
  const ORGANISATION = { owner: 'example-org', ownerType: 'organization' as const };
  const PERSON = { owner: 'example-user', ownerType: 'user' as const };
  const ORG_TOKEN = 'ghs_oooooooooooooooooooooooooooooooooooo';
  const USER_TOKEN = 'ghs_uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';
  let directory = '';
  let env: Record<string, string> = {};

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-accounts-'));
    const keyPath = join(directory, 'app.private-key.pem');
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });
    env = { GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY_PATH: keyPath };
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('looks each board owner\'s installation up where that kind of account keeps it', async () => {
    const fetcher = new FakeFetch([
      { body: { id: 11 } },
      { status: 201, body: { token: ORG_TOKEN } },
      { body: { id: 22 } },
      { status: 201, body: { token: USER_TOKEN } },
    ]);
    const credentials = new AccountCredentials({
      env,
      boards: [ORGANISATION, PERSON],
      logger: new RecordingLogger(),
      clock: new FakeClock(),
      fallback: () => new RefusingProvider(),
      fetchImpl: fetcher.fetch,
    });

    assert.equal(await credentials.for(ORGANISATION).token(), ORG_TOKEN);
    assert.equal(await credentials.for(PERSON).token(), USER_TOKEN);

    assert.deepEqual(fetcher.calls.map((call) => call.url), [
      'https://api.github.com/orgs/example-org/installation',
      'https://api.github.com/app/installations/11/access_tokens',
      'https://api.github.com/users/example-user/installation',
      'https://api.github.com/app/installations/22/access_tokens',
    ]);
  });

  it('shares one cached credential between two boards of one account', async () => {
    const fetcher = new FakeFetch([{ body: { id: 11 } }, { status: 201, body: { token: ORG_TOKEN } }]);
    const credentials = new AccountCredentials({
      env,
      boards: [ORGANISATION, { owner: 'Example-Org', ownerType: 'organization' }],
      logger: new RecordingLogger(),
      clock: new FakeClock(),
      fallback: () => new RefusingProvider(),
      fetchImpl: fetcher.fetch,
    });

    const first = credentials.for(ORGANISATION);
    assert.equal(credentials.for({ owner: 'Example-Org', ownerType: 'organization' }), first);
    assert.equal(await first.token(), ORG_TOKEN);
    assert.equal(await credentials.for(ORGANISATION).token(), ORG_TOKEN);
    assert.equal(fetcher.calls.length, 2, 'one lookup and one minting for the account');
  });

  it('uses a pinned installation only while every board belongs to one account', async () => {
    const pinned = { ...env, GITHUB_APP_INSTALLATION_ID: '99' };
    const alone = new FakeFetch([{ status: 201, body: { token: ORG_TOKEN } }]);
    await new AccountCredentials({
      env: pinned,
      boards: [ORGANISATION],
      logger: new RecordingLogger(),
      clock: new FakeClock(),
      fallback: () => new RefusingProvider(),
      fetchImpl: alone.fetch,
    }).for(ORGANISATION).token();
    const shared = new FakeFetch([{ body: { id: 22 } }, { status: 201, body: { token: USER_TOKEN } }]);
    await new AccountCredentials({
      env: pinned,
      boards: [ORGANISATION, PERSON],
      logger: new RecordingLogger(),
      clock: new FakeClock(),
      fallback: () => new RefusingProvider(),
      fetchImpl: shared.fetch,
    }).for(PERSON).token();

    assert.deepEqual(alone.calls.map((call) => call.url), ['https://api.github.com/app/installations/99/access_tokens']);
    assert.deepEqual(shared.calls.map((call) => call.url), [
      'https://api.github.com/users/example-user/installation',
      'https://api.github.com/app/installations/22/access_tokens',
    ]);
  });

  it('falls back per account when the deployment names no App, minting nothing until asked', async () => {
    const made: CountingProvider[] = [];
    const credentials = new AccountCredentials({
      env: {},
      boards: [ORGANISATION, PERSON],
      logger: new RecordingLogger(),
      clock: new FakeClock(),
      fallback: () => {
        const provider = new CountingProvider();
        made.push(provider);
        return provider;
      },
    });

    const organisation = credentials.for(ORGANISATION);
    const person = credentials.for(PERSON);

    assert.notEqual(organisation, person);
    assert.equal(made.reduce((sum, provider) => sum + provider.mints, 0), 0);
    assert.equal(await person.token(), 'token-1');
    assert.equal(made.length, 2);
  });
});

describe('CachingTokenProvider', () => {
  it('holds one credential for as long as it is good for', async () => {
    const inner = new CountingProvider();
    const clock = new FakeClock();
    const provider = new CachingTokenProvider(inner, clock, 60);
    assert.equal(await provider.token(), 'token-1');
    clock.advance(59_000);
    assert.equal(await provider.token(), 'token-1');
    assert.equal(inner.mints, 1);
  });

  it('mints another once the credential is too old', async () => {
    const inner = new CountingProvider();
    const clock = new FakeClock();
    const provider = new CachingTokenProvider(inner, clock, 60);
    await provider.token();
    clock.advance(60_000);
    assert.equal(await provider.token(), 'token-2');
    assert.equal(inner.mints, 2);
  });

  it('mints another as soon as the held one has been rejected', async () => {
    const inner = new CountingProvider();
    const provider = new CachingTokenProvider(inner, new FakeClock(), 3600);
    await provider.token();
    provider.invalidate();
    assert.equal(await provider.token(), 'token-2');
    assert.equal(inner.invalidations, 1);
  });

  it('mints once for callers that ask at the same moment', async () => {
    const inner = new CountingProvider();
    const provider = new CachingTokenProvider(inner, new FakeClock(), 3600);
    const both = await Promise.all([provider.token(), provider.token()]);
    assert.deepEqual(both, ['token-1', 'token-1']);
    assert.equal(inner.mints, 1);
  });
});

describe('FallbackTokenProvider', () => {
  it('moves on to the next source when one cannot answer', async () => {
    const second = new CountingProvider();
    const provider = new FallbackTokenProvider([new RefusingProvider(), second]);
    assert.equal(await provider.token(), 'token-1');
    assert.equal(second.mints, 1);
  });

  it('names every way it tried when none of them answers', async () => {
    const provider = new FallbackTokenProvider([new RefusingProvider(), new RefusingProvider()]);
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.equal(error.message.split(';').length, 2);
      assert.match(error.message, /no credential could be obtained/);
      return true;
    });
  });

  it('refuses plainly when nothing at all is configured', async () => {
    const provider = new FallbackTokenProvider([]);
    await assert.rejects(() => provider.token(), (error: unknown) => {
      assert.ok(error instanceof TransientFailure);
      assert.match(error.message, /no credential source is configured/);
      return true;
    });
  });

  it('says once that the source it preferred was passed over', async () => {
    const logger = new RecordingLogger();
    const provider = new FallbackTokenProvider([new RefusingProvider(), new CountingProvider()], logger);

    await provider.token();
    await provider.token();

    const said = logger.lines.filter((line) => line.level === 'warn' && /billed elsewhere/.test(line.message));
    assert.equal(said.length, 1, 'which allowance the work is billed to is worth saying, and worth saying once');
  });

  it('says nothing when the source it preferred answered', async () => {
    const logger = new RecordingLogger();

    await new FallbackTokenProvider([new CountingProvider(), new CountingProvider()], logger).token();

    assert.deepEqual(logger.lines, []);
  });

  it('passes a rejection on to every source it wraps', () => {
    const first = new CountingProvider();
    const second = new CountingProvider();
    new FallbackTokenProvider([first, second]).invalidate();
    assert.equal(first.invalidations, 1);
    assert.equal(second.invalidations, 1);
  });
});
