import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { firstBeat } from '../../src/application/service-beat.ts';
import { FileBeatStore } from '../../src/infrastructure/file-beat-store.ts';

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-beat-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const BEAT = firstBeat({ pid: 9, at: new Date('2026-03-02T09:00:00.000Z'), intervalMs: 300_000, passDeadlineMs: 1_200_000 });

describe('the service\'s heartbeat file', () => {
  it('reads back the last beat written, owner-only, with nothing left beside it', (t) => {
    const directory = scratch(t);
    const store = new FileBeatStore(join(directory, 'service.json'));

    store.write(BEAT);
    store.write({ ...BEAT, passes: 1 });

    assert.deepEqual(store.read(), { ...BEAT, passes: 1 });
    assert.equal(statSync(join(directory, 'service.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory), ['service.json']);
  });

  it('reads as none when there is no file, or when the file is not a beat', (t) => {
    const directory = scratch(t);
    const file = join(directory, 'service.json');
    const store = new FileBeatStore(file);

    assert.equal(store.read(), null);
    writeFileSync(file, 'not json', 'utf8');
    assert.equal(store.read(), null);
    writeFileSync(file, JSON.stringify({ ...BEAT, passes: -1 }), 'utf8');
    assert.equal(store.read(), null);
  });
});
