import type { DibsTokenSource, DibsTokenSourceName, SyncConfig } from '../domain/sync-config.ts';
import { tokenFromDibsLogin } from './dibs-login.ts';
import type { DibsLoginDeps } from './dibs-login.ts';
import { tokenFromEnvironment } from './dibs-transport.ts';

/** What every source of the token may read: the environment, and where the dibs tool keeps its login. */
export type DibsTokenContext = {
  env: Readonly<Record<string, string | undefined>>;
  server: string;
  project: string;
  platform?: DibsLoginDeps['platform'];
  home?: DibsLoginDeps['home'];
};

type TokenReader<K extends DibsTokenSourceName> = (
  source: DibsTokenSource<K>,
  context: DibsTokenContext,
) => () => string;

/** How each source the configuration may name is read. */
const READERS: { readonly [K in DibsTokenSourceName]: TokenReader<K> } = {
  env: (source, context) => tokenFromEnvironment(context.env, source.env),
  'dibs-login': (_source, context) => tokenFromDibsLogin(context),
};

function readerOf<K extends DibsTokenSourceName>(source: DibsTokenSource<K>, context: DibsTokenContext): () => string {
  const read: TokenReader<K> = READERS[source.from];
  return read(source, context);
}

/**
 * The coordination server's token, from the source the configuration names. It is
 * read at the moment of a call, never before, so a worker that keeps nothing in
 * step never asks for it; nothing it answers, and no refusal, repeats it.
 */
export function dibsToken(
  sync: SyncConfig,
  env: Readonly<Record<string, string | undefined>>,
  where: Pick<DibsTokenContext, 'platform' | 'home'> = {},
): () => string {
  return readerOf(sync.token, { env, server: sync.server, project: sync.project, ...where });
}
