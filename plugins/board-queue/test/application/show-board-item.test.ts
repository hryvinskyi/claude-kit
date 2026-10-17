import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardRouter } from '../../src/application/board-router.ts';
import { ShowBoardItem } from '../../src/application/show-board-item.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';
import { QueuePause } from '../../src/domain/queue-pause.ts';
import { FakeBoardGateway, seedItem } from '../fakes/fake-board-gateway.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { lanesByBoard } from '../fakes/lanes.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';
import { ORG_BOARD, THIRD, USER_BOARD, testDirectory, twoBoardDirectory } from '../fixtures/config.ts';

const FIRST = 'example-org/first-repo';
const SECOND = 'Example-User/second-repo';

function boardWith(items: { repo: string; issue: number; values: Record<string, string> }[]): FakeBoardGateway {
  return new FakeBoardGateway({
    clock: new FakeClock(),
    items: items.map((item, index) => seedItem(
      IssueRef.of(item.repo, item.issue),
      `item-${String(index + 1)}`,
      item.values,
    )),
    budget: new RateBudget({
      resource: 'graphql',
      remaining: 4800,
      limit: 5000,
      used: 200,
      resetAt: new Date('2026-01-10T10:00:00.000Z'),
    }),
  });
}

const NOW = '2026-01-10T09:00:00.000Z';

/** The same reader the container builds, with a queue of its own to ask about waits. */
function reader(board: FakeBoardGateway, repository = new InMemoryActionRepository()): ShowBoardItem {
  const boards = new BoardRouter(testDirectory, () => ({ board, issues: new FakeIssueGateway() }));
  return new ShowBoardItem({ boards, repository, clock: new FakeClock(NOW) });
}

describe('what the board says about one issue', () => {
  it('answers the row and what the last answer left of the allowance', async () => {
    const board = boardWith([{ repo: FIRST, issue: 12, values: { Status: 'In progress', Severity: 'S2' } }]);

    const row = await reader(board).execute(FIRST, 12);

    assert.equal(row.ref, `${FIRST}#12`);
    assert.equal(row.url, `https://github.com/${FIRST}/issues/12`);
    assert.equal(row.onBoard, true);
    assert.equal(row.itemId, 'item-1');
    assert.deepEqual(row.values, { Status: 'In progress', Severity: 'S2' });
    assert.equal(row.budget, 'graphql 4800/5000 until 2026-01-10T10:00:00.000Z');
  });

  it('says an issue has no row rather than inventing one', async () => {
    const board = boardWith([{ repo: FIRST, issue: 12, values: {} }]);

    const row = await reader(board).execute(FIRST, 99);

    assert.equal(row.onBoard, false);
    assert.equal(row.itemId, null);
    assert.deepEqual(row.values, {});
  });

  it('reads the whole board once, however it was spelled', async () => {
    const board = boardWith([{ repo: SECOND, issue: 4, values: { Status: 'Triage' } }]);
    const show = reader(board);

    const row = await show.execute('example-user/second-repo', 4);
    await show.execute(FIRST, 12);

    assert.equal(row.ref, `${SECOND}#4`);
    assert.equal(row.onBoard, true);
    assert.equal(board.snapshotFetches, 2);
  });

  it('reads nothing while the queue is waiting out a refusal', async () => {
    const board = boardWith([{ repo: FIRST, issue: 12, values: {} }]);
    const repository = new InMemoryActionRepository();
    await repository.setPause(new QueuePause({
      until: new Date(new Date(NOW).getTime() + 10 * 60 * 1000),
      reason: 'the burst limiter refused the last call; waiting 120s',
      consecutiveHits: 1,
    }));

    await assert.rejects(
      () => reader(board, repository).execute(FIRST, 12),
      (error: unknown) => error instanceof RefusedByRule && /the burst limiter/.test(error.describe()),
    );
    assert.equal(board.snapshotFetches, 0, 'a read during the wait spends exactly what the queue waits for');
  });

  it('reads the board again once the wait has run out', async () => {
    const board = boardWith([{ repo: FIRST, issue: 12, values: {} }]);
    const repository = new InMemoryActionRepository();
    await repository.setPause(new QueuePause({
      until: new Date(new Date(NOW).getTime() - 1000),
      reason: 'a refusal that is over',
      consecutiveHits: 1,
    }));

    assert.equal((await reader(board, repository).execute(FIRST, 12)).onBoard, true);
  });

  it('refuses a repository this queue was never pointed at', async () => {
    const board = boardWith([]);

    await assert.rejects(
      () => reader(board).execute('example-org/somewhere-else', 1),
      (error: unknown) => error instanceof RefusedByRule && /not a configured repository/.test(error.describe()),
    );
    assert.equal(board.snapshotFetches, 0);
  });

  it('reads the board that carries the repository and no other', async () => {
    const organisation = boardWith([{ repo: FIRST, issue: 4, values: { Status: 'Todo' } }]);
    const person = boardWith([{ repo: THIRD, issue: 4, values: { Status: 'In Review' } }]);
    const boards = new BoardRouter(twoBoardDirectory, lanesByBoard(new Map([
      [ORG_BOARD, { board: organisation, issues: new FakeIssueGateway() }],
      [USER_BOARD, { board: person, issues: new FakeIssueGateway() }],
    ])));
    const show = new ShowBoardItem({ boards, repository: new InMemoryActionRepository(), clock: new FakeClock(NOW) });

    const row = await show.execute(THIRD, 4);

    assert.equal(row.board, 'example-user/3');
    assert.deepEqual(row.values, { Status: 'In Review' });
    assert.equal(person.snapshotFetches, 1);
    assert.equal(organisation.snapshotFetches, 0, 'the other board was never walked');
  });
});
