import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { LocalProcessTable } from '../../src/infrastructure/process-table.ts';

const TABLE = pathToFileURL(path.join(import.meta.dirname, '..', '..', 'src', 'infrastructure', 'process-table.ts')).href;

/** When this test's own process started, as a reader running in the given language and time zone sees it. */
function startSeenUnder(environment: Record<string, string>): string {
  const ran = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    'const { LocalProcessTable } = await import(process.argv[1]);'
      + 'process.stdout.write(JSON.stringify(new LocalProcessTable().startOf(Number(process.argv[2]))));',
    TABLE,
    String(process.pid),
  ], { encoding: 'utf8', env: { ...process.env, ...environment } });
  assert.equal(ran.status, 0, `the reader failed: ${ran.stderr}`);
  const seen: unknown = JSON.parse(ran.stdout);
  assert.equal(typeof seen, 'string', 'a live process has a start');
  return String(seen);
}

describe('the start of a process', () => {
  it('reads the same in every language and time zone a reader runs in', () => {
    const plain = startSeenUnder({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
    const ukrainian = startSeenUnder({ LANG: 'uk_UA.UTF-8', LC_ALL: 'uk_UA.UTF-8', TZ: 'Europe/Kyiv' });
    const japanese = startSeenUnder({ LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', TZ: 'Asia/Tokyo' });
    const unset = startSeenUnder({ LANG: '', LC_ALL: '', LC_TIME: 'de_DE.UTF-8', TZ: 'America/New_York' });

    assert.equal(ukrainian, plain);
    assert.equal(japanese, plain);
    assert.equal(unset, plain);
    assert.equal(new LocalProcessTable().startOf(process.pid), plain, 'this process reads itself the same way');
  });

  it('is not there for a process that is not', () => {
    assert.equal(new LocalProcessTable().startOf(0), null);
    assert.equal(new LocalProcessTable().startOf(2 ** 22 + 7), null);
  });
});
