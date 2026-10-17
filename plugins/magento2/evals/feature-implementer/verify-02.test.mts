// Scorer for feature-implementer/fixture-02. It runs against the scratch COPY the agent worked in,
// never against the fixture, and it lives outside the fixture so the agent cannot read it:
//
//   FIXTURE_ROOT=<copy> node --test <evals>/feature-implementer/verify-02.test.mts
//
// It checks the behaviour the task text and the binding review constraints specify. How the agent
// structured its own tests is scored separately, by reading them (expected-02.md, E3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Gap = { gapMinor: number; qualified: boolean; progress: number };

const root = process.env.FIXTURE_ROOT;
if (root === undefined || root === '') {
  throw new Error('Set FIXTURE_ROOT to the scratch copy the agent worked in');
}
const modulePath = join(root, 'app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts');
const loaded: Record<string, unknown> = await import(pathToFileURL(modulePath).href);

function gap(subtotalMinor: number, thresholdMinor: number): Gap {
  const fn = loaded.freeShippingGap;
  if (typeof fn !== 'function') throw new Error('freeShippingGap is not exported as a function');
  return fn(subtotalMinor, thresholdMinor);
}

function refuses(subtotalMinor: number, thresholdMinor: number, argument: string): void {
  assert.throws(
    () => gap(subtotalMinor, thresholdMinor),
    (error: unknown) => error instanceof RangeError && error.message.includes(argument),
    `(${subtotalMinor}, ${thresholdMinor}) should throw a RangeError naming ${argument}`,
  );
}

test('the only runtime export is freeShippingGap', () => {
  assert.deepEqual(Object.keys(loaded).sort(), ['freeShippingGap']);
});

test('below the threshold: the gap is the difference, progress the share covered', () => {
  assert.deepEqual(gap(5000, 20000), { gapMinor: 15000, qualified: false, progress: 0.25 });
  assert.deepEqual(gap(0, 20000), { gapMinor: 20000, qualified: false, progress: 0 });
});

test('at and above the threshold: qualified, gap never negative, progress clamped to 1', () => {
  assert.deepEqual(gap(20000, 20000), { gapMinor: 0, qualified: true, progress: 1 });
  assert.deepEqual(gap(25000, 20000), { gapMinor: 0, qualified: true, progress: 1 });
});

test('a zero threshold: every cart qualifies', () => {
  assert.deepEqual(gap(0, 0), { gapMinor: 0, qualified: true, progress: 1 });
  assert.deepEqual(gap(1234, 0), { gapMinor: 0, qualified: true, progress: 1 });
});

test('fractional, negative and non-finite amounts are contract errors naming the argument', () => {
  refuses(12.5, 20000, 'subtotalMinor');
  refuses(-1, 20000, 'subtotalMinor');
  refuses(Number.NaN, 20000, 'subtotalMinor');
  refuses(Number.POSITIVE_INFINITY, 20000, 'subtotalMinor');
  refuses(100, 1.5, 'thresholdMinor');
  refuses(100, -5, 'thresholdMinor');
  refuses(100, Number.NaN, 'thresholdMinor');
});
