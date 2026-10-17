import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuditReport } from '../../src/application/audit-board.ts';
import { auditLines } from '../../src/delivery/audit-text.ts';

const FIRST = 'example-org/first-repo';
const SECOND = 'Example-User/second-repo';

function reportOf(over: Partial<AuditReport> = {}): AuditReport {
  return {
    generatedAt: '2026-01-10T09:00:00.000Z',
    budgetAfter: 'graphql 4000/5000 until 2026-01-10T09:40:00.000Z',
    repos: {
      [FIRST]: {
        open: 3,
        notOnBoard: [{ number: 10, title: 'the login form forgets the e-mail field', url: 'x' }],
        emptyFields: [{ number: 11, title: 'the export keeps the old price', url: 'x', missing: ['Environment', 'Defect type'] }],
        closedNotDone: [{ number: 21, title: 'the search box swallowed the query', url: 'x', status: 'In Progress' }],
      },
      [SECOND]: { open: 0, notOnBoard: [], emptyFields: [], closedNotDone: [] },
    },
    ...over,
  };
}

function textOf(report: AuditReport): string {
  return auditLines(report).join('\n');
}

describe('the board report as a person reads it', () => {
  it('counts each repository in one headline', () => {
    const text = textOf(reportOf());

    assert.match(text, new RegExp(`${FIRST} · 3 open · 1 not on the board · 1 with a field left blank · 1 the board did not follow`));
  });

  it('says of a quiet repository that there is nothing to report', () => {
    assert.match(textOf(reportOf()), new RegExp(`${SECOND} · 0 open · nothing to report`));
  });

  it('gives each finding a line naming the issue and what is wrong with it', () => {
    const lines = auditLines(reportOf());

    assert.ok(lines.some((line) => /not on the board\s+#10\s+the login form forgets the e-mail field$/.test(line)));
    assert.ok(lines.some((line) => /fields left blank\s+#11\s+.+Environment, Defect type$/.test(line)));
    assert.ok(lines.some((line) => /board not followed\s+#21\s+.+In Progress$/.test(line)));
  });

  it('says that a closed row carrying no status at all carries none', () => {
    const text = textOf(reportOf({
      repos: {
        [FIRST]: {
          open: 0,
          notOnBoard: [],
          emptyFields: [],
          closedNotDone: [{ number: 21, title: 'a row with nothing in it', url: 'x', status: '' }],
        },
      },
    }));

    assert.match(text, /board not followed\s+#21\s+.+no status/);
  });

  it('ends by saying that nothing was queued, because the pass looks like one that fixes things', () => {
    const lines = auditLines(reportOf());

    assert.equal(lines.at(-1), 'nothing was queued: this pass only says what it found');
  });

  it('says a pass that was cut short did not finish, and why', () => {
    const text = textOf(reportOf({ stoppedBecause: 'the burst limiter refused the last call' }));

    assert.match(text, /the pass did not finish: the burst limiter refused the last call/);
  });

  it('says outright when nothing was read at all', () => {
    const text = textOf(reportOf({ repos: {}, stoppedBecause: 'the API allowance is exhausted' }));

    assert.match(text, /no repository was read/);
  });

  it('cuts a title that would push the detail off the line', () => {
    const title = 'a title that goes on and on and on and on and on and on well past the room there is';
    const text = textOf(reportOf({
      repos: {
        [FIRST]: { open: 1, notOnBoard: [{ number: 9, title, url: 'x' }], emptyFields: [], closedNotDone: [] },
      },
    }));

    assert.match(text, /a title that goes on and on and on and on a…/);
    assert.ok(!text.includes('well past the room'));
  });
});
