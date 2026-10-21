import { join } from 'node:path';
import { runService, stopOnSignals } from '../../src/delivery/service-runtime.ts';
import { loadConfig } from '../../src/infrastructure/config-file.ts';
import { stateDir } from '../../src/infrastructure/paths.ts';
import { ChildTickPass } from '../../src/infrastructure/child-tick-pass.ts';
import { passEnvironment } from '../../src/delivery/service-runtime.ts';

/**
 * The service as `board-queue service` runs it — the same start checks, the same
 * schedule, real signals — with each pass a stand-in tick, so a test can stop a
 * real process mid-pass without a pass reaching the network.
 */
const graceMs = Number(process.env['FIXTURE_GRACE_MS'] ?? '2000');
await runService({
  env: process.env,
  config: loadConfig(),
  stateDir: stateDir(),
  cliEntry: 'unused',
  nodePath: process.execPath,
  log: {
    line: (text) => {
      process.stdout.write(`${text}\n`);
    },
  },
  stop: stopOnSignals(process),
  pid: process.pid,
  pass: new ChildTickPass({
    command: process.execPath,
    args: [join(import.meta.dirname, 'fake-tick.ts')],
    env: passEnvironment(process.env),
    killGraceMs: 2_000,
  }),
  schedule: { intervalMs: 60_000, passDeadlineMs: 60_000, shutdownGraceMs: graceMs },
});
