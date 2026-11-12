import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { RefusedByRule } from '../domain/errors.ts';
import { readOwnerOnlyFile } from './owner-only-file.ts';

/** The variable that names the file the GitHub App's private key is kept in. */
export const APP_KEY_PATH_VAR = 'GITHUB_APP_PRIVATE_KEY_PATH';

/** The App's key, and the file mode it was read with, which says nothing about the key itself. */
export type AppPrivateKey = { key: KeyObject; mode: string };

/**
 * The GitHub App's private key, read only from a file of this account's own that
 * nobody else may read, and only when it holds a private key.
 *
 * Every reader of the key comes through here, so a key that one entry point
 * would refuse is refused by all of them. A file that another account owns, or
 * that its group or everybody else may read, is refused as `UnsafeSecretFile`
 * with the command that makes it safe; a file that is missing, or holds no key,
 * as a plain `RefusedByRule`. No refusal repeats the file's path or what it holds.
 */
export function readAppPrivateKey(path: string): AppPrivateKey {
  const file = readOwnerOnlyFile(path, `the file named by ${APP_KEY_PATH_VAR}`);
  try {
    return { key: createPrivateKey(file.text), mode: file.mode };
  } catch {
    throw new RefusedByRule(`the file named by ${APP_KEY_PATH_VAR} does not hold a private key`);
  }
}
