import path from 'node:path';
import { SEARCH_PATH, render, templateNamed, write, writeLauncher } from './schedule-files.ts';
import type { Launcher, ScheduleOptions } from './schedule-files.ts';

/** The unit names the user's service manager knows the job by. */
export const SERVICE_UNIT = 'board-queue.service';
export const TIMER_UNIT = 'board-queue.timer';

export type SystemdInstallation = Launcher & {
  /** The one-shot service that runs a pass. */
  servicePath: string;
  /** The timer that starts the service on the interval. */
  timerPath: string;
};

export type SystemdOptions = ScheduleOptions & {
  /** `$XDG_CONFIG_HOME`, when the environment names an absolute one. */
  configHome: string | null;
};

/**
 * Writes the Linux user units — a one-shot service and the timer that starts
 * it — and the launcher the service runs, and answers what went where.
 *
 * As with the macOS job, nothing is enabled here: the person runs the commands
 * this prints, which are also the ones that show or stop the job later.
 */
export function installSystemdUnits(options: SystemdOptions): SystemdInstallation {
  const launcher = writeLauncher(options);
  const unitDir = path.join(options.configHome ?? path.join(options.home, '.config'), 'systemd', 'user');
  const installation: SystemdInstallation = {
    ...launcher,
    servicePath: path.join(unitDir, SERVICE_UNIT),
    timerPath: path.join(unitDir, TIMER_UNIT),
  };
  write(installation.servicePath, render(templateNamed('board-queue.service.template'), {
    LAUNCHER: installation.launcherPath,
    WORKDIR: installation.workDir,
    PATH: SEARCH_PATH,
    LOG: installation.logPath,
  }));
  write(installation.timerPath, render(templateNamed('board-queue.timer.template'), {
    INTERVAL: String(installation.intervalSec),
    SERVICE: SERVICE_UNIT,
  }));
  return installation;
}

/** The commands that make the service manager read the units and start the timer. */
export function enableCommands(): string[] {
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${TIMER_UNIT}`,
  ];
}
