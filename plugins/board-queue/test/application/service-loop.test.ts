import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { PassOutcome, ServiceBeat } from '../../src/application/service-beat.ts';
import { ServiceLoop } from '../../src/application/service-loop.ts';
import type { BeatStore, PassRunner, ServiceSchedule } from '../../src/application/service-loop.ts';
import { AbortableWaiter } from '../../src/infrastructure/abortable-waiter.ts';
import { SystemClock } from '../../src/infrastructure/system-clock.ts';

type Behaviour = (abandon: AbortSignal, pass: number) => Promise<PassOutcome>;

const OK: PassOutcome = { kind: 'finished', exitCode: 0 };

/** Plays one behaviour per pass, the last one for every pass after it, and watches for overlap. */
class ScriptedPasses implements PassRunner {
  readonly startedAt: number[] = [];
  readonly abandonReasons: unknown[] = [];
  running = 0;
  mostAtOnce = 0;
  readonly #script: Behaviour[];

  constructor(...script: Behaviour[]) {
    this.#script = script;
  }

  async run(abandon: AbortSignal): Promise<PassOutcome> {
    const pass = this.startedAt.length;
    this.startedAt.push(performance.now());
    this.running += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.running);
    abandon.addEventListener('abort', () => {
      this.abandonReasons.push(abandon.reason);
    }, { once: true });
    try {
      const behaviour = this.#script[Math.min(pass, this.#script.length - 1)];
      if (behaviour === undefined) {
        throw new Error('no behaviour scripted');
      }
      return await behaviour(abandon, pass);
    } finally {
      this.running -= 1;
    }
  }
}

class RecordedBeats implements BeatStore {
  readonly beats: ServiceBeat[] = [];

  write(beat: ServiceBeat): void {
    this.beats.push(beat);
  }

  get last(): ServiceBeat | undefined {
    return this.beats.at(-1);
  }
}

/** Resolves the moment the signal aborts, with the outcome a pass that was asked to stop answers. */
function untilAbandoned(abandon: AbortSignal): Promise<PassOutcome> {
  return new Promise((resolve) => {
    abandon.addEventListener('abort', () => {
      resolve({ kind: 'abandoned', reason: String(abandon.reason) });
    }, { once: true });
  });
}

function loopOf(pass: PassRunner, schedule: Partial<ServiceSchedule> = {}) {
  const beats = new RecordedBeats();
  const lines: string[] = [];
  const loop = new ServiceLoop({
    pass,
    beats,
    waiter: new AbortableWaiter(),
    clock: new SystemClock(),
    log: { line: (text) => lines.push(text) },
    schedule: { intervalMs: 30, passDeadlineMs: 5_000, shutdownGraceMs: 2_000, ...schedule },
    pid: 4242,
  });
  return { loop, beats, lines };
}

describe('the service\'s schedule', () => {
  it('runs a pass at start and then one per interval, timed from the start of the last, never two at once', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(async (_abandon, pass) => {
      if (pass === 2) {
        stop.abort('SIGTERM');
      }
      return OK;
    });
    const { loop, beats, lines } = loopOf(passes, { intervalMs: 40 });

    const { beat: last } = await loop.run(stop.signal);

    assert.equal(passes.startedAt.length, 3);
    assert.equal(passes.mostAtOnce, 1);
    const [first = 0, second = 0, third = 0] = passes.startedAt;
    assert.ok(second - first >= 38, `the second pass started ${String(second - first)} ms after the first`);
    assert.ok(third - second >= 38, `the third pass started ${String(third - second)} ms after the second`);
    assert.equal(last.passes, 3);
    assert.equal(last.outcome, 'ok');
    assert.notEqual(last.stoppedAt, null);
    assert.equal(beats.beats[0]?.passes, 0);
    assert.equal(beats.beats[0]?.pid, 4242);
    assert.equal(beats.beats[0]?.intervalMs, 40);
    assert.deepEqual(beats.last, last);
    assert.equal(lines.at(-1), 'stopped');
    assert.match(lines[0] ?? '', /^pass 1 ended ok after \d+\.\d s$/);
  });

  it('starts the next pass at once, and alone, when one runs past its slot', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(
      async () => {
        await delay(60);
        return OK;
      },
      async () => {
        stop.abort('SIGTERM');
        return OK;
      },
    );
    const { loop } = loopOf(passes, { intervalMs: 20 });

    await loop.run(stop.signal);

    const [first = 0, second = 0] = passes.startedAt;
    assert.equal(passes.mostAtOnce, 1);
    assert.ok(second - first >= 58, 'the second pass waited for the first');
    assert.ok(second - first < 1_000, 'and did not wait out a further interval');
  });

  it('stops at once when told to while it waits for the next pass', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(async () => OK);
    const { loop } = loopOf(passes, { intervalMs: 60_000 });

    const running = loop.run(stop.signal);
    await delay(20);
    const asked = performance.now();
    stop.abort('SIGTERM');
    const { beat: last } = await running;

    assert.ok(performance.now() - asked < 1_000);
    assert.equal(passes.startedAt.length, 1);
    assert.notEqual(last.stoppedAt, null);
  });

  it('lets a running pass finish when it does so within the grace, and abandons nothing', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(async () => {
      stop.abort('SIGTERM');
      await delay(40);
      return OK;
    });
    const { loop } = loopOf(passes, { shutdownGraceMs: 2_000 });

    const { beat: last } = await loop.run(stop.signal);

    assert.deepEqual(passes.abandonReasons, []);
    assert.equal(last.outcome, 'ok');
    assert.equal(last.passes, 1);
  });

  it('abandons a running pass that outlives the grace, and does not count it as a failure', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(async (abandon) => {
      stop.abort('SIGTERM');
      return untilAbandoned(abandon);
    });
    const { loop } = loopOf(passes, { shutdownGraceMs: 30 });

    const { beat: last } = await loop.run(stop.signal);

    assert.deepEqual(passes.abandonReasons, ['the service was told to stop and the pass did not finish in time']);
    assert.equal(last.outcome, 'abandoned');
    assert.equal(last.consecutiveFailures, 0);
  });

  it('abandons a pass at its deadline, counts it, and goes on with the next', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(
      async (abandon) => untilAbandoned(abandon),
      async () => {
        stop.abort('SIGTERM');
        return OK;
      },
    );
    const { loop, beats } = loopOf(passes, { passDeadlineMs: 40, intervalMs: 10 });

    const { beat: last } = await loop.run(stop.signal);

    assert.deepEqual(passes.abandonReasons, ['it ran past its deadline of 0 s']);
    const afterFirst = beats.beats.find((beat) => beat.passes === 1);
    assert.equal(afterFirst?.outcome, 'abandoned');
    assert.equal(afterFirst?.consecutiveFailures, 1);
    assert.equal(last.passes, 2);
    assert.equal(last.outcome, 'ok');
    assert.equal(last.consecutiveFailures, 0);
  });

  it('records a pass that failed to report how it ended, and keeps its schedule', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(
      async () => {
        throw new Error('the pass could not be spawned');
      },
      async () => {
        stop.abort('SIGTERM');
        return OK;
      },
    );
    const { loop, beats } = loopOf(passes, { intervalMs: 10 });

    await loop.run(stop.signal);

    const afterFirst = beats.beats.find((beat) => beat.passes === 1);
    assert.equal(afterFirst?.outcome, 'failed');
    assert.equal(afterFirst?.detail, 'the pass could not be started: the pass could not be spawned');
    assert.equal(passes.startedAt.length, 2);
  });

  it('runs no pass at all when told to stop before it starts', async () => {
    const stop = new AbortController();
    stop.abort('SIGTERM');
    const passes = new ScriptedPasses(async () => OK);
    const { loop } = loopOf(passes);

    const { beat: last } = await loop.run(stop.signal);

    assert.equal(passes.startedAt.length, 0);
    assert.equal(last.passes, 0);
    assert.notEqual(last.stoppedAt, null);
  });

  it('stops the schedule, to be started afresh, when a pass cannot be ended', async () => {
    const stop = new AbortController();
    const passes = new ScriptedPasses(async () => ({ kind: 'stuck', reason: 'it ran past its deadline, and it did not end once killed' }));
    const { loop, lines } = loopOf(passes);

    const ended = await loop.run(stop.signal);

    assert.equal(ended.mustRestart, true);
    assert.equal(passes.startedAt.length, 1);
    assert.equal(ended.beat.outcome, 'abandoned');
    assert.equal(ended.beat.consecutiveFailures, 1);
    assert.notEqual(ended.beat.stoppedAt, null);
    assert.equal(lines.at(-1), 'stopped: a pass could not be ended, so this service must be started afresh');
  });

  it('ends normally when told to stop', async () => {
    const stop = new AbortController();
    stop.abort('SIGTERM');

    assert.equal((await loopOf(new ScriptedPasses(async () => OK)).loop.run(stop.signal)).mustRestart, false);
  });
});
