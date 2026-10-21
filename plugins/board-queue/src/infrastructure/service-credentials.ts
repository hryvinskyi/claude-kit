import { createPrivateKey } from 'node:crypto';
import type { Config } from '../domain/config.ts';
import { RefusedByRule } from '../domain/errors.ts';
import { syncIsOn } from '../domain/sync-config.ts';
import { dibsToken } from './dibs-token.ts';
import { readOwnerOnlyFile } from './owner-only-file.ts';

const APP_ID_VAR = 'GITHUB_APP_ID';
const INSTALLATION_VAR = 'GITHUB_APP_INSTALLATION_ID';
const KEY_PATH_VAR = 'GITHUB_APP_PRIVATE_KEY_PATH';
const PEM_OPENING = '-----BEGIN';

/** What the service runs as, in words fit for its log: the numbers and the key's mode, never the key or its path. */
export type ServiceCredentials = {
  appId: string;
  installationId: string | null;
  keyMode: string;
};

/**
 * Whether this environment can run the service at all, decided before its first
 * pass: a service that started without its App's key would answer every pass
 * with the same refusal, or, worse, fall back to whatever credential the machine
 * happens to hold.
 *
 * It needs the App's id, the path to its key — a file of this account's own, 0400
 * or 0600, that holds a private key — and, when the configuration keeps anything
 * in step, the coordination server's token, from the source the configuration
 * names: a variable, the file that variable's `_FILE` twin names, or a login the
 * dibs tool stored. Each pass runs this
 * again, so a key or token replaced in its file is checked before it is used. The
 * installation may be named, as a number, or left to be looked up. Every refusal
 * names a variable; none repeats what a variable, or the key, holds.
 */
export function checkServiceCredentials(env: Record<string, string | undefined>, config: Config): ServiceCredentials {
  const appId = (env[APP_ID_VAR] ?? '').trim();
  if (!/^\d+$/.test(appId)) {
    throw new RefusedByRule(`the service runs as a GitHub App: set ${APP_ID_VAR} to the App's numeric id`);
  }
  const installationId = (env[INSTALLATION_VAR] ?? '').trim();
  if (installationId !== '' && !/^\d+$/.test(installationId)) {
    throw new RefusedByRule(`${INSTALLATION_VAR} is not a number; name the installation's id, or leave it unset`);
  }
  const keyPath = (env[KEY_PATH_VAR] ?? '').trim();
  if (keyPath === '') {
    throw new RefusedByRule(`the service runs as a GitHub App: set ${KEY_PATH_VAR} to the path of the App's key`);
  }
  if (keyPath.includes(PEM_OPENING)) {
    throw new RefusedByRule(`${KEY_PATH_VAR} holds a key rather than the path to one; name the key's file instead`);
  }
  const key = readOwnerOnlyFile(keyPath, `the file named by ${KEY_PATH_VAR}`);
  try {
    createPrivateKey(key.text);
  } catch {
    throw new RefusedByRule(`the file named by ${KEY_PATH_VAR} does not hold a private key`);
  }
  const keyMode = key.mode;

  const sync = config.dibs;
  if (sync === undefined || !syncIsOn(sync)) {
    throw new RefusedByRule(
      'the service keeps nothing in step: turn on the mirror, the importer or the forge jobs in the configuration',
    );
  }
  dibsToken(sync, env)();
  return { appId, installationId: installationId === '' ? null : installationId, keyMode };
}
