import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkerReport } from '../../src/application/run-tick.ts';
import { DECLINES, declineOf, declineOfExitCode } from '../../src/application/service-duty.ts';
import type { Decline } from '../../src/application/service-duty.ts';

const QUIET: WorkerReport = {
  executed: 0,
  done: 0,
  blocked: 0,
  failed: 0,
  notApplied: 0,
  requeued: 0,
  unblocked: 0,
  recovered: 0,
  stale: 0,
};

describe('a pass that declines the service\'s job', () => {
  it('is read from why the worker declined, and from a forge pass that would not run', () => {
    assert.equal(declineOf(QUIET), null);
    assert.equal(declineOf({ ...QUIET, sync: {} }), null);
    assert.equal(declineOf({ ...QUIET, sync: { refused: 'x', refusal: 'not-the-owner' } }), 'not-the-owner');
    assert.equal(declineOf({ ...QUIET, sync: { refused: 'x', refusal: 'identity-unreadable' } }), 'identity-unreadable');
    assert.equal(declineOf({ ...QUIET, sync: { forge: { skipped: 'only under an App', declined: true } } }), 'forge-declined');
    assert.equal(declineOf({ ...QUIET, sync: { forge: { skipped: 'another tick holds the lock' } } }), null);
  });

  it('has an exit code of its own for each way, none of them a code the command line already answers', () => {
    const codes = Object.values(DECLINES).map((meaning) => meaning.exitCode);

    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
      assert.ok(![0, 1, 2].includes(code), String(code));
    }
    for (const decline of Object.keys(DECLINES) as Decline[]) {
      assert.equal(declineOfExitCode(DECLINES[decline].exitCode), decline);
    }
    assert.equal(declineOfExitCode(1), null);
  });
});
