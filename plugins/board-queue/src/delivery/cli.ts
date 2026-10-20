import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ACTION_STATES, isActionState } from '../application/action-states.ts';
import type { EnqueueRequest } from '../application/enqueue-action.ts';
import type { ActionFilter } from '../application/ports.ts';
import type { ActionState } from '../domain/action.ts';
import { RefusedByRule } from '../domain/errors.ts';
import { loadConfig } from '../infrastructure/config-file.ts';
import { stateDir } from '../infrastructure/paths.ts';
import { auditLines } from './audit-text.ts';
import { buildContainer } from './container.ts';
import type { Container } from './container.ts';
import { sentenceOf } from './failure-text.ts';
import {
  actionLine,
  boardItemLines,
  enqueueLines,
  movedLine,
  statusLines,
  tickLines,
} from './human-text.ts';
import { momentOf, positiveIntegerOf } from './input-text.ts';
import { installSchedule, loadCommands } from './launchd-install.ts';
import { BRIEF_STATES, briefLines, briefOf } from './repository-brief.ts';
import { enableCommands, installSystemdUnits } from './systemd-install.ts';

/**
 * The queue on a command line: for a person looking at it, and for the scripts
 * that file work without a session behind them.
 *
 * Every subcommand is an entry in one map. There is no ladder of comparisons
 * anywhere below — the map is the dispatch, and teaching this tool another
 * command is adding an entry to it. Each command parses its own words, asks one
 * use case, and prints; nothing here decides anything the application has not
 * already decided.
 *
 * The container is built the first time a command asks for it and closed when the
 * command is done, so the commands that need no database — the usage text,
 * writing the scheduler's files — never open one.
 */

/** What a command may be given, in the shape the platform's parser takes. */
export type FlagSpec = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

type FlagValue = string | boolean | (string | boolean)[] | undefined;

/** A command used in a way it does not support; the runner answers with its usage. */
class MisusedCommand extends Error {
  readonly usage: string;

  constructor(usage: string, message: string) {
    super(message);
    this.name = 'MisusedCommand';
    this.usage = usage;
  }
}

/** The words that followed the command, read as the values a command wants. */
export class Flags {
  readonly #values: Record<string, FlagValue>;
  readonly #usage: string;

  constructor(values: Record<string, FlagValue>, usage: string) {
    this.#values = values;
    this.#usage = usage;
  }

  text(name: string): string | null {
    const value = this.#values[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  /** Every occurrence, with anything comma-separated split out. */
  list(name: string): string[] {
    const value = this.#values[name];
    const given = Array.isArray(value) ? value : [value];
    return given
      .filter((one): one is string => typeof one === 'string')
      .flatMap((one) => one.split(','))
      .map((one) => one.trim())
      .filter((one) => one !== '');
  }

  on(name: string): boolean {
    return this.#values[name] === true;
  }

  required(name: string): string {
    const value = this.text(name);
    if (value === null) {
      throw new MisusedCommand(this.#usage, `this command needs --${name}`);
    }
    return value;
  }
}

export type CommandContext = {
  positionals: readonly string[];
  flags: Flags;
  /** Writes one line to the answer stream. */
  out: (line: string) => void;
  /** The wiring, built on the first ask and closed by the runner. */
  container: () => Container;
  /** Everything piped in, or an empty string when nothing was. */
  stdin: () => Promise<string>;
  home: string;
  cwd: string;
  /** The Node binary running this command. */
  nodePath: string;
  /** `$XDG_CONFIG_HOME` when the environment names an absolute one, otherwise null. */
  configHome: string | null;
};

export type Command = {
  readonly usage: string;
  readonly summary: string;
  readonly flags?: FlagSpec;
  run(context: CommandContext): Promise<void>;
};

const JSON_FLAG: FlagSpec = { json: { type: 'boolean' } };

/** How a request arrives when it is piped in whole rather than typed as words. */
const PipedRequest = z
  .object({
    kind: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    origin: z.string().min(1).optional(),
    hold: z.boolean().optional(),
    notBefore: z.string().min(1).optional(),
    dedupeKey: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** The kind the words below build, and the only one they can build. */
const SET_FIELDS = 'board.set-fields';

/** Each of these names a board field the set-fields payload takes. */
const FIELD_WORDS = ['status', 'severity', 'module', 'environment', 'type'] as const;

const enqueue: Command = {
  usage: 'enqueue [--kind K] --repo owner/name --issue N [--status S] [--severity S] [--module M] '
    + '[--environment E] [--type T] [--hold] [--not-before ISO] [--origin who] [--json]',
  summary: 'file one piece of work; a JSON request on standard input takes any kind',
  flags: {
    ...JSON_FLAG,
    kind: { type: 'string' },
    repo: { type: 'string' },
    issue: { type: 'string' },
    status: { type: 'string' },
    severity: { type: 'string' },
    module: { type: 'string' },
    environment: { type: 'string' },
    type: { type: 'string' },
    hold: { type: 'boolean' },
    'not-before': { type: 'string' },
    origin: { type: 'string' },
  },
  run: async (context) => {
    const request = await enqueueRequest(context);
    const outcome = await context.container().enqueue.execute(request);
    printed(context, outcome, () => enqueueLines(outcome));
  },
};

const list: Command = {
  usage: 'list [--state s,…] [--repo owner/name] [--issue N] [--kind K] [--limit N] [--json]',
  summary: 'what is in the queue, oldest first',
  flags: {
    ...JSON_FLAG,
    state: { type: 'string', multiple: true },
    repo: { type: 'string' },
    issue: { type: 'string' },
    kind: { type: 'string' },
    limit: { type: 'string' },
  },
  run: async (context) => {
    const actions = await context.container().list.execute(filterFrom(context));
    printed(context, actions, () => actions.map(actionLine));
  },
};

const status: Command = {
  usage: 'status [--json]',
  summary: 'counts, the wait in force, the allowance, and everything stuck',
  flags: JSON_FLAG,
  run: async (context) => {
    const view = await context.container().status.execute();
    printed(context, view, () => statusLines(view));
  },
};

const release: Command = {
  usage: 'release <id>',
  summary: 'run a held action at the next tick',
  flags: JSON_FLAG,
  run: async (context) => {
    const view = await context.container().release.execute(identifier(context, release.usage));
    printed(context, view, () => [movedLine('released', view)]);
  },
};

const cancel: Command = {
  usage: 'cancel <id>',
  summary: 'take an action off the queue for good',
  flags: JSON_FLAG,
  run: async (context) => {
    const view = await context.container().cancel.execute(identifier(context, cancel.usage));
    printed(context, view, () => [movedLine('cancelled', view)]);
  },
};

const retry: Command = {
  usage: 'retry <id> | retry --blocked',
  summary: 'put a blocked or failed action back on the queue',
  flags: { ...JSON_FLAG, blocked: { type: 'boolean' } },
  run: async (context) => {
    const queue = context.container().retry;
    if (context.flags.on('blocked')) {
      const ids = await queue.allBlocked();
      printed(context, ids, () => (ids.length === 0 ? ['nothing is blocked'] : ids.map((id) => `retrying ${id}`)));
      return;
    }
    const view = await queue.execute(identifier(context, retry.usage));
    printed(context, view, () => [movedLine('retrying', view)]);
  },
};

const show: Command = {
  usage: 'show <owner/name> <issue> [--json]',
  summary: 'what the board carrying its repository says about one issue',
  flags: JSON_FLAG,
  run: async (context) => {
    const [repo, issue] = context.positionals;
    if (repo === undefined || issue === undefined) {
      throw new MisusedCommand(show.usage, 'name the repository and the issue number');
    }
    const view = await context.container().show.execute(repo, positiveIntegerOf(issue, 'an issue number'));
    printed(context, view, () => boardItemLines(view));
  },
};

/** The variable the scheduled launcher sets; a run started any other way is refused. */
export const SCHEDULED_RUN_VARIABLE = 'BOARD_QUEUE_SCHEDULED';

const tick: Command = {
  usage: 'tick [--json]',
  summary: 'one pass of the worker; the schedule runs it, a session never does',
  flags: JSON_FLAG,
  run: async (context) => {
    // The per-run cap spreads the board writes over five-minute windows; a
    // session that runs passes back to back to empty the queue sooner defeats
    // it while every other session shares the same allowance. So a pass runs
    // only when the schedule's launcher started it, which it says through one
    // variable. A person who needs a pass by hand sets that variable.
    if (process.env[SCHEDULED_RUN_VARIABLE] !== '1') {
      throw new RefusedByRule(
        'a pass is run by the schedule, not by hand: the worker applies filed actions within about five '
        + 'minutes and paces itself against the shared allowance. Read the queue instead (`status`, `list`), '
        + `or set ${SCHEDULED_RUN_VARIABLE}=1 if you are the person operating the schedule.`,
      );
    }
    // A tick that did not run is an answer, not a failure: the lock is held, or
    // the queue is waiting out a refusal. Whoever is watching the schedule reads
    // the report either way.
    const report = await context.container().tick.run();
    printed(context, report, () => tickLines(report));
  },
};

const audit: Command = {
  usage: 'audit [--json]',
  summary: 'read every board and say what does not add up; it files nothing',
  flags: JSON_FLAG,
  run: async (context) => {
    // Whatever this finds, it files nothing: which module an issue belongs to and
    // how badly it hurts are judgements nobody here can make, and a guessed value
    // routes triage wrongly while looking exactly like a chosen one.
    const report = await context.container().audit.execute();
    printed(context, report, () => auditLines(report));
  },
};

const brief: Command = {
  usage: 'brief --repo owner/name [--json]',
  summary: 'the session-start lines for one repository, from the database alone',
  flags: { ...JSON_FLAG, repo: { type: 'string' } },
  run: async (context) => {
    const repo = context.flags.required('repo');
    const container = context.container();
    // A repository this queue does not carry has no actions and so says nothing,
    // which is what lets one session brief ask on behalf of every project.
    const actions = await container.list.execute({ repo, states: BRIEF_STATES });
    const view = briefOf(repo, actions, container.clock.now());
    printed(context, view, () => briefLines(view));
  },
};

/** Where the installer writes the `board-queue` command every scheduled pass runs. */
function commandShim(context: CommandContext): string {
  return path.join(context.home, '.local', 'bin', 'board-queue');
}

const installLaunchd: Command = {
  usage: 'install-launchd',
  summary: 'write the macOS scheduler files and print the two commands that start them',
  run: async (context) => {
    const installation = installSchedule({
      home: context.home,
      nodePath: context.nodePath,
      stateDir: stateDir(),
      commandPath: commandShim(context),
    });
    context.out(`wrote ${installation.plistPath}`);
    context.out(`wrote ${installation.launcherPath}`);
    context.out(`it runs ${installation.commandPath} with ${installation.nodePath} `
      + `every ${String(installation.intervalSec)}s`);
    context.out(`and writes to ${installation.logPath}`);
    context.out('run install-launchd again whenever an upgrade moves that Node binary; until then the '
      + 'launcher falls back to whichever node the scheduled job finds on its own search path');
    context.out('nothing is loaded yet; to start it:');
    for (const line of loadCommands(installation)) {
      context.out(`  ${line}`);
    }
  },
};

const installSystemd: Command = {
  usage: 'install-systemd',
  summary: 'write the Linux user units and print the two commands that start them',
  run: async (context) => {
    const installation = installSystemdUnits({
      home: context.home,
      nodePath: context.nodePath,
      stateDir: stateDir(),
      commandPath: commandShim(context),
      configHome: context.configHome,
    });
    context.out(`wrote ${installation.servicePath}`);
    context.out(`wrote ${installation.timerPath}`);
    context.out(`wrote ${installation.launcherPath}`);
    context.out(`it runs ${installation.commandPath} with ${installation.nodePath} `
      + `every ${String(installation.intervalSec)}s`);
    context.out(`and writes to ${installation.logPath}`);
    context.out('run install-systemd again whenever an upgrade moves that Node binary; until then the '
      + 'launcher falls back to whichever node the service finds on its own search path');
    context.out('nothing is enabled yet; to start it:');
    for (const line of enableCommands()) {
      context.out(`  ${line}`);
    }
  },
};

const help: Command = {
  usage: 'help',
  summary: 'this text',
  run: async (context) => {
    for (const line of usageLines()) {
      context.out(line);
    }
  },
};

/**
 * Every command this tool has. The lookup below is the whole of the dispatch, so
 * a new command is one entry here and a function above — never a branch somewhere
 * that has to be found first.
 */
export const commands: Record<string, Command> = {
  enqueue,
  list,
  status,
  release,
  cancel,
  retry,
  show,
  tick,
  audit,
  brief,
  'install-launchd': installLaunchd,
  'install-systemd': installSystemd,
  help,
};

export type CliStreams = {
  out(text: string): void;
  err(text: string): void;
  stdin(): Promise<string>;
  home: string;
  cwd: string;
  nodePath: string;
  configHome: string | null;
};

/**
 * Runs one command and answers the code the shell should see: nothing wrong, a
 * command used wrongly, or a refusal.
 *
 * A refusal is one sentence on the error stream and never a stack: the person
 * reading it wants to know what to do, and the log file already holds the rest.
 */
export async function runCli(argv: readonly string[], streams: CliStreams = processStreams()): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands[name];
  if (command === undefined) {
    for (const line of usageLines()) {
      streams.err(line);
    }
    if (name !== undefined) {
      streams.err(`there is no command called "${name}"`);
    }
    return 2;
  }

  let parsed: { values: Record<string, FlagValue>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...rest],
      options: command.flags ?? {},
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    streams.err(sentenceOf(error));
    streams.err(`usage: board-queue ${command.usage}`);
    return 2;
  }

  const opened: { container: Container | null } = { container: null };
  try {
    await command.run({
      positionals: parsed.positionals,
      flags: new Flags(parsed.values, command.usage),
      out: (line) => {
        streams.out(line);
      },
      container: () => {
        opened.container ??= buildContainer({ config: loadConfig(), stateDir: stateDir() });
        return opened.container;
      },
      stdin: streams.stdin,
      home: streams.home,
      cwd: streams.cwd,
      nodePath: streams.nodePath,
      configHome: streams.configHome,
    });
    return 0;
  } catch (error) {
    if (error instanceof MisusedCommand) {
      streams.err(error.message);
      streams.err(`usage: board-queue ${error.usage}`);
      return 2;
    }
    streams.err(sentenceOf(error));
    return 1;
  } finally {
    opened.container?.close();
  }
}

/** The streams and surroundings of the process this normally runs in. */
export function processStreams(): CliStreams {
  return {
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
    stdin: readStdin,
    home: os.homedir(),
    cwd: process.cwd(),
    nodePath: process.execPath,
    configHome: absoluteOrNull(process.env['XDG_CONFIG_HOME']),
  };
}

/** A directory named by the environment, honoured only when it is absolute. */
function absoluteOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && path.isAbsolute(trimmed) ? trimmed : null;
}

/**
 * Everything piped in. A terminal is never read from: a command run by hand that
 * waited for input nobody meant to give would look like one that hung.
 */
async function readStdin(): Promise<string> {
  const input = process.stdin;
  if (input.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function usageLines(): string[] {
  const lines = ['usage: board-queue <command> [options]', ''];
  for (const command of Object.values(commands)) {
    lines.push(`  ${command.usage}`);
    lines.push(`      ${command.summary}`);
  }
  lines.push(
    '',
    'The queue lives in $BOARD_QUEUE_STATE_DIR, or ~/.claude/state/board-queue; the boards, and the',
    'repositories each one carries, come from ${XDG_CONFIG_HOME:-~/.config}/board-queue/config.json,',
    'or $BOARD_QUEUE_CONFIG.',
  );
  return lines;
}

/** The same answer either way: the words a person reads, or the values a script reads. */
function printed(context: CommandContext, value: unknown, lines: () => string[]): void {
  if (context.flags.on('json')) {
    context.out(JSON.stringify(value, null, 2));
    return;
  }
  for (const line of lines()) {
    context.out(line);
  }
}

function identifier(context: CommandContext, usage: string): string {
  const [id] = context.positionals;
  if (id === undefined || id.trim() === '') {
    throw new MisusedCommand(usage, 'name the action id');
  }
  return id.trim();
}

/**
 * A request as it was typed, or as it was piped in.
 *
 * Naming the repository is what says which of the two was meant, and it is asked
 * for first: a command that was given words to work with must not stop to read a
 * stream nobody is going to close.
 */
async function enqueueRequest(context: CommandContext): Promise<EnqueueRequest> {
  const repo = context.flags.text('repo');
  if (repo !== null) {
    return typedRequest(context, repo);
  }
  const piped = (await context.stdin()).trim();
  if (piped === '') {
    throw new MisusedCommand(
      enqueue.usage,
      'nothing was filed: name --repo and --issue with the fields to set, or pipe in a JSON request',
    );
  }
  return pipedRequest(context, piped);
}

function typedRequest(context: CommandContext, repo: string): EnqueueRequest {
  const kind = context.flags.text('kind') ?? SET_FIELDS;
  if (kind !== SET_FIELDS) {
    throw new MisusedCommand(
      enqueue.usage,
      `these words build a ${SET_FIELDS} request; pipe a ${kind} request in as JSON instead`,
    );
  }
  const fields: Record<string, string> = {};
  for (const word of FIELD_WORDS) {
    const wanted = context.flags.text(word);
    if (wanted !== null) {
      fields[word] = wanted;
    }
  }
  const notBefore = context.flags.text('not-before');
  return {
    kind,
    payload: {
      repo,
      issue: positiveIntegerOf(context.flags.required('issue'), 'an issue number'),
      fields,
    },
    origin: context.flags.text('origin') ?? context.cwd,
    hold: context.flags.on('hold'),
    notBefore: notBefore === null ? null : momentOf(notBefore),
  };
}

function pipedRequest(context: CommandContext, text: string): EnqueueRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RefusedByRule('what was piped in is not readable JSON');
  }
  const request = PipedRequest.safeParse(parsed);
  if (!request.success) {
    throw new RefusedByRule(
      'a piped request is {"kind": …, "payload": {…}} and may add "origin", "hold", "notBefore" and '
      + '"dedupeKey" — '
      + request.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
    );
  }
  const given = request.data;
  return {
    kind: given.kind,
    payload: given.payload,
    origin: given.origin ?? context.cwd,
    hold: given.hold,
    notBefore: given.notBefore === undefined ? null : momentOf(given.notBefore),
    dedupeKey: given.dedupeKey ?? null,
  };
}

/** The listing's narrowing, with a state nobody knows refused by name. */
function filterFrom(context: CommandContext): ActionFilter {
  const states: ActionState[] = [];
  for (const wanted of context.flags.list('state')) {
    if (!isActionState(wanted)) {
      throw new MisusedCommand(list.usage, `there is no state "${wanted}"; there is ${ACTION_STATES.join(', ')}`);
    }
    states.push(wanted);
  }
  const issue = context.flags.text('issue');
  const limit = context.flags.text('limit');
  const filter: ActionFilter = {};
  if (states.length > 0) {
    filter.states = states;
  }
  const repo = context.flags.text('repo');
  if (repo !== null) {
    filter.repo = repo;
  }
  if (issue !== null) {
    filter.issue = positiveIntegerOf(issue, 'an issue number');
  }
  const kind = context.flags.text('kind');
  if (kind !== null) {
    filter.kind = kind;
  }
  if (limit !== null) {
    filter.limit = positiveIntegerOf(limit, 'a limit');
  }
  return filter;
}
