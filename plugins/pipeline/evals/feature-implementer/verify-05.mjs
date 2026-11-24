// Scorer for feature-implementer/fixture-05. Run against the copy after the agent finished:
//   FIXTURE_ROOT=<copy> node <evals>/feature-implementer/verify-05.mjs
// 1. The answer key's own assertions against the agent's src/late-fee.js (E1).
// 2. The agent's test/late-fee.test.js passes against the reference module and fails against
//    every mutant, each of which breaks one acceptance criterion (E3).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.FIXTURE_ROOT;
if (!root) { console.error('FIXTURE_ROOT is not set'); process.exit(2); }
const mutantsDir = join(dirname(fileURLToPath(import.meta.url)), 'mutants-05');
const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); };

// 1. Behaviour of the agent's module.
const modulePath = join(root, 'src/late-fee.js');
if (!existsSync(modulePath)) {
  record('E1', false, 'src/late-fee.js does not exist');
} else {
  const mod = await import(pathToFileURL(modulePath).href);
  const base = { dueOn: '2026-03-10', dailyRateMinor: 50, graceDays: 0, capMinor: 10_000 };
  const checks = [
    ['on the due date', () => assert.equal(mod.lateFee({ ...base, returnedOn: '2026-03-10' }), 0)],
    ['before the due date', () => assert.equal(mod.lateFee({ ...base, returnedOn: '2026-03-01' }), 0)],
    ['grace days free', () => assert.equal(mod.lateFee({ ...base, graceDays: 2, returnedOn: '2026-03-15' }), 150)],
    ['capped', () => assert.equal(mod.lateFee({ ...base, capMinor: 500, returnedOn: '2026-04-09' }), 500)],
    ['within grace', () => assert.equal(mod.lateFee({ ...base, graceDays: 3, returnedOn: '2026-03-12' }), 0)],
    ['refusals name the argument', () => {
      for (const name of ['dailyRateMinor', 'graceDays', 'capMinor']) {
        assert.throws(() => mod.lateFee({ ...base, returnedOn: '2026-03-12', [name]: -1 }),
          { name: 'RangeError', message: new RegExp(name) });
      }
    }],
    ['only lateFee exported', () => assert.deepEqual(Object.keys(mod), ['lateFee'])],
  ];
  for (const [label, check] of checks) {
    try { check(); record('E1', true, label); } catch (e) { record('E1', false, `${label}: ${e.message}`); }
  }
}

// 2. The agent's tests against the reference and the mutants.
const testPath = join(root, 'test/late-fee.test.js');
const runWith = (moduleFile) => {
  const dir = mkdtempSync(join(tmpdir(), 'fx05-'));
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true });
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    cpSync(join(mutantsDir, '_days-late.js'), join(dir, 'src/_days-late.js'));
    cpSync(moduleFile, join(dir, 'src/late-fee.js'));
    execFileSync(process.execPath, ['--test', 'test/late-fee.test.js'], { cwd: dir, stdio: 'ignore' });
    return 'pass';
  } catch {
    return 'fail';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
if (!existsSync(testPath)) {
  record('E3', false, 'test/late-fee.test.js does not exist');
} else {
  const ref = runWith(join(mutantsDir, 'reference.js'));
  record('E3', ref === 'pass', `reference implementation: tests ${ref}`);
  for (const file of readdirSync(mutantsDir).filter((f) => f !== 'reference.js' && !f.startsWith('_')).sort()) {
    const outcome = runWith(join(mutantsDir, file));
    record('E3', outcome === 'fail', `mutant ${file}: ${outcome === 'fail' ? 'killed' : 'SURVIVED'}`);
  }
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
