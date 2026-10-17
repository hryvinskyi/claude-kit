import type { Action } from '../domain/action.ts';
import { RefusedByRule } from '../domain/errors.ts';
import type { ActionRepository } from './ports.ts';

/**
 * The action with this id, or a refusal naming the id that was asked for.
 *
 * Every command that changes one action starts here: a mistyped id must come
 * back as a sentence a person can act on, never as a command that quietly
 * changed nothing and reported success.
 */
export async function requireAction(repository: ActionRepository, id: string): Promise<Action> {
  const action = await repository.get(id);
  if (action === null) {
    throw new RefusedByRule(`this queue holds no action with the id "${id}"`);
  }
  return action;
}
