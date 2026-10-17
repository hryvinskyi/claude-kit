import path from 'node:path';
import { SEARCH_PATH, render, templateNamed, write, writeLauncher } from './schedule-files.ts';
import type { Launcher, ScheduleOptions } from './schedule-files.ts';

/** The name the scheduler knows this job by, and the name every command below names. */
export const SCHEDULE_LABEL = 'com.user.board-queue';

export type ScheduleInstallation = Launcher & {
  label: string;
  /** The job description the scheduler reads. */
  plistPath: string;
};

/**
 * Writes the macOS job description and the launcher it runs, and answers what
 * went where.
 *
 * Nothing is loaded here. Handing the two commands to the person instead of
 * running them keeps the moment a background job starts running on this machine a
 * decision somebody took, and the commands are the same ones they would use to
 * look at it later.
 */
export function installSchedule(options: ScheduleOptions): ScheduleInstallation {
  const launcher = writeLauncher(options);
  const installation: ScheduleInstallation = {
    ...launcher,
    label: SCHEDULE_LABEL,
    plistPath: path.join(options.home, 'Library', 'LaunchAgents', `${SCHEDULE_LABEL}.plist`),
  };
  write(installation.plistPath, render(templateNamed('com.user.board-queue.plist.template'), {
    LABEL: installation.label,
    LAUNCHER: installation.launcherPath,
    INTERVAL: String(installation.intervalSec),
    LOG: installation.logPath,
    WORKDIR: installation.workDir,
    PATH: SEARCH_PATH,
  }));
  return installation;
}

/**
 * The commands that start the job, in the order they are run: the first
 * registers it, the second runs it once now instead of waiting out the interval.
 * The second is also what re-reads a description that changed.
 */
export function loadCommands(installation: ScheduleInstallation): string[] {
  return [
    `launchctl bootstrap gui/$(id -u) ${installation.plistPath}`,
    `launchctl kickstart -k gui/$(id -u)/${installation.label}`,
  ];
}
