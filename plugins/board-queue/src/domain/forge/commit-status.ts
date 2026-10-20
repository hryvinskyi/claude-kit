/** The states a commit status takes on a pull request's head: the coordination server names only these two. */
export type CommitStatusState = 'success' | 'failure';

/** One commit status, as the forge files it under its context. */
export type CommitStatus = {
  readonly state: CommitStatusState;
  readonly description: string;
  /** The name the status is filed under; one commit keeps one status per context. */
  readonly context: string;
};

/**
 * Whether the status wanted must be written over the one last written for the same
 * commit and context. The forge keeps a bounded number of statuses per commit and
 * counts every write against its content-creation limit, so the same state and
 * description are never written twice.
 */
export function needsWriting(last: CommitStatus | null, wanted: CommitStatus): boolean {
  return last === null
    || last.context !== wanted.context
    || last.state !== wanted.state
    || last.description !== wanted.description;
}

/**
 * The status that takes back one this system wrote and no longer stands behind —
 * the repository stopped wanting one, its context changed, or the author is no
 * longer a member — or nothing when the last one was a success, which holds no
 * pull request back and is simply forgotten.
 */
export function withdrawalOf(last: CommitStatus): CommitStatus | null {
  if (last.state === 'success') {
    return null;
  }
  return { state: 'success', description: `no longer checked by ${last.context}`, context: last.context };
}
