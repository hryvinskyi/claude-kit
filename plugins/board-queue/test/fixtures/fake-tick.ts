import { writeFileSync } from 'node:fs';

/**
 * Stands in for `board-queue tick` where a test runs a pass as a process of its
 * own. It writes down the variables a scheduled pass is told by, then does what
 * FAKE_TICK_MODE says: `exit:<code>`, `sleep:<ms>` (then a clean exit), `wait`
 * (until a signal ends it — like the real tick, it has no handler for SIGTERM), or
 * `stubborn` (ignores SIGTERM, so only a kill ends it).
 */
const record = process.env['FAKE_TICK_RECORD'];
if (record !== undefined && record !== '') {
  writeFileSync(record, JSON.stringify({
    scheduled: process.env['BOARD_QUEUE_SCHEDULED'] ?? null,
    identity: process.env['BOARD_QUEUE_IDENTITY'] ?? null,
    args: process.argv.slice(2),
  }), 'utf8');
}

const mode = process.env['FAKE_TICK_MODE'] ?? 'exit:0';
const keepAlive = (): void => {
  setInterval(() => undefined, 1_000);
};
if (mode.startsWith('exit:')) {
  process.exitCode = Number(mode.slice('exit:'.length));
} else if (mode.startsWith('sleep:')) {
  setTimeout(() => undefined, Number(mode.slice('sleep:'.length)));
} else if (mode === 'wait') {
  keepAlive();
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => undefined);
  keepAlive();
}
