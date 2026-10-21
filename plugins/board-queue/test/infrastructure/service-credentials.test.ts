import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigSchema } from '../../src/domain/config.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { checkServiceCredentials } from '../../src/infrastructure/service-credentials.ts';
import { writeAppKey } from '../fixtures/app-key.ts';
import { testConfig } from '../fixtures/config.ts';
import { syncConfig } from '../fixtures/sync.ts';

const TOKEN = 'dibs_imp_ssssssssssssssssssssssss';

describe('what the service needs before its first pass', () => {
  let directory = '';
  let keyPath = '';
  let privateKey = '';

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-service-key-'));
    ({ path: keyPath, privateKey } = writeAppKey(directory));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function envWith(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      GITHUB_APP_ID: '123456',
      GITHUB_APP_INSTALLATION_ID: '7890',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      DIBS_TEST_TOKEN: TOKEN,
      ...overrides,
    };
  }

  function refusal(env: Record<string, string | undefined>, config = syncConfig): string {
    try {
      checkServiceCredentials(env, config);
    } catch (error) {
      assert.ok(error instanceof RefusedByRule, String(error));
      return error.describe();
    }
    assert.fail('the service was allowed to start');
  }

  it('starts with the App\'s id, an owner-only key and the server\'s token, and says what it runs as', () => {
    assert.deepEqual(checkServiceCredentials(envWith(), syncConfig), {
      appId: '123456',
      installationId: '7890',
      keyMode: '0400',
    });
    assert.equal(checkServiceCredentials(envWith({ GITHUB_APP_INSTALLATION_ID: '' }), syncConfig).installationId, null);
  });

  it('refuses without the App\'s id or the path to its key', () => {
    assert.match(refusal(envWith({ GITHUB_APP_ID: undefined })), /set GITHUB_APP_ID/);
    assert.match(refusal(envWith({ GITHUB_APP_ID: 'my-app' })), /numeric id/);
    assert.match(refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: '' })), /set GITHUB_APP_PRIVATE_KEY_PATH/);
    assert.match(refusal(envWith({ GITHUB_APP_INSTALLATION_ID: 'abc' })), /GITHUB_APP_INSTALLATION_ID is not a number/);
  });

  it('refuses a key that is missing, shared, unreadable or not a key, and never quotes what it holds', () => {
    const shared = join(directory, 'shared.pem');
    writeFileSync(shared, privateKey, { mode: 0o644 });
    chmodSync(shared, 0o644);
    const notAKey = join(directory, 'not-a-key.pem');
    writeFileSync(notAKey, 'hello\n', { mode: 0o600 });
    const unreadable = join(directory, 'unreadable.pem');
    writeFileSync(unreadable, privateKey, { mode: 0o600 });
    chmodSync(unreadable, 0o000);

    const missing = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: join(directory, 'absent.pem') }));
    const tooOpen = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: shared }));
    const garbage = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: notAKey }));
    const locked = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: unreadable }));
    const inline = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: privateKey }));
    const directoryNotFile = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: directory }));
    const someoneElses = join(directory, 'someone-elses.pem');
    symlinkSync('/etc/hosts', someoneElses);
    const notOurs = refusal(envWith({ GITHUB_APP_PRIVATE_KEY_PATH: someoneElses }));

    assert.match(missing, /is not there/);
    assert.match(tooOpen, /mode 644; make it 0400 or 0600/);
    assert.match(garbage, /does not hold a private key/);
    assert.match(locked, /this account cannot read it/);
    assert.match(inline, /holds a key rather than the path to one/);
    assert.match(directoryNotFile, /is not a file/);
    assert.match(notOurs, /belongs to another account/);
    for (const said of [missing, tooOpen, garbage, locked, inline, directoryNotFile, notOurs]) {
      assert.equal(said.includes(directory), false, `the configured path is never repeated: ${said}`);
      assert.equal(said.includes('PRIVATE KEY'), false, said);
      assert.equal(said.includes(privateKey.split('\n')[1] ?? 'none'), false, said);
    }
  });

  it('refuses a configuration that keeps nothing in step, and one whose server token is missing', () => {
    assert.match(refusal(envWith(), testConfig), /keeps nothing in step/);
    const allOff = ConfigSchema.parse({
      ...testConfig,
      dibs: { ...syncConfig.dibs, mirror: undefined, importer: { enabled: false } },
    });
    assert.match(refusal(envWith(), allOff), /keeps nothing in step/);
    const missingToken = refusal(envWith({ DIBS_TEST_TOKEN: ' ' }));
    assert.match(missingToken, /DIBS_TEST_TOKEN holds no token/);
  });

  it('takes the server\'s token from a file of the service\'s own, and refuses one anyone else may read', () => {
    const owned = join(directory, 'importer.token');
    writeFileSync(owned, `${TOKEN}\n`, { mode: 0o400 });
    chmodSync(owned, 0o400);
    const shared = join(directory, 'shared.token');
    writeFileSync(shared, `${TOKEN}\n`, { mode: 0o644 });
    chmodSync(shared, 0o644);

    assert.equal(
      checkServiceCredentials(envWith({ DIBS_TEST_TOKEN: undefined, DIBS_TEST_TOKEN_FILE: owned }), syncConfig).appId,
      '123456',
    );
    const tooOpen = refusal(envWith({ DIBS_TEST_TOKEN: undefined, DIBS_TEST_TOKEN_FILE: shared }));
    const both = refusal(envWith({ DIBS_TEST_TOKEN_FILE: owned }));

    assert.match(tooOpen, /DIBS_TEST_TOKEN_FILE is mode 644/);
    assert.equal(tooOpen.includes(TOKEN), false);
    assert.match(both, /both DIBS_TEST_TOKEN and DIBS_TEST_TOKEN_FILE are set/);
  });
});
