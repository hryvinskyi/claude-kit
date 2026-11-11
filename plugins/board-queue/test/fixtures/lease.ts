import type { TickLease } from '../../src/application/ports.ts';

/** The lock held for the whole run, as it is when no other pass comes near it. */
export const HELD: TickLease = { stillHeld: () => Promise.resolve(true) };

/**
 * A lease another pass takes the moment `taken` first answers true: from then on
 * it answers that the lock is lost, as a real one does.
 */
export function leaseLostWhen(taken: () => boolean): TickLease {
  let lost = false;
  return {
    stillHeld: () => {
      lost ||= taken();
      return Promise.resolve(!lost);
    },
  };
}
