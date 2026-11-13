import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';
import type { CarriedVariable } from './schedule-environment.ts';
import {
  earlierJob,
  jobEnvironment,
  render,
  renderLauncher,
  shellWord,
  nothingToSettle,
  templateNamed,
  writeRendered,
} from './schedule-files.ts';
import type { JobOptions, Launcher, RenderedSchedule } from './schedule-files.ts';

/** The name the scheduler knows the job of an install at the default places by. */
export const SCHEDULE_LABEL = 'com.user.board-queue';

/** What the scheduler knows an install's job by, and where its description is. */
export type LaunchdJobNames = {
  /** The name the scheduler knows this job by, and the name every command below names. */
  readonly label: string;
  /** The job description the scheduler reads. */
  readonly plistPath: string;
};

export type ScheduleInstallation = Launcher & LaunchdJobNames & {
  /** A job under the default name this one stands beside, for a person to look at; null when there is none. */
  earlierJobPath: string | null;
};

/**
 * The names of an install's job: the default label, or the default label with
 * the install's own name after it, and the description named after the label.
 */
export function launchdJobNames(home: string, instance: string | null): LaunchdJobNames {
  const label = instance === null ? SCHEDULE_LABEL : `${SCHEDULE_LABEL}.${instance}`;
  return { label, plistPath: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`) };
}

/**
 * The macOS job description and the launcher it runs, as an install writes
 * them, and what goes where; nothing is written. Installing and asking whether
 * an install would change anything both start here, so the two never differ.
 */
export function renderSchedule(options: JobOptions): RenderedSchedule<ScheduleInstallation> {
  const launcher = renderLauncher(options);
  const installation: ScheduleInstallation = {
    ...launcher.installation,
    ...launchdJobNames(options.home, options.instance),
    earlierJobPath: earlierJob(options.instance, launchdJobNames(options.home, null).plistPath),
  };
  const plist = render(templateNamed('com.user.board-queue.plist.template'), {
    LABEL: xmlText(installation.label),
    LAUNCHER: xmlText(installation.launcherPath),
    INTERVAL: xmlText(String(installation.intervalSec)),
    LOG: xmlText(installation.logPath),
    WORKDIR: xmlText(installation.workDir),
    ENVIRONMENT: plistEnvironment(jobEnvironment(options)),
  });
  return { installation, files: [{ path: installation.plistPath, contents: plist, mode: null }, ...launcher.files] };
}

/**
 * Writes the macOS job description and the launcher it runs, and answers what
 * went where. Everything is rendered before anything is written, and
 * `beforeWriting` runs between the two, so a refused install writes nothing.
 *
 * Nothing is loaded here. Handing the two commands to the person instead of
 * running them keeps the moment a background job starts running on this machine a
 * decision somebody took, and the commands are the same ones they would use to
 * look at it later.
 */
export function installSchedule(options: JobOptions, beforeWriting: () => void = nothingToSettle): ScheduleInstallation {
  return writeRendered(renderSchedule(options), beforeWriting);
}

/** The entries of the job's `EnvironmentVariables` dictionary, one key and its string each. */
function plistEnvironment(variables: readonly CarriedVariable[]): string {
  return variables
    .map(([name, value]) => `        <key>${xmlText(name)}</key>\n        <string>${xmlText(value)}</string>`)
    .join('\n');
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
 * The command that starts a job that is not loaded: it registers the
 * description, and the description's `RunAtLoad` runs a pass at once instead of
 * waiting out the interval.
 */
export function loadCommands(installation: LaunchdJobNames): string[] {
  return [`launchctl bootstrap gui/$(id -u) ${shellWord(installation.plistPath)}`];
}

/** How many one-second waits a reload gives launchd to finish a bootout. */
const WAIT_TRIES = 30;

/**
 * The commands that make a job loaded under this label read its description
 * again, in the order they are run. launchd reads a description only when the
 * job is bootstrapped, so the job is unloaded and registered again; restarting
 * it (`kickstart -k`) would run it with the description it read before.
 * launchd finishes unloading after `bootout` returns and refuses a `bootstrap`
 * of the label until then, so the second command waits for the label to go:
 * at most `WAIT_TRIES` seconds, so a job a failed `bootout` left loaded still
 * reaches the `bootstrap`, whose refusal then says what is wrong.
 */
export function reloadCommands(installation: LaunchdJobNames): string[] {
  return [
    `launchctl bootout gui/$(id -u)/${installation.label}`,
    `tries=0; while [ "$tries" -lt ${String(WAIT_TRIES)} ] && launchctl print "gui/$(id -u)/${installation.label}" `
    + '>/dev/null 2>&1; do sleep 1; tries=$((tries + 1)); done',
    ...loadCommands(installation),
  ];
}


/**
 * The commands that stop the job and remove its description, in the order they
 * are run. They name this install's label, so another install's job stays.
 */
export function removeCommands(installation: LaunchdJobNames): string[] {
  return [
    `launchctl bootout gui/$(id -u)/${installation.label}`,
    `rm ${shellWord(installation.plistPath)}`,
  ];
}
