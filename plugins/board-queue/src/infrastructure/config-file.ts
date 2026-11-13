import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { ConfigSchema, unknownWorkerSettings } from '../domain/config.ts';
import type { Config } from '../domain/config.ts';
import { RefusedByRule } from '../domain/errors.ts';

/** Lets a second installation — or a test — run against another board. */
const CONFIG_VAR = 'BOARD_QUEUE_CONFIG';

type Env = Record<string, string | undefined>;

/** Where a line meant for the person running this goes. */
export type Notice = (line: string) => void;

const toStandardError: Notice = (line) => {
  process.stderr.write(`${line}\n`);
};

/** The person's home directory, as the environment names it. */
function homeOf(env: Env): string {
  const home = env['HOME']?.trim();
  return home === undefined || home === '' ? os.homedir() : home;
}

/**
 * The base directory for configuration files: `$XDG_CONFIG_HOME`, or
 * `~/.config`. The variable is only honoured when it is absolute, as the base
 * directory convention requires; a relative one would mean something different
 * in every directory the tool is started from.
 */
function configHome(env: Env): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), '.config');
}

export function configPath(env: Env = process.env): string {
  const configured = env[CONFIG_VAR]?.trim();
  return configured === undefined || configured === '' ? defaultConfigPath(env) : configured;
}

/** Where the configuration is read from when the environment names no file: under its configuration home. */
export function defaultConfigPath(env: Env = process.env): string {
  return path.join(configHome(env), 'board-queue', 'config.json');
}

/**
 * Where the configuration lived before it had a directory of its own: beside
 * the package, when the package was installed under the assistant's home.
 */
export function previousConfigPaths(env: Env = process.env): string[] {
  return [path.join(homeOf(env), '.claude', 'tools', 'board-queue', 'config.json')];
}

/**
 * The deployment's own file: which board, which repositories, which numbers the
 * worker paces itself by.
 *
 * Nothing in this package names an organisation or a repository, so a missing or
 * unreadable file is not a detail to fall back from — it is the whole of what
 * this system is allowed to touch. Each refusal below says what to do next,
 * because the person meeting it is usually setting the queue up for the first
 * time.
 *
 * A configuration found only at a previous location is read from there once,
 * written to the current one, and announced, so the next run reads the current
 * file and the person learns the old one can go. When the environment names a
 * file, that file is the only one read.
 */
export function loadConfig(env: Env = process.env, notice: Notice = toStandardError): Config {
  const found = foundConfig(env);
  const config = parsed(found.text, found.file, notice);
  adoptFound(found, env, notice);
  return config;
}

/**
 * Copies a configuration found only at its previous location to the current
 * one, and says so, as `loadConfig` does; nothing when it is at the current one
 * already. For a command that read it with `readConfig` and writes only once
 * everything it was going to refuse has been checked.
 */
export function adoptConfig(env: Env = process.env, notice: Notice = toStandardError): void {
  adoptFound(foundConfig(env), env, notice);
}

function adoptFound(found: { file: string; text: string }, env: Env, notice: Notice): void {
  const file = configPath(env);
  if (found.file !== file) {
    notice(adopted(found.file, file, found.text));
  }
}

/**
 * The configuration `loadConfig` would answer, read from the same file, with
 * nothing written: one found only at a previous location is read there and
 * left where it is. For a command that promises to change nothing.
 */
export function readConfig(env: Env = process.env, notice: Notice = toStandardError): Config {
  const found = foundConfig(env);
  return parsed(found.text, found.file, notice);
}

/** The file the configuration is read from, and its text; refused when there is none. */
function foundConfig(env: Env): { file: string; text: string } {
  const file = configPath(env);
  const named = env[CONFIG_VAR]?.trim();
  const candidates = named === undefined || named === '' ? [file, ...previousConfigPaths(env)] : [file];

  const found = firstReadable(candidates);
  if (found === null) {
    throw new RefusedByRule(
      `there is no configuration at ${file}; copy config.example.json there and name the board, `
      + 'the repositories this queue may write to and the fields it may set',
    );
  }
  return found;
}

function firstReadable(files: readonly string[]): { file: string; text: string } | null {
  for (const file of files) {
    try {
      return { file, text: readFileSync(file, 'utf8') };
    } catch {
      // Not there, or not readable by this account: the next candidate is asked.
    }
  }
  return null;
}

/**
 * The configuration in a file, refused when it is not usable. Worker settings
 * this release does not know are ignored and named in one notice, because they
 * are what a configuration written for a later release carries after a rollback.
 */
function parsed(text: string, file: string, notice: Notice): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new RefusedByRule(`the configuration at ${file} is not readable JSON`);
  }
  const validated = ConfigSchema.safeParse(raw);
  if (!validated.success) {
    throw new RefusedByRule(`the configuration at ${file} is not usable — ${issuesOf(validated.error)}`);
  }
  const unknown = unknownWorkerSettings(raw);
  if (unknown.length > 0) {
    notice(`the configuration at ${file} names worker settings this release does not know (${unknown.join(', ')}); `
      + 'they are ignored');
  }
  return validated.data;
}

/**
 * Copies a configuration read from a previous location to the current one and
 * says what happened. A copy that cannot be written leaves the previous file in
 * use, and the line says that instead, so it is repeated until somebody acts.
 */
function adopted(from: string, to: string, text: string): string {
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, text, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return `board-queue: the configuration was read from ${from}, its previous location; it could not be `
      + `copied to ${to}, where it is read from now — move it there`;
  }
  return `board-queue: the configuration moved from ${from} to ${to}, which is the one read from now on; `
    + `${from} is no longer read and can be deleted`;
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}
