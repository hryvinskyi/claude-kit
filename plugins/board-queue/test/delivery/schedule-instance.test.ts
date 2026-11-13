import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleInstance } from '../../src/delivery/schedule-instance.ts';
import type { ScheduleLocations } from '../../src/delivery/schedule-instance.ts';

const DEFAULTS: ScheduleLocations = {
  configPath: '/home/acme/.config/board-queue/config.json',
  stateDir: '/home/acme/.claude/state/board-queue',
};

describe('the name that sets one install\'s scheduled job apart from another\'s', () => {
  it('is none for the default locations, so the job keeps the name an earlier install gave it', () => {
    assert.equal(scheduleInstance({ ...DEFAULTS }, DEFAULTS), null);
  });

  it('is the same for the same locations, so installing again replaces the job', () => {
    const elsewhere = { configPath: '/home/acme/boards/second.json', stateDir: DEFAULTS.stateDir };

    assert.equal(scheduleInstance(elsewhere, DEFAULTS), scheduleInstance({ ...elsewhere }, DEFAULTS));
  });

  it('differs between installs that read another configuration or keep another queue', () => {
    const names = [
      scheduleInstance({ configPath: '/home/acme/boards/second.json', stateDir: DEFAULTS.stateDir }, DEFAULTS),
      scheduleInstance({ configPath: '/home/acme/boards/third.json', stateDir: DEFAULTS.stateDir }, DEFAULTS),
      scheduleInstance({ configPath: DEFAULTS.configPath, stateDir: '/home/acme/state/second' }, DEFAULTS),
    ];

    assert.equal(new Set(names).size, names.length);
    for (const name of names) {
      assert.ok(name !== null);
      assert.match(name, /^[0-9a-f]{12}$/, 'a launchd label and a systemd unit name both take it as it is');
    }
  });
});
