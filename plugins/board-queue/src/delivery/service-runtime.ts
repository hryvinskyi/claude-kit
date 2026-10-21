import type { Clock } from '../application/ports.ts';
import { healthOf } from '../application/service-beat.ts';
import type { HealthVerdict } from '../application/service-beat.ts';
import { ServiceLoop } from '../application/service-loop.ts';
import type { PassRunner, ServiceEnd, ServiceLog, ServiceSchedule, Waiter } from '../application/service-loop.ts';
import type { Config } from '../domain/config.ts';
import { AbortableWaiter } from '../infrastructure/abortable-waiter.ts';
import { ChildTickPass } from '../infrastructure/child-tick-pass.ts';
import { FileBeatStore } from '../infrastructure/file-beat-store.ts';
import { beatPath } from '../infrastructure/paths.ts';
import { checkServiceCredentials } from '../infrastructure/service-credentials.ts';
import { SystemClock } from '../infrastructure/system-clock.ts';
import { IDENTITY_VARIABLE } from './local-identity.ts';
import { SCHEDULED_RUN_VARIABLE } from './scheduled-run.ts';

/**
 * A pass every five minutes, as a person's scheduler runs it. A pass gets twenty
 * minutes before it is given up on — less than the half hour after which the tick
 * lock is taken from a holder that looks dead, so an abandoned pass never meets a
 * second one on the same lock. Told to stop, a running pass gets 25 seconds to
 * finish and ten more to exit once asked: the container's stop grace must be
 * longer than both together.
 */
export const SERVICE_SCHEDULE: ServiceSchedule = {
  intervalMs: 5 * 60_000,
  passDeadlineMs: 20 * 60_000,
  shutdownGraceMs: 25_000,
};

/** Something that can tell a process to stop, narrow enough for a test to stand in for. */
export interface StopSignals {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** An abort that fires on the first SIGTERM or SIGINT, whichever comes first. */
export function stopOnSignals(source: StopSignals): AbortSignal {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    source.once(signal, () => {
      controller.abort(signal);
    });
  }
  return controller.signal;
}

/**
 * The environment each pass runs with: the service's own, plus the two things
 * that make it the service's pass — the schedule started it, and it is judged by
 * the login of the GitHub App it runs as rather than a person's.
 */
export function passEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, [SCHEDULED_RUN_VARIABLE]: '1', [IDENTITY_VARIABLE]: 'app' };
}

export type RunServiceOptions = {
  env: Record<string, string | undefined>;
  config: Config;
  stateDir: string;
  /** The command line's own entry point, which each pass runs `tick` through. */
  cliEntry: string;
  /** The Node binary running this process. */
  nodePath: string;
  log: ServiceLog;
  stop: AbortSignal;
  pid: number;
  /** Stand-ins for a test; the real ones otherwise. */
  pass?: PassRunner;
  waiter?: Waiter;
  clock?: Clock;
  schedule?: ServiceSchedule;
};

/**
 * The worker as a long-running service: refuse to start without the App's
 * credential and the coordination server's token, then run the schedule until
 * told to stop — or until a pass cannot be ended, which the answer says so the
 * process can exit for whatever runs it to start it afresh.
 */
export async function runService(options: RunServiceOptions): Promise<ServiceEnd> {
  const credentials = checkServiceCredentials(options.env, options.config);
  const schedule = options.schedule ?? SERVICE_SCHEDULE;
  options.log.line(
    `starting as GitHub App ${credentials.appId}, installation ${credentials.installationId ?? 'looked up'}, `
    + `its key mode ${credentials.keyMode}; a pass every `
    + `${String(Math.round(schedule.intervalMs / 1000))} s`,
  );
  const loop = new ServiceLoop({
    pass: options.pass ?? new ChildTickPass({
      command: options.nodePath,
      args: [options.cliEntry, 'tick'],
      env: passEnvironment(options.env),
    }),
    beats: new FileBeatStore(beatPath(options.stateDir)),
    waiter: options.waiter ?? new AbortableWaiter(),
    clock: options.clock ?? new SystemClock(),
    log: options.log,
    schedule,
    pid: options.pid,
  });
  return loop.run(options.stop);
}

/** Whether the service writing into this state directory is doing its job. */
export function serviceHealth(stateDir: string, clock: Clock = new SystemClock()): HealthVerdict {
  return healthOf(new FileBeatStore(beatPath(stateDir)).read(), clock.now());
}
