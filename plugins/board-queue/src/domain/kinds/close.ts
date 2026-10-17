import { z } from 'zod';
import { ReadbackMismatch } from '../errors.ts';
import { IssueRef } from '../issue-ref.ts';
import type { ActionKind, ActionResult, ExecutionContext } from './action-kind.ts';
import { BodyTextSchema, IssueNumberSchema, RepoSchema } from './fields.ts';
import { postCommentOnce } from './posts.ts';

const shape = z
  .object({
    repo: RepoSchema,
    issue: IssueNumberSchema,
    reason: z.enum(['completed', 'not_planned']),
    comment: BodyTextSchema.optional(),
  })
  .strict();

export type ClosePayload = z.infer<typeof shape>;

const DESCRIBE = [
  'Close an issue, posting a comment first when one is given. Name the repository as owner/name, the issue',
  'number and the reason: completed for work that is done, not_planned for work that will not happen. An',
  'issue that is already closed is left alone, the comment carries the same marker a plain comment does so a',
  'retry never posts twice, and the close is confirmed by reading the issue back. Closing is also how a row',
  'reaches the board\'s final column: the board\'s own automation moves it, and this queue never writes that',
  'status itself.',
].join(' ');

/** Closes an issue and confirms it, optionally leaving the evidence comment first. */
export class CloseKind implements ActionKind {
  readonly name = 'issue.close';
  readonly describe = DESCRIBE;
  readonly payloadSchema: z.ZodType<ClosePayload> = shape;

  issueRefOf(payload: unknown): IssueRef | null {
    const parsed = this.payloadSchema.parse(payload);
    return IssueRef.of(parsed.repo, parsed.issue);
  }

  /** A second close request may name another reason or comment; both are kept as filed. */
  coalesce(_existing: unknown, _incoming: unknown): unknown {
    return null;
  }

  /**
   * The comment goes first, because it is the evidence the close is about and the
   * board's own automation reacts to the close within seconds. An issue that is
   * already closed is left alone: the read that establishes it is the readback,
   * and sending the change anyway would spend allowance to confirm what the answer
   * just said. A close that was sent is confirmed by reading the issue again,
   * because an answer that arrived is not yet a state that changed.
   */
  async execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult> {
    const parsed = this.payloadSchema.parse(payload);
    const ref = IssueRef.of(parsed.repo, parsed.issue);
    const notes: string[] = [];
    let wrote = false;
    if (parsed.comment !== undefined) {
      const posted = await postCommentOnce(ref, parsed.comment, ctx);
      wrote = !posted.adopted;
      notes.push(posted.adopted ? `this comment was already there: ${posted.url}` : `commented: ${posted.url}`);
    }
    const before = await ctx.issues.get(ref);
    if (before.state === 'closed') {
      notes.push(`it was already closed: ${before.url}`);
      return { summary: `${ref.toString()}: ${notes.join('; ')}` };
    }
    if (wrote) {
      await ctx.sleeper.sleep(ctx.paceMs);
    }
    await ctx.issues.close(ref, parsed.reason);
    const after = await ctx.issues.get(ref);
    if (after.state !== 'closed') {
      throw new ReadbackMismatch('state', 'closed', after.state);
    }
    notes.push(`closed as ${parsed.reason}: ${after.url}`);
    return { summary: `${ref.toString()}: ${notes.join('; ')}` };
  }
}
