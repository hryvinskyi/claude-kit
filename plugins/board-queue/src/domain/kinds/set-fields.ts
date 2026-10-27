import { z } from 'zod';
import type { Config } from '../config.ts';
import { IssueRef } from '../issue-ref.ts';
import type { ActionKind, ActionResult, ExecutionContext } from './action-kind.ts';
import {
  FieldShapeSchema,
  IssueNumberSchema,
  RepoSchema,
  StatusPreconditionSchema,
  applyFields,
  checkFields,
  describeValues,
  fieldRequestFrom,
} from './fields.ts';

const shape = z
  .object({
    repo: RepoSchema,
    issue: IssueNumberSchema,
    fields: FieldShapeSchema,
    onlyIfStatusIn: StatusPreconditionSchema.optional(),
  })
  .strict();

export type SetFieldsPayload = z.infer<typeof shape>;

const DESCRIBE = [
  'Set the board fields of an issue that already exists. Name the repository as owner/name (one of the',
  'configured repositories), the issue number, and any of status, severity, module, environment and type',
  '(type is the board field spelled "Defect type"). Each wanted text is matched against the board\'s live',
  'options: exactly, ignoring case, and otherwise as a prefix that fits one option only, so the beginning of',
  'a long label is enough. A text that fits nothing, or several options, blocks the action and reports the',
  'options the field accepts rather than guessing. Status "Done" is refused: the board\'s auto-close workflow',
  'reacts to it by closing the issue, which would happen before the evidence comment exists — close the issue',
  'itself and let the board follow. Two of these waiting on the same issue merge into one, the later values',
  'winning; a request that waits on a deploy is held instead and never merges. onlyIfStatusIn makes the write',
  'conditional: it goes ahead only while the row\'s status is one of the listed texts ("" for no status at all),',
  'and otherwise the action ends skipped, writing nothing — the form for work that mirrors another system and',
  'must never move a row out of a column it does not own. A conditional request never merges with another.',
  'A status that starts the work on an issue also assigns the person filing it, in an issue.assignees filed',
  'beside it.',
].join(' ');

/** Writes single-select values on an issue's board row and reads them back. */
export class SetFieldsKind implements ActionKind {
  readonly name = 'board.set-fields';
  readonly describe = DESCRIBE;
  readonly payloadSchema: z.ZodType<SetFieldsPayload>;
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
    this.payloadSchema = shape.superRefine((payload, ctx) => {
      checkFields(payload.fields, config, 'write', ctx, 'fields');
    });
  }

  issueRefOf(payload: unknown): IssueRef | null {
    const parsed = this.payloadSchema.parse(payload);
    return IssueRef.of(parsed.repo, parsed.issue);
  }

  statusAskedFor(payload: unknown): string | null {
    return this.payloadSchema.parse(payload).fields.status ?? null;
  }

  /**
   * Field by field, the later request wins; everything else stays as it was filed.
   * A conditional request merges with nothing: its condition would then guard the
   * other request's values too, or be lost.
   */
  coalesce(existing: unknown, incoming: unknown): unknown {
    const before = this.payloadSchema.parse(existing);
    const after = this.payloadSchema.parse(incoming);
    if (before.onlyIfStatusIn !== undefined || after.onlyIfStatusIn !== undefined) {
      return null;
    }
    return {
      ...before,
      ...after,
      fields: { ...before.fields, ...after.fields },
    } satisfies SetFieldsPayload;
  }

  async execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult> {
    const parsed = this.payloadSchema.parse(payload);
    const ref = IssueRef.of(parsed.repo, parsed.issue);
    const readback = await applyFields(
      ref,
      fieldRequestFrom(parsed.fields, this.#config, 'write'),
      ctx,
      parsed.onlyIfStatusIn ?? null,
    );
    return { summary: `${ref.toString()}: ${describeValues(readback)}`, readback };
  }
}
