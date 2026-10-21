import type { Clock } from '../application/ports.ts';
import type { LocalIdentity } from '../application/sync-ports.ts';
import type { BoardPlacement } from '../domain/board-directory.ts';
import { RefusedByRule } from '../domain/errors.ts';
import { AppIdentity } from '../infrastructure/app-identity.ts';
import { GhCliIdentity } from '../infrastructure/gh-cli-identity.ts';
import type { FetchLike } from '../infrastructure/github-http.ts';
import { AppTokenProvider } from '../infrastructure/token-providers.ts';

/** The variable that says whose login this worker answers the owner check with. */
export const IDENTITY_VARIABLE = 'BOARD_QUEUE_IDENTITY';

/**
 * Where a worker's login comes from: a person's machine answers with the login
 * its GitHub command line tool is signed in as; the service answers with its
 * GitHub App's, read with the App's key. Without the variable a worker is a
 * person's.
 */
const SOURCES = {
  gh: () => new GhCliIdentity(),
  app: (deps: IdentityDeps) => new AppIdentity(() => AppTokenProvider.fromEnv(deps.env, deps.board.board, {
    clock: deps.clock,
    fetchImpl: deps.fetchImpl,
  })),
} as const satisfies Record<string, (deps: IdentityDeps) => LocalIdentity>;

export type IdentitySource = keyof typeof SOURCES;

export type IdentityDeps = {
  env: Record<string, string | undefined>;
  /** Any configured board: an App's login is the same whichever account it is installed on. */
  board: BoardPlacement;
  clock: Clock;
  /** Stands in for the network under the App's own calls. */
  fetchImpl?: FetchLike | undefined;
};

/** Whether this worker is the service, whose passes are judged by its App's login. */
export function runsAsTheService(env: Record<string, string | undefined>): boolean {
  return (env[IDENTITY_VARIABLE] ?? '').trim() === 'app';
}

function isSource(name: string): name is IdentitySource {
  return Object.hasOwn(SOURCES, name);
}

/**
 * The source the environment names. A value the variable cannot mean is refused
 * by name rather than read as a person's machine, because a service that silently
 * fell back to `gh` would decline on every pass for a reason nobody looks for.
 */
function sourceOf(env: Record<string, string | undefined>): IdentitySource {
  const named = (env[IDENTITY_VARIABLE] ?? '').trim();
  const source = named === '' ? 'gh' : named;
  if (!isSource(source)) {
    throw new RefusedByRule(
      `${IDENTITY_VARIABLE} is "${source}", which names no identity; it is one of: ${Object.keys(SOURCES).join(', ')}`,
    );
  }
  return source;
}

/**
 * Who this worker runs as: the person its machine is signed in as, or the
 * service's App. A person's login never ends in `[bot]`, so a person's worker
 * handed a configuration whose owner is an App is simply not the owner's.
 */
export function localIdentity(deps: IdentityDeps): LocalIdentity {
  return SOURCES[sourceOf(deps.env)](deps);
}
