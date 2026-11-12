import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { readAppPrivateKey } from '../../src/infrastructure/app-private-key.ts';
import { UnsafeSecretFile } from '../../src/infrastructure/owner-only-file.ts';

const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-app-key-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function written(directory: string, name: string, mode: number, text = PRIVATE_KEY): string {
  const file = join(directory, name);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, mode);
  return file;
}

function refusalOf(path: string): RefusedByRule {
  try {
    readAppPrivateKey(path);
  } catch (error) {
    assert.ok(error instanceof RefusedByRule, String(error));
    return error;
  }
  assert.fail('the key was read');
}

describe('the GitHub App\'s private key', () => {
  it('is read from a file of this account\'s own that nobody else may read', (t) => {
    const directory = scratch(t);

    const key = readAppPrivateKey(written(directory, 'key.pem', 0o600));

    assert.equal(key.key.type, 'private');
    assert.equal(key.mode, '0600');
    assert.equal(readAppPrivateKey(written(directory, 'locked.pem', 0o400)).mode, '0400');
  });

  it('is refused as unsafe when its group or everybody may read it, with the command that fixes it', (t) => {
    const directory = scratch(t);
    const path = written(directory, 'shared.pem', 0o644);

    const refusal = refusalOf(path);

    assert.ok(refusal instanceof UnsafeSecretFile);
    assert.match(refusal.describe(), /^the file named by GITHUB_APP_PRIVATE_KEY_PATH is mode 644/);
    assert.match(refusal.describe(), /chmod 600/);
    assert.equal(refusal.describe().includes(path), false, 'the path is never repeated');
    assert.equal(refusal.describe().includes('PRIVATE KEY'), false, 'nor anything the file holds');
  });

  it('is refused as unsafe when another account owns it, with the command that fixes it', (t) => {
    const directory = scratch(t);
    // A file this test cannot own: the system's own, reached through a link in the test's directory.
    const link = join(directory, 'linked.pem');
    symlinkSync('/etc/hosts', link);

    const refusal = refusalOf(link);

    assert.ok(refusal instanceof UnsafeSecretFile);
    assert.match(refusal.describe(), /belongs to another account/);
    assert.match(refusal.describe(), /chown it to this account/);
    assert.match(refusal.describe(), /chmod 600/);
  });

  it('is refused, but not as unsafe, when it is missing or holds no key', (t) => {
    const directory = scratch(t);

    const missing = refusalOf(join(directory, 'absent.pem'));
    const garbage = refusalOf(written(directory, 'garbage.pem', 0o600, 'not a key at all\n'));

    assert.equal(missing instanceof UnsafeSecretFile, false);
    assert.match(missing.describe(), /is not there, or this account cannot read it/);
    assert.equal(garbage instanceof UnsafeSecretFile, false);
    assert.match(garbage.describe(), /does not hold a private key/);
  });
});
