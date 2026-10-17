import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { FieldRequest } from '../../src/domain/field-request.ts';
import { testConfig } from '../fixtures/config.ts';

describe('FieldRequest', () => {
  it('spells field names the way the configuration spells them', () => {
    const request = FieldRequest.forWrite({ status: 'In Progress', 'defect type': ' Bug ' }, testConfig);
    assert.deepEqual(request.entries(), [['Status', 'In Progress'], ['Defect type', 'Bug']]);
    assert.deepEqual(request.names(), ['Status', 'Defect type']);
    assert.equal(request.size, 2);
  });

  it('answers a lookup whatever case it is asked in', () => {
    const request = FieldRequest.forWrite({ Severity: 'S2' }, testConfig);
    assert.equal(request.get('severity'), 'S2');
    assert.ok(request.has('SEVERITY'));
    assert.equal(request.get('Module'), undefined);
    assert.deepEqual(request.toObject(), { Severity: 'S2' });
    assert.equal(request.describe(), 'Severity → S2');
  });

  it('refuses a field the board does not carry', () => {
    assert.throws(
      () => FieldRequest.forWrite({ priority: 'high' }, testConfig),
      (error: unknown) => error instanceof RefusedByRule && error.message.includes('Defect type'),
    );
  });

  it('refuses an empty request, an empty value and a field named twice', () => {
    assert.throws(() => FieldRequest.forWrite({}, testConfig), RefusedByRule);
    assert.throws(() => FieldRequest.forWrite({ status: '   ' }, testConfig), RefusedByRule);
    assert.throws(() => FieldRequest.forWrite({ status: 'Ready', STATUS: 'Ready' }, testConfig), RefusedByRule);
  });

  it('merges with the other request winning field by field', () => {
    const first = FieldRequest.forWrite({ status: 'In Progress', severity: 'S3' }, testConfig);
    const second = FieldRequest.forWrite({ severity: 'S1', module: 'Checkout' }, testConfig);
    assert.deepEqual(first.merge(second).toObject(), {
      Status: 'In Progress',
      Severity: 'S1',
      Module: 'Checkout',
    });
    assert.deepEqual(first.toObject(), { Status: 'In Progress', Severity: 'S3' });
  });

  it('refuses a refused status on a write, in any case, and says why', () => {
    for (const value of ['Done', 'done', 'DONE']) {
      assert.throws(
        () => FieldRequest.forWrite({ status: value }, testConfig),
        (error: unknown) => error instanceof RefusedByRule
          && error.message.includes('auto-close')
          && error.category === 'refused-by-rule',
      );
    }
  });

  it('accepts a refused status on a read, because that is what a verification asks', () => {
    const request = FieldRequest.forRead({ status: 'Done' }, testConfig);
    assert.deepEqual(request.toObject(), { Status: 'Done' });
  });

  it('still refuses an unknown field on a read', () => {
    assert.throws(() => FieldRequest.forRead({ priority: 'high' }, testConfig), RefusedByRule);
  });
});
