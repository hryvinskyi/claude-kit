import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { readOwnerOnlyFile } from '../../src/infrastructure/owner-only-file.ts';

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-owner-only-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function secret(directory: string, name: string, mode: number, text = 'the-secret-value\n'): string {
  const file = join(directory, name);
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, mode);
  return file;
}

function refusal(path: string): string {
  try {
    readOwnerOnlyFile(path, 'the file named by SOME_FILE');
  } catch (error) {
    assert.ok(error instanceof RefusedByRule, String(error));
    return error.describe();
  }
  assert.fail('the file was read');
}

describe('a file that holds a secret', () => {
  it('is read when it is this account\'s own, 0400 or 0600', (t) => {
    const directory = scratch(t);

    assert.deepEqual(readOwnerOnlyFile(secret(directory, 'a', 0o400), 'x'), { text: 'the-secret-value\n', mode: '0400' });
    assert.deepEqual(readOwnerOnlyFile(secret(directory, 'b', 0o600), 'x'), { text: 'the-secret-value\n', mode: '0600' });
  });

  it('is refused when anyone else may read it, when it is not a file, or not there — naming it, never its path or text', (t) => {
    const directory = scratch(t);
    const said = [
      refusal(secret(directory, 'group', 0o640)),
      refusal(secret(directory, 'executable', 0o700)),
      refusal(directory),
      refusal(join(directory, 'absent')),
    ];

    assert.match(said[0] ?? '', /mode 640; make it 0400 or 0600/);
    assert.match(said[1] ?? '', /mode 700/);
    assert.match(said[2] ?? '', /is not a file/);
    assert.match(said[3] ?? '', /is not there, or this account cannot read it/);
    for (const sentence of said) {
      assert.match(sentence, /^the file named by SOME_FILE /);
      assert.equal(sentence.includes(directory), false, sentence);
      assert.equal(sentence.includes('the-secret-value'), false, sentence);
    }
  });

  it('is refused when it belongs to another account, judged on what was opened, a link followed', (t) => {
    const directory = scratch(t);
    // A file this test cannot own: the system's own, reached through a link in the test's directory.
    const link = join(directory, 'linked');
    symlinkSync('/etc/hosts', link);

    assert.match(refusal(link), /belongs to another account/);
  });
});
