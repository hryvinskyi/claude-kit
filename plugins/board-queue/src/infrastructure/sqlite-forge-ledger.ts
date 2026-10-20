import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  ForgeLedger,
  KeptMeasure,
  KeptPull,
  ListingMark,
  Pruned,
  ResolvedCommit,
} from '../application/forge-ports.ts';
import { parseJson } from '../application/json-values.ts';
import type { CommitStatus } from '../domain/forge/commit-status.ts';
import { openQueueDatabase } from './queue-database.ts';

const Moment = z.string().datetime({ offset: true }).transform((text) => new Date(text));
const Integer = z.union([z.number(), z.bigint()]).transform(Number);

const PullRecord = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  mergedAt: Moment.nullable(),
  updatedAt: Moment,
  author: z.string().nullable(),
  headRef: z.string(),
  headRepo: z.string().nullable(),
  headSha: z.string(),
  baseRef: z.string(),
  etag: z.string().nullable(),
  mergeableSent: z.boolean().nullable(),
  reported: z.enum(['merged', 'closed']).nullable(),
});

const PullRow = z.object({ record: z.string() });

const ListingRow = z.object({ cursor_at: Integer.nullable(), listing_etag: z.string().nullable() });

const BranchRow = z.object({ default_branch: z.string().nullable(), default_branch_etag: z.string().nullable() });

const StatusRow = z.object({
  state: z.enum(['success', 'failure']),
  description: z.string(),
  context: z.string(),
});

const MeasureRecord = z.object({
  baseSha: z.string(),
  baseAt: Moment,
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

const MeasureRow = z.object({ etag: z.string().nullable(), measure: z.string() });

const MeasuredBranch = z.object({ base: z.string(), branch: z.string() });

const Counted = z.object({ written: Integer });

const CommitRow = z.object({ repo: z.string(), full_sha: z.string() });

/** How long a status write counts against the hour. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * What the forge jobs keep between passes, in the queue's own file: each
 * repository's listing mark and default branch, the pull requests seen and what
 * the coordination server was told about them, the statuses written and the
 * writes of the last hour, the last measure of each claimed branch, and the
 * commits holds name. A row this version cannot read is no row:
 * the pull request is read again, the status written again, the branch measured
 * again — every one of those is safe to repeat.
 */
export class SqliteForgeLedger implements ForgeLedger {
  readonly #db: DatabaseSync;
  readonly #listing: StatementSync;
  readonly #writeListing: StatementSync;
  readonly #pull: StatementSync;
  readonly #openPulls: StatementSync;
  readonly #writePull: StatementSync;
  readonly #status: StatementSync;
  readonly #writeStatus: StatementSync;
  readonly #defaultBranch: StatementSync;
  readonly #writeDefaultBranch: StatementSync;
  readonly #measure: StatementSync;
  readonly #writeMeasure: StatementSync;
  readonly #measuresOf: StatementSync;
  readonly #forgetMeasure: StatementSync;
  readonly #statusesOn: StatementSync;
  readonly #forgetStatus: StatementSync;
  readonly #noteWrite: StatementSync;
  readonly #forgetWrites: StatementSync;
  readonly #writesSince: StatementSync;
  readonly #commit: StatementSync;
  readonly #writeCommit: StatementSync;
  readonly #pruneStatuses: StatementSync;
  readonly #prunePulls: StatementSync;

  constructor(file: string) {
    this.#db = openQueueDatabase(file);
    const db = this.#db;
    this.#listing = db.prepare('SELECT cursor_at, listing_etag FROM forge_repos WHERE repo = ?');
    this.#writeListing = db.prepare(
      'INSERT INTO forge_repos (repo, cursor_at, listing_etag) VALUES (?, ?, ?) '
      + 'ON CONFLICT(repo) DO UPDATE SET cursor_at = excluded.cursor_at, listing_etag = excluded.listing_etag',
    );
    this.#pull = db.prepare('SELECT record FROM forge_pulls WHERE repo = ? AND number = ?');
    this.#openPulls = db.prepare('SELECT record FROM forge_pulls WHERE repo = ? AND open = 1 ORDER BY number');
    this.#writePull = db.prepare(
      'INSERT INTO forge_pulls (repo, number, open, reported, updated_at, head_sha, record) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(repo, number) DO UPDATE SET open = excluded.open, reported = excluded.reported, '
      + 'updated_at = excluded.updated_at, head_sha = excluded.head_sha, record = excluded.record',
    );
    this.#status = db.prepare(
      'SELECT state, description, context FROM forge_statuses WHERE repo = ? AND sha = ? AND context = ?',
    );
    this.#writeStatus = db.prepare(
      'INSERT INTO forge_statuses (repo, sha, context, state, description, written_at) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(repo, sha, context) DO UPDATE SET state = excluded.state, '
      + 'description = excluded.description, written_at = excluded.written_at',
    );
    this.#defaultBranch = db.prepare('SELECT default_branch, default_branch_etag FROM forge_repos WHERE repo = ?');
    this.#writeDefaultBranch = db.prepare(
      'INSERT INTO forge_repos (repo, default_branch, default_branch_etag) VALUES (?, ?, ?) '
      + 'ON CONFLICT(repo) DO UPDATE SET default_branch = excluded.default_branch, '
      + 'default_branch_etag = excluded.default_branch_etag',
    );
    this.#measure = db.prepare('SELECT etag, measure FROM forge_measures WHERE repo = ? AND base = ? AND branch = ?');
    this.#writeMeasure = db.prepare(
      'INSERT INTO forge_measures (repo, base, branch, etag, measure) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(repo, base, branch) DO UPDATE SET etag = excluded.etag, measure = excluded.measure',
    );
    this.#measuresOf = db.prepare('SELECT base, branch FROM forge_measures WHERE repo = ?');
    this.#forgetMeasure = db.prepare('DELETE FROM forge_measures WHERE repo = ? AND base = ? AND branch = ?');
    this.#statusesOn = db.prepare(
      'SELECT state, description, context FROM forge_statuses WHERE repo = ? AND sha = ? ORDER BY context',
    );
    this.#forgetStatus = db.prepare('DELETE FROM forge_statuses WHERE repo = ? AND sha = ? AND context = ?');
    this.#noteWrite = db.prepare('INSERT INTO forge_status_writes (written_at) VALUES (?)');
    this.#forgetWrites = db.prepare('DELETE FROM forge_status_writes WHERE written_at < ?');
    this.#writesSince = db.prepare('SELECT COUNT(*) AS written FROM forge_status_writes WHERE written_at >= ?');
    this.#commit = db.prepare('SELECT repo, full_sha FROM forge_commits WHERE sha = ?');
    this.#writeCommit = db.prepare(
      'INSERT INTO forge_commits (sha, repo, full_sha) VALUES (?, ?, ?) '
      + 'ON CONFLICT(sha) DO UPDATE SET repo = excluded.repo, full_sha = excluded.full_sha',
    );
    this.#pruneStatuses = db.prepare(
      // A status that still stands on the head of an open pull request is kept
      // however old: it is what a withdrawal reads, and forgetting it would write it again.
      'DELETE FROM forge_statuses WHERE rowid IN (SELECT rowid FROM forge_statuses AS status '
      + 'WHERE written_at < ? AND NOT EXISTS (SELECT 1 FROM forge_pulls AS pull '
      + 'WHERE pull.repo = status.repo AND pull.head_sha = status.sha AND pull.open = 1) '
      + 'ORDER BY written_at LIMIT ?)',
    );
    this.#prunePulls = db.prepare(
      'DELETE FROM forge_pulls WHERE rowid IN (SELECT rowid FROM forge_pulls '
      + 'WHERE open = 0 AND reported = 1 AND updated_at < ? ORDER BY updated_at LIMIT ?)',
    );
  }

  close(): void {
    this.#db.close();
  }

  async listing(repo: string): Promise<ListingMark | null> {
    const row = ListingRow.safeParse(this.#listing.get(keyOf(repo)));
    if (!row.success || row.data.cursor_at === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ cursor: new Date(row.data.cursor_at), etag: row.data.listing_etag });
  }

  async pull(repo: string, number: number): Promise<KeptPull | null> {
    const row = PullRow.safeParse(this.#pull.get(keyOf(repo), number));
    return Promise.resolve(row.success ? pullFrom(row.data.record) : null);
  }

  async openPulls(repo: string): Promise<KeptPull[]> {
    const pulls: KeptPull[] = [];
    for (const raw of this.#openPulls.all(keyOf(repo))) {
      const row = PullRow.safeParse(raw);
      const pull = row.success ? pullFrom(row.data.record) : null;
      if (pull !== null) {
        pulls.push(pull);
      }
    }
    return Promise.resolve(pulls);
  }

  async recordListing(repo: string, mark: ListingMark, pulls: readonly KeptPull[]): Promise<void> {
    this.#transact(() => {
      for (const pull of pulls) {
        this.#putPull(pull);
      }
      this.#writeListing.run(keyOf(repo), mark.cursor.getTime(), mark.etag);
    });
    return Promise.resolve();
  }

  async recordPull(pull: KeptPull): Promise<void> {
    this.#putPull(pull);
    return Promise.resolve();
  }

  async lastStatus(repo: string, sha: string, context: string): Promise<CommitStatus | null> {
    const row = StatusRow.safeParse(this.#status.get(keyOf(repo), sha, context));
    return Promise.resolve(row.success ? row.data : null);
  }

  async recordStatus(repo: string, sha: string, status: CommitStatus, at: Date): Promise<void> {
    this.#writeStatus.run(keyOf(repo), sha, status.context, status.state, status.description, at.getTime());
    return Promise.resolve();
  }

  async statusesOn(repo: string, sha: string): Promise<CommitStatus[]> {
    const statuses: CommitStatus[] = [];
    for (const raw of this.#statusesOn.all(keyOf(repo), sha)) {
      const row = StatusRow.safeParse(raw);
      if (row.success) {
        statuses.push(row.data);
      }
    }
    return Promise.resolve(statuses);
  }

  async forgetStatus(repo: string, sha: string, context: string): Promise<void> {
    this.#forgetStatus.run(keyOf(repo), sha, context);
    return Promise.resolve();
  }

  async noteStatusWrite(at: Date): Promise<void> {
    this.#transact(() => {
      this.#noteWrite.run(at.getTime());
      this.#forgetWrites.run(at.getTime() - HOUR_MS);
    });
    return Promise.resolve();
  }

  async statusWritesSince(since: Date): Promise<number> {
    const row = Counted.safeParse(this.#writesSince.get(since.getTime()));
    return Promise.resolve(row.success ? row.data.written : 0);
  }

  async resolvedCommit(sha: string): Promise<ResolvedCommit | null> {
    const row = CommitRow.safeParse(this.#commit.get(sha.toLowerCase()));
    return Promise.resolve(row.success ? { repo: row.data.repo, sha: row.data.full_sha } : null);
  }

  async recordResolvedCommit(sha: string, resolved: ResolvedCommit): Promise<void> {
    this.#writeCommit.run(sha.toLowerCase(), keyOf(resolved.repo), resolved.sha);
    return Promise.resolve();
  }

  async prune(before: Date, limit: number): Promise<Pruned> {
    let pruned: Pruned = { statuses: 0, pulls: 0 };
    this.#transact(() => {
      pruned = {
        statuses: Number(this.#pruneStatuses.run(before.getTime(), limit).changes),
        pulls: Number(this.#prunePulls.run(before.getTime(), limit).changes),
      };
    });
    return Promise.resolve(pruned);
  }

  async defaultBranch(repo: string): Promise<{ name: string; etag: string | null } | null> {
    const row = BranchRow.safeParse(this.#defaultBranch.get(keyOf(repo)));
    if (!row.success || row.data.default_branch === null) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ name: row.data.default_branch, etag: row.data.default_branch_etag });
  }

  async recordDefaultBranch(repo: string, name: string, etag: string | null): Promise<void> {
    this.#writeDefaultBranch.run(keyOf(repo), name, etag);
    return Promise.resolve();
  }

  async measure(repo: string, base: string, branch: string): Promise<KeptMeasure | null> {
    const row = MeasureRow.safeParse(this.#measure.get(keyOf(repo), base, branch));
    if (!row.success) {
      return Promise.resolve(null);
    }
    const measure = MeasureRecord.safeParse(parseJson(row.data.measure));
    return Promise.resolve(measure.success ? { etag: row.data.etag, measure: measure.data } : null);
  }

  async recordMeasure(repo: string, base: string, branch: string, kept: KeptMeasure): Promise<void> {
    const measure = {
      baseSha: kept.measure.baseSha,
      baseAt: kept.measure.baseAt.toISOString(),
      paths: [...kept.measure.paths],
      truncated: kept.measure.truncated,
    };
    this.#writeMeasure.run(keyOf(repo), base, branch, kept.etag, JSON.stringify(measure));
    return Promise.resolve();
  }

  async forgetMeasuresExcept(
    repo: string,
    keep: readonly { readonly base: string; readonly branch: string }[],
  ): Promise<void> {
    const kept = new Set(keep.map((one) => `${one.base}\n${one.branch}`));
    this.#transact(() => {
      for (const raw of this.#measuresOf.all(keyOf(repo))) {
        const row = MeasuredBranch.safeParse(raw);
        if (row.success && !kept.has(`${row.data.base}\n${row.data.branch}`)) {
          this.#forgetMeasure.run(keyOf(repo), row.data.base, row.data.branch);
        }
      }
    });
    return Promise.resolve();
  }

  #putPull(pull: KeptPull): void {
    const record = {
      repo: keyOf(pull.repo),
      number: pull.number,
      state: pull.state,
      mergedAt: pull.mergedAt === null ? null : pull.mergedAt.toISOString(),
      updatedAt: pull.updatedAt.toISOString(),
      author: pull.author,
      headRef: pull.headRef,
      headRepo: pull.headRepo,
      headSha: pull.headSha,
      baseRef: pull.baseRef,
      etag: pull.etag,
      mergeableSent: pull.mergeableSent,
      reported: pull.reported,
    };
    this.#writePull.run(
      keyOf(pull.repo),
      pull.number,
      pull.state === 'open' ? 1 : 0,
      pull.reported === null ? 0 : 1,
      pull.updatedAt.getTime(),
      pull.headSha,
      JSON.stringify(record),
    );
  }

  #transact(fn: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Repositories are kept in lower case: the forge's names are case-insensitive. */
function keyOf(repo: string): string {
  return repo.toLowerCase();
}

function pullFrom(text: string): KeptPull | null {
  const parsed = PullRecord.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}
