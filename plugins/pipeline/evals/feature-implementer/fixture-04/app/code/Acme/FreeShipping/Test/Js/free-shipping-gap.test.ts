import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gapModule from '../../view/frontend/web/ts/free-shipping-gap.ts';

const { freeShippingGap } = gapModule;

function refuses(subtotalMinor: number, thresholdMinor: number, argument: string): void {
  assert.throws(
    () => freeShippingGap(subtotalMinor, thresholdMinor),
    (error: unknown) => error instanceof RangeError && error.message.includes(argument),
  );
}

test('the module exports the calculation and nothing else at runtime', () => {
  assert.deepEqual(Object.keys(gapModule).sort(), ['freeShippingGap']);
});

test('below the threshold the gap is the difference and progress the share covered', () => {
  assert.deepEqual(freeShippingGap(5000, 20000), { gapMinor: 15000, qualified: false, progress: 0.25 });
  assert.deepEqual(freeShippingGap(0, 20000), { gapMinor: 20000, qualified: false, progress: 0 });
});

test('one minor unit short does not qualify', () => {
  assert.deepEqual(freeShippingGap(19999, 20000), { gapMinor: 1, qualified: false, progress: 0.99995 });
});

test('a subtotal exactly at the threshold qualifies', () => {
  assert.deepEqual(freeShippingGap(20000, 20000), { gapMinor: 0, qualified: true, progress: 1 });
});

test('above the threshold the gap stays at zero and progress at one', () => {
  assert.deepEqual(freeShippingGap(25000, 20000), { gapMinor: 0, qualified: true, progress: 1 });
});

test('a zero threshold means the store offers no free shipping, so no cart qualifies', () => {
  assert.deepEqual(freeShippingGap(0, 0), { gapMinor: 0, qualified: false, progress: 0 });
  assert.deepEqual(freeShippingGap(1234, 0), { gapMinor: 0, qualified: false, progress: 0 });
});

test('a fractional amount is refused, never rounded', () => {
  refuses(12.5, 20000, 'subtotalMinor');
  refuses(100, 1.5, 'thresholdMinor');
});

test('a negative amount is refused', () => {
  refuses(-1, 20000, 'subtotalMinor');
  refuses(100, -5, 'thresholdMinor');
});

test('a non-finite amount is refused', () => {
  refuses(Number.NaN, 20000, 'subtotalMinor');
  refuses(Number.POSITIVE_INFINITY, 20000, 'subtotalMinor');
  refuses(100, Number.NaN, 'thresholdMinor');
});
