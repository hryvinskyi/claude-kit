import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { auditPath, dbPath, logPath, stateDir } from '../../src/infrastructure/paths.ts';

const STATE_DIR_VAR = 'BOARD_QUEUE_STATE_DIR';

describe('where the queue keeps what it knows', () => {
  let directory = '';
  let previous: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-paths-'));
    previous = process.env[STATE_DIR_VAR];
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[STATE_DIR_VAR];
    } else {
      process.env[STATE_DIR_VAR] = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('makes a directory nobody else on the machine can read', () => {
    const wanted = join(directory, 'state');
    process.env[STATE_DIR_VAR] = wanted;

    assert.equal(stateDir(), wanted);
    assert.equal(statSync(wanted).mode & 0o777, 0o700);
  });

  it('narrows one that was made before this rule existed', () => {
    const wanted = join(directory, 'older');
    mkdirSync(wanted);
    chmodSync(wanted, 0o755);
    process.env[STATE_DIR_VAR] = wanted;

    stateDir();

    assert.equal(statSync(wanted).mode & 0o777, 0o700);
  });

  it('keeps the queue, the log and the report in that one place', () => {
    assert.equal(dbPath(directory), join(directory, 'queue.db'));
    assert.equal(logPath(directory), join(directory, 'worker.log'));
    assert.equal(auditPath(directory), join(directory, 'audit.json'));
  });
});
