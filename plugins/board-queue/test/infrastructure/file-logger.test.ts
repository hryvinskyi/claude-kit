import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FileLogger } from '../../src/infrastructure/file-logger.ts';
import { FakeClock } from '../fakes/in-memory-time.ts';

describe('FileLogger', () => {
  let directory = '';
  let logPath = '';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'board-queue-log-'));
    logPath = join(directory, 'nested', 'board-queue.log');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function linesOf(): Record<string, unknown>[] {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('keeps the log and the directory it makes to their owner', () => {
    const logger = new FileLogger(logPath, new FakeClock());
    logger.info('graph call', { operation: 'BoardSnapshot' });
    logger.info('graph call', { operation: 'BoardCatalog' });

    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'nested')).mode & 0o777, 0o700);
  });

  it('narrows a log somebody left readable before it writes to it again', () => {
    writeFileSync(logPath.replace('nested/', ''), '{}\n', { mode: 0o644 });
    const loose = logPath.replace('nested/', '');
    const logger = new FileLogger(loose, new FakeClock());

    logger.info('graph call', {});

    assert.equal(statSync(loose).mode & 0o777, 0o600);
  });

  it('writes one object per event, into a directory it makes itself', () => {
    const clock = new FakeClock(new Date('2026-09-16T12:00:00.000Z'));
    const logger = new FileLogger(logPath, clock);
    logger.info('graph call', { operation: 'BoardSnapshot', status: 200, remaining: 4000 });
    clock.advance(1000);
    logger.warn('credential rejected', { subject: 'the board catalog' });
    logger.error('tick failed', {});
    const lines = linesOf();
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], {
      ts: '2026-09-16T12:00:00.000Z',
      level: 'info',
      msg: 'graph call',
      operation: 'BoardSnapshot',
      status: 200,
      remaining: 4000,
    });
    assert.equal(lines[1]?.['ts'], '2026-09-16T12:00:01.000Z');
    assert.equal(lines[1]?.['level'], 'warn');
    assert.equal(lines[2]?.['level'], 'error');
  });

  it('replaces anything credential-shaped, wherever it sits in the line', () => {
    const logger = new FileLogger(logPath, new FakeClock());
    logger.info('a token ghp_abcdefghijklmnopqrstuvwxyz0123456789 slipped into a message', {
      nested: { header: 'Bearer ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      pat: 'github_pat_11ABCDEFG0aBcDeFgHiJkL_abcdefghijklmnop',
      assertion: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTYifQ.c2lnbmF0dXJlLWhlcmU',
    });
    const written = readFileSync(logPath, 'utf8');
    assert.equal(written.includes('ghp_'), false);
    assert.equal(written.includes('ghs_'), false);
    assert.equal(written.includes('github_pat_'), false);
    assert.equal(written.includes('eyJhbGciOiJSUzI1NiJ9'), false);
    assert.equal((written.match(/\[redacted\]/g) ?? []).length, 4);
    assert.match(written, /a token \[redacted\] slipped into a message/);
  });

  it('keeps its own keys out of reach of an event', () => {
    const logger = new FileLogger(logPath, new FakeClock(new Date('2026-09-16T12:00:00.000Z')));
    logger.info('the real message', { msg: 'an impostor', level: 'error', ts: 'yesterday', kept: 1 });
    assert.deepEqual(linesOf()[0], {
      ts: '2026-09-16T12:00:00.000Z',
      level: 'info',
      msg: 'the real message',
      kept: 1,
    });
  });

  it('loses only the field JSON cannot express, never the line', () => {
    const logger = new FileLogger(logPath, new FakeClock());
    logger.info('odd field', { count: 1, huge: 10n });
    const line = linesOf()[0];
    assert.equal(line?.['msg'], 'odd field');
    assert.equal(line?.['count'], 1);
    assert.equal(line?.['huge'], '[unserialisable]');
  });

  it('never turns a place it cannot write into a failure of the work', () => {
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const logger = new FileLogger(join(blocker, 'deeper', 'board-queue.log'), new FakeClock());
    assert.doesNotThrow(() => {
      logger.error('this line has nowhere to go', { attempt: 1 });
    });
  });
});
