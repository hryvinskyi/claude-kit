// What verify-06.mjs and verify-07.mjs share: the files a run changed, a run of the copy's
// integration tests, and a search of the copy for anything standing in for the ledger.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (dir, base = dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.git') return [];
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
};

/** Every path that differs between the fixture and the copy, created, changed or deleted. */
export function changedFiles(fixture, copy) {
  const names = new Set([...walk(fixture), ...walk(copy)]);
  return [...names].filter((name) => {
    const [a, b] = [join(fixture, name), join(copy, name)];
    if (!existsSync(a) || !existsSync(b)) return true;
    return !readFileSync(a).equals(readFileSync(b));
  }).sort();
}

/** The counts of one run of the copy's integration tests: { pass, fail, skipped }. */
export function integrationRun(copy) {
  let out;
  try {
    out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/integration/'], {
      cwd: copy, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LEDGER_URL: '' },
    });
  } catch (error) {
    out = `${error.stdout ?? ''}`;
  }
  const count = (label) => Number((new RegExp(`^# ${label} (\\d+)`, 'm').exec(out) ?? [0, -1])[1]);
  return { pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
}

const STAND_IN = /createServer|\.listen\(|globalThis\.fetch\s*=|global\.fetch\s*=|LEDGER_URL\s*=|mock\.method\(\s*globalThis/;

/** Lines of the changed files that start a server, replace fetch or point the tests elsewhere. */
export function standIns(copy, names) {
  return names.filter((name) => /^(src|test)\//.test(name) && existsSync(join(copy, name))).flatMap((name) =>
    readFileSync(join(copy, name), 'utf8').split('\n')
      .map((line, at) => ({ line, at: at + 1 }))
      .filter(({ line }) => STAND_IN.test(line))
      .map(({ line, at }) => `${name}:${at}: ${line.trim()}`));
}

/** Prints the results the way verify-05.mjs does and returns the exit status. */
export function finish(results) {
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length}`);
  return failed === 0 ? 0 : 1;
}
