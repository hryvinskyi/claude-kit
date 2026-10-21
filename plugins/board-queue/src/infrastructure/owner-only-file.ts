import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { RefusedByRule } from '../domain/errors.ts';

/** The permission bits of anybody but a file's owner: a secret's file carries none of them. */
const GROUP_AND_WORLD = 0o077;

export type OwnerOnlyText = { text: string; mode: string };

/**
 * The text of a file that holds a secret, read only when the file is this
 * process's own and nobody else's.
 *
 * The file is opened once and every check is made on what was opened, so what
 * is read is exactly what was checked — a file swapped in between a look and a
 * read is never read. `named` says how the file is spoken of in a refusal (the
 * variable that names it); no refusal repeats its path or anything it holds.
 */
export function readOwnerOnlyFile(path: string, named: string): OwnerOnlyText {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    throw new RefusedByRule(`${named} is not there, or this account cannot read it`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new RefusedByRule(`${named} is not a file`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new RefusedByRule(`${named} belongs to another account; it must be this account's own`);
    }
    const mode = stat.mode & 0o777;
    if ((mode & GROUP_AND_WORLD) !== 0) {
      throw new RefusedByRule(
        `${named} is mode ${mode.toString(8)}; take every permission away from its group and from everybody else, `
        + 'so that its owner alone may read it (chmod go-rwx)',
      );
    }
    return { text: readFileSync(descriptor, 'utf8'), mode: `0${mode.toString(8)}` };
  } finally {
    closeSync(descriptor);
  }
}
