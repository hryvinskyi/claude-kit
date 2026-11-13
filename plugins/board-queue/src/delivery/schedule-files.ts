import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
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

/**
 * The size, in bytes, past which the launcher moves the log of a scheduled job
 * aside before a pass: to the same name with `.1` after it, replacing the one
 * moved aside before. The check runs only at the start of a pass, and the
 * scheduler opened the log before it, so the pass that moves the log still
 * writes into the `.1` file. The log therefore holds at most this plus one
 * pass's output, the `.1` file at most this plus two passes' output, and the
 * two together at most twice this plus three passes' output. Nothing bounds
 * what a single pass prints.
 */
export const SCHEDULER_LOG_CAP_BYTES = 5 * 1024 * 1024;

/** What the log of an install's scheduled job is called, before the install's own name and the extension. */
const SCHEDULER_LOG_STEM = 'launchd';

/** What the launcher of an install's job is called, before the install's own name and the extension. */
const LAUNCHER_STEM = 'board-queue-tick';

/**
 * Where the launcher an install's scheduler runs is written, in a state
 * directory. It is named after the install the way the job is, so two installs
 * that share a state directory — each baking in its own Node binary — keep a
 * launcher each; the install at the default places keeps the plain name.
 */
export function launcherPathIn(stateDir: string, instance: string | null): string {
  const name = instance === null ? LAUNCHER_STEM : `${LAUNCHER_STEM}.${instance}`;
  return path.join(stateDir, `${name}.sh`);
}

/**
 * The file in a state directory that everything an install's scheduled pass
 * prints is appended to. It is named after the install the way the job is, so
 * two installs that share a state directory keep two logs; the install at the
 * default places keeps the plain name.
 */
export function schedulerLogIn(stateDir: string, instance: string | null): string {
  const name = instance === null ? SCHEDULER_LOG_STEM : `${SCHEDULER_LOG_STEM}.${instance}`;
  return path.join(stateDir, `${name}.log`);
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
  /** What sets this install's job apart from another install's; null for the default locations. */
  instance: string | null;
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

/** One file an install writes: where, what it holds, and the mode it is given when it has to have one. */
export type ScheduleFile = {
  readonly path: string;
  readonly contents: string;
  /** The permission bits the file is set to; null leaves them to the umask. */
  readonly mode: number | null;
};

/** What an install would write, rendered and not yet written, and what it answers once it has. */
export type RenderedSchedule<Installation> = {
  readonly installation: Installation;
  /** Every file, in the order the install writes them. */
  readonly files: readonly ScheduleFile[];
};

/** The scheduler can run it through a shell, but a person has to be able to run it by hand to see what the job does. */
const LAUNCHER_MODE = 0o755;

/**
 * Renders the launcher every scheduler runs and answers where everything goes.
 *
 * Every path baked in is absolute and resolved now, while a shell with a full
 * environment is running: a scheduler starts a job with neither a checkout's
 * directory nor the search path a person's shell has. The command it runs must
 * already exist and be executable, because a job pointed at nothing fails at a
 * moment nobody is watching, in a log nobody is reading.
 */
export function renderLauncher(options: ScheduleOptions): RenderedSchedule<Launcher> {
  try {
    accessSync(options.commandPath, constants.X_OK);
  } catch {
    throw new RefusedByRule(
      `there is no board-queue command at ${options.commandPath}; install the command shims first, `
      + 'then run this again',
    );
  }
  const launcher: Launcher = {
    launcherPath: launcherPathIn(options.stateDir, options.instance),
    nodePath: options.nodePath,
    commandPath: options.commandPath,
    logPath: schedulerLogIn(options.stateDir, options.instance),
    workDir: options.stateDir,
    intervalSec: INTERVAL_SEC,
  };
  const contents = render(templateNamed('board-queue-tick.sh.template'), {
    NODE: insideSingleQuotes(launcher.nodePath),
    COMMAND: insideSingleQuotes(launcher.commandPath),
    LOG: insideSingleQuotes(launcher.logPath),
    LOGCAP: String(SCHEDULER_LOG_CAP_BYTES),
  });
  return { installation: launcher, files: [{ path: launcher.launcherPath, contents, mode: LAUNCHER_MODE }] };
}

/**
 * Writes what an install rendered and answers what went where. Every file's
 * place is probed first (`refuseUnwritable`), then `beforeWriting` runs —
 * whatever the install has to settle on disk before its files go there — and
 * only then are the files written. An install refused at rendering or at the
 * probe leaves nothing behind; a write the operating system refuses only when
 * it happens (a full disk) can still fail after the settling.
 */
export function writeRendered<Installation>(
  rendered: RenderedSchedule<Installation>,
  beforeWriting: () => void,
): Installation {
  refuseUnwritable(rendered.files);
  beforeWriting();
  writeScheduleFiles(rendered.files);
  return rendered.installation;
}

/** Nothing to settle before the files are written. */
export function nothingToSettle(): void {
  // An install whose places are made by writing its files.
}

/** Writes every file an install rendered, each with its mode. */
export function writeScheduleFiles(files: readonly ScheduleFile[]): void {
  for (const file of files) {
    write(file.path, file.contents);
    if (file.mode !== null) {
      chmodSync(file.path, file.mode);
    }
  }
}

/** The bits of a file's mode an install sets. */
const PERMISSION_BITS = 0o777;

/**
 * The files an install would write because they are not on disk as it would
 * leave them — missing, holding other text, or without the mode it sets — in
 * the order it writes them. It reads and writes nothing else. Every place is
 * probed as the install probes it, and one the install could not write is
 * refused.
 */
export function staleScheduleFiles(files: readonly ScheduleFile[]): string[] {
  refuseUnwritable(files);
  return files.filter((file) => !isCurrent(file)).map((file) => file.path);
}

/**
 * Refuses the first file an install could not write, as far as can be known
 * before writing: a place that holds something other than a file, a file this
 * process may not write, or — for a file not there yet — a nearest existing
 * ancestor that is not a directory, or a directory this process may not create
 * entries in.
 */
export function refuseUnwritable(files: readonly ScheduleFile[]): void {
  for (const file of files) {
    const found = statOf(file.path);
    if (found === undefined) {
      refuseUnwritableDirectory(file.path, path.dirname(file.path));
    } else if (!found.isFile()) {
      throw new RefusedByRule(`${file.path} is there and is not a file, so an install could not write it`);
    } else if (!mayAccess(file.path, constants.W_OK)) {
      throw new RefusedByRule(`${file.path} cannot be written by this account`);
    }
  }
}

/** Refuses a file that would be created under `directory`, or under its nearest ancestor that is there, when it cannot be. */
function refuseUnwritableDirectory(file: string, directory: string): void {
  const found = statOf(directory);
  if (found === undefined) {
    const parent = path.dirname(directory);
    if (parent !== directory) {
      refuseUnwritableDirectory(file, parent);
    }
    return;
  }
  if (!found.isDirectory()) {
    throw new RefusedByRule(`${file} cannot be written: ${directory} is not a directory`);
  }
  if (!mayAccess(directory, constants.W_OK | constants.X_OK)) {
    throw new RefusedByRule(`${file} cannot be written: this account may not create files in ${directory}`);
  }
}

/** Whether this process may use a place in the ways `mode` names. */
function mayAccess(place: string, mode: number): boolean {
  try {
    accessSync(place, mode);
    return true;
  } catch {
    return false;
  }
}

function isCurrent(file: ScheduleFile): boolean {
  const found = statOf(file.path);
  if (found === undefined) {
    return false;
  }
  if (file.mode !== null && (found.mode & PERMISSION_BITS) !== file.mode) {
    return false;
  }
  try {
    return readFileSync(file.path, 'utf8') === file.contents;
  } catch {
    throw new RefusedByRule(`${file.path} cannot be read, so whether an install would change it is unknown`);
  }
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

/** What is at a place, or undefined when nothing is. */
function statOf(file: string): Stats | undefined {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch {
    throw new RefusedByRule(`${file} cannot be looked at, so whether an install would change it is unknown`);
  }
}

/**
 * Fills a template in, refusing to write one that still has a gap in it: a job
 * description carrying a placeholder where a path belongs fails at a moment
 * nobody is watching, in a log nobody is reading.
 *
 * The template is read once, from start to end, and a value is put in as it is
 * and never read again, so a value whose text looks like a placeholder — a
 * directory called `{{LOG}}` — stays that text. Only the template's own
 * placeholders are checked for a value.
 */
export function render(template: string, values: Readonly<Record<string, string>>): string {
  const unfilled: string[] = [];
  const filled = template.replace(/\{\{([A-Z]+)\}\}/g, (whole: string, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unfilled.push(whole);
      return whole;
    }
    return value;
  });
  const [first] = unfilled;
  if (first !== undefined) {
    throw new RefusedByRule(`nothing was supplied for ${first} in this template`);
  }
  return filled;
}

export function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}
