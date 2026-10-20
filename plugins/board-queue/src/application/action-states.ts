import type { ActionCounts } from './ports.ts';
import type { ActionState } from '../domain/action.ts';

/**
 * Every state an action can be in, as a list.
 *
 * A count or a listing accounts for all of them, including the ones nothing is
 * in: a status report that silently omits "blocked" because the queue happens to
 * be healthy reads the same as one that forgot to look.
 */
export const ACTION_STATES: readonly ActionState[] = [
  'queued',
  'held',
  'running',
  'done',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
];

export function isActionState(value: string): value is ActionState {
  return (ACTION_STATES as readonly string[]).includes(value);
}

/** A tally with every state present and nothing counted yet. */
export function emptyActionCounts(): ActionCounts {
  return {
    queued: 0,
    held: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
  };
}
