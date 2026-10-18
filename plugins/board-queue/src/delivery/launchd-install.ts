import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';
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
    LABEL: xmlText(installation.label),
    LAUNCHER: xmlText(installation.launcherPath),
    INTERVAL: xmlText(String(installation.intervalSec)),
    LOG: xmlText(installation.logPath),
    WORKDIR: xmlText(installation.workDir),
    PATH: xmlText(SEARCH_PATH),
  }));
  return installation;
}

/** The characters XML 1.0 does not allow in a document at all, escaped or not. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;

const XML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ['\'', '&apos;'],
]);

/**
 * A value as the text of an element of the job description, so that a path
 * holding an ampersand or an angle bracket is read back as the same path. A
 * control character has no way to be written in XML; the job is refused rather
 * than written as a file the scheduler rejects.
 */
function xmlText(value: string): string {
  if (NOT_XML.test(value)) {
    throw new RefusedByRule(
      `the macOS job description cannot hold ${JSON.stringify(value)}: XML has no way to write a control `
      + 'character; choose a state directory and home without one',
    );
  }
  return value.replace(/[&<>"']/g, (char: string) => XML_ENTITIES.get(char) ?? char);
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
