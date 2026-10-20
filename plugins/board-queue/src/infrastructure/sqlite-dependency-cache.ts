import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type { DependencyCache, DependencyFetch, DependencyList, LinkedIssue } from '../application/sync-ports.ts';
import { IssueRef } from '../domain/issue-ref.ts';
import { openQueueDatabase } from './queue-database.ts';

const KeptIssues = z.array(z.object({
  ref: z.string(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
}));

const Row = z.object({
  etag: z.string().nullable(),
  answer: z.string(),
  fetched_at: z.union([z.number(), z.bigint()]),
  issue_updated_at: z.union([z.number(), z.bigint()]).nullable(),
});

/**
 * The dependency answers an import keeps between runs, in the queue's own file:
 * the tag each answer carried, what it said, and when it was fetched. A row this
 * version cannot read is no row, and the list is asked for again.
 */
export class SqliteDependencyCache implements DependencyCache {
  readonly #db: DatabaseSync;
  readonly #read: StatementSync;
  readonly #write: StatementSync;

  constructor(file: string) {
    this.#db = openQueueDatabase(file);
    this.#read = this.#db.prepare(
      'SELECT etag, answer, fetched_at, issue_updated_at FROM import_fetches WHERE key = ?',
    );
    this.#write = this.#db.prepare(
      'INSERT INTO import_fetches (key, etag, answer, fetched_at, issue_updated_at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, answer = excluded.answer, '
      + 'fetched_at = excluded.fetched_at, issue_updated_at = excluded.issue_updated_at',
    );
  }

  close(): void {
    this.#db.close();
  }

  async get(list: DependencyList, ref: IssueRef): Promise<DependencyFetch | null> {
    const row = Row.safeParse(this.#read.get(keyOf(list, ref)));
    if (!row.success) {
      return Promise.resolve(null);
    }
    const issues = issuesFrom(row.data.answer);
    if (issues === null) {
      return Promise.resolve(null);
    }
    const updated = row.data.issue_updated_at;
    return Promise.resolve({
      etag: row.data.etag,
      issues,
      fetchedAt: new Date(Number(row.data.fetched_at)),
      issueUpdatedAt: updated === null ? null : new Date(Number(updated)),
    });
  }

  async put(list: DependencyList, ref: IssueRef, fetch: DependencyFetch): Promise<void> {
    const answer = JSON.stringify(fetch.issues.map((issue) => ({
      ref: issue.ref.toString(),
      title: issue.title,
      state: issue.state,
    })));
    this.#write.run(
      keyOf(list, ref),
      fetch.etag,
      answer,
      fetch.fetchedAt.getTime(),
      fetch.issueUpdatedAt === null ? null : fetch.issueUpdatedAt.getTime(),
    );
    return Promise.resolve();
  }
}

function keyOf(list: DependencyList, ref: IssueRef): string {
  return `${list}:${ref.key()}`;
}

function issuesFrom(text: string): LinkedIssue[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const kept = KeptIssues.safeParse(raw);
  if (!kept.success) {
    return null;
  }
  try {
    return kept.data.map((issue) => ({ ref: IssueRef.parse(issue.ref), title: issue.title, state: issue.state }));
  } catch {
    return null;
  }
}
