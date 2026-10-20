import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isActionState, ACTION_STATES } from '../application/action-states.ts';
import type { ActionFilter } from '../application/ports.ts';
import type { BoardDirectory } from '../domain/board-directory.ts';
import type { Config } from '../domain/config.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import type { Container } from './container.ts';
import { sentenceOf } from './failure-text.ts';
import { momentOf } from './input-text.ts';

const SERVER_NAME = 'board-queue';
const SERVER_VERSION = '0.1.0';

/**
 * The queue, offered to a session as tools.
 *
 * Two rules shape everything below. This process writes nothing to its own
 * standard output — that stream is the protocol itself, and a stray line on it
 * ends the session's connection — so anything worth recording goes to the log
 * file the container built. And no tool here touches the board on the caller's
 * behalf except to read one row: filing work and doing it are deliberately
 * different processes, because the doing has to be paced against an allowance
 * that every session on the account shares.
 */
export function createMcpServer(container: Container): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'board_enqueue',
    {
      description: enqueueDescription(container.config, container.directory, container.kinds),
      inputSchema: {
        kind: choiceOf(container.kinds.names(), 'an action kind').describe('which sort of work this is'),
        payload: z.record(z.string(), z.unknown()).describe('the fields the chosen kind takes'),
        origin: z.string().min(1).optional()
          .describe('who is filing it; the directory this server runs in by default'),
        hold: z.boolean().optional()
          .describe('file it, but do not run it until board_release says the moment has come'),
        notBefore: z.string().datetime({ offset: true }).optional()
          .describe('do not run it before this moment, as an ISO 8601 timestamp, at most thirty days away'),
      },
    },
    async (args) => guarded(() => container.enqueue.execute({
      kind: args.kind,
      payload: args.payload,
      origin: args.origin ?? process.cwd(),
      hold: args.hold,
      notBefore: args.notBefore === undefined ? null : momentOf(args.notBefore),
    })),
  );

  server.registerTool(
    'board_queue',
    {
      description: [
        'List what is in the queue, oldest first, with each action\'s state, its payload as it was filed, how',
        'often it has been attempted and the error that stopped it. Filters narrow it; with none, the whole',
        'queue comes back. This reads the queue only and costs no API allowance.',
      ].join(' '),
      inputSchema: {
        states: z.array(choiceOf(ACTION_STATES, 'an action state')).optional()
          .describe('only actions in these states'),
        repo: z.string().min(1).optional().describe('only actions on this repository, written owner/name'),
        issue: z.number().int().positive().optional().describe('only actions on this issue number'),
        kind: z.string().min(1).optional().describe('only actions of this kind'),
        limit: z.number().int().positive().optional().describe('at most this many'),
      },
    },
    async (args) => guarded(() => container.list.execute(filterFrom(args))),
  );

  server.registerTool(
    'board_status',
    {
      description: [
        'What the queue is doing: how many actions are in each state, whether it is waiting out a rate limit,',
        'when the worker last ran, what the last answer said was left of the allowance, the blocked actions',
        'with the error that stopped each one, and the held actions with how many days each has been waiting.',
        'A held action nobody released is the thing to look for here. Where the deployment keeps the boards in',
        'step with a coordination server, it also says whether the mirror and the importer are on, what each did',
        'last, and why this worker declined when it is not the one that runs them. This reads the queue only and',
        'costs no API allowance.',
      ].join(' '),
      inputSchema: {},
    },
    async () => guarded(() => container.status.execute()),
  );

  server.registerTool(
    'board_release',
    {
      description: [
        'Run a held action at the next tick: the deploy it was waiting for is live, or whatever else held it',
        'has happened. Only a held action can be released.',
      ].join(' '),
      inputSchema: { id: z.string().min(1).describe('the action id board_enqueue answered with') },
    },
    async ({ id }) => guarded(() => container.release.execute(id)),
  );

  server.registerTool(
    'board_cancel',
    {
      description: [
        'Take an action off the queue for good. An action the worker is running at this moment is not',
        'cancelled: it is out at the API, and a row that read "cancelled" while the write landed would be a',
        'lie about the board.',
      ].join(' '),
      inputSchema: { id: z.string().min(1).describe('the action id') },
    },
    async ({ id }) => guarded(() => container.cancel.execute(id)),
  );

  server.registerTool(
    'board_retry',
    {
      description: [
        'Put a blocked or failed action back on the queue with its attempts reset. Use it once you have fixed',
        'what the action reported — added the option to the board, found the issue that was missing. Nothing',
        'retries itself: an action is blocked because something outside this queue has to change first.',
      ].join(' '),
      inputSchema: { id: z.string().min(1).describe('the action id') },
    },
    async ({ id }) => guarded(() => container.retry.execute(id)),
  );

  server.registerTool(
    'board_show',
    {
      description: [
        'What the board that carries the repository says about one issue: whether it has a row and which option',
        'each field carries, plus what the last answer said was left of the allowance. That whole board is read',
        'in one walk of a few points and reused for a minute, so asking about several issues in a row costs no',
        'more than the first. This is the only tool here that talks to a board, and it only reads — and it is',
        'refused while the queue is waiting out a rate limit, because it would spend exactly what the queue is',
        'waiting for.',
      ].join(' '),
      inputSchema: {
        repo: z.string().min(1).describe('the repository, written owner/name'),
        issue: z.number().int().positive().describe('the issue number'),
      },
    },
    async ({ repo, issue }) => guarded(() => container.show.execute(repo, issue)),
  );

  return server;
}

/**
 * Everything a caller has to know before filing work, said once: what the kinds
 * are, which repositories this queue may touch and which board carries each, and
 * the four rules that would otherwise be learnt from an action sitting in the
 * queue doing nothing.
 */
function enqueueDescription(config: Config, directory: BoardDirectory, kinds: KindRegistry): string {
  const lines: string[] = [
    'File one piece of outward work on a board or on an issue. Nothing happens while you wait: a worker '
    + 'drains this queue every five minutes, reads what is left of the hourly API allowance out of the '
    + 'answers themselves and paces its writes inside it. So never write to the board yourself, and never '
    + 'retry a filed action — filing it again files it twice.',
    '',
    'The kinds, and what each one takes as its payload:',
  ];
  for (const kind of kinds.all()) {
    lines.push(`- ${kind.name} — ${kind.describe}`);
  }
  lines.push(
    '',
    `The repository must be one of: ${directory.repos().join(', ')}. Anything else is refused as you file it, `
    + 'which is what catches a session filing work against the wrong checkout. Each issue is written to the '
    + 'board that carries its repository, and to no other:',
  );
  for (const placement of directory.boards()) {
    lines.push(`- board ${placement.name} carries ${placement.repos.join(', ')}`);
  }
  if (config.refusedStatus.length > 0) {
    lines.push(
      `The board status ${config.refusedStatus.join(', ')} is refused: the board's own automation reacts to `
      + 'it by closing the issue, and it would do so before the evidence comment exists. File an issue.close '
      + 'instead and let the board move the row itself.',
    );
  }
  lines.push(
    'Use hold: true for work that waits on something outside this queue — a move that is only true once a '
    + 'deploy is live — and board_release when it is. A held request is never folded into one that is already '
    + 'waiting, so what you hold stays held. Use notBefore for work that waits on a date rather than an '
    + 'event; more than thirty days off is refused, because nothing would ever notice it again.',
    'A warning in the answer means a wanted option did not match the board catalog as it was last read. Check '
    + 'the spelling now: an option the board does not offer blocks the action when the worker reaches it.',
    'A blocked action waits for a person. Fix what it reports, then run board_retry with its id.',
  );
  return lines.join('\n');
}

/** Only the states this system knows; a name it does not know is refused by the schema. */
function filterFrom(args: {
  states?: string[];
  repo?: string;
  issue?: number;
  kind?: string;
  limit?: number;
}): ActionFilter {
  return {
    states: args.states?.filter(isActionState),
    repo: args.repo,
    issue: args.issue,
    kind: args.kind,
    limit: args.limit,
  };
}

/**
 * The known values as a choice, so a caller sees them in the tool's own schema
 * rather than learning them from a refusal.
 */
function choiceOf(values: readonly string[], what: string): z.ZodEnum<[string, ...string[]]> {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error(`there is nothing registered to choose from for ${what}`);
  }
  return z.enum([first, ...rest]);
}

/** Runs one tool and answers in the protocol's terms, a refusal included. */
async function guarded(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: sentenceOf(error) }], isError: true };
  }
}
