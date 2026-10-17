import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardRouter } from '../../src/application/board-router.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { FakeBoardGateway } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { lanesByBoard } from '../fakes/lanes.ts';
import { ORG_BOARD, THIRD, USER_BOARD, twoBoardDirectory } from '../fixtures/config.ts';

const RESET = new Date('2026-01-10T10:00:00.000Z');

function budget(remaining: number): RateBudget {
  return new RateBudget({ resource: 'graphql', remaining, limit: 5000, used: 5000 - remaining, resetAt: RESET });
}

function twoBoards(): { router: BoardRouter; organisation: FakeBoardGateway; person: FakeBoardGateway } {
  const organisation = new FakeBoardGateway({ budget: budget(4000) });
  const person = new FakeBoardGateway({ budget: budget(3000) });
  const router = new BoardRouter(twoBoardDirectory, lanesByBoard(new Map([
    [ORG_BOARD, { board: organisation, issues: new FakeIssueGateway() }],
    [USER_BOARD, { board: person, issues: new FakeIssueGateway() }],
  ])));
  return { router, organisation, person };
}

describe('BoardRouter', () => {
  it('hands an issue the gateways of the board that carries its repository', () => {
    const { router, organisation, person } = twoBoards();

    const first = router.laneOf(IssueRef.of('EXAMPLE-ORG/first-repo', 1));
    const third = router.laneOf(IssueRef.of(THIRD, 1));

    assert.equal(first.board, organisation);
    assert.equal(first.placement.key, ORG_BOARD);
    assert.equal(third.board, person);
    assert.equal(third.placement.key, USER_BOARD);
  });

  it('builds the gateways once per board, in the order the configuration lists the boards', () => {
    const asked: string[] = [];
    const router = new BoardRouter(twoBoardDirectory, (placement) => {
      asked.push(placement.name);
      return { board: new FakeBoardGateway(), issues: new FakeIssueGateway() };
    });

    router.laneOf(IssueRef.of(THIRD, 1));
    router.laneOf(IssueRef.of(THIRD, 2));

    assert.deepEqual(asked, ['example-org/7', 'example-user/3']);
    assert.deepEqual(router.lanes().map((lane) => lane.placement.name), ['example-org/7', 'example-user/3']);
  });

  it('refuses an issue no board carries, naming the repositories that are carried', () => {
    const { router } = twoBoards();

    assert.throws(
      () => router.laneOf(IssueRef.of('someone/else', 1)),
      (error: unknown) => error instanceof RefusedByRule && error.describe().includes(THIRD),
    );
  });

  it('asks the shared allowance through the first board, and reads the first answer any board heard', async () => {
    const { router, organisation, person } = twoBoards();

    assert.equal((await router.probeBudget()).remaining, 4000);
    assert.deepEqual(organisation.calls, ['probeBudget']);
    assert.deepEqual(person.calls, []);
    assert.equal(router.lastBudget()?.remaining, 4000);
  });
});
