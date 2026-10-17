import { Action } from '../../src/domain/action.ts';
import type { ActionState } from '../../src/domain/action.ts';
import { OptionNotFound } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';

export const FIRST = 'example-org/first-repo';

export const NOW = '2026-01-10T09:00:00.000Z';

export type FiledAction = {
  id: string;
  state: ActionState;
  kind?: string;
  issue?: number;
  origin?: string;
  createdAt?: Date;
  payload?: unknown;
  /** Work somebody pushed into the future; it is queued, and nothing will take it yet. */
  notBefore?: Date;
};

export type Fixture = {
  repository: InMemoryActionRepository;
  clock: FakeClock;
  file: (options: FiledAction) => Promise<Action>;
};

/**
 * A queue already holding actions in the states a command has to deal with.
 * Each one gets there the way a real one does — through the transitions the
 * aggregate allows — so a test never asserts against a state nothing can reach.
 */
export function fixture(): Fixture {
  const repository = new InMemoryActionRepository();
  const clock = new FakeClock(NOW);
  return {
    repository,
    clock,
    file: async (options: FiledAction): Promise<Action> => {
      const issue = options.issue ?? 12;
      const createdAt = options.createdAt ?? new Date(NOW);
      const action = Action.enqueue({
        id: options.id,
        kind: options.kind ?? 'board.set-fields',
        payload: options.payload ?? { repo: FIRST, issue, fields: { severity: 'S2' } },
        issueRef: IssueRef.of(FIRST, issue),
        origin: options.origin ?? 'a session',
        now: createdAt,
        hold: options.state === 'held',
        notBefore: options.notBefore ?? null,
      });
      reach(action, options.state, createdAt);
      await repository.insert(action);
      return action;
    },
  };
}

function reach(action: Action, state: ActionState, now: Date): void {
  if (state === 'queued' || state === 'held') {
    return;
  }
  if (state === 'cancelled') {
    action.cancel(now);
    return;
  }
  action.start(now);
  if (state === 'running') {
    return;
  }
  if (state === 'done') {
    action.succeed(now, 'the board agrees');
    return;
  }
  if (state === 'failed') {
    action.failTransient(now, 'the API was unreachable', 1, 60);
    return;
  }
  action.block(now, new OptionNotFound('Severity', 'urgent', ['S1 · blocking', 'S2 · broken']));
}
