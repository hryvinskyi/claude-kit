import { execFileSync } from 'node:child_process';
import type { LocalIdentity } from '../application/sync-ports.ts';

/** Running a command and answering what it printed, narrow enough for a test to stand in for. */
export type CommandOutput = (command: string, args: readonly string[]) => string;

const runCommand: CommandOutput = (command, args) =>
  execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The login the GitHub command line tool is signed in as on this machine, read
 * from its own configuration: nothing goes over the network, and nothing a
 * credential would be printed by is run. A tool that is missing, or signed in to
 * nobody, answers no login.
 */
export class GhCliIdentity implements LocalIdentity {
  readonly #run: CommandOutput;
  readonly #host: string;

  constructor(run: CommandOutput = runCommand, host = 'github.com') {
    this.#run = run;
    this.#host = host;
  }

  async login(): Promise<string | null> {
    let output: string;
    try {
      output = this.#run('gh', ['config', 'get', '-h', this.#host, 'user']);
    } catch {
      return Promise.resolve(null);
    }
    const login = output.trim();
    return Promise.resolve(login === '' ? null : login);
  }
}
