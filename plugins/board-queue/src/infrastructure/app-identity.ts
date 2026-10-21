import type { LocalIdentity } from '../application/sync-ports.ts';
import { RefusedByRule } from '../domain/errors.ts';

/** What an App can say about itself: the login GitHub shows for what it does. */
export interface AppSelf {
  appLogin(): Promise<string>;
}

/**
 * The login of the GitHub App this worker runs as, for a worker that is a service
 * rather than a person's machine.
 *
 * It is read from GitHub with the App's own key, never from a file: a
 * configuration copied to another machine names whatever it names, while a
 * machine without the key gets no answer here, so it cannot pass for the service.
 * The App is resolved on the first ask, so an environment that names none, or
 * names it wrongly, is a reason this worker declines rather than a failure to
 * start. A login read once is kept for the life of the process; a failure is not,
 * so the next ask tries again.
 */
export class AppIdentity implements LocalIdentity {
  readonly #resolve: () => AppSelf | null;
  #held: string | null = null;

  constructor(resolve: () => AppSelf | null) {
    this.#resolve = resolve;
  }

  async login(): Promise<string | null> {
    if (this.#held !== null) {
      return this.#held;
    }
    const app = this.#resolve();
    if (app === null) {
      throw new RefusedByRule(
        'this worker runs as its GitHub App, and the environment names none: set GITHUB_APP_ID and '
        + 'GITHUB_APP_PRIVATE_KEY_PATH',
      );
    }
    const login = (await app.appLogin()).trim();
    this.#held = login === '' ? null : login;
    return this.#held;
  }
}
