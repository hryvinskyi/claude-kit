import { z } from 'zod';
import { parseJson } from './json-values.ts';
import type { ActionRepository, MetaWrite } from './ports.ts';

/**
 * What the two directions of keeping in step with a coordination server leave
 * behind for the next run and for a status report. The keys and the shapes live
 * here, so the writer and every reader agree on them; anything read back is
 * parsed, and a note this version cannot read counts as no note.
 */

const MIRROR_LAST_RUN = 'mirror.lastRun';
const IMPORT_LAST_ATTEMPT_AT = 'import.lastAttemptAt';
const IMPORT_LAST_RUN = 'import.lastRun';
/** How many items were open at the last import that said it was complete. */
export const IMPORT_LAST_COMPLETE_OPEN = 'import.lastCompleteOpen';
const SYNC_REFUSED = 'sync.refused';
const FORGE_LAST_RUN = 'forge.lastRun';

const Moment = z.string().datetime({ offset: true });

const MirrorRunSchema = z.object({
  at: Moment,
  /** Events read from the log, claim events or not. */
  events: z.number().int().nonnegative(),
  /** Actions written to the queue. */
  filed: z.number().int().nonnegative(),
  /** Actions that were already in the queue under the same key. */
  duplicates: z.number().int().nonnegative(),
  /** Moves about an issue the configuration does not keep in step, or an item with no issue. */
  ignored: z.number().int().nonnegative(),
  /** Moves the queue's rules refused; each one is in the log. */
  refused: z.number().int().nonnegative(),
  /** Moves passed over because the item's reference could not be read; each one is in the log. */
  unresolved: z.number().int().nonnegative(),
  /** Where the next run reads from. */
  cursor: z.number().int().nonnegative(),
  /** Why the run stopped short, when it did. */
  error: z.string().nullable(),
  /**
   * Set when the log no longer kept what came after the cursor, until the current
   * claims have been filed in place of the events that were lost.
   */
  cursorExpired: z.object({ at: Moment, prunedThrough: z.number().int().nonnegative() }).nullable(),
  /** When the mirror last started from the head of the log, at which event, and why. */
  startedFromHead: z.object({ at: Moment, event: z.number().int().nonnegative(), because: z.string() }).nullable(),
  /** The member whose moves alone this run filed; null when it filed everybody's. */
  filedFor: z.string().nullable().default(null),
  /** Moves another person caused, left to that person's own worker. */
  othersMoves: z.number().int().nonnegative().default(0),
  /** Moves no person's worker can file — their author is unnamed, removed or has no GitHub login — filed here. */
  orphanMoves: z.number().int().nonnegative().default(0),
  /** Moves passed over because the server no longer shows the state they left. */
  staleMoves: z.number().int().nonnegative().default(0),
  /** Why this run filed nothing and read nothing, when whose moves to file could not be settled. */
  declined: z.string().nullable().default(null),
  /** A configured owner the project does not know, so that nobody files the moves no person's worker can. */
  ownerWarning: z.string().nullable().default(null),
});

export type MirrorRun = z.infer<typeof MirrorRunSchema>;

const ImportRunSchema = z.object({
  at: Moment,
  /** Items sent, listed and carried. */
  items: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  /** Whether the last batch said it named every open item, so the server closed the rest. */
  complete: z.boolean(),
  /** How many listed items were open. */
  open: z.number().int().nonnegative(),
  /** Why it did not, when it did not. */
  incompleteBecause: z.string().nullable(),
  /** Dependency requests made, and how many of them answered "unchanged". */
  requests: z.number().int().nonnegative(),
  notModified: z.number().int().nonnegative(),
  /** What the walks of the boards cost, as the API priced them; null when no walk said. */
  readCost: z.number().nonnegative().nullable(),
  /** Edges the server would not record, a cycle among them. */
  refusedEdges: z.number().int().nonnegative(),
  /** Why the run stopped short, when it did — a limiter's refusal, an unreachable server. */
  stoppedBecause: z.string().nullable(),
});

export type ImportRun = z.infer<typeof ImportRunSchema>;

const Count = z.number().int().nonnegative();

const ForgeRepositoryRunSchema = z.object({
  repo: z.string(),
  /** How far its listing of pull requests has read; null before the first listing. */
  cursor: Moment.nullable(),
  /** Whether this pass started its listing from now, taking in only the pull requests open at the moment. */
  seeded: z.boolean(),
  /** Pull requests read in the listing's window. */
  listed: Count,
  /** Whether the coordination server lists this repository; one it does not gets no status and no footprint. */
  listedByServer: z.boolean(),
  /** Merges and closes reported. */
  merged: Count,
  closed: Count,
  /** Merges reported without their files, because those could not be read. */
  mergesWithoutFiles: Count,
  /** Reports the server refused; each one is in the log, and none is sent again by the listing. */
  refusedReports: Count,
  /** Reports of whether a pull request merges cleanly. */
  mergeability: Count,
  statuses: Count,
  /** Statuses taken back because the repository, the context or the author no longer called for one. */
  statusesWithdrawn: Count,
  /** Statuses left for the next pass because this pass, or the hour, wrote as many as it may. */
  statusesDeferred: Count,
  footprints: Count,
  /** Claimed branches the forge no longer has; nothing was sent for them. */
  branchesGone: Count,
  holdsReleased: Count,
  /** Requests for one thing that failed; each one is in the log, and the pass went on. */
  failures: Count,
  /** Why the listing did not read this pass, when it did not. */
  listingError: z.string().nullable(),
  /** Why this repository's jobs ended early, when they did: GitHub did not answer. */
  stoppedBecause: z.string().nullable(),
});

const ForgeRunSchema = z.object({
  at: Moment,
  /** Requests made to GitHub, and how many of them answered "unchanged". */
  requests: Count,
  notModified: Count,
  repos: z.array(ForgeRepositoryRunSchema),
  /** Why the pass stopped short, when it did: a limiter's refusal, an unreachable server, its time or allowance. */
  stoppedBecause: z.string().nullable(),
  /** Why the pass did not start at all, when it did not: this worker is not where the jobs may run. */
  refused: z.string().nullable(),
  /** Rows the pass forgot because no pass needs them any more. */
  pruned: z.object({ statuses: Count, pulls: Count }),
});

export type ForgeRepositoryRun = z.infer<typeof ForgeRepositoryRunSchema>;
export type ForgeRun = z.infer<typeof ForgeRunSchema>;

/** Why a worker declined the jobs that run only in the owner's: its login could not be read, or it is somebody else. */
export const OwnerRefusalSchema = z.enum(['identity-unreadable', 'not-the-owner']);

export type OwnerRefusal = z.infer<typeof OwnerRefusalSchema>;

const RefusalSchema = z.object({
  at: Moment,
  reason: z.string(),
  /** Absent from a note an earlier version wrote. */
  refusal: OwnerRefusalSchema.optional(),
});

export type SyncRefusal = z.infer<typeof RefusalSchema>;

/** Where the mirror reads the log from; a cursor of another server or project is never mistaken for it. */
export function mirrorCursorKey(server: string, project: string): string {
  return `mirror.cursor:${server}:${project}`;
}

/** The last event whose state the mirror filed for one work item. */
export function mirrorItemKey(server: string, project: string, item: number): string {
  return `mirror.item:${server}:${project}:${String(item)}`;
}

/** A work item's outside reference, as the server answered it once; an empty value is an item with none. */
export function mirrorRefKey(server: string, project: string, item: number): string {
  return `mirror.ref:${server}:${project}:${String(item)}`;
}

/** The GitHub login a member named when the members were last read, kept after the member is gone. */
export function mirrorLoginKey(server: string, project: string, handle: string): string {
  return `mirror.login:${server}:${project}:${handle}`;
}

/** Where the mirror stands: never started, at a cursor, or at a note that is not a cursor at all. */
export type StoredCursor =
  | { readonly kind: 'none' }
  | { readonly kind: 'at'; readonly cursor: number }
  | { readonly kind: 'unreadable'; readonly stored: string };

const CursorText = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe());

export async function readMirrorCursor(repository: ActionRepository, key: string): Promise<StoredCursor> {
  const stored = await repository.getMeta(key);
  if (stored === null) {
    return { kind: 'none' };
  }
  const cursor = CursorText.safeParse(stored);
  return cursor.success ? { kind: 'at', cursor: cursor.data } : { kind: 'unreadable', stored };
}

/** A number kept as a note, or null when there is none or it is not one. */
export async function readCount(repository: ActionRepository, key: string): Promise<number | null> {
  const parsed = CursorText.safeParse(await repository.getMeta(key));
  return parsed.success ? parsed.data : null;
}

export function mirrorCursorWrite(key: string, cursor: number): MetaWrite {
  return { key, value: String(cursor) };
}

export async function readMirrorRun(repository: ActionRepository): Promise<MirrorRun | null> {
  return readJson(repository, MIRROR_LAST_RUN, MirrorRunSchema);
}

export async function writeMirrorRun(repository: ActionRepository, run: MirrorRun): Promise<void> {
  await repository.setMeta(MIRROR_LAST_RUN, JSON.stringify(run));
}

export async function readImportRun(repository: ActionRepository): Promise<ImportRun | null> {
  return readJson(repository, IMPORT_LAST_RUN, ImportRunSchema);
}

export async function writeImportRun(repository: ActionRepository, run: ImportRun): Promise<void> {
  await repository.setMeta(IMPORT_LAST_RUN, JSON.stringify(run));
}

export async function readForgeRun(repository: ActionRepository): Promise<ForgeRun | null> {
  return readJson(repository, FORGE_LAST_RUN, ForgeRunSchema);
}

export async function writeForgeRun(repository: ActionRepository, run: ForgeRun): Promise<void> {
  await repository.setMeta(FORGE_LAST_RUN, JSON.stringify(run));
}

/** When an import was last started, finished or not; it is what holds the cadence. */
export async function readImportAttemptAt(repository: ActionRepository): Promise<Date | null> {
  const stored = await repository.getMeta(IMPORT_LAST_ATTEMPT_AT);
  const parsed = Moment.safeParse(stored);
  return parsed.success ? new Date(parsed.data) : null;
}

export async function writeImportAttemptAt(repository: ActionRepository, at: Date): Promise<void> {
  await repository.setMeta(IMPORT_LAST_ATTEMPT_AT, at.toISOString());
}

/** Why this worker declined to keep in step at its last tick, or nothing when it did not decline. */
export async function readSyncRefusal(repository: ActionRepository): Promise<SyncRefusal | null> {
  return readJson(repository, SYNC_REFUSED, RefusalSchema);
}

export async function writeSyncRefusal(repository: ActionRepository, refusal: SyncRefusal | null): Promise<void> {
  await repository.setMeta(SYNC_REFUSED, refusal === null ? 'null' : JSON.stringify(refusal));
}

async function readJson<T>(
  repository: ActionRepository,
  key: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T | null> {
  const stored = await repository.getMeta(key);
  if (stored === null) {
    return null;
  }
  const parsed = schema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : null;
}
