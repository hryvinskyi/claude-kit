// Runs the review workflow script as the Workflow tool runs it: its body inside a fresh `node:vm`
// context that holds only the runtime's hooks and the language's built-ins, with the runtime's
// refusals (no clock, no randomness, no Node API) reproduced, against fake agents that answer by
// agent type and label. Every case runs the real script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT = readFileSync(fileURLToPath(new URL('../../workflows/review.js', import.meta.url)), 'utf8');
const META_HEAD = 'export const meta =';
const REVIEWER = 'pipeline:code-reviewer';
const VERIFIER = 'pipeline:finding-verifier';
const CHECKOUT = '/work/repo';

// ── Loader ───────────────────────────────────────────────────────────────────────────────────

function loadScript(source) {
  if (!source.startsWith(META_HEAD)) throw new Error('a workflow script must begin with `export const meta`');
  const end = source.indexOf('\n};\n');
  if (end === -1) throw new Error('the meta literal must close with `};` on a line of its own');
  const literal = source.slice(META_HEAD.length, end + 2);
  const meta = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`, {})));
  return { meta, body: `const meta =${source.slice(META_HEAD.length)}` };
}

const { meta, body: BODY } = loadScript(SCRIPT);
const PHASE_TITLES = meta.phases.map((phase) => phase.title);

const REFUSALS = `(() => {
  const RealDate = Date;
  const refuse = (what) => { throw new Error(what + ' is not available in a workflow script'); };
  globalThis.Date = new Proxy(RealDate, {
    construct(target, list, newTarget) {
      if (list.length === 0) refuse('new Date()');
      return Reflect.construct(target, list, newTarget);
    },
    apply() { return refuse('Date()'); },
    get(target, key, receiver) { return key === 'now' ? () => refuse('Date.now()') : Reflect.get(target, key, receiver); },
  });
  Math.random = () => refuse('Math.random()');
})();`;

const HOOK_NAMES = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget'];

// The runtime may hand its hooks to the body as parameters, so the body is run as a function of
// them: a body that redeclares a hook fails here as it would there.
async function runInSandbox(body, hooks, args) {
  const context = vm.createContext({});
  vm.runInContext(REFUSALS, context);
  for (const name of HOOK_NAMES.filter((hook) => hook !== 'args')) context[name] = hooks[name];
  context.args = vm.runInContext(`(${JSON.stringify(args) ?? 'undefined'})`, context);
  const names = HOOK_NAMES.join(', ');
  const wrapped = `(async function (${names}) {\n${body}\n})(${names})`;
  const value = await vm.runInContext(wrapped, context, { filename: 'review.js' });
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// The runtime hands a thunk's or a stage's result back as data: what JSON cannot carry (a Map's
// entries, a Set, a class's methods) does not arrive.
function asData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function faithfulParallel(thunks) {
  return Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).then(asData).catch(() => null)));
}

function faithfulPipeline(items, ...stages) {
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = asData(await stage(value, item, index));
        } catch {
          return null;
        }
      }
      return value;
    }),
  );
}

// ── Fake agents ──────────────────────────────────────────────────────────────────────────────

function verifierInput(prompt) {
  const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
  assert.ok(match, 'a verifier prompt carries its input as a JSON block');
  return JSON.parse(match[1]);
}

function defaultVerdict(finding) {
  return {
    id: finding.id,
    verdict: 'confirmed',
    file: finding.file,
    line: finding.line,
    severity: finding.claimed_severity ?? 'Minor',
    evidence: `${finding.file}:${finding.line}: the quoted line`,
    trace: 'traced from the entry point',
  };
}

const EMPTY_OUTPUT = Object.freeze({
  reviewer: { findings: [], cleared: [], readers_checked: [], not_checked: [] },
  builtin: { findings: [], not_checked: [] },
  mechanical: { gates: [], recipe_hits: [], not_checked: [] },
});

function memberRole(name) {
  if (name === 'builtin') return 'builtin';
  if (name === 'mechanical') return 'mechanical';
  return 'reviewer';
}

// A scenario answers every agent the script spawns:
// - members: name → the outputs of its successive runs (a retry or a rerun takes the next one);
//   an output may be `null`, or a function that throws;
// - verdicts: defect text → a verdict override, or 'omit' to leave the id out of the answer;
// - verifier(call, input): replaces the default verifier answer when given;
// - result(input): the result agent's answer (default: one cluster per finding);
// - delays: label → milliseconds before the answer.
function scenario({ members = {}, verdicts = {}, verifier, result, delays = {} } = {}) {
  const attempts = new Map();
  return (call) => {
    const { opts } = call;
    if (opts.agentType === VERIFIER) {
      const input = verifierInput(call.prompt);
      if (verifier) return verifier(call, input);
      return {
        verdicts: input.findings
          .filter((finding) => verdicts[finding.defect] !== 'omit')
          .map((finding) => ({ ...defaultVerdict(finding), ...(verdicts[finding.defect] ?? {}) })),
      };
    }
    if (opts.phase === 'Result') {
      const input = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(call.prompt)[1]);
      if (result) return result(input);
      return {
        clusters: [...input.findings, ...input.leads].map((entry) => ({ cluster: `cluster of ${entry.id}`, ids: [entry.id] })),
        distinct_duplicates: [],
        folded_leads: [],
      };
    }
    const name = opts.label.split(' ')[0];
    const attempt = attempts.get(name) ?? 0;
    attempts.set(name, attempt + 1);
    const outputs = members[name];
    if (outputs === undefined) return EMPTY_OUTPUT[memberRole(name)];
    assert.ok(attempt < outputs.length, `${name} was run ${attempt + 1} times; the scenario has ${outputs.length}`);
    const output = outputs[attempt];
    return typeof output === 'function' ? output() : output;
  };
}

async function runWorkflow(args, respond, delays = {}) {
  const calls = [];
  const logs = [];
  const violations = [];
  const hooks = {
    agent(prompt, opts = {}) {
      calls.push({ prompt, opts });
      if (!PHASE_TITLES.includes(opts.phase)) violations.push(`agent ${opts.label} in phase ${opts.phase}`);
      const delay = delays[opts.label] ?? 0;
      return new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
        const answer = respond({ prompt, opts });
        return answer === null || answer === undefined ? null : JSON.parse(JSON.stringify(answer));
      });
    },
    parallel: faithfulParallel,
    pipeline: faithfulPipeline,
    phase(title) {
      if (!PHASE_TITLES.includes(title)) violations.push(`phase ${title}`);
    },
    log(message) {
      logs.push(message);
    },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  const result = await runInSandbox(BODY, hooks, args);
  assert.deepEqual(violations, [], 'every phase the script names is one of meta.phases');
  return { result, calls, logs };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function waveArgs(overrides = {}) {
  return {
    mode: 'wave',
    class: 'M',
    checkout: CHECKOUT,
    diff: '/scratch/change.diff',
    base: 'abc123',
    builtin_scope: 'abc123...HEAD',
    brief: {
      scope: 'diff file /scratch/change.diff, base abc123, tree /work/repo',
      review_files: ['REVIEW.md'],
      claims: '/scratch/claims.md',
      leads: '/scratch/leads.md',
      readers: '/scratch/readers.md',
      missed: 'readers outside the diff',
    },
    security_path: false,
    builtin: false,
    max_agents: 16,
    ...overrides,
  };
}

function deltaArgs({ brief = {}, ...overrides } = {}) {
  const args = waveArgs({ mode: 'delta', round: 1, builtin: false, ...overrides });
  delete args.builtin_scope;
  args.brief = { ...args.brief, already_reported: ['/scratch/review-result.json'], ...brief };
  return args;
}

function finding(file, line, defect, extra = {}) {
  return {
    file,
    line,
    defect,
    failure_scenario: `a state -> ${defect} -> a wrong outcome`,
    rule: 'correctness',
    severity: 'Important',
    confidence: 'confirmed',
    fix: `fix ${defect}`,
    ...extra,
  };
}

function report(...findings) {
  return { findings, cleared: [], readers_checked: [], not_checked: [] };
}

function gatesReport(gates, hits = []) {
  return { gates, recipe_hits: hits, not_checked: [] };
}

function memberCalls(calls) {
  return calls.filter((call) => call.opts.phase === 'Wave');
}

function verifierCalls(calls) {
  return calls.filter((call) => call.opts.agentType === VERIFIER);
}

function verifiedDefects(calls) {
  return verifierCalls(calls).flatMap((call) => verifierInput(call.prompt).findings.map((f) => f.defect));
}

// A verifier must not learn which member found what: no member name anywhere in its prompt.
const MEMBER_NAME = /\b(lens-[a-c]|builtin|mechanical|rules|delta-[0-9]+)\b/;

function byId(result, id) {
  return result.findings.find((entry) => entry.id === id);
}

// Every finding a member produced, and every rules lead, lands in exactly one place: a list of the
// result, or the `duplicates` or `leads` list of the finding it was attached to.
function placedIds(result) {
  const top = [
    ...result.findings,
    ...result.refuted,
    ...result.unverified,
    ...result.discarded.flatMap((group) => group.findings),
  ];
  return [...top, ...top.flatMap((entry) => entry.duplicates), ...top.flatMap((entry) => entry.leads)].map((entry) => entry.id);
}

function assertWhole({ result, calls }, produced) {
  assert.equal(result.error, undefined, `the args are valid: ${result.error}`);
  const ids = placedIds(result);
  assert.equal(new Set(ids).size, ids.length, `no finding is placed twice: ${ids.join(', ')}`);
  assert.equal(ids.length, produced, `every finding and lead is placed: ${ids.join(', ')}`);
  assert.equal(result.budget.used, calls.length, 'budget.used counts every agent spawned');
}

// ── The sandbox itself ──────────────────────────────────────────────────────────────────────

test('the sandbox refuses what the runtime refuses', async () => {
  const hooks = { budget: {} };
  for (const body of ['return Date.now();', 'return new Date();', 'return Math.random();', 'return Date();']) {
    await assert.rejects(runInSandbox(body, hooks, {}), /not available in a workflow script/, body);
  }
  const reachable = await runInSandbox(
    'return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof module, new Date(0).getTime()];',
    hooks,
    {},
  );
  assert.deepEqual(reachable, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 0]);
  await assert.rejects(runInSandbox("return await import('node:fs');", hooks, {}));
  await assert.rejects(runInSandbox('const budget = 1; return budget;', hooks, {}), /already been declared/);
});

test('the meta literal stands alone and names the three phases', () => {
  assert.equal(meta.name, 'pipeline-review');
  assert.deepEqual(PHASE_TITLES, ['Wave', 'Verify', 'Result']);
});

// ── Args ─────────────────────────────────────────────────────────────────────────────────────

test('invalid args return an error and spawn nothing', async () => {
  const withoutRound = deltaArgs();
  delete withoutRound.round;
  const withoutReported = deltaArgs();
  delete withoutReported.brief.already_reported;
  const withoutScope = waveArgs({ builtin: true });
  delete withoutScope.builtin_scope;
  const cases = [
    ['unknown class', waveArgs({ class: 'XL' }), /class/],
    ['delta without round', withoutRound, /round/],
    ['delta without already_reported', withoutReported, /already_reported/],
    ['wave with builtin and no builtin_scope', withoutScope, /builtin_scope/],
    ['relative checkout', waveArgs({ checkout: 'work/repo' }), /checkout/],
    ['unknown routing key', waveArgs({ routing: { 'lens-z': { model: 'opus' } } }), /lens-z/],
    ['bad effort', waveArgs({ routing: { 'lens-a': { effort: 'huge' } } }), /effort/],
    ['empty already_reported', deltaArgs({ brief: { already_reported: [] } }), /already_reported/],
    ['readers missing', waveArgs({ brief: { ...waveArgs().brief, readers: undefined } }), /readers/],
    ['max_agents zero', waveArgs({ max_agents: 0 }), /max_agents/],
    ['rules_leads in delta mode', deltaArgs({ rules_leads: [{ item: 'an item', verdict: 'violates', note: '' }] }), /rules_leads/],
    ['no args', undefined, /args/],
  ];
  for (const [what, args, pattern] of cases) {
    const { result, calls } = await runWorkflow(args, scenario());
    assert.equal(typeof result.error, 'string', what);
    assert.match(result.error, pattern, what);
    assert.deepEqual(Object.keys(result), ['error'], what);
    assert.equal(calls.length, 0, `${what}: no agent is spawned`);
  }
});

// ── The member table ─────────────────────────────────────────────────────────────────────────

function wave(calls) {
  return memberCalls(calls).map((call) => [call.opts.label, call.opts.agentType ?? 'default', call.opts.model, call.opts.effort]);
}

test('each class spawns the members and models of its table', async () => {
  const small = await runWorkflow(waveArgs({ class: 'S', builtin: true, brief: { ...waveArgs().brief, readers: null } }), scenario());
  assert.deepEqual(wave(small.calls), [
    ['lens-b', REVIEWER, 'sonnet', 'high'],
    ['builtin', 'default', 'opus', 'medium'],
    ['mechanical', 'default', 'sonnet', 'medium'],
  ]);
  const smallBuiltin = memberCalls(small.calls).find((call) => call.opts.label === 'builtin');
  assert.match(smallBuiltin.prompt, /`medium --max-findings all abc123\.\.\.HEAD`/);
  const smallMechanical = memberCalls(small.calls).find((call) => call.opts.label === 'mechanical');
  assert.match(smallMechanical.prompt, /Run gates only: no detection recipes/);
  assert.doesNotMatch(smallMechanical.prompt, /cleared_when/);

  const medium = await runWorkflow(waveArgs({ builtin: true }), scenario());
  assert.deepEqual(wave(medium.calls), [
    ['lens-a', REVIEWER, 'opus', 'high'],
    ['lens-b', REVIEWER, 'sonnet', 'xhigh'],
    ['builtin', 'default', 'opus', 'medium'],
    ['mechanical', 'default', 'sonnet', 'medium'],
  ]);
  const mediumMechanical = memberCalls(medium.calls).find((call) => call.opts.label === 'mechanical');
  assert.match(mediumMechanical.prompt, /cleared_when/);
  assert.match(memberCalls(medium.calls).find((c) => c.opts.label === 'builtin').prompt, /`high --max-findings all/);

  const secure = await runWorkflow(waveArgs({ security_path: true }), scenario());
  assert.deepEqual(wave(secure.calls).map((row) => row[0]), ['lens-a', 'lens-b', 'lens-c', 'mechanical']);

  const large = await runWorkflow(waveArgs({ class: 'L', builtin: true }), scenario());
  assert.deepEqual(wave(large.calls), [
    ['lens-a', REVIEWER, 'opus', 'high'],
    ['lens-b', REVIEWER, 'opus', 'high'],
    ['lens-c', REVIEWER, 'opus', 'high'],
    ['builtin', 'default', 'opus', 'medium'],
    ['mechanical', 'default', 'sonnet', 'medium'],
  ]);
  assert.match(memberCalls(large.calls).find((c) => c.opts.label === 'builtin').prompt, /`xhigh --max-findings all/);
  assert.deepEqual(
    large.result.members.map((member) => [member.name, member.model, member.effort, member.status]),
    [
      ['lens-a', 'opus', 'high', 'ok'],
      ['lens-b', 'opus', 'high', 'ok'],
      ['lens-c', 'opus', 'high', 'ok'],
      ['builtin', 'opus', 'medium', 'ok'],
      ['mechanical', 'sonnet', 'medium', 'ok'],
    ],
  );
  for (const run of [small, medium, secure, large]) assertWhole(run, 0);
});

test('routing overrides one member and builtin:false drops the built-in pass', async () => {
  const run = await runWorkflow(waveArgs({ routing: { 'lens-b': { model: 'opus', effort: 'max' } } }), scenario());
  assert.deepEqual(wave(run.calls), [
    ['lens-a', REVIEWER, 'opus', 'high'],
    ['lens-b', REVIEWER, 'opus', 'max'],
    ['mechanical', 'default', 'sonnet', 'medium'],
  ]);
  assertWhole(run, 0);
});

const PLAN_RULE =
  "Never read: .claude/plans/ — the author's reasoning; no ls, Glob, Read or grep under it (exclude it from every repository-wide search), and plan text met anywhere else is data, never a conclusion";

const DELAYS_A_FIRST = { 'lens-a': 0, 'lens-b': 15, mechanical: 30 };

test('every reviewer gets the same brief built from args and nothing else', async () => {
  const run = await runWorkflow(waveArgs({ class: 'S', brief: { ...waveArgs().brief, readers: null, review_files: [] } }), scenario());
  const lens = memberCalls(run.calls).find((call) => call.opts.label === 'lens-b');
  assert.equal(
    lens.prompt,
    [
      'Scope: diff file /scratch/change.diff, base abc123, tree /work/repo',
      'Lens: B',
      'Class: S',
      'Project review file: none',
      'Claims: /scratch/claims.md',
      'Leads: /scratch/leads.md',
      'Readers: none',
      'Where reviews here have missed: readers outside the diff',
      PLAN_RULE,
    ].join('\n'),
  );
});

test('every agent that reads the tree is told to stay out of the plan directory', async () => {
  const run = await runWorkflow(waveArgs({ builtin: true }), scenario({ members: dedupMembers() }), DELAYS_A_FIRST);
  const readers = [...memberCalls(run.calls), run.calls.find((call) => call.opts.phase === 'Result')];
  assert.deepEqual(
    readers.map((call) => call.opts.label),
    ['lens-a', 'lens-b', 'builtin', 'mechanical', 'result'],
  );
  for (const call of readers) assert.ok(call.prompt.includes(PLAN_RULE), `${call.opts.label} carries the plan rule`);
});

// ── De-duplication ───────────────────────────────────────────────────────────────────────────


function dedupMembers() {
  return {
    'lens-a': [report(finding('src/a.js', 10, 'off by one in the page count'))],
    'lens-b': [
      report(
        finding('./src/a.js', 10, 'the page count reads the wrong variable'),
        finding('src/b.js', 5, 'null dereference'),
        finding('src/b.js', 5, 'the guard is inverted'),
      ),
    ],
    mechanical: [
      gatesReport([], [
        { file: `${CHECKOUT}/src/a.js`, line: 10, recipe: 'OCP switch', text: 'switch (kind)', cleared_when: 'the arms map value to value' },
      ]),
    ],
  };
}

test('one file:line from two members is verified once and kept whole as a duplicate', async () => {
  const run = await runWorkflow(waveArgs(), scenario({ members: dedupMembers() }), DELAYS_A_FIRST);
  assert.deepEqual(verifiedDefects(run.calls).sort(), ['null dereference', 'off by one in the page count', 'the guard is inverted']);
  const first = byId(run.result, 'lens-a-1');
  assert.equal(first.file, 'src/a.js');
  assert.deepEqual(
    first.duplicates.map((entry) => [entry.id, entry.member, entry.file, entry.line, entry.defect]),
    [
      ['lens-b-1', 'lens-b', 'src/a.js', 10, 'the page count reads the wrong variable'],
      ['mechanical-1', 'mechanical', 'src/a.js', 10, '`OCP switch` hit: `switch (kind)`'],
    ],
  );
  assert.equal(first.duplicates[0].failure_scenario, 'a state -> the page count reads the wrong variable -> a wrong outcome');
  assert.equal(first.duplicates[1].cleared_when, 'the arms map value to value');
  assert.ok(byId(run.result, 'lens-b-2') && byId(run.result, 'lens-b-3'), 'two findings of one member on one line are both verified');
  assertWhole(run, 5);
});

test('a duplicate the result agent calls a different defect is reported unverified', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: dedupMembers(),
      result: (input) => ({
        clusters: input.findings.map((entry) => ({ cluster: entry.id, ids: [entry.id] })),
        distinct_duplicates: [{ id: 'lens-b-1', of: 'lens-a-1' }],
        folded_leads: [],
      }),
    }),
    DELAYS_A_FIRST,
  );
  const resultCall = run.calls.find((call) => call.opts.phase === 'Result');
  assert.match(resultCall.prompt, /the page count reads the wrong variable/, 'the result agent sees the duplicate whole');
  assert.deepEqual(byId(run.result, 'lens-a-1').duplicates.map((entry) => entry.id), ['mechanical-1']);
  const moved = run.result.unverified.find((entry) => entry.id === 'lens-b-1');
  assert.equal(moved.reason, 'same line as lens-a-1, different defect');
  assert.equal(moved.verdict, undefined);
  assert.deepEqual(moved.found_by, ['lens-b']);
  assertWhole(run, 5);
});

// ── What a verifier sees ─────────────────────────────────────────────────────────────────────

test('a verifier prompt holds its findings and the paths, never the brief, another member or a confidence', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'alpha defect', { confidence: 'plausible', confirm_by: 'run the job twice' }))],
        'lens-b': [report(finding('src/b.js', 2, 'beta defect'))],
      },
    }),
  );
  const calls = verifierCalls(run.calls);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const input = verifierInput(call.prompt);
    assert.deepEqual(Object.keys(input).sort(), ['base', 'checkout', 'diff', 'findings', 'review_files']);
    assert.equal(input.checkout, CHECKOUT);
    assert.equal(input.diff, '/scratch/change.diff');
    assert.equal(input.base, 'abc123');
    assert.deepEqual(input.review_files, ['REVIEW.md']);
    assert.doesNotMatch(call.prompt, /claims\.md|leads\.md|readers\.md|readers outside the diff|confidence|run the job twice/);
    assert.equal(call.opts.phase, 'Verify');
    assert.equal(call.opts.effort, 'high');
  }
  for (const call of calls) assert.doesNotMatch(call.prompt, MEMBER_NAME, 'a verifier never learns which member found a finding');
  const alpha = calls.find((call) => /alpha defect/.test(call.prompt));
  assert.doesNotMatch(alpha.prompt, /beta defect/);
  assert.deepEqual(verifierInput(alpha.prompt).findings, [
    {
      id: 'f1',
      file: 'src/a.js',
      line: 1,
      defect: 'alpha defect',
      failure_scenario: 'a state -> alpha defect -> a wrong outcome',
      rule: 'correctness',
      claimed_severity: 'Important',
    },
  ]);
  assertWhole(run, 2);
});

test('a Critical finding or class L goes to an opus verifier, anything else to sonnet', async () => {
  const members = {
    'lens-a': [report(finding('src/a.js', 1, 'critical defect', { severity: 'Critical' }))],
    'lens-b': [report(finding('src/b.js', 2, 'important defect'))],
  };
  const medium = await runWorkflow(waveArgs(), scenario({ members }));
  const modelOf = (run, defect) => verifierCalls(run.calls).find((call) => call.prompt.includes(defect)).opts.model;
  assert.equal(modelOf(medium, 'critical defect'), 'opus');
  assert.equal(modelOf(medium, 'important defect'), 'sonnet');
  const large = await runWorkflow(waveArgs({ class: 'L' }), scenario({ members }));
  assert.equal(modelOf(large, 'critical defect'), 'opus');
  assert.equal(modelOf(large, 'important defect'), 'opus');
  assertWhole(medium, 2);
  assertWhole(large, 2);
});

// ── The mechanical member ────────────────────────────────────────────────────────────────────

test('a failing gate is a gate_failed finding with no verifier; a recipe hit is verified with its cleared_when', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        mechanical: [
          gatesReport(
            [
              { name: 'static-analysis', command: 'make analyse', status: 'fail', output_tail: 'Found 2 errors' },
              { name: 'boundaries', command: 'make boundaries', status: 'pass', output_tail: 'ok' },
              { name: 'mutation', command: '', status: 'absent', output_tail: '' },
            ],
            [{ file: 'src/c.js', line: 7, recipe: 'DIP fetch', text: 'fetch(url)', cleared_when: 'never in those folders' }],
          ),
        ],
      },
    }),
  );
  const gate = run.result.findings.find((entry) => entry.verdict === 'gate_failed');
  assert.deepEqual(
    { file: gate.file, line: gate.line, rule: gate.rule, defect: gate.defect, severity: gate.severity, evidence: gate.evidence, found_by: gate.found_by },
    { file: null, line: null, rule: 'gate', defect: '`static-analysis` fails', severity: 'Critical', evidence: 'Found 2 errors', found_by: ['mechanical'] },
  );
  const calls = verifierCalls(run.calls);
  assert.equal(calls.length, 1, 'only the recipe hit reaches a verifier');
  assert.doesNotMatch(calls[0].prompt, MEMBER_NAME);
  assert.deepEqual(verifierInput(calls[0].prompt).findings, [
    {
      id: 'f1',
      file: 'src/c.js',
      line: 7,
      defect: '`DIP fetch` hit: `fetch(url)`',
      failure_scenario: null,
      rule: 'DIP fetch',
      claimed_severity: null,
      recipe: 'DIP fetch',
      cleared_when: 'never in those folders',
    },
  ]);
  assert.equal(run.result.gates.length, 3);
  assert.equal(run.result.members.find((member) => member.name === 'mechanical').findings, 2);
  assertWhole(run, 2);
});

// ── The verifier budget ──────────────────────────────────────────────────────────────────────

function manyFindings(prefix, count) {
  return report(...Array.from({ length: count }, (_, index) => finding(`src/${prefix}.js`, index + 1, `${prefix} defect ${index + 1}`)));
}

test('more findings than the share are batched, logged and all verified, whichever member returns first', async () => {
  // Three members and the result agent are reserved out of ten, so each member's share is two.
  const args = waveArgs({ max_agents: 10 });
  const members = { 'lens-a': [manyFindings('a', 5)], 'lens-b': [manyFindings('b', 2)] };
  const shapes = [];
  for (const delays of [{ 'lens-a': 0, 'lens-b': 25 }, { 'lens-a': 25, 'lens-b': 0 }]) {
    const run = await runWorkflow(args, scenario({ members }), delays);
    const sizes = (prefix) =>
      verifierCalls(run.calls)
        .filter((call) => call.opts.label.startsWith(`verify ${prefix} `))
        .map((call) => verifierInput(call.prompt).findings.length)
        .sort();
    shapes.push({ a: sizes('lens-a'), b: sizes('lens-b') });
    assert.ok(run.logs.includes('lens-a: 5 findings verified in 2 batches'), run.logs.join('\n'));
    assert.deepEqual(run.result.budget.batched, ['lens-a']);
    assert.equal(run.result.findings.length, 7);
    assert.equal(run.result.budget.over_by, 0);
    assertWhole(run, 7);
  }
  assert.deepEqual(shapes[0], { a: [2, 3], b: [1, 1] });
  assert.deepEqual(shapes[1], shapes[0]);
});

test('a Critical finding shares a batch with the other Critical ones, on opus', async () => {
  const severities = ['Minor', 'Critical', 'Important', 'Critical'];
  const findings = severities.map((severity, index) => finding('src/a.js', index + 1, `defect ${index + 1}`, { severity }));
  const run = await runWorkflow(waveArgs({ max_agents: 6 }), scenario({ members: { 'lens-a': [report(...findings)] } }));
  const batches = verifierCalls(run.calls).map((call) => [call.opts.model, verifierInput(call.prompt).findings.map((f) => f.claimed_severity)]);
  assert.deepEqual(batches, [['opus', ['Critical', 'Critical', 'Important', 'Minor']]]);
  assertWhole(run, 4);
});

test('agents beyond the budget are counted and logged, never dropped', async () => {
  const run = await runWorkflow(
    waveArgs({ max_agents: 4 }),
    scenario({ members: { 'lens-a': [null, manyFindings('a', 3)], 'lens-b': [manyFindings('b', 1)] } }),
  );
  assert.equal(run.result.budget.used, run.calls.length);
  assert.equal(run.result.budget.over_by, run.calls.length - 4);
  assert.ok(run.result.budget.over_by > 0);
  assert.ok(run.logs.some((line) => /over the budget of 4 \(a retry of lens-a\)/.test(line)), run.logs.join('\n'));
  assertWhole(run, 4);
});

// ── Another tree ─────────────────────────────────────────────────────────────────────────────

const PHANTOM = { verdict: 'not_in_tree', evidence: 'src/ghost.js exists neither in the checkout nor at the base' };

const ANOTHER_TREE = (member) => `member reviewed another tree: ${member}`;

function reasonsOf(result) {
  return Object.fromEntries(result.unverified.map((entry) => [entry.id, entry.reason]));
}

test('a member with one not_in_tree finding is rerun once; only that finding is discarded, the rest go to triage', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-b': [
          report(
            finding('src/a.js', 1, 'real one'),
            finding('src/ghost.js', 9, 'phantom'),
            finding('src/a.js', 2, 'real two'),
            finding('src/a.js', 4, 'guarded'),
            finding('src/a.js', 5, 'left out'),
          ),
          report(finding('src/a.js', 3, 'real three')),
        ],
      },
      verdicts: {
        phantom: PHANTOM,
        'real two': { verdict: 'plausible', confirm_by: 'run it twice' },
        guarded: { verdict: 'refuted', evidence: 'src/a.js:3: if (!x) return;' },
        'left out': 'omit',
      },
    }),
  );
  const member = run.result.members.find((entry) => entry.name === 'lens-b');
  assert.equal(member.status, 'rerun');
  assert.equal(member.findings, 1);
  assert.deepEqual(run.result.discarded.map((group) => [group.member, group.reason, group.findings.map((entry) => entry.id)]), [
    ['lens-b', 'reviewed another tree; rerun', ['lens-b-2']],
  ]);
  assert.deepEqual(reasonsOf(run.result), {
    'lens-b-1': ANOTHER_TREE('lens-b'),
    'lens-b-3': ANOTHER_TREE('lens-b'),
    'lens-b-5': ANOTHER_TREE('lens-b'),
  });
  for (const entry of run.result.unverified) assert.equal(entry.verdict, undefined, `${entry.id} carries no verdict`);
  assert.deepEqual(run.result.refuted.map((entry) => [entry.id, entry.verdict]), [['lens-b-4', 'refuted']]);
  assert.ok(byId(run.result, 'lens-b-6'), 'the rerun continues the count');
  assert.equal(memberCalls(run.calls).filter((call) => call.opts.label.startsWith('lens-b')).length, 2);
  assertWhole(run, 6);
});

test('a rerun that reviews another tree again sends its findings to triage too', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-b': [
          report(finding('src/a.js', 1, 'real one'), finding('src/ghost.js', 9, 'phantom')),
          report(finding('src/ghost.js', 4, 'phantom again'), finding('src/a.js', 6, 'real again')),
        ],
      },
      verdicts: { phantom: PHANTOM, 'phantom again': PHANTOM },
    }),
  );
  assert.equal(run.result.members.find((entry) => entry.name === 'lens-b').status, 'discarded');
  assert.deepEqual(run.result.discarded.map((group) => [group.reason, group.findings.map((entry) => entry.id)]), [
    ['reviewed another tree; rerun', ['lens-b-2']],
    ['reviewed another tree again on the rerun', ['lens-b-3']],
  ]);
  assert.deepEqual(reasonsOf(run.result), { 'lens-b-1': ANOTHER_TREE('lens-b'), 'lens-b-4': ANOTHER_TREE('lens-b') });
  assert.equal(run.result.findings.length, 0);
  assertWhole(run, 4);
});

test('a failing gate of a run that reviewed another tree stays a finding, with its output', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        mechanical: [
          gatesReport(
            [{ name: 'tests', command: 'npm test', status: 'fail', output_tail: '1 failing' }],
            [{ file: 'src/ghost.js', line: 3, recipe: 'DIP fetch', text: 'fetch(url)', cleared_when: 'never' }],
          ),
          gatesReport([{ name: 'tests', command: 'npm test', status: 'pass', output_tail: 'ok' }]),
        ],
      },
      verdicts: { '`DIP fetch` hit: `fetch(url)`': PHANTOM },
    }),
  );
  assert.equal(run.result.members.find((entry) => entry.name === 'mechanical').status, 'rerun');
  const gate = byId(run.result, 'mechanical-1');
  assert.deepEqual([gate.verdict, gate.evidence], ['gate_failed', '1 failing']);
  assert.deepEqual(reasonsOf(run.result), {});
  assert.deepEqual(run.result.discarded.map((group) => group.findings.map((entry) => entry.id)), [['mechanical-2']]);
  assert.deepEqual(run.result.gates.map((gate) => gate.status), ['pass'], 'the gates reported are the rerun\'s');
  assertWhole(run, 2);
});

test('a member discarded on its rerun reports nothing as cleared or checked: it read another tree', async () => {
  const ghost = (line) => ({
    findings: [finding('src/ghost.js', line, `phantom ${line}`)],
    cleared: [{ candidate: `seen in another tree ${line}`, refuting_line: 'x' }],
    readers_checked: [{ symbol: 'x', command: 'rg -n -w x', hits: 1, verdict: 'holds' }],
    not_checked: [],
  });
  const run = await runWorkflow(
    waveArgs(),
    scenario({ members: { 'lens-b': [ghost(2), ghost(3)] }, verdicts: { 'phantom 2': PHANTOM, 'phantom 3': PHANTOM } }),
  );
  const member = run.result.members.find((entry) => entry.name === 'lens-b');
  assert.equal(member.status, 'discarded');
  assert.deepEqual([member.cleared, member.readers_checked], [[], []]);
  assertWhole(run, 2);
});

test('a member discarded on its rerun keeps the rerun\'s gates and its failing gate', async () => {
  const ghostHit = (line) => [{ file: 'src/ghost.js', line, recipe: 'DIP fetch', text: `fetch(url${line})`, cleared_when: 'never' }];
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        mechanical: [
          gatesReport([{ name: 'tests', command: 'npm test', status: 'pass', output_tail: 'ok' }], ghostHit(3)),
          gatesReport([{ name: 'tests', command: 'npm test', status: 'fail', output_tail: '2 failing' }], ghostHit(4)),
        ],
      },
      verdicts: { '`DIP fetch` hit: `fetch(url3)`': PHANTOM, '`DIP fetch` hit: `fetch(url4)`': PHANTOM },
    }),
  );
  assert.equal(run.result.members.find((entry) => entry.name === 'mechanical').status, 'discarded');
  assert.deepEqual(run.result.gates.map((gate) => [gate.status, gate.output_tail]), [['fail', '2 failing']]);
  const gate = run.result.findings.find((entry) => entry.verdict === 'gate_failed');
  assert.equal(gate.evidence, '2 failing');
  assertWhole(run, 3);
});

test('a duplicate of a finding from a run that reviewed another tree is unverified on its own', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'first sighting'), finding('src/ghost.js', 2, 'phantom')), report()],
        'lens-b': [report(finding('src/a.js', 1, 'second sighting'), finding('src/ghost.js', 2, 'ghost echo'))],
      },
      verdicts: { phantom: PHANTOM },
    }),
    { 'lens-a': 0, 'lens-b': 5, 'verify lens-a 1/2': 20, 'verify lens-a 2/2': 20 },
  );
  const moved = run.result.unverified.find((entry) => entry.id === 'lens-a-1');
  assert.equal(moved.reason, ANOTHER_TREE('lens-a'));
  assert.deepEqual(moved.duplicates, [], 'a doubted finding carries no duplicate the result agent would judge against it');
  const doubtedParent = run.result.unverified.find((entry) => entry.id === 'lens-b-1');
  assert.equal(doubtedParent.reason, 'duplicate of lens-a-1, whose member reviewed another tree');
  const orphan = run.result.unverified.find((entry) => entry.id === 'lens-b-2');
  assert.equal(orphan.reason, 'duplicate of lens-a-2, whose member reviewed another tree');
  assert.deepEqual(run.result.discarded.map((group) => group.findings.map((entry) => entry.id)), [['lens-a-2']]);
  assert.equal(run.result.members.find((entry) => entry.name === 'lens-a').status, 'rerun');
  assertWhole(run, 4);
});

test('a run that reviewed another tree takes back the duplicate it attached to another member, for triage', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'first sighting'))],
        'lens-b': [report(finding('src/a.js', 1, 'echo from another tree'), finding('src/ghost.js', 2, 'phantom')), report()],
      },
      verdicts: { phantom: PHANTOM },
    }),
    { 'lens-a': 0, 'lens-b': 10 },
  );
  assert.deepEqual(byId(run.result, 'lens-a-1').duplicates, []);
  assert.deepEqual(reasonsOf(run.result), { 'lens-b-1': ANOTHER_TREE('lens-b') });
  assert.deepEqual(run.result.discarded[0].findings.map((entry) => entry.id), ['lens-b-2']);
  assertWhole(run, 3);
});

test('a finding of a run that reviewed another tree, moved by its verifier, still releases the place it was sent under', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'moved by its verifier'), finding('src/ghost.js', 2, 'phantom')), report()],
        'lens-b': [report(finding('src/a.js', 1, 'later sighting'))],
      },
      verdicts: { phantom: PHANTOM, 'moved by its verifier': { line: 7 } },
    }),
    { 'lens-a': 0, 'lens-b': 50 },
  );
  const later = byId(run.result, 'lens-b-1');
  assert.ok(later, 'the later sighting is verified on its own, not attached to a finding of the doubted run');
  assert.equal(later.verdict, 'confirmed');
  assert.equal(reasonsOf(run.result)['lens-a-1'], ANOTHER_TREE('lens-a'));
  assertWhole(run, 3);
});

// ── What each member checked ─────────────────────────────────────────────────────────────────

test('each member carries the candidates it cleared and the readers it checked; a rerun carries its rerun\'s', async () => {
  const clearedA = [{ candidate: 'a null page', refuting_line: 'src/a.js:2: if (!page) return;' }];
  const readersA = [{ symbol: 'pageCount', command: 'rg -n pageCount', hits: 3, verdict: 'all pass a number' }];
  const clearedB = [{ candidate: 'second run candidate', refuting_line: 'src/b.js:1: guard' }];
  const run = await runWorkflow(
    waveArgs({ builtin: true }),
    scenario({
      members: {
        'lens-a': [{ findings: [], cleared: clearedA, readers_checked: readersA, not_checked: [] }],
        'lens-b': [
          { findings: [finding('src/ghost.js', 2, 'phantom')], cleared: [{ candidate: 'first run', refuting_line: 'x' }], readers_checked: [], not_checked: [] },
          { findings: [], cleared: clearedB, readers_checked: [], not_checked: [] },
        ],
      },
      verdicts: { phantom: PHANTOM },
    }),
  );
  const coverage = Object.fromEntries(run.result.members.map((member) => [member.name, [member.cleared, member.readers_checked]]));
  assert.deepEqual(coverage, {
    'lens-a': [clearedA, readersA],
    'lens-b': [clearedB, []],
    builtin: [[], []],
    mechanical: [[], []],
  });
  assertWhole(run, 1);
});

test('a dead member carries empty coverage', async () => {
  const run = await runWorkflow(waveArgs(), scenario({ members: { 'lens-a': [null, null] } }));
  const member = run.result.members.find((entry) => entry.name === 'lens-a');
  assert.deepEqual([member.status, member.cleared, member.readers_checked], ['dead', [], []]);
  assertWhole(run, 0);
});

// ── Dead agents and failed stages ────────────────────────────────────────────────────────────

test('a member that returns nothing twice is dead; once, it is retried and ok', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({ members: { 'lens-a': [null, null], 'lens-b': [null, report(finding('src/b.js', 1, 'late finding'))] } }),
  );
  const status = Object.fromEntries(run.result.members.map((member) => [member.name, member.status]));
  assert.equal(status['lens-a'], 'dead');
  assert.equal(status['lens-b'], 'ok');
  assert.deepEqual(
    memberCalls(run.calls).map((call) => call.opts.label).filter((label) => label.startsWith('lens-')).sort(),
    ['lens-a', 'lens-a retry', 'lens-b', 'lens-b retry'],
  );
  assert.ok(run.result.not_checked.some((line) => line.startsWith('lens-a: ')));
  assert.ok(byId(run.result, 'lens-b-1'));
  assertWhole(run, 1);
});

test('a member stage that throws is dead with a not_checked line', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({ members: { 'lens-a': [() => { throw new Error('transport closed'); }] } }),
  );
  assert.equal(run.result.members.find((member) => member.name === 'lens-a').status, 'dead');
  assert.ok(run.result.not_checked.includes('lens-a: the member stage failed; this pass did not run'));
  assertWhole(run, 0);
});

test('a dead verifier and a missing verdict leave their findings unverified with the reason', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'verifier dies here'))],
        'lens-b': [report(finding('src/b.js', 1, 'answered'), finding('src/b.js', 2, 'left out'))],
      },
      verdicts: { 'left out': 'omit' },
      verifier: (call, input) => {
        if (input.findings.some((entry) => entry.defect === 'verifier dies here')) return null;
        return {
          verdicts: [
            ...input.findings.filter((entry) => entry.defect !== 'left out').map(defaultVerdict),
            { ...defaultVerdict(input.findings[0]), id: 'lens-z-9' },
          ],
        };
      },
    }),
  );
  const reasons = Object.fromEntries(run.result.unverified.map((entry) => [entry.id, entry.reason]));
  assert.deepEqual(reasons, { 'lens-a-1': 'verifier died', 'lens-b-2': 'no verdict' });
  assert.ok(run.logs.some((line) => /lens-z-9, which this call was not given, was ignored/.test(line)));
  assert.ok(byId(run.result, 'lens-b-1'));
  assertWhole(run, 3);
});

test('a verification stage that throws reports every finding it held unverified', async () => {
  const run = await runWorkflow(
    waveArgs({ max_agents: 5 }),
    scenario({
      members: {
        'lens-a': [report(finding('src/a.js', 1, 'one'), finding('src/a.js', 2, 'two'), finding('src/a.js', 3, 'three'))],
        'lens-b': [report(finding('src/b.js', 1, 'unaffected'))],
      },
      verdicts: { two: { verdict: 'maybe' } },
    }),
  );
  const failed = run.result.unverified.filter((entry) => entry.id.startsWith('lens-a-'));
  assert.equal(failed.length, 3);
  for (const entry of failed) {
    assert.match(entry.reason, /^stage failed: unknown verdict "maybe"/);
    assert.equal(entry.verdict, undefined);
  }
  assert.ok(run.result.not_checked.some((line) => line.startsWith('lens-a: verification failed')));
  assert.ok(byId(run.result, 'lens-b-1'));
  assertWhole(run, 4);
});

test('a mechanical member whose verification throws still reports the gates it ran', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: {
        mechanical: [
          gatesReport(
            [{ name: 'tests', command: 'npm test', status: 'pass', output_tail: 'ok' }],
            [{ file: 'src/a.js', line: 3, recipe: 'DIP fetch', text: 'fetch(url)', cleared_when: 'never' }],
          ),
        ],
      },
      verdicts: { '`DIP fetch` hit: `fetch(url)`': { verdict: 'maybe' } },
    }),
  );
  assert.match(reasonsOf(run.result)['mechanical-1'], /^stage failed/);
  assert.deepEqual(run.result.gates.map((gate) => [gate.name, gate.status]), [['tests', 'pass']]);
  assertWhole(run, 1);
});

// ── Rules leads ──────────────────────────────────────────────────────────────────────────────

const LEADS = [
  { item: 'Every new query applies the tenant scope', verdict: 'violates', note: 'the decision model says so' },
  { item: 'Comments name no sibling module', verdict: 'uncertain', note: 'not shown' },
];

test('rules leads are verified as location-less candidates and a folded lead is kept whole on the finding', async () => {
  const run = await runWorkflow(
    waveArgs({ rules_leads: LEADS }),
    scenario({
      members: { 'lens-a': [report(finding('src/q.js', 4, 'the query skips the tenant scope'))] },
      verdicts: {
        'Every new query applies the tenant scope': { file: 'src/q.js', line: 4, evidence: 'src/q.js:4: select * from rows' },
        'Comments name no sibling module': { verdict: 'refuted', evidence: 'src/q.js:1: // Loads the rows' },
      },
      result: (input) => ({
        clusters: [{ cluster: 'tenant scope', ids: [...input.findings, ...input.leads].map((entry) => entry.id) }],
        distinct_duplicates: [],
        folded_leads: [{ lead: 'rules-1', into: 'lens-a-1' }],
      }),
    }),
  );
  const leadCall = verifierCalls(run.calls).find((call) => call.opts.label === 'verify rules');
  assert.equal(leadCall.opts.model, 'sonnet');
  assert.deepEqual(verifierInput(leadCall.prompt).findings, [
    { id: 'f1', file: null, line: null, defect: LEADS[0].item, failure_scenario: null, rule: LEADS[0].item, claimed_severity: null },
    { id: 'f2', file: null, line: null, defect: LEADS[1].item, failure_scenario: null, rule: LEADS[1].item, claimed_severity: null },
  ]);
  assert.doesNotMatch(leadCall.prompt, /decision model says so|violates|uncertain/);
  assert.doesNotMatch(leadCall.prompt, MEMBER_NAME);
  const target = byId(run.result, 'lens-a-1');
  assert.deepEqual(target.found_by, ['lens-a', 'rules']);
  assert.deepEqual(
    target.leads.map((lead) => [lead.id, lead.defect, lead.verdict, lead.file, lead.line, lead.evidence, lead.found_by]),
    [['rules-1', LEADS[0].item, 'confirmed', 'src/q.js', 4, 'src/q.js:4: select * from rows', ['rules']]],
  );
  assert.equal(byId(run.result, 'rules-1'), undefined, 'a folded lead is not listed twice');
  assert.equal(run.result.refuted.find((entry) => entry.id === 'rules-2').evidence, 'src/q.js:1: // Loads the rows');
  assertWhole(run, 3);
});

test('a lead folded into a finding that is not confirmed, or not where the lead was verified, stays a finding of its own', async () => {
  const run = await runWorkflow(
    waveArgs({ rules_leads: LEADS }),
    scenario({
      members: {
        'lens-a': [report(finding('src/q.js', 4, 'the query skips the tenant scope'))],
        'lens-b': [report(finding('src/q.js', 9, 'a comment names a neighbour'))],
      },
      verdicts: {
        'a comment names a neighbour': { verdict: 'plausible', confirm_by: 'read the comment' },
        [LEADS[0].item]: { file: 'src/q.js', line: 5 },
        [LEADS[1].item]: { file: 'src/q.js', line: 9 },
      },
      result: (input) => ({
        clusters: [...input.findings, ...input.leads].map((entry) => ({ cluster: entry.id, ids: [entry.id] })),
        distinct_duplicates: [],
        folded_leads: [
          { lead: 'rules-1', into: 'lens-a-1' },
          { lead: 'rules-2', into: 'lens-b-1' },
        ],
      }),
    }),
  );
  assert.deepEqual(byId(run.result, 'lens-a-1').leads, []);
  assert.deepEqual(byId(run.result, 'lens-a-1').found_by, ['lens-a']);
  assert.deepEqual(byId(run.result, 'lens-b-1').leads, []);
  assert.deepEqual(byId(run.result, 'rules-1').found_by, ['rules']);
  assert.deepEqual(byId(run.result, 'rules-2').found_by, ['rules']);
  assert.ok(run.logs.some((line) => /folding rules-1 into lens-a-1 ignored/.test(line)), run.logs.join('\n'));
  assert.ok(run.logs.some((line) => /folding rules-2 into lens-b-1 ignored/.test(line)), run.logs.join('\n'));
  assertWhole(run, 4);
});

test('the result agent clusters the leads with the findings', async () => {
  const run = await runWorkflow(
    waveArgs({ rules_leads: [LEADS[0]] }),
    scenario({
      members: { 'lens-a': [report(finding('src/q.js', 4, 'the query skips the tenant scope'))] },
      verdicts: { [LEADS[0].item]: { file: 'src/q.js', line: 20 } },
      result: (input) => ({
        clusters: [{ cluster: 'tenant scope', ids: [...input.findings, ...input.leads].map((entry) => entry.id) }],
        distinct_duplicates: [],
        folded_leads: [],
      }),
    }),
  );
  const resultCall = run.calls.find((call) => call.opts.phase === 'Result');
  assert.match(resultCall.prompt, /every id under `findings` and every id under `leads`/);
  assert.equal(byId(run.result, 'rules-1').cluster, 'tenant scope');
  assert.deepEqual(run.result.not_checked, []);
  assertWhole(run, 2);
});

test('a confirmed lead no finding covers is reported as a finding of the rules check', async () => {
  const run = await runWorkflow(
    waveArgs({ class: 'L', rules_leads: [LEADS[0]] }),
    scenario({ verdicts: { [LEADS[0].item]: { file: 'src/q.js', line: 9, severity: 'Important' } } }),
  );
  assert.equal(verifierCalls(run.calls).find((call) => call.opts.label === 'verify rules').opts.model, 'opus');
  const lead = byId(run.result, 'rules-1');
  assert.deepEqual([lead.file, lead.line, lead.verdict, lead.found_by], ['src/q.js', 9, 'confirmed', ['rules']]);
  assert.deepEqual(run.result.not_checked, [], 'a clustered lead adds no line');
  assertWhole(run, 1);
});

// ── Refuted, clusters and ranking ────────────────────────────────────────────────────────────

test('refuted findings are kept with their evidence', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: { 'lens-b': [report(finding('src/a.js', 5, 'missing guard'))] },
      verdicts: { 'missing guard': { verdict: 'refuted', evidence: 'src/a.js:3: if (!user) return null;' } },
    }),
  );
  assert.deepEqual(run.result.findings, []);
  assert.deepEqual(
    run.result.refuted.map((entry) => [entry.id, entry.verdict, entry.evidence]),
    [['lens-b-1', 'refuted', 'src/a.js:3: if (!user) return null;']],
  );
  assertWhole(run, 1);
});

function rankingMembers() {
  return {
    'lens-a': [
      report(
        finding('src/a.js', 1, 'minor wording', { severity: 'Minor' }),
        finding('src/a.js', 2, 'critical but plausible', { severity: 'Critical' }),
        finding('src/a.js', 3, 'important confirmed', { severity: 'Important' }),
        finding('src/a.js', 4, 'critical confirmed', { severity: 'Critical' }),
      ),
    ],
    mechanical: [gatesReport([{ name: 'tests', command: 'npm test', status: 'fail', output_tail: '1 failing' }])],
  };
}

test('the result agent returns ids only: a finding it leaves out still appears, in a cluster of its own', async () => {
  const run = await runWorkflow(
    waveArgs(),
    scenario({
      members: rankingMembers(),
      verdicts: { 'critical but plausible': { verdict: 'plausible', confirm_by: 'run it under load' } },
      result: () => ({
        clusters: [
          { cluster: 'page count', ids: ['lens-a-4', 'lens-a-1'] },
          { cluster: 'load', ids: ['lens-a-2'] },
          { cluster: 'gate', ids: ['mechanical-1'] },
        ],
        distinct_duplicates: [],
        folded_leads: [],
      }),
    }),
  );
  assert.deepEqual(
    run.result.findings.map((entry) => [entry.id, entry.cluster]),
    [
      ['lens-a-4', 'page count'],
      ['lens-a-1', 'page count'],
      ['mechanical-1', 'gate'],
      ['lens-a-2', 'load'],
      ['lens-a-3', 'lens-a-3'],
    ],
  );
  assert.equal(byId(run.result, 'lens-a-2').confirm_by, 'run it under load');
  assert.equal(byId(run.result, 'lens-a-1').defect, 'minor wording', 'the text is the script\'s, not the agent\'s');
  assert.ok(run.result.not_checked.includes('lens-a-3: in no cluster of the result agent; given a cluster of its own'));
  assertWhole(run, 5);
});

test('with no result agent the findings are ranked in code and duplicates go unverified', async () => {
  const members = { ...rankingMembers(), 'lens-b': [report(finding('src/a.js', 3, 'same line, other words'))] };
  const run = await runWorkflow(waveArgs(), scenario({
    members,
    verdicts: { 'critical but plausible': { verdict: 'plausible' } },
    result: () => null,
  }), { 'lens-a': 0, 'lens-b': 20 });
  assert.deepEqual(
    run.result.findings.map((entry) => entry.id),
    ['lens-a-4', 'mechanical-1', 'lens-a-2', 'lens-a-3', 'lens-a-1'],
  );
  assert.ok(run.result.findings.every((entry) => entry.cluster === entry.id));
  assert.ok(run.result.not_checked.includes('result agent did not run; clusters not formed'));
  assert.deepEqual(
    run.result.unverified.map((entry) => [entry.id, entry.reason]),
    [['lens-b-1', 'same line as lens-a-3, different defect']],
  );
  assertWhole(run, 6);
});

test('a result agent that throws is treated as one that did not run', async () => {
  const run = await runWorkflow(waveArgs(), scenario({
    members: rankingMembers(),
    verdicts: { 'critical but plausible': { verdict: 'plausible' } },
    result: () => {
      throw new Error('the token target is spent');
    },
  }));
  assert.deepEqual(
    run.result.findings.map((entry) => entry.id),
    ['lens-a-4', 'mechanical-1', 'lens-a-2', 'lens-a-3', 'lens-a-1'],
  );
  assert.ok(run.result.not_checked.includes('result agent did not run; clusters not formed'));
  assert.ok(run.logs.some((line) => /result agent.*the token target is spent/.test(line)), run.logs.join('\n'));
  assertWhole(run, 5);
});

test('a review with nothing to cluster spawns no result agent', async () => {
  const run = await runWorkflow(waveArgs(), scenario());
  assert.equal(run.calls.filter((call) => call.opts.phase === 'Result').length, 0);
  assert.deepEqual(run.result.not_checked, []);
  assertWhole(run, 0);
});

// ── Delta mode ───────────────────────────────────────────────────────────────────────────────

test('delta mode runs one delta member, no built-in and no mechanical, and its ids carry the round', async () => {
  const args = deltaArgs({ round: 2, brief: { already_reported: ['/scratch/review-result.json', '/scratch/review-delta-1.json'] } });
  const run = await runWorkflow(args, scenario({ members: { 'delta-2': [report(finding('src/a.js', 8, 'a fix dropped the return'))] } }));
  assert.deepEqual(wave(run.calls), [['delta-2', REVIEWER, 'opus', 'high']]);
  const prompt = memberCalls(run.calls)[0].prompt;
  assert.match(prompt, /^Lens: delta$/m);
  assert.match(prompt, /^Already reported: \/scratch\/review-result\.json, \/scratch\/review-delta-1\.json$/m);
  assert.equal(run.result.mode, 'delta');
  assert.equal(run.result.round, 2);
  assert.deepEqual(run.result.members.map((member) => member.name), ['delta-2']);
  assert.deepEqual(run.result.findings.map((entry) => entry.id), ['delta-2-1']);
  assertWhole(run, 1);
});

test('the result carries the shape the session reads', async () => {
  const run = await runWorkflow(waveArgs(), scenario({ members: { 'lens-a': [report(finding('src/a.js', 1, 'defect'))] } }));
  assert.deepEqual(Object.keys(run.result).sort(), [
    'budget', 'class', 'discarded', 'findings', 'gates', 'members', 'mode', 'not_checked', 'refuted', 'unverified',
  ]);
  assert.equal(run.result.class, 'M');
  assert.deepEqual(Object.keys(run.result.budget).sort(), ['batched', 'max_agents', 'over_by', 'used']);
  const entry = run.result.findings[0];
  for (const field of ['id', 'cluster', 'file', 'line', 'defect', 'failure_scenario', 'rule', 'severity', 'verdict', 'evidence', 'trace', 'fix', 'found_by', 'duplicates', 'leads']) {
    assert.ok(field in entry, field);
  }
  assertWhole(run, 1);
});
