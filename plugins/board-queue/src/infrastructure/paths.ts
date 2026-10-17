import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Lets a test — or a second installation — put the state somewhere else. */
const STATE_DIR_VAR = 'BOARD_QUEUE_STATE_DIR';

/** Nobody but the owner: the queue, the log and the report all quote private work. */
const OWNER_ONLY_DIR = 0o700;

/**
 * Where everything this system keeps between runs lives: the queue itself, the
 * worker's log and the last audit report.
 *
 * It sits outside the tracked tree on purpose — it is machine state, not source —
 * and it is created on demand, so a fresh checkout works without a setup step.
 * It is the owner's alone: what is kept here is the text of every comment this
 * system is about to post, the errors the API answered with, and a database any
 * process on the machine could otherwise read.
 */
export function stateDir(): string {
  const configured = process.env[STATE_DIR_VAR]?.trim();
  const dir = configured === undefined || configured === ''
    ? path.join(os.homedir(), '.claude', 'state', 'board-queue')
    : configured;
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  // A directory that already existed keeps the mode it was created with, and the
  // one this system made before this rule existed was the umask's. Narrowing it
  // is best effort: a directory somebody else owns is not ours to change, and
  // refusing to run over it would help nobody.
  try {
    fs.chmodSync(dir, OWNER_ONLY_DIR);
  } catch {
    // Left as it is; the files inside still ask for owner-only permissions.
  }
  return dir;
}

/**
 * The three files that live in it. Each takes the directory rather than looking
 * it up, so a caller that already resolved one state directory — the composition
 * root, a test on a temporary directory — keeps everything in that one place.
 */
export function dbPath(dir: string = stateDir()): string {
  return path.join(dir, 'queue.db');
}

export function logPath(dir: string = stateDir()): string {
  return path.join(dir, 'worker.log');
}

export function auditPath(dir: string = stateDir()): string {
  return path.join(dir, 'audit.json');
}
