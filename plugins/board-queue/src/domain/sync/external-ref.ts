import { BoardQueueError } from '../errors.ts';
import { IssueRef } from '../issue-ref.ts';

/** The scheme the coordination server files a GitHub issue under. */
const GITHUB_SCHEME = 'gh:';

/**
 * The reference the coordination server files an issue under:
 * `gh:owner/repo#number`, in lower case, because GitHub's names are and the server
 * keeps them so.
 */
export function externalRefOf(ref: IssueRef): string {
  return `${GITHUB_SCHEME}${ref.toString().toLowerCase()}`;
}

/**
 * The issue an outside reference names, or nothing when it names something else —
 * another scheme, or a value that is not an issue.
 */
export function issueRefOfExternal(text: string): IssueRef | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(GITHUB_SCHEME)) {
    return null;
  }
  try {
    return IssueRef.parse(trimmed.slice(GITHUB_SCHEME.length));
  } catch (error) {
    if (error instanceof BoardQueueError) {
      return null;
    }
    throw error;
  }
}
