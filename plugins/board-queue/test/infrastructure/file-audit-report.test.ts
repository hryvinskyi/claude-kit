import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AuditReport } from '../../src/application/audit-board.ts';
import { FileAuditReport } from '../../src/infrastructure/file-audit-report.ts';

const FIRST = 'example-org/first-repo';

function reportOf(generatedAt: string, notOnBoard: number[]): AuditReport {
  return {
    generatedAt,
    budgetAfter: 'graphql 4000/5000 until 2026-01-10T09:40:00.000Z',
    repos: {
      [FIRST]: {
        open: notOnBoard.length,
        notOnBoard: notOnBoard.map((number) => ({
          number,
          title: `issue ${String(number)}`,
          url: `https://github.com/${FIRST}/issues/${String(number)}`,
        })),
        emptyFields: [],
        closedNotDone: [],
      },
    },
  };
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'board-queue-report-'));
}

describe('the board report on disk', () => {
  it('writes it where it was told, indented enough to read by eye', async () => {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, 'audit.json');
      await new FileAuditReport(path).save(reportOf('2026-01-10T09:00:00.000Z', [10]));

      const raw = readFileSync(path, 'utf8');
      assert.ok(raw.includes('\n  "repos"'));
      assert.deepEqual(JSON.parse(raw), reportOf('2026-01-10T09:00:00.000Z', [10]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps only the last one, and leaves nothing half-written beside it', async () => {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, 'audit.json');
      const store = new FileAuditReport(path);
      await store.save(reportOf('2026-01-10T09:00:00.000Z', [10, 11, 12]));
      await store.save(reportOf('2026-01-10T15:00:00.000Z', [10]));

      const written: AuditReport = JSON.parse(readFileSync(path, 'utf8')) as AuditReport;
      assert.equal(written.generatedAt, '2026-01-10T15:00:00.000Z');
      assert.deepEqual(readdirSync(directory), ['audit.json']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the report, and the directory it makes, to their owner', async () => {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, 'state', 'audit.json');
      const store = new FileAuditReport(path);
      await store.save(reportOf('2026-01-10T09:00:00.000Z', [10]));
      // The second save replaces a file that is already there, which is the one
      // that would otherwise keep whatever mode it was first given.
      await store.save(reportOf('2026-01-10T15:00:00.000Z', [10]));

      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, 'state')).mode & 0o777, 0o700);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes the directory when a fresh installation has none yet', async () => {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, 'state', 'audit.json');
      await new FileAuditReport(path).save(reportOf('2026-01-10T09:00:00.000Z', []));

      assert.ok(existsSync(path));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
