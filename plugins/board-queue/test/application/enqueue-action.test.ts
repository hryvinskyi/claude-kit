import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnqueueAction } from '../../src/application/enqueue-action.ts';
import type { BoardDirectory } from '../../src/domain/board-directory.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';
import type { Config } from '../../src/domain/config.ts';
import { RefusedByRule, UnknownKind } from '../../src/domain/errors.ts';
import { defaultKindRegistry } from '../../src/domain/kinds/default-kinds.ts';
import {
  ORG_BOARD,
  TEST_BOARD,
  THIRD,
  USER_BOARD,
  testConfig,
  testDirectory,
  twoBoardConfig,
  twoBoardDirectory,
} from '../fixtures/config.ts';
import { InMemoryActionRepository } from '../fakes/in-memory-action-repository.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';

const FIRST = 'example-org/first-repo';
const SECOND = 'Example-User/second-repo';

const catalog: FieldCatalog = {
  projectId: 'project-1',
  fields: [
    {
      id: 'field-severity',
      name: 'Severity',
      dataType: 'SINGLE_SELECT',
      options: [
        { id: 'option-1', name: 'S1 · blocking · no workaround' },
        { id: 'option-2', name: 'S2 · broken · workaround exists' },
      ],
    },
  ],
};

function harness(config: Config = testConfig, directory: BoardDirectory = testDirectory): {
  repository: InMemoryActionRepository;
  clock: FakeClock;
  enqueue: EnqueueAction;
} {
  const repository = new InMemoryActionRepository();
  const clock = new FakeClock('2026-01-01T09:00:00.000Z');
  const enqueue = new EnqueueAction({
    repository,
    kinds: defaultKindRegistry(config),
    directory,
    clock,
  });
  return { repository, clock, enqueue };
}

function setFields(fields: Record<string, string>, issue = 12, repo = FIRST): unknown {
  return { repo, issue, fields };
}

describe('filing an action', () => {
  it('writes down a request nothing is waiting to merge with', async () => {
    const { repository, enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session in the first repository',
    });

    assert.equal(outcome.coalescedInto, undefined);
    assert.deepEqual(outcome.warnings, []);
    const filed = await repository.get(outcome.id);
    assert.equal(filed?.state, 'queued');
    assert.equal(filed?.kind, 'board.set-fields');
    assert.equal(filed?.origin, 'a session in the first repository');
    assert.equal(filed?.issueRef?.toString(), `${FIRST}#12`);
    assert.deepEqual(filed?.payload, { repo: FIRST, issue: 12, fields: { severity: 'S2' } });
  });

  it('folds a second request on the same issue into the first, later values winning', async () => {
    const { repository, enqueue } = harness();

    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2', module: 'Checkout' }),
      origin: 'a session',
    });
    const second = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S1', environment: 'Staging' }),
      origin: 'the same session, a minute later',
    });

    assert.equal(second.id, first.id);
    assert.equal(second.coalescedInto, first.id);
    assert.deepEqual((await repository.counts()).queued, 1);
    const folded = await repository.get(first.id);
    assert.deepEqual(folded?.payload, {
      repo: FIRST,
      issue: 12,
      fields: { severity: 'S1', module: 'Checkout', environment: 'Staging' },
    });
  });

  it('gives a request that waits on a deploy an action of its own', async () => {
    const { repository, enqueue } = harness();

    const queued = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    const held = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ status: 'In review' }),
      origin: 'a session',
      hold: true,
    });

    assert.notEqual(held.id, queued.id);
    assert.equal(held.coalescedInto, undefined);
    assert.equal((await repository.get(held.id))?.state, 'held');
    assert.deepEqual((await repository.counts()).queued, 1);
  });

  it('never folds a later request into one that is being held', async () => {
    const { repository, enqueue } = harness();

    const held = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ status: 'In review' }),
      origin: 'a session',
      hold: true,
    });
    const queued = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });

    assert.notEqual(queued.id, held.id);
    assert.deepEqual(await repository.counts(), {
      queued: 1,
      held: 1,
      running: 0,
      done: 0,
      failed: 0,
      blocked: 0,
      skipped: 0,
      cancelled: 0,
    });
  });

  it('never folds a request that names the moment it may run', async () => {
    const { repository, enqueue } = harness();

    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    const later = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S1' }),
      origin: 'a session',
      notBefore: new Date('2026-01-01T18:00:00.000Z'),
    });

    assert.notEqual(later.id, first.id);
    assert.equal((await repository.list({})).length, 2);
  });

  it('files a new action when the one it would have folded into was claimed meanwhile', async () => {
    const { repository, clock, enqueue } = harness();
    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    // The worker took it between the two requests: the merged values would never
    // reach the board, because this row is already on its way out.
    await repository.claimNextRunnable(clock.now());

    const second = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S1' }),
      origin: 'a session',
    });

    assert.notEqual(second.id, first.id);
    assert.equal(second.coalescedInto, undefined);
    assert.equal((await repository.list({})).length, 2);
  });

  it('works the merge out again when another enqueuer reached the same action first', async () => {
    const { repository, enqueue } = harness();
    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    // Between reading the waiting action and writing to it, somebody else folds
    // their own request into it. A merge computed from the row as it was would
    // put back a payload that never had their field in it.
    repository.beforeNextCoalesce = async (): Promise<void> => {
      await enqueue.execute({
        kind: 'board.set-fields',
        payload: setFields({ module: 'Checkout' }),
        origin: 'another session',
      });
    };

    const second = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ status: 'In Progress' }),
      origin: 'a session',
    });

    assert.equal(second.coalescedInto, first.id);
    assert.equal((await repository.list({})).length, 1);
    const stored = await repository.get(first.id);
    assert.deepEqual(stored?.payload, {
      repo: FIRST,
      issue: 12,
      fields: { severity: 'S2', module: 'Checkout', status: 'In Progress' },
    });
  });

  it('looks again when the store refuses the fold, rather than dropping the request', async () => {
    const { repository, enqueue } = harness();
    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    repository.refuseNextCoalesce = true;

    const second = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S1' }),
      origin: 'a session',
    });

    assert.equal(second.coalescedInto, first.id);
    assert.equal((await repository.list({})).length, 1);
  });

  it('files its own action rather than folding into one that has stepped into a wait', async () => {
    const { repository, clock, enqueue } = harness();
    const first = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });
    // A failure pushed the waiting action into a backoff after this request read
    // it. Folding into it now would hide the request behind a delay nobody asked
    // for.
    repository.beforeNextCoalesce = (): Promise<void> => {
      repository.delayBehindTheBackOf(first.id, new Date(clock.now().getTime() + 600_000));
      return Promise.resolve();
    };

    const second = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S1' }),
      origin: 'a session',
    });

    assert.equal(second.coalescedInto, undefined);
    assert.notEqual(second.id, first.id);
    assert.equal((await repository.list({})).length, 2);
  });

  it('gives each comment an action of its own', async () => {
    const { repository, enqueue } = harness();
    const body = { repo: FIRST, issue: 12, body: 'the first note' };

    const first = await enqueue.execute({ kind: 'issue.comment', payload: body, origin: 'a session' });
    const second = await enqueue.execute({
      kind: 'issue.comment',
      payload: { ...body, body: 'the second note' },
      origin: 'a session',
    });

    assert.notEqual(second.id, first.id);
    assert.equal((await repository.list({})).length, 2);
  });

  it('refuses the status the board closes issues on, and says what to do instead', async () => {
    const { repository, enqueue } = harness();

    await assert.rejects(
      () => enqueue.execute({
        kind: 'board.set-fields',
        payload: setFields({ status: 'Done' }),
        origin: 'a session',
      }),
      (error: unknown) => error instanceof RefusedByRule
        && error.category === 'refused-by-rule'
        && error.message.includes('fields:')
        && error.message.includes('Close the issue itself'),
    );
    assert.equal((await repository.list({})).length, 0);
  });

  it('refuses that status however little of it was typed', async () => {
    const { repository, enqueue } = harness();
    // A wanted text reaches the board as the option it resolves to, and every one
    // of these resolves to the status the board closes issues on. Refusing them
    // here is the difference between a sentence the person reads now and an
    // action that sits blocked in a worker log.
    for (const status of ['Don', 'do', 'Done · shipped']) {
      await assert.rejects(
        () => enqueue.execute({
          kind: 'board.set-fields',
          payload: setFields({ status }),
          origin: 'a session',
        }),
        (error: unknown) => error instanceof RefusedByRule && error.message.includes('Close the issue itself'),
        `"${status}" reaches the refused status and was not refused`,
      );
    }
    assert.equal((await repository.list({})).length, 0);
  });

  it('still takes a status that only shares a letter with the refused one', async () => {
    const { repository, enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ status: 'In Progress' }),
      origin: 'a session',
    });

    assert.equal((await repository.get(outcome.id))?.state, 'queued');
  });

  it('refuses a delay so far off that nobody would see the action again', async () => {
    const { repository, clock, enqueue } = harness();

    await assert.rejects(
      () => enqueue.execute({
        kind: 'board.set-fields',
        payload: setFields({ severity: 'S2' }),
        origin: 'a session',
        notBefore: new Date(clock.now().getTime() + 31 * 24 * 60 * 60 * 1000),
      }),
      (error: unknown) => error instanceof RefusedByRule && /30 days/.test(error.describe()),
    );
    assert.equal((await repository.list({})).length, 0);
  });

  it('takes a delay inside the month it allows', async () => {
    const { repository, clock, enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
      notBefore: new Date(clock.now().getTime() + 29 * 24 * 60 * 60 * 1000),
    });

    assert.equal((await repository.get(outcome.id))?.notBefore?.toISOString(), '2026-01-30T09:00:00.000Z');
  });

  it('accepts that same status as something to check for', async () => {
    const { repository, enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.verify',
      payload: { repo: FIRST, issue: 12, expect: { status: 'Done' } },
      origin: 'a session',
    });

    assert.equal((await repository.get(outcome.id))?.kind, 'board.verify');
  });

  it('refuses a repository this queue does not write to, naming the ones it does', async () => {
    const { enqueue } = harness();

    await assert.rejects(
      () => enqueue.execute({
        kind: 'board.set-fields',
        payload: setFields({ severity: 'S2' }, 12, 'someone-else/their-repo'),
        origin: 'a session',
      }),
      (error: unknown) => error instanceof RefusedByRule
        && error.message.includes('someone-else/their-repo')
        && error.message.includes(SECOND),
    );
  });

  it('stores the repository the way the configuration spells it', async () => {
    const { repository, enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }, 12, SECOND.toUpperCase()),
      origin: 'a session',
    });

    const filed = await repository.get(outcome.id);
    assert.equal(filed?.issueRef?.toString(), `${SECOND}#12`);
    assert.deepEqual(filed?.payload, { repo: SECOND, issue: 12, fields: { severity: 'S2' } });
  });

  it('refuses a sort of work nobody registered', async () => {
    const { enqueue } = harness();

    await assert.rejects(
      () => enqueue.execute({ kind: 'board.set-labels', payload: {}, origin: 'a session' }),
      (error: unknown) => error instanceof UnknownKind && error.describe().includes('board.set-fields'),
    );
  });

  it('refuses a payload the kind cannot read, naming the parts that are wrong', async () => {
    const { enqueue } = harness();

    await assert.rejects(
      () => enqueue.execute({
        kind: 'board.set-fields',
        payload: { repo: FIRST, fields: { severity: 'S2' } },
        origin: 'a session',
      }),
      (error: unknown) => error instanceof RefusedByRule && error.message.includes('issue:'),
    );
  });

  it('notes an option the board did not have when it was last read, and files the action anyway', async () => {
    const { repository, enqueue } = harness();
    await repository.putCatalog(TEST_BOARD, catalog, new Date('2026-01-01T08:00:00.000Z'));

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'urgent' }),
      origin: 'a session',
    });

    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0] ?? '', /Severity has no option matching "urgent"/);
    assert.equal((await repository.get(outcome.id))?.state, 'queued');
  });

  it('notes an option that fits several, and says nothing about one that fits', async () => {
    const { repository, enqueue } = harness();
    await repository.putCatalog(TEST_BOARD, catalog, new Date('2026-01-01T08:00:00.000Z'));

    const ambiguous = await enqueue.execute({
      kind: 'board.verify',
      payload: { repo: FIRST, issue: 12, expect: { severity: 'S' } },
      origin: 'a session',
    });
    const exact = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a session',
    });

    assert.equal(ambiguous.warnings.length, 1);
    assert.match(ambiguous.warnings[0] ?? '', /several ways/);
    assert.deepEqual(exact.warnings, []);
  });

  it('measures the wanted options against the catalog of the board that carries the issue', async () => {
    const { repository, enqueue } = harness(twoBoardConfig, twoBoardDirectory);
    await repository.putCatalog(ORG_BOARD, catalog, new Date('2026-01-01T08:00:00.000Z'));

    const onTheReadBoard = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'urgent' }),
      origin: 'a session',
    });
    const onTheUnreadBoard = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'urgent' }, 12, THIRD),
      origin: 'a session',
    });

    assert.equal(onTheReadBoard.warnings.length, 1);
    assert.deepEqual(onTheUnreadBoard.warnings, [], 'the other board has its own options and none were read');
    assert.equal(await repository.getCatalog(USER_BOARD), null);
  });

  it('files work on the second board in that board\'s spelling, and refuses a repository no board carries', async () => {
    const { repository, enqueue } = harness(twoBoardConfig, twoBoardDirectory);

    const outcome = await enqueue.execute({
      kind: 'issue.comment',
      payload: { repo: 'example-user/THIRD-REPO', issue: 4, body: 'seen on staging' },
      origin: 'a session',
    });

    assert.equal((await repository.get(outcome.id))?.issueRef?.toString(), `${THIRD}#4`);
    await assert.rejects(
      () => enqueue.execute({
        kind: 'issue.comment',
        payload: { repo: 'someone-else/their-repo', issue: 4, body: 'lost' },
        origin: 'a session',
      }),
      (error: unknown) => error instanceof RefusedByRule
        && error.message.includes('someone-else/their-repo')
        && error.message.includes(`example-org/first-repo, Example-User/second-repo, ${THIRD}`),
    );
  });

  it('says nothing about options while no catalog has been read', async () => {
    const { enqueue } = harness();

    const outcome = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ severity: 'anything at all' }),
      origin: 'a session',
    });

    assert.deepEqual(outcome.warnings, []);
  });

  it('files a request carrying a key once, and answers the action already filed under it', async () => {
    const { repository, enqueue } = harness();
    const request = {
      kind: 'board.set-fields',
      payload: setFields({ severity: 'S2' }),
      origin: 'a mirror',
      dedupeKey: 'mirror:one',
    };

    const first = await enqueue.execute(request);
    const second = await enqueue.execute(request);

    assert.equal(first.duplicateOf, undefined);
    assert.equal(second.duplicateOf, first.id);
    assert.equal(second.id, first.id);
    assert.equal((await repository.list({})).length, 1);
    assert.equal((await repository.get(first.id))?.dedupeKey, 'mirror:one');
  });

  it('never folds a request carrying a key into a waiting one, nor one into it', async () => {
    const { repository, enqueue } = harness();
    await enqueue.execute({ kind: 'board.set-fields', payload: setFields({ severity: 'S2' }), origin: 'a session' });

    const keyed = await enqueue.execute({
      kind: 'board.set-fields',
      payload: setFields({ module: 'Checkout' }),
      origin: 'a mirror',
      dedupeKey: 'mirror:two',
    });

    assert.equal(keyed.coalescedInto, undefined);
    assert.equal((await repository.list({})).length, 2);
  });

  it('answers the action another filer wrote under the same key a moment earlier', async () => {
    const { repository, enqueue } = harness();
    const request = { kind: 'issue.comment', payload: { repo: FIRST, issue: 12, body: 'once' }, origin: 'a mirror' };
    const racing = await enqueue.execute({ ...request, dedupeKey: 'race' });
    const realFind = repository.findByDedupeKey.bind(repository);
    let looked = false;
    repository.findByDedupeKey = async (key: string) => {
      if (!looked) {
        looked = true;
        return null;
      }
      return realFind(key);
    };

    const late = await enqueue.execute({ ...request, dedupeKey: 'race' });

    assert.equal(late.duplicateOf, racing.id);
    assert.equal((await repository.list({})).length, 1);
  });
});
