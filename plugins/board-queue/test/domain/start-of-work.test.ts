import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StartOfWork } from '../../src/domain/start-of-work.ts';

describe('the statuses that start the work on an issue', () => {
  const start = new StartOfWork(['In Progress']);

  it('starts the work for the status as it is written, and for the beginning of it, ignoring case', () => {
    assert.equal(start.starts('In Progress'), true);
    assert.equal(start.starts('in prog'), true);
    assert.equal(start.starts('In Progress · picked up'), true);
  });

  it('starts nothing for another status, or for no text at all', () => {
    assert.equal(start.starts('Ready for QA'), false);
    assert.equal(start.starts('Todo'), false);
    assert.equal(start.starts('  '), false);
  });

  it('starts nothing when the deployment names no status, or only empty ones', () => {
    assert.equal(new StartOfWork([]).starts('In Progress'), false);
    assert.equal(new StartOfWork(['', ' ']).starts('In Progress'), false);
  });
});
