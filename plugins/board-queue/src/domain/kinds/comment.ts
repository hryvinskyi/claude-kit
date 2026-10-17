import { z } from 'zod';
import { IssueRef } from '../issue-ref.ts';
import type { ActionKind, ActionResult, ExecutionContext } from './action-kind.ts';
import { BodyTextSchema, IssueNumberSchema, RepoSchema } from './fields.ts';
import { postCommentOnce } from './posts.ts';

const shape = z
  .object({
    repo: RepoSchema,
    issue: IssueNumberSchema,
    body: BodyTextSchema,
  })
  .strict();

export type CommentPayload = z.infer<typeof shape>;

const DESCRIBE = [
  'Post a comment on an issue. Name the repository as owner/name, the issue number and the body. The comment',
  'carries an invisible marker naming the action, so a retry after a failure whose post had already landed',
  'adopts that comment instead of posting a second one. Comments never merge: each is its own action, and',
  'actions on one issue run in the order they were filed, so a comment filed before a close is posted before',
  'the issue closes.',
].join(' ');

/** Posts one comment, once, however often the action is retried. */
export class CommentKind implements ActionKind {
  readonly name = 'issue.comment';
  readonly describe = DESCRIBE;
  readonly payloadSchema: z.ZodType<CommentPayload> = shape;

  issueRefOf(payload: unknown): IssueRef | null {
    const parsed = this.payloadSchema.parse(payload);
    return IssueRef.of(parsed.repo, parsed.issue);
  }

  /** Merging two comments would silently drop one of them. */
  coalesce(_existing: unknown, _incoming: unknown): unknown {
    return null;
  }

  async execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult> {
    const parsed = this.payloadSchema.parse(payload);
    const ref = IssueRef.of(parsed.repo, parsed.issue);
    const posted = await postCommentOnce(ref, parsed.body, ctx);
    const what = posted.adopted ? 'this comment was already there' : 'commented';
    return { summary: `${ref.toString()}: ${what}: ${posted.url}` };
  }
}
