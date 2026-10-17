import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RealSleeper, SystemClock } from '../../src/infrastructure/system-clock.ts';

describe('the machine\'s own time', () => {
  it('answers the moment it is asked, afresh each time', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const first = clock.now();
    const second = clock.now();

    assert.ok(first.getTime() >= before);
    assert.ok(second.getTime() >= first.getTime());
    assert.notEqual(first, second);
  });

  it('waits at least as long as it was asked to', async () => {
    const started = Date.now();
    await new RealSleeper().sleep(20);

    assert.ok(Date.now() - started >= 15, 'the sleeper came back early');
  });
});
