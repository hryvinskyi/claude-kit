import { z } from 'zod';
import type { CatalogField, CatalogOption, FieldCatalog, FieldReading, ReadItemResult } from '../catalog.ts';
import { findCatalogField, resolveOption } from '../catalog.ts';
import type { Config } from '../config.ts';
import { BoardQueueError, PreconditionUnmet, ReadbackMismatch, RefusedByRule } from '../errors.ts';
import { FieldRequest, STATUS_FIELD, namesRefusedStatus } from '../field-request.ts';
import type { FieldRequestMode } from '../field-request.ts';
import type { IssueRef } from '../issue-ref.ts';
import { isRepoFullName } from '../issue-ref.ts';
import type { ExecutionContext } from './action-kind.ts';

/**
 * The short payload keys callers type, and the board fields they mean. The board
 * spells one of them with a space, which is why a payload key is not simply the
 * field name; the configuration decides the exact spelling of each field.
 */
export const BOARD_FIELD_OF: Record<string, string> = {
  status: 'Status',
  severity: 'Severity',
  module: 'Module',
  environment: 'Environment',
  type: 'Defect type',
};

const optional = z.string().trim().min(1).optional();

const FieldValuesSchema = z
  .object({
    status: optional,
    severity: optional,
    module: optional,
    environment: optional,
    type: optional,
  })
  .strict();

/** Every key a payload may name a board field by. */
export const FIELD_KEYS = FieldValuesSchema.keyof().options;

export const FieldShapeSchema = FieldValuesSchema
  .refine(
    (shape) => Object.values(shape).some((value) => value !== undefined),
    'name at least one field',
  );

export type FieldShape = z.infer<typeof FieldShapeSchema>;

export const RepoSchema = z.string().trim().refine(isRepoFullName, 'a repository is written owner/name');
export const IssueNumberSchema = z.number().int().positive();

/**
 * The longest text GitHub accepts as an issue body or a comment. A longer one is
 * refused with a 422, which reads as a fault of the moment and is retried five
 * times before the action gives up — so the length is a rule of this system too,
 * checked where the person who typed it can still do something about it.
 */
export const MAX_BODY_LENGTH = 65_536;

export const BodyTextSchema = z.string().min(1).max(MAX_BODY_LENGTH);

/**
 * The statuses a row may carry for a write to go ahead; an empty text stands for
 * a row whose status is not set at all.
 */
export const StatusPreconditionSchema = z.array(z.string().trim().max(200)).min(1);

/** A field value a guarded write left as it was, because the row no longer read as the guard said. */
export type LeftAsItWas = {
  field: string;
  wanted: string;
  expected: string;
  actual: string;
};

/** What a write landed, as the row reads it back, and what it left alone. */
export type AppliedFields = {
  readback: Record<string, string>;
  leftAsItWas: LeftAsItWas[];
};

const BUILD: Record<FieldRequestMode, (wanted: Record<string, string>, config: Config) => FieldRequest> = {
  write: FieldRequest.forWrite,
  read: FieldRequest.forRead,
};

/**
 * Turns the short payload shape into a request against the board's own field
 * names. A write goes through the rules that refuse a status this system must not
 * write; a read is an expectation and accepts every value.
 */
export function fieldRequestFrom(fields: FieldShape, config: Config, mode: FieldRequestMode): FieldRequest {
  const wanted: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    wanted[BOARD_FIELD_OF[key] ?? key] = value;
  }
  return BUILD[mode](wanted, config);
}

/**
 * Runs the field rules while a payload is being validated, so a request nobody
 * may make is refused at the moment it is made rather than five minutes later in
 * a worker log. A refusal becomes an issue on the `fields` path, in the words the
 * domain used.
 */
export function checkFields(
  fields: FieldShape,
  config: Config,
  mode: FieldRequestMode,
  ctx: z.RefinementCtx,
  path: string,
): void {
  try {
    fieldRequestFrom(fields, config, mode);
  } catch (error) {
    if (!(error instanceof BoardQueueError)) {
      throw error;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: error.describe() });
  }
}

/** A wanted text, matched to the board's own field and option. */
export type ResolvedField = {
  field: CatalogField;
  option: CatalogOption;
};

type Resolution =
  | { ok: true; resolved: ResolvedField[] }
  | { ok: false; error: BoardQueueError };

function resolveAgainst(request: FieldRequest, catalog: FieldCatalog): Resolution {
  const resolved: ResolvedField[] = [];
  for (const [name, wanted] of request.entries()) {
    const field = findCatalogField(catalog, name);
    if (field === null) {
      return {
        ok: false,
        error: new RefusedByRule(
          `the board has no field called "${name}"; it has ${catalog.fields.map((one) => one.name).join(', ')}`,
        ),
      };
    }
    try {
      resolved.push({ field, option: resolveOption(field, wanted) });
    } catch (error) {
      if (!(error instanceof BoardQueueError)) {
        throw error;
      }
      return { ok: false, error };
    }
  }
  return { ok: true, resolved };
}

/**
 * The board's own fields and options behind the texts a caller typed.
 *
 * A text the catalog cannot answer for earns exactly one fresh look: the catalog
 * is kept for an hour, and somebody who adds an option in the board's own
 * interface expects the next request to use it rather than to wait out a cache.
 * A second miss is final and carries the list the field accepts, because guessing
 * which option was meant is how a row ends up in the wrong column.
 */
export async function resolveWanted(request: FieldRequest, ctx: ExecutionContext): Promise<ResolvedField[]> {
  const cached = resolveAgainst(request, await ctx.board.catalog());
  if (cached.ok) {
    return cached.resolved;
  }
  const fresh = resolveAgainst(request, await ctx.board.catalog(true));
  if (fresh.ok) {
    return fresh.resolved;
  }
  throw fresh.error;
}

/**
 * The second of the two guards on the status this system must not write. The
 * first one refuses the request when somebody makes it; this one refuses it when
 * it runs, because the text in the payload is not the value that reaches the
 * board — a prefix does, and the option it resolves to is what the board's
 * auto-close workflow would see.
 */
function refuseForbiddenStatus(resolved: readonly ResolvedField[], ctx: ExecutionContext): void {
  for (const { field, option } of resolved) {
    if (field.name.trim().toLowerCase() !== STATUS_FIELD.toLowerCase()) {
      continue;
    }
    if (namesRefusedStatus(option.name, ctx.refusedStatus)) {
      throw new RefusedByRule(
        `${field.name} "${option.name}" is not written by this queue: the board's auto-close workflow `
        + 'would close the issue before its evidence comment exists. Close the issue itself and let the '
        + 'board follow.',
      );
    }
  }
}

/**
 * Writes the wanted values onto an issue's board row and answers what the board
 * says afterwards.
 *
 * The row is added unconditionally first: the add is idempotent and hands back
 * the row that is already there, while asking the issue's side which board items
 * it belongs to was measured to answer nothing for rows that are demonstrably on
 * the board whenever the repository's owner differs from the board's. Every
 * mutation waits out the pacing gap after the one before it, adding the row
 * included, so a burst never looks like one. The write is finished only when
 * reading the row back agrees with it; a value that reads differently is reported
 * with both texts rather than recorded as a success.
 *
 * A guard names, per board field, what the row must still read for that field to
 * be written. The row is read afresh right before the writes — once, the same
 * read a status condition takes — and a guarded field that reads otherwise is
 * left as it is: somebody moved it, and that move is theirs. The rest is written.
 * When the guard leaves nothing to write, the action ends without a write.
 */
export async function applyFields(
  ref: IssueRef,
  request: FieldRequest,
  ctx: ExecutionContext,
  onlyIfStatusIn: readonly string[] | null = null,
  guard: ReadonlyMap<string, FieldReading> = new Map<string, FieldReading>(),
): Promise<AppliedFields> {
  const resolved = await resolveWanted(request, ctx);
  refuseForbiddenStatus(resolved, ctx);
  const target = onlyIfStatusIn === null
    ? { itemId: await ctx.board.ensureItem(ref), row: null }
    : await requireStatusIn(ref, onlyIfStatusIn, ctx);
  const { toWrite, leftAsItWas } = guard.size === 0
    ? { toWrite: [...resolved], leftAsItWas: [] }
    : await guarded(resolved, guard, target.row ?? await ctx.board.readItemById(target.itemId), ctx);
  if (toWrite.length === 0) {
    throw new PreconditionUnmet(
      'changed_since',
      `${leftAsItWas.map(describeLeft).join('; ')}, so the row was left as it is`,
    );
  }
  for (const { field, option } of toWrite) {
    await ctx.sleeper.sleep(ctx.paceMs);
    await ctx.board.setSingleSelect(target.itemId, field.id, option.id);
  }
  const row = await ctx.board.readItemById(target.itemId);
  const readback: Record<string, string> = {};
  for (const { field, option } of toWrite) {
    const actual = row.values[field.name] ?? '';
    if (actual !== option.name) {
      throw new ReadbackMismatch(field.name, option.name, actual === '' ? 'nothing' : actual);
    }
    readback[field.name] = actual;
  }
  return { readback, leftAsItWas };
}

/**
 * The resolved values the guard lets through against the row as it reads now, and
 * the ones it holds back. A field reads unchanged when it holds the same option it
 * held when the guard was taken: the same id, so a renamed option is no change. A
 * name the cached catalog does not know earns one fresh look, as a wanted text
 * does; a name nothing knows can only be compared as a name.
 */
async function guarded(
  resolved: readonly ResolvedField[],
  guard: ReadonlyMap<string, FieldReading>,
  row: ReadItemResult,
  ctx: ExecutionContext,
): Promise<{ toWrite: ResolvedField[]; leftAsItWas: LeftAsItWas[] }> {
  let catalog = await ctx.board.catalog();
  const unknown = resolved.some(({ field }) => {
    const current = row.values[field.name] ?? '';
    return current !== '' && optionIdIn(catalog, field.name, current) === null;
  });
  if (unknown) {
    catalog = await ctx.board.catalog(true);
  }
  const toWrite: ResolvedField[] = [];
  const leftAsItWas: LeftAsItWas[] = [];
  for (const one of resolved) {
    const expected = guard.get(one.field.name.trim().toLowerCase());
    const actual = row.values[one.field.name] ?? '';
    const optionId = actual === '' ? null : optionIdIn(catalog, one.field.name, actual);
    const now: FieldReading = { name: actual, optionId };
    if (expected === undefined || sameReading(expected, now)) {
      toWrite.push(one);
    } else {
      leftAsItWas.push({ field: one.field.name, wanted: one.option.name, expected: expected.name, actual });
    }
  }
  return { toWrite, leftAsItWas };
}

/** The id of the option a row shows under this name, when the catalog knows it. */
export function optionIdIn(catalog: FieldCatalog, fieldName: string, optionName: string): string | null {
  const field = findCatalogField(catalog, fieldName);
  return field?.options.find((option) => option.name === optionName)?.id ?? null;
}

/** Whether a field holds what it held: the same option by id when both ids are known, by name otherwise. */
function sameReading(before: FieldReading, now: FieldReading): boolean {
  if (before.name === '' || now.name === '') {
    return before.name === now.name;
  }
  if (before.optionId !== null && now.optionId !== null) {
    return before.optionId === now.optionId;
  }
  return before.name === now.name;
}

/** `Status was not set to "In Review": it has been changed on the board since (from "Todo" to "In Progress")`. */
export function describeLeft(left: LeftAsItWas): string {
  return `${left.field} was not set to "${left.wanted}": it has been changed on the board since (from `
    + `${shownValue(left.expected)} to ${shownValue(left.actual)})`;
}

function shownValue(value: string): string {
  return value === '' ? 'nothing' : `"${value}"`;
}

/**
 * Lets a write go ahead only while the row's status is one the writer owns, and
 * answers the row to write to, as it was just read.
 *
 * A writer that copies another system's state onto the board can arrive late —
 * its machine slept, its source was slow — and by then somebody else may have
 * moved the row on. Writing over that would move the row backwards, out of a
 * column nobody gave this writer. So the row is found on the board's walk before
 * anything is written — an issue with no row ends the action, and is never added
 * — and read once more, fresh, for its status. A status outside the list ends the
 * action without a write too.
 *
 * Each listed text is matched against the board's options the way a wanted value
 * is, so the beginning of a long label is enough, and an empty text is a row with
 * no status. A listed text the board offers no option for cannot be the status a
 * row carries, so it is passed over rather than stopping a write that never
 * needed it.
 */
async function requireStatusIn(
  ref: IssueRef,
  allowed: readonly string[],
  ctx: ExecutionContext,
): Promise<{ itemId: string; row: ReadItemResult }> {
  const field = findCatalogField(await ctx.board.catalog(), STATUS_FIELD);
  if (field === null) {
    throw new RefusedByRule(`the board has no field called "${STATUS_FIELD}", so no status can be required of a row`);
  }
  const listed = await ctx.board.findItem(ref);
  if (listed === null) {
    throw new PreconditionUnmet(
      'not_on_board',
      `${ref.toString()} has no row on the board, and this write adds none`,
    );
  }
  const names = allowed.flatMap((text) => optionNamed(field, text));
  const row = await ctx.board.readItemById(listed.itemId);
  const current = row.values[field.name] ?? '';
  if (!names.includes(current)) {
    const from = names.map((name) => (name === '' ? 'an empty status' : `"${name}"`)).join(', ');
    throw new PreconditionUnmet(
      'status_not_owned',
      `${field.name} reads ${current === '' ? 'nothing' : `"${current}"`}; this write moves a row only from `
      + `${from}, so the row was left as it is`,
    );
  }
  return { itemId: listed.itemId, row };
}

/** The option a listed text stands for, an empty text for no status, or nothing when it fits no option. */
function optionNamed(field: CatalogField, text: string): string[] {
  if (text.trim() === '') {
    return [''];
  }
  try {
    return [resolveOption(field, text).name];
  } catch (error) {
    if (!(error instanceof BoardQueueError)) {
      throw error;
    }
    return [];
  }
}

/** `Status → In Progress, Severity → S2 · broken`, for a person reading the queue. */
export function describeValues(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([field, value]) => `${field} → ${value}`)
    .join(', ');
}
