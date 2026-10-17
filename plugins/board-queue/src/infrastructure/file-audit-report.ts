import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The report names every issue on the board; it is the owner's reading alone. */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
import type { AuditReport, AuditReportSink } from '../application/audit-board.ts';

/**
 * The last report, as one indented JSON file somebody can open or pipe through
 * `jq`.
 *
 * Only the latest one is kept: every finding in it is a question about the board
 * as it is now, and a stack of older answers would mostly list things that have
 * since been fixed. It is written beside the file and moved into place, so a
 * reader opening it while a pass is writing sees the previous report whole rather
 * than half of the new one.
 */
export class FileAuditReport implements AuditReportSink {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  save(report: AuditReport): Promise<void> {
    mkdirSync(dirname(this.#filePath), { recursive: true, mode: OWNER_ONLY_DIR });
    const partial = `${this.#filePath}.writing`;
    writeFileSync(partial, `${JSON.stringify(report, null, 2)}\n`, { mode: OWNER_ONLY_FILE });
    // A file that was already there keeps its own mode, so the permissions are
    // stated again rather than assumed from the write above.
    chmodSync(partial, OWNER_ONLY_FILE);
    renameSync(partial, this.#filePath);
    return Promise.resolve();
  }
}
