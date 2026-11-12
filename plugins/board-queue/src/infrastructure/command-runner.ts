import { execFileSync } from 'node:child_process';
import { z } from 'zod';

/** Running a command and answering what it printed, narrow enough for a test to stand in for. */
export type CommandRunner = (command: string, args: readonly string[]) => string;

/** How long a local command may run before it is killed; it reads local state and answers at once. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export type CommandDeadline = {
  /** How long the command may run; it is killed outright once this has passed. */
  timeoutMs?: number;
  /** Whether what the command writes to its error stream is kept for the error, or dropped. */
  errors: 'pipe' | 'ignore';
  /** The environment the command runs with; the process's own by default. */
  env?: NodeJS.ProcessEnv;
};

const TimedOutRun = z.object({ code: z.literal('ETIMEDOUT') });
const ExitStatus = z.object({ status: z.number() });

/**
 * A runner whose command cannot outlive its deadline: one that has not answered
 * when the time is up is killed with SIGKILL, which no handler of its own can
 * hold off, and the run fails as one that timed out.
 */
export function commandWithDeadline(deadline: CommandDeadline): CommandRunner {
  const timeoutMs = deadline.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return (command, args) => execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', deadline.errors],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    ...(deadline.env === undefined ? {} : { env: deadline.env }),
  });
}

/**
 * How a failed run ended, in words fit for a person: its deadline passed, it
 * exited with a code, or it could not be started. What it printed is never
 * among them, because a credential is exactly what such a command prints.
 */
export function howTheRunFailed(cause: unknown): string {
  if (TimedOutRun.safeParse(cause).success) {
    return 'because it did not answer within its deadline and was killed';
  }
  const exited = ExitStatus.safeParse(cause);
  return exited.success ? `with exit code ${String(exited.data.status)}` : 'and could not be run';
}
