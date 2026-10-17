import { z } from 'zod';
import type { CatalogField, CatalogOption, FieldCatalog } from '../catalog.ts';
import { findCatalogField, resolveOption } from '../catalog.ts';
import type { Config } from '../config.ts';
import { BoardQueueError, ReadbackMismatch, RefusedByRule } from '../errors.ts';
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

export const FieldShapeSchema = z
  .object({
    status: optional,
    severity: optional,
    module: optional,
    environment: optional,
    type: optional,
  })
  .strict()
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
 */
export async function applyFields(
  ref: IssueRef,
  request: FieldRequest,
  ctx: ExecutionContext,
): Promise<Record<string, string>> {
  const resolved = await resolveWanted(request, ctx);
  refuseForbiddenStatus(resolved, ctx);
  const itemId = await ctx.board.ensureItem(ref);
  for (const { field, option } of resolved) {
    await ctx.sleeper.sleep(ctx.paceMs);
    await ctx.board.setSingleSelect(itemId, field.id, option.id);
  }
  const row = await ctx.board.readItemById(itemId);
  const readback: Record<string, string> = {};
  for (const { field, option } of resolved) {
    const actual = row.values[field.name] ?? '';
    if (actual !== option.name) {
      throw new ReadbackMismatch(field.name, option.name, actual === '' ? 'nothing' : actual);
    }
    readback[field.name] = actual;
  }
  return readback;
}

/** `Status → In Progress, Severity → S2 · broken`, for a person reading the queue. */
export function describeValues(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([field, value]) => `${field} → ${value}`)
    .join(', ');
}
