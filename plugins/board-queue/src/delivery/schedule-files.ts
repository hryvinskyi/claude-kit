import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';
import type { CarriedVariable } from './schedule-environment.ts';

/** Five minutes: often enough that a filed action feels prompt, seldom enough to cost nothing. */
export const INTERVAL_SEC = 300;

/**
 * A scheduler starts a job with a bare path that has no room for anything
 * installed by a package manager — and the credential this system falls back to
 * comes from the GitHub command line tool, which lives in exactly such a place.
 * A tick that cannot find it would read as a login problem rather than a path one.
 * The job looks in the install's own search path first and in these after it.
 */
export const SEARCH_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** Everything a scheduled pass prints goes to one file in the state directory. */
export const SCHEDULER_LOG = 'launchd.log';

/** The launcher's name in the state directory. */
const LAUNCHER = 'board-queue-tick.sh';

/** Where the launcher every scheduler runs is written, in a state directory. */
export function launcherPathIn(stateDir: string): string {
  return path.join(stateDir, LAUNCHER);
}

export type ScheduleOptions = {
  /** The home directory the scheduler's own files are written under. */
  home: string;
  /** The Node binary to bake in; the running process's own is the honest answer. */
  nodePath: string;
  /** Where the queue keeps its state: the launcher and the job's log live there. */
  stateDir: string;
  /**
   * The `board-queue` command at a path that stays put when this package moves —
   * the shim an installer writes — which is what every scheduled pass runs.
   */
  commandPath: string;
};

/** What a scheduler's job description is written from: the launcher's options and what is particular to this install. */
export type JobOptions = ScheduleOptions & {
  /**
   * The variables, as this install found them, that tell the pass where its
   * configuration, queue and credentials are; the job starts the pass with them.
   */
  environment: readonly CarriedVariable[];
  /**
   * The absolute directories of the install's own search path that exist, each
   * once: where the person's commands were found, which the job looks in first.
   */
  searchPath: readonly string[];
  /** What sets this install's job apart from another install's; null for the default locations. */
  instance: string | null;
};

/**
 * Everything a job description sets in the pass's environment: the search path
 * — the install's own directories, then the fixed ones it lacks — and then what
 * the install carried.
 */
export function jobEnvironment(options: JobOptions): CarriedVariable[] {
  const searchPath = [...options.searchPath];
  for (const directory of SEARCH_PATH.split(':')) {
    if (!searchPath.includes(directory)) {
      searchPath.push(directory);
    }
  }
  return [['PATH', searchPath.join(':')], ...options.environment];
}

/**
 * The job file under the default name, when this install writes one under
 * another name and that file is there. It may be another install's at the
 * default places, or one written for these same places under the default name;
 * only a person can tell which, so this points at it and touches nothing.
 */
export function earlierJob(instance: string | null, defaultJobPath: string): string | null {
  return instance !== null && existsSync(defaultJobPath) ? defaultJobPath : null;
}

/** What every scheduler's job is made of, whichever scheduler starts it. */
export type Launcher = {
  /** The small shell script the job runs. */
  launcherPath: string;
  /** The Node binary the launcher hands to the command. */
  nodePath: string;
  /** The command the launcher runs a pass through. */
  commandPath: string;
  /** Where the job's own output lands. */
  logPath: string;
  /** The directory the job starts in. */
  workDir: string;
  intervalSec: number;
};

/**
 * Writes the launcher every scheduler runs and answers where everything went.
 *
 * Every path baked in is absolute and resolved now, while a shell with a full
 * environment is running: a scheduler starts a job with neither a checkout's
 * directory nor the search path a person's shell has. The command it runs must
 * already exist and be executable, because a job pointed at nothing fails at a
 * moment nobody is watching, in a log nobody is reading.
 */
export function writeLauncher(options: ScheduleOptions): Launcher {
  try {
    accessSync(options.commandPath, constants.X_OK);
  } catch {
    throw new RefusedByRule(
      `there is no board-queue command at ${options.commandPath}; install the command shims first, `
      + 'then run this again',
    );
  }
  const launcher: Launcher = {
    launcherPath: launcherPathIn(options.stateDir),
    nodePath: options.nodePath,
    commandPath: options.commandPath,
    logPath: path.join(options.stateDir, SCHEDULER_LOG),
    workDir: options.stateDir,
    intervalSec: INTERVAL_SEC,
  };
  write(launcher.launcherPath, render(templateNamed('board-queue-tick.sh.template'), {
    NODE: insideSingleQuotes(launcher.nodePath),
    COMMAND: insideSingleQuotes(launcher.commandPath),
  }));
  // The scheduler runs it through a shell, but a person has to be able to run it
  // by hand to find out what the job actually does.
  chmodSync(launcher.launcherPath, 0o755);
  return launcher;
}

/**
 * A value as the inside of a single-quoted shell word. Every character stands
 * for itself between single quotes except the quote, which is written as one
 * that closes the word, an escaped quote, and one that opens it again.
 */
function insideSingleQuotes(value: string): string {
  return value.replaceAll('\'', '\'\\\'\'');
}

/** A value as one single-quoted shell word, which a shell reads back as the value and runs none of. */
export function shellWord(value: string): string {
  return `'${insideSingleQuotes(value)}'`;
}

/** This package's own directory, from this file's place inside it. */
function packageRoot(): string {
  return path.join(import.meta.dirname, '..', '..');
}

export function templateNamed(name: string): string {
  const file = path.join(packageRoot(), 'schedule', name);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new RefusedByRule(`the template at ${file} is missing; this checkout is incomplete`);
  }
}

/**
 * Fills a template in, refusing to write one that still has a gap in it: a job
 * description carrying a placeholder where a path belongs fails at a moment
 * nobody is watching, in a log nobody is reading.
 */
export function render(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{([A-Z]+)\}\}/g, (whole: string, name: string) => values[name] ?? whole);
  const leftover = /\{\{[A-Z]+\}\}/.exec(filled);
  if (leftover !== null) {
    throw new RefusedByRule(`nothing was supplied for ${leftover[0]} in this template`);
  }
  return filled;
}

export function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}
