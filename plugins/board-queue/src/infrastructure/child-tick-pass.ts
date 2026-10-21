import { spawn } from 'node:child_process';
import type { PassOutcome } from '../application/service-beat.ts';
import type { PassRunner } from '../application/service-loop.ts';

/** How long an abandoned pass gets to end before it is killed outright. */
const DEFAULT_KILL_GRACE_MS = 10_000;
/** How long a killed pass gets to be reaped before it is reported as stuck. */
const DEFAULT_REAP_GRACE_MS = 5_000;

export type ChildTickPassDeps = {
  /** The program that runs one pass, and its arguments. */
  command: string;
  args: readonly string[];
  /** The whole environment the pass runs with. */
  env: Record<string, string | undefined>;
  killGraceMs?: number;
  reapGraceMs?: number;
  /** Starts the process; the platform's own by default. */
  spawnImpl?: SpawnPass;
};

/** What this needs of a started process: to end it, and to hear how it ended. */
export interface PassProcess {
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnPass = (command: string, args: readonly string[], env: Record<string, string | undefined>) => PassProcess;

const spawnProcess: SpawnPass = (command, args, env) =>
  spawn(command, [...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });

/**
 * One pass as a process of its own, the way a person's scheduler runs it: the
 * same command, the same lock, the configuration read afresh, and nothing a pass
 * allocates outliving it. Its output goes where the service's own goes.
 *
 * Abandoning a pass sends it SIGTERM — the tick has no handler for it, so this
 * ends the pass where it stands — and SIGKILL once the grace is over. A pass
 * that is still not reaped some seconds after that is answered as stuck.
 */
export class ChildTickPass implements PassRunner {
  readonly #deps: ChildTickPassDeps;

  constructor(deps: ChildTickPassDeps) {
    this.#deps = deps;
  }

  run(abandon: AbortSignal): Promise<PassOutcome> {
    const { command, args, env } = this.#deps;
    const killGraceMs = this.#deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const reapGraceMs = this.#deps.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
    const spawnPass = this.#deps.spawnImpl ?? spawnProcess;
    return new Promise<PassOutcome>((resolve) => {
      let settled = false;
      let abandonedFor: string | null = null;
      const timers: NodeJS.Timeout[] = [];
      const settle = (outcome: PassOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
        abandon.removeEventListener('abort', onAbandon);
        resolve(outcome);
      };

      const child = spawnPass(command, args, env);

      function onAbandon(): void {
        const reason = reasonOf(abandon.reason);
        abandonedFor = reason;
        child.kill('SIGTERM');
        timers.push(setTimeout(() => {
          child.kill('SIGKILL');
          timers.push(setTimeout(() => {
            settle({ kind: 'stuck', reason: `${reason}, and it did not end once killed` });
          }, reapGraceMs));
        }, killGraceMs));
      }

      child.once('error', (error) => {
        settle({ kind: 'unstarted', reason: error.message });
      });
      child.once('exit', (code, signal) => {
        if (abandonedFor !== null) {
          settle({ kind: 'abandoned', reason: abandonedFor });
        } else if (code !== null) {
          settle({ kind: 'finished', exitCode: code });
        } else {
          settle({ kind: 'killed', signal: signal ?? 'an unnamed signal' });
        }
      });
      if (abandon.aborted) {
        onAbandon();
      } else {
        abandon.addEventListener('abort', onAbandon, { once: true });
      }
    });
  }
}

function reasonOf(reason: unknown): string {
  return typeof reason === 'string' && reason !== '' ? reason : 'the pass was given up on';
}
