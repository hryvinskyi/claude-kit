import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planReplay, replayNote } from '../../src/application/option-wait.ts';

const todo = { name: 'Todo', optionId: 'option-status-todo' };
const none = { name: '', optionId: null };

describe('what a release by the board takes back onto the queue', () => {
  it('guards every other value by what the row read at the block, and leaves out the rest with why', () => {
    const plan = planReplay({
      missing: ['severity'],
      wanted: ['status', 'module', 'type', 'severity', 'environment'],
      unanswered: new Set(['environment']),
      atBlock: { status: todo, type: none, environment: none },
      earlier: null,
    });

    assert.deepEqual(plan.keys, ['status', 'type', 'severity']);
    assert.deepEqual(plan.guard, { status: todo, type: none });
    assert.deepEqual([...plan.leftOut.keys()], ['module', 'environment']);
    assert.match(plan.leftOut.get('module') ?? '', /could not be read when the action blocked/);
    assert.match(plan.leftOut.get('environment') ?? '', /no longer offers it in Environment/);
  });

  it('keeps the guard an earlier release set, for a value the board lacked as much as for the others', () => {
    const inProgress = { name: 'In Progress', optionId: 'option-status-in-progress' };
    const plan = planReplay({
      missing: ['status'],
      wanted: ['status', 'module'],
      unanswered: new Set(),
      atBlock: { module: { name: 'Catalog', optionId: 'option-module-catalog' } },
      earlier: { status: inProgress, module: { name: 'Checkout', optionId: 'option-module-checkout' } },
    });

    assert.deepEqual(plan.keys, ['status', 'module']);
    assert.deepEqual(plan.guard, {
      status: inProgress,
      module: { name: 'Checkout', optionId: 'option-module-checkout' },
    });
  });

  it('never carries a value the board no longer offers, whatever guard it had', () => {
    const plan = planReplay({
      missing: ['severity'],
      wanted: ['status', 'severity'],
      unanswered: new Set(['status']),
      atBlock: { status: todo },
      earlier: { status: todo },
    });

    assert.deepEqual(plan.keys, ['severity']);
    assert.deepEqual(plan.guard, {});
    assert.match(plan.leftOut.get('status') ?? '', /no longer offers it/);
  });

  it('guards nothing and leaves every other value out when the row could not be read at the block', () => {
    const plan = planReplay({
      missing: ['severity'],
      wanted: ['status', 'severity'],
      unanswered: new Set(),
      atBlock: null,
      earlier: null,
    });

    assert.deepEqual(plan.keys, ['severity']);
    assert.match(plan.leftOut.get('status') ?? '', /could not be read when the action blocked/);
  });

  it('names what runs, on what condition, and every value left out with its reason', () => {
    const filed = { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress', module: 'Billing', severity: 'S4' } };
    const replay = { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress', severity: 'S4' } };
    const note = replayNote(filed, replay, {
      keys: ['status', 'severity'],
      guard: { status: todo },
      leftOut: new Map([['module', 'the board no longer offers it in Module']]),
    });

    assert.equal(
      note,
      'the board now offers what this waited for, so it runs again with status "In Progress", severity "S4"; '
      + 'status only if the row still reads as it did when the action blocked; module "Billing" was not written: '
      + 'the board no longer offers it in Module — file it anew if it still holds',
    );
    assert.equal(
      replayNote(filed, filed, { keys: [], guard: {}, leftOut: new Map() }),
      'the board now offers what this waited for, so it runs again with status "In Progress", module "Billing", severity "S4"',
    );
  });
});
