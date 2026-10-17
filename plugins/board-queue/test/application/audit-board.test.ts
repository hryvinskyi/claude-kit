import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditBoard } from '../../src/application/audit-board.ts';
import type { AuditReport, AuditReportSink } from '../../src/application/audit-board.ts';
import { readLastAudit } from '../../src/application/queue-meta.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';
import { IssueNotFound, PrimaryRateLimited, SecondaryRateLimited } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { seedItem } from '../fakes/fake-board-gateway.ts';
import type { SeededItem } from '../fakes/fake-board-gateway.ts';
import type { SeededIssue } from '../fakes/fake-issue-gateway.ts';
import { FIRST, RESET, SECOND, START, tickFixture } from './tick-fixture.ts';
import type { TickFixture } from './tick-fixture.ts';

/** Keeps every report it is handed, so a test can prove what was and was not written. */
class RecordingSink implements AuditReportSink {
  readonly saved: AuditReport[] = [];

  save(report: AuditReport): Promise<void> {
    this.saved.push(report);
    return Promise.resolve();
  }
}

const FULL = {
  Status: 'In Review',
  Severity: 'S2 · broken · no workaround',
  Module: 'Checkout',
  Environment: 'staging',
  'Defect type': 'Bug',
};

/** Three open issues: one nobody filed, one filed half-way, one complete. */
const OPEN: SeededIssue[] = [
  { ref: IssueRef.of(FIRST, 10), title: 'the login form forgets the e-mail field' },
  { ref: IssueRef.of(FIRST, 11), title: 'the export keeps yesterday’s price' },
  { ref: IssueRef.of(FIRST, 12), title: 'the receipt prints twice' },
];

/** Three closed issues: one the board followed, one it did not, one it never held. */
const CLOSED: SeededIssue[] = [
  { ref: IssueRef.of(FIRST, 20), state: 'closed', title: 'the cart total rounded down' },
  { ref: IssueRef.of(FIRST, 21), state: 'closed', title: 'the search box swallowed the query' },
  { ref: IssueRef.of(FIRST, 22), state: 'closed', title: 'a note nobody ever filed' },
];

const ROWS: SeededItem[] = [
  seedItem(IssueRef.of(FIRST, 11), 'item-11', {
    Status: 'Todo',
    Severity: 'S2 · broken · no workaround',
    Module: 'Checkout',
  }),
  seedItem(IssueRef.of(FIRST, 12), 'item-12', FULL),
  seedItem(IssueRef.of(FIRST, 20), 'item-20', { ...FULL, Status: 'Done' }),
  seedItem(IssueRef.of(FIRST, 21), 'item-21', { ...FULL, Status: 'In Progress' }),
  // The other repository's numbers collide with this one's on purpose: this row
  // is complete, and nothing here may take it for the issue of the same number.
  seedItem(IssueRef.of(SECOND, 10), 'item-second-10', FULL),
];

function board(options: { issues?: SeededIssue[]; items?: SeededItem[] } = {}): TickFixture {
  return tickFixture({
    issues: options.issues ?? [...OPEN, ...CLOSED],
    items: options.items ?? ROWS,
  });
}

function auditOf(tick: TickFixture, sink: AuditReportSink, config: Config = tick.config): AuditBoard {
  return new AuditBoard({
    config,
    repository: tick.repository,
    boards: tick.boards,
    policy: tick.policy,
    clock: tick.clock,
    logger: tick.logger,
    reports: sink,
  });
}

describe('AuditBoard', () => {
  it('says exactly what the board does not say', async () => {
    const tick = board();
    const sink = new RecordingSink();

    const report = await auditOf(tick, sink).execute();

    assert.deepEqual(report, {
      generatedAt: START,
      budgetAfter: `graphql 4000/5000 until ${RESET.toISOString()}`,
      repos: {
        [FIRST]: {
          open: 3,
          notOnBoard: [{
            number: 10,
            title: 'the login form forgets the e-mail field',
            url: `https://github.com/${FIRST}/issues/10`,
          }],
          emptyFields: [{
            number: 11,
            title: 'the export keeps yesterday’s price',
            url: `https://github.com/${FIRST}/issues/11`,
            missing: ['Environment', 'Defect type'],
          }],
          closedNotDone: [{
            number: 21,
            title: 'the search box swallowed the query',
            url: `https://github.com/${FIRST}/issues/21`,
            status: 'In Progress',
          }],
        },
        [SECOND]: { open: 0, notOnBoard: [], emptyFields: [], closedNotDone: [] },
      },
    });
    assert.deepEqual(sink.saved, [report]);
  });

  it('walks the board once per listing, and not at all for a repository with nothing to check', async () => {
    const tick = board();

    await auditOf(tick, new RecordingSink()).execute();

    assert.equal(tick.board.snapshotFetches, 2);
  });

  it('files nothing, whatever it finds', async () => {
    const tick = board();

    await auditOf(tick, new RecordingSink()).execute();

    assert.deepEqual(await tick.repository.list({}), []);
  });

  it('matches a number against its own repository, not against the one that shares it', async () => {
    const tick = board({
      issues: [
        { ref: IssueRef.of(FIRST, 30), title: 'never filed here' },
        { ref: IssueRef.of(FIRST, 31), title: 'filed here, half-way' },
      ],
      items: [
        seedItem(IssueRef.of(SECOND, 30), 'item-second-30', FULL),
        seedItem(IssueRef.of(SECOND, 31), 'item-second-31', FULL),
        seedItem(IssueRef.of(FIRST, 31), 'item-31', { Status: 'Todo' }),
      ],
    });

    const report = await auditOf(tick, new RecordingSink()).execute();

    const found = report.repos[FIRST];
    assert.deepEqual(found?.notOnBoard.map((issue) => issue.number), [30]);
    assert.deepEqual(found?.emptyFields[0]?.missing, ['Severity', 'Module', 'Environment', 'Defect type']);
  });

  it('leaves a closed issue alone when the board carried it, however the option is spelled out', async () => {
    const tick = board({
      issues: [{ ref: IssueRef.of(FIRST, 40), state: 'closed', title: 'carried by the board itself' }],
      items: [seedItem(IssueRef.of(FIRST, 40), 'item-40', { ...FULL, Status: 'Done · shipped' })],
    });

    const report = await auditOf(tick, new RecordingSink()).execute();

    assert.deepEqual(report.repos[FIRST]?.closedNotDone, []);
  });

  it('checks no closed issue where nothing says which status the board sets on its own', async () => {
    const tick = board();
    const blind: Config = ConfigSchema.parse({ ...tick.config, refusedStatus: [] });

    const report = await auditOf(tick, new RecordingSink(), blind).execute();

    assert.deepEqual(report.repos[FIRST]?.closedNotDone, []);
    assert.equal(tick.issues.calls.filter((call) => call === 'listClosedSince').length, 0);
    assert.ok(tick.logger.lines.some((line) => line.level === 'warn' && line.message === 'closed issues were not checked'));
  });

  it('writes down the summary a status listing shows', async () => {
    const tick = board();

    await auditOf(tick, new RecordingSink()).execute();

    assert.deepEqual(await readLastAudit(tick.repository), {
      at: tick.clock.now(),
      notOnBoard: 1,
      emptyFields: 1,
      closedNotDone: 1,
    });
  });

  it('keeps what it found when the burst limiter stops it half-way, and makes the queue wait', async () => {
    const tick = board();
    tick.issues.fail('listClosedSince', new SecondaryRateLimited(null));
    const sink = new RecordingSink();

    const report = await auditOf(tick, sink).execute();

    assert.deepEqual(report.repos[FIRST]?.notOnBoard.map((issue) => issue.number), [10]);
    assert.equal(report.repos[SECOND], undefined);
    assert.match(report.stoppedBecause ?? '', new RegExp(`burst limiter.+stopped at ${FIRST}`));
    assert.deepEqual(sink.saved, [report]);
    const pause = await tick.repository.getPause();
    assert.equal((pause?.until.getTime() ?? 0) - tick.clock.now().getTime(), 120 * 1000);
  });

  it('leaves the summary alone when it did not get to the end, so the next pass looks again', async () => {
    const tick = board();
    tick.issues.fail('listClosedSince', new SecondaryRateLimited(null));

    await auditOf(tick, new RecordingSink()).execute();

    assert.equal(await readLastAudit(tick.repository), null);
  });

  it('replaces no report at all when it was refused before it read anything', async () => {
    const tick = board();
    tick.issues.fail('listOpen', new PrimaryRateLimited(RESET));
    const sink = new RecordingSink();

    const report = await auditOf(tick, sink).execute();

    assert.deepEqual(report.repos, {});
    assert.deepEqual(sink.saved, []);
    assert.equal(await readLastAudit(tick.repository), null);
    assert.equal((await tick.repository.getPause())?.until.getTime(), RESET.getTime() + 5000);
  });

  it('hands a failure that is not the queue\'s business back to whoever asked', async () => {
    const tick = board();
    tick.issues.fail('listOpen', new IssueNotFound(`${FIRST}#10`));
    const sink = new RecordingSink();

    await assert.rejects(() => auditOf(tick, sink).execute(), /does not exist/);
    assert.deepEqual(sink.saved, []);
    assert.equal(await tick.repository.getPause(), null);
  });
});
