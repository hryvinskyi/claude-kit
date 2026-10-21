import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { passEnvironment } from '../../src/delivery/service-runtime.ts';
import { ChildTickPass } from '../../src/infrastructure/child-tick-pass.ts';
import type { PassProcess } from '../../src/infrastructure/child-tick-pass.ts';

const FAKE_TICK = join(import.meta.dirname, '..', 'fixtures', 'fake-tick.ts');
const scratch = mkdtempSync(join(tmpdir(), 'board-queue-child-pass-'));

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function passWith(mode: string, record = '', killGraceMs = 2_000): ChildTickPass {
  return new ChildTickPass({
    command: process.execPath,
    args: [FAKE_TICK, 'tick'],
    env: passEnvironment({ ...process.env, FAKE_TICK_MODE: mode, FAKE_TICK_RECORD: record }),
    killGraceMs,
  });
}

describe('a pass as a process of its own', () => {
  it('runs as a scheduled pass judged by the App\'s login, and answers its exit code', async () => {
    const record = join(scratch, 'scheduled.json');

    const outcome = await passWith('exit:0', record).run(new AbortController().signal);

    assert.deepEqual(outcome, { kind: 'finished', exitCode: 0 });
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { scheduled: '1', identity: 'app', args: ['tick'] });
  });

  it('answers a refusal\'s exit code as it is', async () => {
    assert.deepEqual(await passWith('exit:1').run(new AbortController().signal), { kind: 'finished', exitCode: 1 });
  });

  it('ends an abandoned pass where it stands, and answers why it was abandoned', async () => {
    const abandon = new AbortController();
    const running = passWith('wait').run(abandon.signal);
    await delay(300);

    abandon.abort('it ran past its deadline of 1200 s');

    assert.deepEqual(await running, { kind: 'abandoned', reason: 'it ran past its deadline of 1200 s' });
  });

  it('kills a pass that does not stop when asked, once the grace is over', async () => {
    const abandon = new AbortController();
    const running = passWith('stubborn', '', 100).run(abandon.signal);
    await delay(300);
    const asked = performance.now();

    abandon.abort('the service was told to stop and the pass did not finish in time');
    const outcome = await running;

    assert.equal(outcome.kind, 'abandoned');
    assert.ok(performance.now() - asked >= 90, 'it was given the grace first');
  });

  it('answers a pass that could not be started', async () => {
    const missing = new ChildTickPass({ command: join(scratch, 'no-such-node'), args: [], env: {} });

    const outcome = await missing.run(new AbortController().signal);

    assert.equal(outcome.kind, 'unstarted');
  });

  it('answers a pass that is still there once killed as stuck', async () => {
    const signals: string[] = [];
    const undying: PassProcess = {
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
      once: () => undying,
    };
    const pass = new ChildTickPass({
      command: 'unused',
      args: [],
      env: {},
      killGraceMs: 20,
      reapGraceMs: 20,
      spawnImpl: () => undying,
    });
    const abandon = new AbortController();
    const running = pass.run(abandon.signal);

    abandon.abort('it ran past its deadline of 1200 s');

    assert.deepEqual(await running, {
      kind: 'stuck',
      reason: 'it ran past its deadline of 1200 s, and it did not end once killed',
    });
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});
