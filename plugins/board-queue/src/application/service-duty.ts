import type { WorkerReport } from './run-tick.ts';

/**
 * The ways a pass of the service can decline the one job the service exists for.
 * On a person's machine each is an ordinary answer — that worker is simply not
 * the one that keeps the boards in step. In the service each means nothing is
 * kept in step at all, so the pass ends with an exit code of its own and the
 * service's health says which it was, in words that hold nothing secret.
 */
export type Decline = 'identity-unreadable' | 'not-the-owner' | 'forge-declined' | 'credentials-refused';

export const DECLINES = {
  'identity-unreadable': { exitCode: 3, says: 'the GitHub App\'s login could not be read' },
  'not-the-owner': { exitCode: 4, says: 'the GitHub App is not the configured owner' },
  'forge-declined': { exitCode: 5, says: 'the forge jobs would not run under the App\'s credential' },
  'credentials-refused': { exitCode: 6, says: 'the App\'s key or the coordination server\'s token was refused' },
} as const satisfies Record<Decline, { exitCode: number; says: string }>;

/** What in a pass's report, if anything, says the service declined its job. */
export function declineOf(report: WorkerReport): Decline | null {
  const sync = report.sync;
  if (sync === undefined) {
    return null;
  }
  if (sync.refusal !== undefined) {
    return sync.refusal;
  }
  const forge = sync.forge;
  if (forge !== undefined && 'declined' in forge && forge.declined === true) {
    return 'forge-declined';
  }
  return null;
}

/** The decline an exit code stands for, or none for any other code. */
export function declineOfExitCode(exitCode: number): Decline | null {
  for (const [decline, meaning] of Object.entries(DECLINES)) {
    if (meaning.exitCode === exitCode && isDecline(decline)) {
      return decline;
    }
  }
  return null;
}

function isDecline(name: string): name is Decline {
  return Object.hasOwn(DECLINES, name);
}
