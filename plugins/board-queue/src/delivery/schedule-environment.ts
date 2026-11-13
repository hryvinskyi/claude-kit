import { statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';

/** A variable a scheduled job is started with: its name and its value. */
export type CarriedVariable = readonly [name: string, value: string];

type Environment = Readonly<Record<string, string | undefined>>;

/** What deciding which values a job is handed needs to know of the disk. */
export type PlaceProbe = {
  /** Whether a regular file is there, following a link to one. */
  isFile(file: string): boolean;
  /** Whether a directory is there, following a link to one. */
  isDirectory(directory: string): boolean;
};

/** The disk this process runs on. A place it may not look at counts as not there. */
export const disk: PlaceProbe = {
  isFile: (file) => statOf(file)?.isFile() ?? false,
  isDirectory: (directory) => statOf(directory)?.isDirectory() ?? false,
};

function statOf(place: string): Stats | undefined {
  try {
    return statSync(place, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * What a value of each kind of variable becomes in the job, or nothing when the
 * job should not be handed it.
 *
 * - `path`: a file or directory the pass reads. A relative one is resolved now,
 *   against the directory the install ran in, because the job starts in another.
 * - `secret-file`: the file a key or a token is read from, resolved as a `path`
 *   is. It is handed over only when it names a regular file; anything else is
 *   refused, because a value that names no file may be the secret itself, and
 *   the job description would hold it.
 * - `absolute-path`: a base directory that is honoured only when absolute; a
 *   relative one is ignored by the pass, so it is not handed over either.
 * - `value`: a word or a number that names something rather than a place.
 */
const TREATMENTS = {
  path: (_name: string, value: string, cwd: string) => path.resolve(cwd, value),
  'secret-file': (name: string, value: string, cwd: string, probe: PlaceProbe) => {
    const file = path.resolve(cwd, value);
    if (!probe.isFile(file)) {
      throw new RefusedByRule(
        `${name} does not name a file, and a schedule carries a key or a token only as the path to the file `
        + `that holds it; write it to a file, chmod 600 it, and set ${name} to that file's path`,
      );
    }
    return file;
  },
  'absolute-path': (_name: string, value: string) => (path.isAbsolute(value) ? value : null),
  value: (_name: string, value: string) => value,
} as const satisfies Record<string, (name: string, value: string, cwd: string, probe: PlaceProbe) => string | null>;

type Treatment = keyof typeof TREATMENTS;

/**
 * Every variable that changes where a pass reads its configuration, its queue or
 * its credentials, or which credential it uses. Each holds a place or a name;
 * none holds a token or a key, and none is ever added that does: a schedule file
 * is readable by whoever can read the home directory's job descriptions, and is
 * kept in no secret store.
 */
const CARRIED: ReadonlyMap<string, Treatment> = new Map<string, Treatment>([
  ['BOARD_QUEUE_CONFIG', 'path'],
  ['BOARD_QUEUE_STATE_DIR', 'path'],
  ['BOARD_QUEUE_ENV', 'path'],
  ['BOARD_QUEUE_IDENTITY', 'value'],
  ['XDG_CONFIG_HOME', 'absolute-path'],
  ['DIBS_CONFIG_DIR', 'path'],
  ['GH_CONFIG_DIR', 'path'],
  ['GITHUB_APP_ID', 'value'],
  ['GITHUB_APP_INSTALLATION_ID', 'value'],
  ['GITHUB_APP_PRIVATE_KEY_PATH', 'secret-file'],
  ['GITHUB_APP_PRIVATE_KEY', 'secret-file'],
]);

/** A name that says its variable holds a key or a token, or the place of one. */
const SECRET_NAME = /(^|_)(KEY|TOKEN)(_|$)/;

/** How a variable is handed over: a path whose name says it leads to a secret is held to a file. */
function treatmentOf(name: string, declared: Treatment): Treatment {
  return declared === 'path' && SECRET_NAME.test(name) ? 'secret-file' : declared;
}

/** How a private key's text begins; no path does. */
const KEY_OPENING = '-----BEGIN';

/**
 * The variables of this environment a scheduled pass is started with, sorted by
 * name, so that the pass reads the configuration, the queue and the credentials
 * this install found rather than whatever a scheduler's bare environment points
 * at.
 *
 * `tokenFileVariables` are the variables that name a file a token is read from,
 * which the configuration decides; each is carried only while it names a
 * regular file, whatever its name says. An
 * unset or empty variable is left out. A variable that holds a key's text, or
 * that should name a key's or a token's file and names none, is refused, naming
 * the variable and never repeating what it holds, because a job description is
 * no place for a key.
 */
export function carriedEnvironment(
  env: Environment,
  cwd: string,
  tokenFileVariables: readonly string[] = [],
  probe: PlaceProbe = disk,
): CarriedVariable[] {
  const wanted = new Map<string, Treatment>(CARRIED);
  for (const name of tokenFileVariables) {
    wanted.set(name, 'secret-file');
  }
  const carried: CarriedVariable[] = [];
  for (const [name, declared] of wanted) {
    const value = (env[name] ?? '').trim();
    if (value === '') {
      continue;
    }
    if (value.includes(KEY_OPENING)) {
      throw new RefusedByRule(
        `${name} holds a key rather than the path to one, and a schedule never carries a key; `
        + 'write the key to a file, chmod 600 it, and name that file instead',
      );
    }
    const handed = TREATMENTS[treatmentOf(name, declared)](name, value, cwd, probe);
    if (handed !== null) {
      carried.push([name, handed]);
    }
  }
  return carried.sort(byName);
}

/**
 * The directories of the install's own search path a scheduled pass can use:
 * the absolute ones that are there, each once, in the order the install had
 * them. A relative entry would mean another directory in the job, which starts
 * elsewhere, and a missing one finds nothing.
 */
export function installSearchPath(value: string | undefined, probe: PlaceProbe = disk): string[] {
  const kept: string[] = [];
  for (const directory of (value ?? '').split(path.delimiter)) {
    if (path.isAbsolute(directory) && !kept.includes(directory) && probe.isDirectory(directory)) {
      kept.push(directory);
    }
  }
  return kept;
}

/** Names in code point order, the same on every machine whatever its locale. */
function byName([left]: CarriedVariable, [right]: CarriedVariable): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
