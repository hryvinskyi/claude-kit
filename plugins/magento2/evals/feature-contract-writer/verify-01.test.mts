// Scorer for feature-contract-writer/fixture-01. It runs against the scratch COPY the agent worked
// in, never against the fixture, and it lives outside the fixture so the agent cannot read it:
//
//   FIXTURE_ROOT=<copy> node --test <evals>/feature-contract-writer/verify-01.test.mts
//
// A contract is as good as the wrong implementations it refuses. The agent's test file is run
// against a correct reference implementation (it must pass) and against mutants, each wrong in one
// way the task forbids (each must be refused). Tests named "hygiene:" score expected-01.md's
// hygiene row, the rest its pass criteria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.env.FIXTURE_ROOT;
if (root === undefined || root === '') {
  throw new Error('Set FIXTURE_ROOT to the scratch copy the agent worked in');
}
const modulePath = 'app/code/Acme/FreeShipping/view/frontend/web/ts/free-shipping-gap.ts';
const testPath = 'app/code/Acme/FreeShipping/Test/Js/free-shipping-gap.test.ts';

const reference = `export type FreeShippingGap = { gapMinor: number; qualified: boolean; progress: number };

function requireMinorUnits(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(\`\${name}: expected a non-negative integer amount in minor units, got \${value}\`);
  }
  return value;
}

export function freeShippingGap(subtotalMinor: number, thresholdMinor: number): FreeShippingGap {
  const subtotal = requireMinorUnits(subtotalMinor, 'subtotalMinor');
  const threshold = requireMinorUnits(thresholdMinor, 'thresholdMinor');
  if (threshold === 0) {
    return { gapMinor: 0, qualified: true, progress: 1 };
  }
  const gapMinor = Math.max(0, threshold - subtotal);
  return { gapMinor, qualified: gapMinor === 0, progress: Math.min(1, subtotal / threshold) };
}
`;

function mutate(from: string, to: string): string {
  assert.ok(reference.includes(from), `scorer bug: mutant anchor not found: ${from}`);
  return reference.replace(from, to);
}

const zeroThresholdBlock = `  if (threshold === 0) {
    return { gapMinor: 0, qualified: true, progress: 1 };
  }
`;

const mutants: Array<{ id: string; hygiene: boolean; rule: string; source: string }> = [
  { id: 'M1', hygiene: false, rule: 'the gap is never negative',
    source: mutate('Math.max(0, threshold - subtotal)', 'threshold - subtotal') },
  { id: 'M2', hygiene: false, rule: 'progress is clamped to 1',
    source: mutate('Math.min(1, subtotal / threshold)', 'subtotal / threshold') },
  { id: 'M3', hygiene: false, rule: 'a zero threshold qualifies every cart with progress 1',
    source: mutate(zeroThresholdBlock, '') },
  { id: 'M4', hygiene: false, rule: 'a fractional amount is refused, never rounded',
    source: mutate('function requireMinorUnits(value: number, name: string): number {\n', 'function requireMinorUnits(raw: number, name: string): number {\n  const value = Math.round(raw);\n') },
  { id: 'M5', hygiene: false, rule: 'a negative amount is refused',
    source: mutate('!Number.isSafeInteger(value) || value < 0', '!Number.isSafeInteger(value)') },
  { id: 'M6', hygiene: false, rule: 'the error names the argument',
    source: mutate('${name}: expected', 'expected') },
  { id: 'M8', hygiene: false, rule: 'a subtotal exactly at the threshold qualifies',
    source: mutate('qualified: gapMinor === 0', 'qualified: subtotal > threshold') },
  { id: 'M9', hygiene: false, rule: 'a contract error is a RangeError',
    source: mutate('throw new RangeError(', 'throw new Error(') },
  { id: 'M7', hygiene: true, rule: 'a non-finite amount is refused',
    source: mutate('!Number.isSafeInteger(value) || value < 0', 'Math.floor(value) !== value || value < 0') },
  { id: 'M10', hygiene: true, rule: 'a zero threshold does not let an invalid subtotal through',
    source: mutate(
      `  const subtotal = requireMinorUnits(subtotalMinor, 'subtotalMinor');\n  const threshold = requireMinorUnits(thresholdMinor, 'thresholdMinor');\n${zeroThresholdBlock}`,
      `  const threshold = requireMinorUnits(thresholdMinor, 'thresholdMinor');\n${zeroThresholdBlock}  const subtotal = requireMinorUnits(subtotalMinor, 'subtotalMinor');\n`,
    ) },
];

function runContractAgainst(source: string | null): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  try {
    cpSync(root as string, dir, { recursive: true });
    if (source !== null) writeFileSync(join(dir, modulePath), source);
    // A nested runner that inherits NODE_TEST_CONTEXT reports to this one and always exits 0.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', testPath], { cwd: dir, encoding: 'utf8', env });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the contract exists and the agent wrote no implementation', () => {
  assert.ok(existsSync(join(root, testPath)), `missing ${testPath}`);
  assert.ok(!existsSync(join(root, modulePath)), `${modulePath} exists: the contract writer implemented or stubbed it`);
});

test('the contract is red as delivered, because the module is missing', () => {
  const run = runContractAgainst(null);
  assert.notEqual(run.status, 0, 'the contract passes with no implementation');
  assert.match(run.output, /free-shipping-gap\.ts|ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test('a correct implementation passes the contract', () => {
  const run = runContractAgainst(reference);
  assert.equal(run.status, 0, `the reference implementation fails the contract:\n${run.output.slice(-2000)}`);
});

for (const mutant of mutants) {
  test(`${mutant.hygiene ? 'hygiene: ' : ''}${mutant.id} refused — ${mutant.rule}`, () => {
    const run = runContractAgainst(mutant.source);
    assert.notEqual(run.status, 0, `${mutant.id} passes the contract`);
  });
}
