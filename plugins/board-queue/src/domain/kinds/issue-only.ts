import type { IssueReading } from '../ports.ts';
import { RefusedByRule } from '../errors.ts';
import type { IssueRef } from '../issue-ref.ts';
import type { ExecutionContext } from './action-kind.ts';

/**
 * The issue this number names, read before anything is written to it.
 *
 * The issue endpoints accept a pull request's number too, and would comment on,
 * close or assign the pull request without a word. This queue carries work on
 * issues, so a number that turns out to name a pull request is refused: that is a
 * mistake in what was filed, which no retry mends and a person has to correct.
 */
export async function readIssueOnly(ref: IssueRef, ctx: ExecutionContext): Promise<IssueReading> {
  const reading = await ctx.issues.get(ref);
  if (reading.isPullRequest) {
    throw new RefusedByRule(
      `${ref.toString()} is a pull request, not an issue; this queue writes only to issues, so file the action `
      + 'again with the number of the issue it is about',
    );
  }
  return reading;
}
