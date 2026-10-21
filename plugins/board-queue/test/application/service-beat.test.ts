import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstBeat, healthOf, passEnded, passStarted, stopped } from '../../src/application/service-beat.ts';
import type { ServiceBeat } from '../../src/application/service-beat.ts';

const START = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

function fresh(): ServiceBeat {
  return firstBeat({ pid: 7, at: START, intervalMs: 5 * MINUTE, passDeadlineMs: 20 * MINUTE });
}

describe('what a pass leaves in the heartbeat', () => {
  it('records a clean pass and clears the run of failures', () => {
    const failed = passEnded(fresh(), { kind: 'finished', exitCode: 1 }, at(1), false);
    const clean = passEnded(passStarted(failed, at(5)), { kind: 'finished', exitCode: 0 }, at(6), false);

    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.detail, 'the pass exited 1');
    assert.equal(failed.consecutiveFailures, 1);
    assert.equal(clean.outcome, 'ok');
    assert.equal(clean.detail, null);
    assert.equal(clean.consecutiveFailures, 0);
    assert.equal(clean.passes, 2);
    assert.equal(clean.passStartedAt, at(5).toISOString());
    assert.equal(clean.passEndedAt, at(6).toISOString());
  });

  it('counts a pass killed from outside, one that never started and one given up at its deadline as failures', () => {
    let beat = fresh();
    beat = passEnded(beat, { kind: 'killed', signal: 'SIGKILL' }, at(1), false);
    beat = passEnded(beat, { kind: 'unstarted', reason: 'spawn node ENOENT' }, at(2), false);
    beat = passEnded(beat, { kind: 'abandoned', reason: 'it ran past its deadline of 1200 s' }, at(3), false);

    assert.equal(beat.consecutiveFailures, 3);
    assert.equal(beat.outcome, 'abandoned');
    assert.equal(beat.detail, 'it ran past its deadline of 1200 s');
  });

  it('does not count a pass abandoned because the service was told to stop', () => {
    const beat = passEnded(fresh(), { kind: 'abandoned', reason: 'told to stop' }, at(1), true);

    assert.equal(beat.outcome, 'abandoned');
    assert.equal(beat.consecutiveFailures, 0);
  });
});

describe('whether the service is healthy', () => {
  it('is not when it has written nothing, or when it stopped', () => {
    assert.equal(healthOf(null, START).healthy, false);
    assert.match(healthOf(stopped(fresh(), at(1)), at(1)).reason, /stopped at/);
  });

  it('is while its first pass runs, for as long as a pass may take and the gap after it', () => {
    const running = passStarted(fresh(), START);

    assert.equal(healthOf(running, at(25)).healthy, true);
    assert.equal(healthOf(running, at(27)).healthy, false);
    assert.match(healthOf(running, at(27)).reason, /nothing has happened since 2026-03-02T09:00:00.000Z/);
  });

  it('is after a recent pass, and stops being once the passes stop coming', () => {
    const passed = passEnded(passStarted(fresh(), at(10)), { kind: 'finished', exitCode: 0 }, at(11), false);

    assert.deepEqual(healthOf(passed, at(12)), {
      healthy: true,
      reason: '1 passes; the last ended ok at 2026-03-02T09:11:00.000Z',
    });
    assert.equal(healthOf(passed, at(11 + 27)).healthy, false);
  });

  it('is not once three passes in a row failed, and says why the last one did', () => {
    const failing = (beat: ServiceBeat, pass: number): ServiceBeat =>
      passEnded(passStarted(beat, at(pass * 5)), { kind: 'finished', exitCode: 1 }, at(pass * 5 + 1), false);
    const twice = failing(failing(fresh(), 1), 2);
    const thrice = failing(twice, 3);

    assert.equal(healthOf(twice, at(12)).healthy, true);
    assert.deepEqual(healthOf(thrice, at(17)), {
      healthy: false,
      reason: 'the last 3 passes failed; the last: the pass exited 1',
    });
  });

  it('is not as soon as a pass declined the service\'s job, and says which way, holding nothing secret', () => {
    const declined = passEnded(passStarted(fresh(), at(5)), { kind: 'finished', exitCode: 4 }, at(6), false);

    assert.equal(declined.outcome, 'declined');
    assert.equal(declined.consecutiveFailures, 1);
    assert.deepEqual(healthOf(declined, at(7)), {
      healthy: false,
      reason: 'the last pass declined the service\'s job: the GitHub App is not the configured owner',
    });
    const recovered = passEnded(passStarted(declined, at(10)), { kind: 'finished', exitCode: 0 }, at(11), false);
    assert.equal(healthOf(recovered, at(12)).healthy, true);
  });

  it('counts a pass that could not be ended as abandoned', () => {
    const stuck = passEnded(fresh(), { kind: 'stuck', reason: 'it did not end once killed' }, at(1), false);

    assert.equal(stuck.outcome, 'abandoned');
    assert.equal(stuck.consecutiveFailures, 1);
  });
});
