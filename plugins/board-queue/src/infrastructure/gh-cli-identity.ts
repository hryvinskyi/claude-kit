import type { LocalIdentity } from '../application/sync-ports.ts';
import { commandWithDeadline } from './command-runner.ts';
import type { CommandRunner } from './command-runner.ts';

/**
 * The login the GitHub command line tool is signed in as on this machine, read
 * from its own configuration: nothing goes over the network, and nothing a
 * credential would be printed by is run. A tool that is missing, signed in to
 * nobody, or still not answering at its deadline (it is killed then) answers no
 * login.
 */
export class GhCliIdentity implements LocalIdentity {
  readonly #run: CommandRunner;
  readonly #host: string;

  constructor(run: CommandRunner = commandWithDeadline({ errors: 'ignore' }), host = 'github.com') {
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
