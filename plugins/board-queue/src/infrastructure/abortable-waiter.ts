import { setTimeout as delay } from 'node:timers/promises';
import type { Waiter } from '../application/service-loop.ts';

/** Waiting by waiting, cut short the moment the signal aborts. */
export class AbortableWaiter implements Waiter {
  async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      // The signal aborting the timer is the early end this wait promises, not a
      // failure; anything else is.
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
