import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RefusedByRule } from '../domain/errors.ts';
import { readOwnerOnlyFile } from './owner-only-file.ts';
import { parseTomlTables } from './toml-tables.ts';

/** The variable that moves the dibs command line tool's configuration, its credentials file with it. */
const CONFIG_DIR_VARIABLE = 'DIBS_CONFIG_DIR';
const FILE_NAME = 'credentials.toml';
const NAMED = 'the dibs login file';
/** What the dibs command line tool accepts as a token: printable characters, at most this many. */
const MAX_TOKEN_CHARS = 512;

/**
 * One credential as the dibs command line tool writes it: the token itself, or a
 * note that the operating system's credential store holds it.
 */
const EntrySchema = z.object({
  server: z.string(),
  project: z.string(),
  token: z.string().optional(),
  keychain: z.boolean().optional(),
}).strict();

const DocumentSchema = z.object({
  root: z.object({}).strict(),
  arrays: z.object({ credential: z.array(EntrySchema).default([]) }).strict(),
});

export type DibsLoginDeps = {
  /** The server whose token is wanted, as the configuration names it. */
  server: string;
  /** The project on that server. */
  project: string;
  /** Where the file's location is read from: the variables the dibs tool reads it from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The operating system: on Windows the file is guarded by an access list this reader cannot check. */
  platform?: NodeJS.Platform;
  /** The account's home directory when `HOME` does not name one. */
  home?: () => string;
};

/**
 * Where the dibs command line tool keeps its logins on macOS and Linux: the
 * directory `DIBS_CONFIG_DIR` names, else `$XDG_CONFIG_HOME/dibs`, else
 * `~/.config/dibs`, macOS included. An empty variable counts as unset, as it does
 * for the tool itself.
 */
export function dibsCredentialsPath(deps: DibsLoginDeps): string {
  const variable = (name: string): string | null => {
    const value = (deps.env[name] ?? '').trim();
    return value === '' ? null : value;
  };
  const named = variable(CONFIG_DIR_VARIABLE);
  if (named !== null) {
    return join(named, FILE_NAME);
  }
  const xdg = variable('XDG_CONFIG_HOME');
  if (xdg !== null) {
    return join(xdg, 'dibs', FILE_NAME);
  }
  return join(variable('HOME') ?? (deps.home ?? homedir)(), '.config', 'dibs', FILE_NAME);
}

/**
 * The token `dibs login` stored on this machine for the configured server and
 * project, read at the moment of each call, so a login renewed since is the one
 * the next call sends.
 *
 * The file is read only when it is this account's own and readable by nobody
 * else, the rule the dibs tool keeps for it too. A login for another server or
 * project is no login for this one, and is refused naming what the file does
 * hold — servers and projects, never a token. A login kept in the operating
 * system's credential store (`dibs login --keychain`) leaves only a note in the
 * file, and is refused: that store asks the person to allow each new reader, and
 * a scheduled worker has nobody to ask. On Windows the dibs tool guards the file
 * with an access list rather than with its mode, which this reader cannot check,
 * so a stored login is not read there. No message repeats the token or a line of
 * the file.
 */
export function tokenFromDibsLogin(deps: DibsLoginDeps): () => string {
  const wanted = `${deps.project} on ${deps.server}`;
  return () => {
    if ((deps.platform ?? process.platform) === 'win32') {
      throw new RefusedByRule(
        'a stored dibs login is not read on Windows; name the token in an environment variable instead',
      );
    }
    const server = normalServer(deps.server);
    if (server === null) {
      throw new RefusedByRule(`${deps.server} is no server address a dibs login is stored under`);
    }
    const path = dibsCredentialsPath(deps);
    const document = DocumentSchema.safeParse(parseTomlTables(readOwnerOnlyFile(path, NAMED).text, NAMED));
    if (!document.success) {
      throw new RefusedByRule(`${NAMED} holds something other than dibs logins; sign in again with dibs login`);
    }
    const entries = document.data.arrays.credential;
    const entry = entries.find((one) => one.project === deps.project && normalServer(one.server) === server);
    if (entry === undefined) {
      const held = entries.map((one) => `${one.project} on ${normalServer(one.server) ?? one.server}`);
      throw new RefusedByRule(
        `${NAMED} holds no login for ${wanted}`
        + (held.length === 0 ? '' : ` (it holds: ${held.join(', ')})`)
        + `; run dibs login for ${deps.project} on that server, or name the token in an environment variable`,
      );
    }
    if (entry.token === undefined) {
      throw new RefusedByRule(
        entry.keychain === true
          ? `the dibs login for ${wanted} is kept in the operating system's credential store (dibs login --keychain), `
            + 'which a scheduled worker cannot read; sign in again without --keychain, '
            + 'or name the token in an environment variable'
          : `the dibs login for ${wanted} holds no token; sign in again with dibs login`,
      );
    }
    const token = entry.token.trim();
    if (token === '' || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) {
      throw new RefusedByRule(`the dibs login for ${wanted} holds no valid token; sign in again with dibs login`);
    }
    return token;
  };
}

/**
 * A server's address in the one spelling the dibs tool files it under: scheme and
 * host in lower case, no default port, no trailing slash. Null for text that is
 * no address.
 */
export function normalServer(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}
