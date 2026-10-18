import { accessSync, chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';

/** Five minutes: often enough that a filed action feels prompt, seldom enough to cost nothing. */
export const INTERVAL_SEC = 300;

/**
 * A scheduler starts a job with a bare path that has no room for anything
 * installed by a package manager — and the credential this system falls back to
 * comes from the GitHub command line tool, which lives in exactly such a place.
 * A tick that cannot find it would read as a login problem rather than a path one.
 */
export const SEARCH_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** Everything a scheduled pass prints goes to one file in the state directory. */
export const SCHEDULER_LOG = 'launchd.log';

/** The launcher's name in the state directory. */
const LAUNCHER = 'board-queue-tick.sh';

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
    launcherPath: path.join(options.stateDir, LAUNCHER),
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
