import { z } from 'zod';
import type { Config } from '../config.ts';
import { ReadbackMismatch, RefusedByRule } from '../errors.ts';
import { IssueRef } from '../issue-ref.ts';
import type { ActionKind, ActionResult, ExecutionContext } from './action-kind.ts';
import {
  FieldShapeSchema,
  IssueNumberSchema,
  RepoSchema,
  checkFields,
  describeValues,
  fieldRequestFrom,
  resolveWanted,
} from './fields.ts';

const shape = z
  .object({
    repo: RepoSchema,
    issue: IssueNumberSchema,
    expect: FieldShapeSchema.optional(),
    onBoard: z.boolean().optional(),
  })
  .strict();

export type VerifyPayload = z.infer<typeof shape>;

const DESCRIBE = [
  'Read one issue\'s board row back and compare it with what you expect. Name the repository as owner/name,',
  'the issue number, and under expect the same fields set-fields takes; add onBoard: false to assert that the',
  'issue is deliberately not on the board, which is the one case that needs no expect at all. Any status may',
  'be expected here, including one that writes refuse,',
  'because confirming that closing an issue carried its row there is exactly what this kind is for. Expected',
  'text is matched against the live options the same way a write matches them, so a prefix is enough. Nothing',
  'is written: a value that does not match blocks the action and reports both what was expected and what the',
  'board says.',
].join(' ');

/** Compares an issue's board row with an expectation; writes nothing. */
export class VerifyKind implements ActionKind {
  readonly name = 'board.verify';
  readonly describe = DESCRIBE;
  readonly payloadSchema: z.ZodType<VerifyPayload>;
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
    this.payloadSchema = shape.superRefine((payload, ctx) => {
      if (payload.expect === undefined) {
        // A verification that says the issue is deliberately absent has nothing to
        // compare; every other one would be a question with no question in it.
        if (payload.onBoard !== false) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['expect'],
            message: 'name the fields to compare, or say onBoard: false to assert the issue is deliberately absent',
          });
        }
        return;
      }
      checkFields(payload.expect, config, 'read', ctx, 'expect');
    });
  }

  issueRefOf(payload: unknown): IssueRef | null {
    const parsed = this.payloadSchema.parse(payload);
    return IssueRef.of(parsed.repo, parsed.issue);
  }

  /** Two verifications are two questions; merging them would lose one of the answers. */
  coalesce(_existing: unknown, _incoming: unknown): unknown {
    return null;
  }

  /**
   * Membership is read from one walk of the whole board rather than from the
   * issue's own side, which was measured to answer nothing for rows that are
   * demonstrably there whenever the repository's owner differs from the board's.
   * An expectation is matched against the live options exactly as a write is, so
   * the beginning of a long label is enough here too.
   */
  async execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult> {
    const parsed = this.payloadSchema.parse(payload);
    const ref = IssueRef.of(parsed.repo, parsed.issue);
    const row = await ctx.board.findItem(ref);
    if (parsed.onBoard === false) {
      if (row !== null) {
        throw new ReadbackMismatch('membership', 'absent', 'on the board');
      }
      return { summary: `${ref.toString()}: not on the board, as expected` };
    }
    if (row === null) {
      throw new ReadbackMismatch('membership', 'on the board', 'absent');
    }
    const expected = parsed.expect;
    if (expected === undefined) {
      // The schema refuses this combination, so a payload that reaches here was
      // never validated; saying so is better than reporting an empty comparison
      // as a row that agrees with everything.
      throw new RefusedByRule('a verification that is not about membership names the fields to compare');
    }
    const resolved = await resolveWanted(fieldRequestFrom(expected, this.#config, 'read'), ctx);
    const seen: Record<string, string> = {};
    for (const { field, option } of resolved) {
      const actual = row.values[field.name] ?? '';
      if (actual !== option.name) {
        throw new ReadbackMismatch(field.name, option.name, actual === '' ? 'nothing' : actual);
      }
      seen[field.name] = actual;
    }
    return { summary: `${ref.toString()}: ${describeValues(seen)}`, readback: seen };
  }
}
