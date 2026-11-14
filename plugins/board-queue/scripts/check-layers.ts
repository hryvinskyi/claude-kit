/**
 * The layer gate: walks `src/`, prints every import that points outward, and
 * exits non-zero when there is one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { violationsIn } from './layer-rule.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(SRC);
const violations = files.flatMap((file) => violationsIn(SRC, file, fs.readFileSync(file, 'utf8')));

if (violations.length > 0) {
  process.stderr.write(`${String(violations.length)} import(s) point outward:\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`layers: ${String(files.length)} files, every import points inward\n`);
}
