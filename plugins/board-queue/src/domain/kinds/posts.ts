import type { IssueRef } from '../issue-ref.ts';
import type { ExecutionContext } from './action-kind.ts';

/**
 * Everything this system writes in prose, and the signature that keeps it from
 * being written twice.
 *
 * A post is the one outward act that cannot be taken back: a request whose answer
 * never arrived has landed as often as not, and an action that simply tried again
 * would leave the same paragraph on the issue a second time. So every body
 * carries the id of the action that wrote it, in a marker the web interface does
 * not show, and a run looks for its own signature before it writes anything.
 */
const OPEN = '<!-- board-queue action ';
const CLOSE = ' -->';

/** Appended to a body, on its own line, where it renders as nothing. */
export function marker(actionId: string): string {
  return `\n\n${OPEN}${actionId}${CLOSE}`;
}

/** Whether this text is one that action already wrote. */
export function carriesMarker(text: string, actionId: string): boolean {
  return text.includes(`${OPEN}${actionId}${CLOSE}`);
}

export type PostedComment = {
  url: string;
  /** True when the comment was already there and this run wrote nothing. */
  adopted: boolean;
};

/**
 * The comment, posted once however often the action runs.
 *
 * Only comments written since the action was filed are read: everything older
 * belongs to somebody else, and the listing stays cheap on an issue with a long
 * conversation.
 */
export async function postCommentOnce(
  ref: IssueRef,
  body: string,
  ctx: ExecutionContext,
): Promise<PostedComment> {
  const existing = await ctx.issues.listComments(ref, ctx.enqueuedAt);
  const landed = existing.find((comment) => carriesMarker(comment.body, ctx.actionId));
  if (landed !== undefined) {
    return { url: landed.url, adopted: true };
  }
  const url = await ctx.issues.comment(ref, `${body}${marker(ctx.actionId)}`);
  return { url, adopted: false };
}
