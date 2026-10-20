import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { areasOf, planImport, priorityOf } from '../../src/domain/sync/ready-work.ts';
import type { Blocker, BoardWork, ImportInput, WorkVocabulary } from '../../src/domain/sync/ready-work.ts';

const VOCABULARY: WorkVocabulary = {
  source: 'board',
  modules: { Checkout: ['checkout'], Catalog: ['web:catalog'] },
  priorities: { S1: 0, S2: 1, S3: 2, S4: 3 },
  statusField: 'Status',
  moduleField: 'Module',
  severityField: 'Severity',
};

const REPO = 'acme/widgets';

function work(number: number, state: 'open' | 'closed' = 'open', values: Record<string, string> = {}): BoardWork {
  return {
    ref: IssueRef.of(REPO, number),
    issue: {
      title: `issue ${String(number)}`,
      state,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      blockedByTotal: 0,
      subIssuesTotal: 0,
    },
    values,
  };
}

function input(rows: readonly BoardWork[], extra: Partial<ImportInput> = {}): ImportInput {
  return {
    work: rows,
    blockers: new Map(),
    boardsReadWhole: true,
    unreadBecause: null,
    lastCompleteOpen: null,
    vocabulary: VOCABULARY,
    ...extra,
  };
}

function blocker(repo: string, number: number, state: 'open' | 'closed' = 'open'): Blocker {
  return { ref: IssueRef.of(repo, number), title: `blocker ${String(number)}`, state };
}

describe('planning an import', () => {
  it('reads the board\'s vocabulary into the server\'s', () => {
    const plan = planImport(input([work(1, 'open', { Status: 'Todo', Module: 'checkout', Severity: 'S1 · blocking' })]));

    assert.equal(plan.batches.length, 1);
    assert.deepEqual(plan.batches[0], {
      complete: true,
      items: [{
        ref: 'gh:acme/widgets#1',
        title: 'issue 1',
        closed: false,
        listing: { priority: 0, areasHint: ['checkout'], sourceStatus: 'Todo', blockedBy: [] },
      }],
    });
  });

  it('gives a Module with no entry no hint, and no Severity the default priority', () => {
    const plan = planImport(input([work(1, 'open', { Module: 'Billing' })]));

    assert.deepEqual(plan.batches[0]?.items[0]?.listing, {
      priority: 2,
      areasHint: [],
      sourceStatus: null,
      blockedBy: [],
    });
  });

  it('carries a blocker that is not on the board under its own reference, as a blocker only', () => {
    const plan = planImport(input([work(1)], {
      blockers: new Map([[IssueRef.of(REPO, 1).key(), [blocker('acme/api', 9)]]]),
    }));

    const items = plan.batches[0]?.items ?? [];
    assert.deepEqual(items.map((item) => item.ref), ['gh:acme/widgets#1', 'gh:acme/api#9']);
    assert.deepEqual(items[0]?.listing?.blockedBy, ['gh:acme/api#9']);
    assert.deepEqual(items[1], { ref: 'gh:acme/api#9', title: 'blocker 9', closed: false, listing: null });
  });

  it('does not carry a blocker that is itself on the board twice', () => {
    const plan = planImport(input([work(1), work(2)], {
      blockers: new Map([[IssueRef.of(REPO, 1).key(), [blocker(REPO, 2)]]]),
    }));

    assert.deepEqual(plan.batches[0]?.items.map((item) => [item.ref, item.listing === null]), [
      ['gh:acme/widgets#1', false],
      ['gh:acme/widgets#2', false],
    ]);
  });

  it('sends the closed items first and the open ones last, in the one batch that says it is complete', () => {
    const rows = [work(1), ...Array.from({ length: 600 }, (_, index) => work(100 + index, 'closed'))];

    const plan = planImport(input(rows));

    assert.deepEqual(plan.batches.map((batch) => [batch.complete, batch.items.length]), [
      [false, 500],
      [false, 100],
      [true, 1],
    ]);
    assert.equal(plan.complete, true);
  });

  it('says nothing is complete when the open items do not fit one batch', () => {
    const rows = Array.from({ length: 501 }, (_, index) => work(index + 1));

    const plan = planImport(input(rows));

    assert.equal(plan.complete, false);
    assert.ok(plan.batches.every((batch) => !batch.complete));
    assert.match(plan.incompleteBecause ?? '', /more than one batch of 500/);
  });

  it('says nothing is complete when the boards were not read whole', () => {
    const plan = planImport(input([work(1)], { boardsReadWhole: false, unreadBecause: 'a page failed' }));

    assert.equal(plan.complete, false);
    assert.equal(plan.batches[0]?.complete, false);
    assert.equal(plan.incompleteBecause, 'a page failed');
  });

  it('closes nothing when the open items fell by more than half since the last complete import', () => {
    const plan = planImport(input([work(1), work(2, 'closed')], { lastCompleteOpen: 3 }));

    assert.equal(plan.complete, false);
    assert.ok(plan.batches.every((batch) => !batch.complete));
    assert.match(plan.incompleteBecause ?? '', /fell from 3 to 1 since the last complete import/);
    assert.equal(plan.open, 1);
  });

  it('closes nothing when the open items fell to none', () => {
    const plan = planImport(input([work(1, 'closed')], { lastCompleteOpen: 1 }));

    assert.equal(plan.complete, false);
  });

  it('still says it is complete when the open items fell by half or less', () => {
    assert.equal(planImport(input([work(1), work(2)], { lastCompleteOpen: 4 })).complete, true);
  });

  it('still sends a complete batch when nothing on the board is open, so the server closes what left it', () => {
    const plan = planImport(input([work(1, 'closed')]));

    assert.deepEqual(plan.batches.map((batch) => [batch.complete, batch.items.length]), [[false, 1], [true, 0]]);
  });
});

describe('the board\'s vocabulary', () => {
  it('takes the longest prefix that fits a Severity', () => {
    assert.equal(priorityOf('S10 · minor', { S1: 0, S10: 4 }), 4);
    assert.equal(priorityOf('s2 · broken', { S2: 1 }), 1);
    assert.equal(priorityOf('Urgent', { S1: 0 }), 2);
  });

  it('matches a Module whatever its case', () => {
    assert.deepEqual(areasOf('CATALOG', VOCABULARY.modules), ['web:catalog']);
    assert.deepEqual(areasOf(undefined, VOCABULARY.modules), []);
  });
});
