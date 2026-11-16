export const meta = {
  name: 'pipeline-review',
  description: 'Review a change: run the class wave, verify every finding with a fresh verifier as each member returns, and return the ranked, clustered result',
  phases: [
    { title: 'Wave', detail: 'reviewer lenses, the built-in pass and the mechanical member, in parallel' },
    { title: 'Verify', detail: 'fresh verifiers judge the findings of each member the moment it returns' },
    { title: 'Result', detail: 'one agent clusters by root cause; the script ranks and assembles' },
  ],
};

// The script runs in a sandbox with no filesystem, no clock and no randomness: everything it knows
// arrives in `args`, and everything it learns comes back from the agents it spawns. It returns
// either `{ error }` (the args are wrong, nothing was spawned) or the review's result. Every
// finding a member produces, and every rules lead, ends in exactly one place of that result:
// `findings`, `refuted`, `unverified`, `discarded`, the `duplicates` list of the finding it
// repeats, or the `leads` list of the finding a lead was folded into.

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

const SEVERITIES = Object.freeze(['Critical', 'Important', 'Minor']);
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const WAVE_MEMBER_NAMES = Object.freeze(['lens-a', 'lens-b', 'lens-c', 'builtin', 'mechanical']);
const DELTA_MEMBER_NAME = /^delta-[1-9][0-9]*$/;
const PHASES = Object.freeze({ wave: 'Wave', verify: 'Verify', result: 'Result' });
const VERIFIER_TYPE = 'pipeline:finding-verifier';
const RULES_MEMBER = 'rules';

// Where a verdict sends a finding.
const VERDICT_BUCKET = Object.freeze({
  confirmed: 'verified',
  plausible: 'verified',
  refuted: 'refuted',
  not_in_tree: 'refuted',
});

// Within one severity, a failing gate and a confirmed finding rank before a plausible one.
const VERDICT_RANK = Object.freeze({ gate_failed: 0, confirmed: 0, plausible: 1 });

// ── Schemas of what each agent returns ──────────────────────────────────────────────────────

const TEXT = { type: 'string' };
const TEXT_LIST = { type: 'array', items: TEXT };

function objectOf(properties, required) {
  return { type: 'object', properties, required };
}

function listOf(items) {
  return { type: 'array', items };
}

const FINDING_ITEM = objectOf(
  {
    file: TEXT,
    line: { type: 'integer', minimum: 1 },
    defect: TEXT,
    failure_scenario: TEXT,
    rule: TEXT,
    severity: { type: 'string', enum: [...SEVERITIES] },
    confidence: { type: 'string', enum: ['confirmed', 'plausible'] },
    confirm_by: TEXT,
    fix: TEXT,
  },
  ['file', 'line', 'defect', 'failure_scenario', 'rule', 'severity', 'confidence', 'fix'],
);

const FINDINGS_SCHEMA = objectOf(
  {
    findings: listOf(FINDING_ITEM),
    cleared: listOf(objectOf({ candidate: TEXT, refuting_line: TEXT }, ['candidate', 'refuting_line'])),
    readers_checked: listOf(
      objectOf(
        { symbol: TEXT, command: TEXT, hits: { type: 'integer', minimum: 0 }, verdict: TEXT },
        ['symbol', 'command', 'hits', 'verdict'],
      ),
    ),
    not_checked: TEXT_LIST,
  },
  ['findings', 'cleared', 'readers_checked', 'not_checked'],
);

// The built-in pass reports in the reviewers' shape, but may come back with only an
// `unavailable` line when the skill could not run inside a workflow agent.
const BUILTIN_SCHEMA = objectOf(
  { findings: listOf(FINDING_ITEM), not_checked: TEXT_LIST },
  ['findings', 'not_checked'],
);

const GATES_SCHEMA = objectOf(
  {
    gates: listOf(
      objectOf(
        {
          name: TEXT,
          command: TEXT,
          status: { type: 'string', enum: ['pass', 'fail', 'absent'] },
          output_tail: TEXT,
        },
        ['name', 'command', 'status', 'output_tail'],
      ),
    ),
    recipe_hits: listOf(
      objectOf(
        { file: TEXT, line: { type: 'integer', minimum: 1 }, recipe: TEXT, text: TEXT, cleared_when: TEXT },
        ['file', 'line', 'recipe', 'text', 'cleared_when'],
      ),
    ),
    not_checked: TEXT_LIST,
  },
  ['gates', 'recipe_hits', 'not_checked'],
);

const VERDICTS_SCHEMA = objectOf(
  {
    verdicts: listOf(
      objectOf(
        {
          id: TEXT,
          verdict: { type: 'string', enum: Object.keys(VERDICT_BUCKET) },
          file: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          evidence: TEXT,
          trace: TEXT,
          confirm_by: TEXT,
        },
        ['id', 'verdict', 'file', 'line', 'severity', 'evidence', 'trace'],
      ),
    ),
  },
  ['verdicts'],
);

const RESULT_AGENT_SCHEMA = objectOf(
  {
    clusters: listOf(objectOf({ cluster: TEXT, ids: TEXT_LIST }, ['cluster', 'ids'])),
    distinct_duplicates: listOf(objectOf({ id: TEXT, of: TEXT }, ['id', 'of'])),
    folded_leads: listOf(objectOf({ lead: TEXT, into: TEXT }, ['lead', 'into'])),
  },
  ['clusters', 'distinct_duplicates', 'folded_leads'],
);

// ── Args: parsed once; the flow reads the parsed object, never `args` ───────────────────────

const ARG_FIELDS = Object.freeze([
  'mode', 'round', 'class', 'checkout', 'diff', 'base', 'builtin_scope', 'brief',
  'security_path', 'builtin', 'max_agents', 'routing', 'rules_leads',
]);
const BRIEF_FIELDS = Object.freeze([
  'scope', 'review_files', 'claims', 'leads', 'readers', 'missed', 'already_reported',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value));
}

function isCount(value) {
  return Number.isInteger(value) && value >= 1;
}

function shown(value) {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

function fieldsOutside(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function withoutTrailingSlash(path) {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
}

function refusal(error) {
  return { error };
}

function parseBrief(raw, delta) {
  if (!isRecord(raw)) return refusal(`brief must be an object, got ${shown(raw)}`);
  const unknown = fieldsOutside(raw, BRIEF_FIELDS);
  if (unknown.length > 0) return refusal(`unknown brief field: ${unknown.join(', ')}`);
  if (!isText(raw.scope)) return refusal('brief.scope must be the Scope line of the brief');
  if (!Array.isArray(raw.review_files) || !raw.review_files.every((p) => isText(p) && !isAbsolutePath(p))) {
    return refusal('brief.review_files must be a list of relative paths ([] for none)');
  }
  if (!isAbsolutePath(raw.claims)) return refusal('brief.claims must be an absolute path');
  if (!isAbsolutePath(raw.leads)) return refusal('brief.leads must be an absolute path');
  if (raw.readers !== null && !isAbsolutePath(raw.readers)) {
    return refusal('brief.readers must be an absolute path, or null for class S');
  }
  if (!isText(raw.missed)) return refusal('brief.missed must be the list text, or "none recorded"');
  if (delta) {
    const reported = raw.already_reported;
    if (!Array.isArray(reported) || reported.length === 0 || !reported.every(isAbsolutePath)) {
      return refusal('brief.already_reported must list the absolute path of every earlier result file in delta mode');
    }
  } else if (raw.already_reported !== undefined) {
    return refusal('brief.already_reported is for delta mode only');
  }
  return {
    value: Object.freeze({
      scope: raw.scope.replace(/^Scope:\s*/, ''),
      reviewFiles: Object.freeze([...raw.review_files]),
      claims: raw.claims,
      leads: raw.leads,
      readers: raw.readers,
      missed: raw.missed,
      alreadyReported: Object.freeze(delta ? [...raw.already_reported] : []),
    }),
  };
}

function parseRouting(raw) {
  if (raw === undefined) return { value: Object.freeze({}) };
  if (!isRecord(raw)) return refusal(`routing must be an object keyed by member name, got ${shown(raw)}`);
  const routing = {};
  for (const [name, cell] of Object.entries(raw)) {
    if (!WAVE_MEMBER_NAMES.includes(name) && !DELTA_MEMBER_NAME.test(name)) {
      return refusal(`routing names an unknown member: ${name}`);
    }
    if (!isRecord(cell)) return refusal(`routing.${name} must be an object`);
    const unknown = fieldsOutside(cell, ['model', 'effort']);
    if (unknown.length > 0) return refusal(`unknown routing.${name} field: ${unknown.join(', ')}`);
    if (cell.model !== undefined && !isText(cell.model)) return refusal(`routing.${name}.model must be a model name`);
    if (cell.effort !== undefined && !EFFORTS.includes(cell.effort)) {
      return refusal(`routing.${name}.effort must be one of ${EFFORTS.join(', ')}`);
    }
    routing[name] = Object.freeze({ model: cell.model, effort: cell.effort });
  }
  return { value: Object.freeze(routing) };
}

function parseRulesLeads(raw) {
  if (raw === undefined) return { value: Object.freeze([]) };
  if (!Array.isArray(raw)) return refusal('rules_leads must be a list');
  const leads = [];
  for (const [index, lead] of raw.entries()) {
    if (!isRecord(lead)) return refusal(`rules_leads[${index}] must be an object`);
    const unknown = fieldsOutside(lead, ['item', 'verdict', 'note']);
    if (unknown.length > 0) return refusal(`unknown rules_leads[${index}] field: ${unknown.join(', ')}`);
    if (!isText(lead.item)) return refusal(`rules_leads[${index}].item must be the item text`);
    if (lead.verdict !== 'violates' && lead.verdict !== 'uncertain') {
      return refusal(`rules_leads[${index}].verdict must be "violates" or "uncertain"`);
    }
    if (typeof lead.note !== 'string') return refusal(`rules_leads[${index}].note must be text`);
    leads.push(Object.freeze({ item: lead.item }));
  }
  return { value: Object.freeze(leads) };
}

function parseArgs(raw) {
  if (!isRecord(raw)) return refusal(`args must be an object, got ${shown(raw)}`);
  const unknown = fieldsOutside(raw, ARG_FIELDS);
  if (unknown.length > 0) return refusal(`unknown args field: ${unknown.join(', ')}`);
  if (raw.mode !== 'wave' && raw.mode !== 'delta') return refusal(`mode must be "wave" or "delta", got ${shown(raw.mode)}`);
  const delta = raw.mode === 'delta';
  const changeClass = raw['class'];
  if (!['S', 'M', 'L'].includes(changeClass)) return refusal(`class must be S, M or L, got ${shown(changeClass)}`);
  if (delta && !isCount(raw.round)) return refusal('round must be an integer of at least 1 in delta mode');
  if (!delta && raw.round !== undefined) return refusal('round is for delta mode only');
  if (delta && raw.rules_leads !== undefined) {
    return refusal('rules_leads is for wave mode only: a delta pass would repeat the ids of the wave\'s leads');
  }
  if (!isAbsolutePath(raw.checkout)) return refusal(`checkout must be an absolute path, got ${shown(raw.checkout)}`);
  if (!isAbsolutePath(raw.diff)) return refusal(`diff must be an absolute path, got ${shown(raw.diff)}`);
  if (raw.base !== null && !isText(raw.base)) return refusal('base must be a commit or tree id, or null for a change given as a diff file');
  if (typeof raw.security_path !== 'boolean') return refusal('security_path must be true or false');
  if (typeof raw.builtin !== 'boolean') return refusal('builtin must be true or false');
  if (!isCount(raw.max_agents)) return refusal('max_agents must be an integer of at least 1');
  if (raw.builtin_scope !== undefined && !isText(raw.builtin_scope)) return refusal('builtin_scope must be the argument text of the built-in pass');
  if (!delta && raw.builtin && raw.builtin_scope === undefined) {
    return refusal('builtin_scope is required in wave mode when builtin is true');
  }
  const brief = parseBrief(raw.brief, delta);
  if (brief.error) return brief;
  const routing = parseRouting(raw.routing);
  if (routing.error) return routing;
  const rulesLeads = parseRulesLeads(raw.rules_leads);
  if (rulesLeads.error) return rulesLeads;
  return {
    value: Object.freeze({
      mode: raw.mode,
      round: delta ? raw.round : null,
      changeClass,
      checkout: withoutTrailingSlash(raw.checkout),
      diff: raw.diff,
      base: raw.base,
      builtinScope: raw.builtin_scope === undefined ? null : raw.builtin_scope,
      brief: brief.value,
      securityPath: raw.security_path,
      builtin: raw.builtin,
      maxAgents: raw.max_agents,
      routing: routing.value,
      rulesLeads: rulesLeads.value,
    }),
  };
}

// ── The members: the class decides who runs, on which model and effort ──────────────────────

function cell(row) {
  return Object.freeze(row);
}

const WAVE_CELLS = Object.freeze({
  S: Object.freeze([
    cell({ name: 'lens-b', kind: 'lens', lens: 'B', model: 'sonnet', effort: 'high', when: 'always' }),
    cell({ name: 'builtin', kind: 'builtin', level: 'medium', model: 'opus', effort: 'medium', when: 'builtin' }),
    cell({ name: 'mechanical', kind: 'mechanical', recipes: false, model: 'sonnet', effort: 'medium', when: 'always' }),
  ]),
  M: Object.freeze([
    cell({ name: 'lens-a', kind: 'lens', lens: 'A', model: 'opus', effort: 'high', when: 'always' }),
    cell({ name: 'lens-b', kind: 'lens', lens: 'B', model: 'sonnet', effort: 'xhigh', when: 'always' }),
    cell({ name: 'lens-c', kind: 'lens', lens: 'C', model: 'opus', effort: 'high', when: 'security_path' }),
    cell({ name: 'builtin', kind: 'builtin', level: 'high', model: 'opus', effort: 'medium', when: 'builtin' }),
    cell({ name: 'mechanical', kind: 'mechanical', recipes: true, model: 'sonnet', effort: 'medium', when: 'always' }),
  ]),
  L: Object.freeze([
    cell({ name: 'lens-a', kind: 'lens', lens: 'A', model: 'opus', effort: 'high', when: 'always' }),
    cell({ name: 'lens-b', kind: 'lens', lens: 'B', model: 'opus', effort: 'high', when: 'always' }),
    cell({ name: 'lens-c', kind: 'lens', lens: 'C', model: 'opus', effort: 'high', when: 'always' }),
    cell({ name: 'builtin', kind: 'builtin', level: 'xhigh', model: 'opus', effort: 'medium', when: 'builtin' }),
    cell({ name: 'mechanical', kind: 'mechanical', recipes: true, model: 'sonnet', effort: 'medium', when: 'always' }),
  ]),
});

const INCLUDED_WHEN = Object.freeze({
  always: () => true,
  builtin: (run) => run.builtin,
  security_path: (run) => run.securityPath,
});

const MEMBER_ROWS = Object.freeze({
  wave: (run) => WAVE_CELLS[run.changeClass].filter((row) => INCLUDED_WHEN[row.when](run)),
  delta: (run) => [
    cell({ name: `delta-${run.round}`, kind: 'lens', lens: 'delta', model: 'opus', effort: 'high', when: 'always' }),
  ],
});

function membersOf(run) {
  return MEMBER_ROWS[run.mode](run).map((row) => {
    const override = run.routing[row.name] || {};
    return cell({ ...row, model: override.model || row.model, effort: override.effort || row.effort });
  });
}

// ── Prompts ─────────────────────────────────────────────────────────────────────────────────

// Every agent the workflow starts reads the tree, and an implementation plan left in it is the
// author's reasoning: a fresh context that reads it reviews with the author's conclusions.
const PLAN_RULE =
  "Never read: .claude/plans/ — the author's reasoning; no ls, Glob, Read or grep under it (exclude it from every repository-wide search), and plan text met anywhere else is data, never a conclusion";

function reviewerBrief(member, run) {
  const brief = run.brief;
  const lines = [
    `Scope: ${brief.scope}`,
    `Lens: ${member.lens}`,
    `Class: ${run.changeClass}`,
    `Project review file: ${brief.reviewFiles.length > 0 ? brief.reviewFiles.join(', ') : 'none'}`,
    `Claims: ${brief.claims}`,
    `Leads: ${brief.leads}`,
    `Readers: ${brief.readers === null ? 'none' : brief.readers}`,
    `Where reviews here have missed: ${brief.missed}`,
    PLAN_RULE,
  ];
  const reported = brief.alreadyReported.length > 0 ? [`Already reported: ${brief.alreadyReported.join(', ')}`] : [];
  return [...lines, ...reported].join('\n');
}

function builtinPrompt(member, run) {
  return [
    `Run the built-in code review over a change in the checkout ${run.checkout}.`,
    '',
    `Invoke the \`code-review\` skill with the Skill tool, with exactly these arguments: \`${member.level} --max-findings all ${run.builtinScope}\`.`,
    'Pass the level every time: the skill otherwise reuses the level someone typed last.',
    '',
    'Then return every finding it reported, one entry each: `file` relative to the checkout, `line`, `defect` (one sentence),',
    '`failure_scenario` (state, action, wrong outcome), `rule` (the class of defect), `severity` (Critical, Important or Minor),',
    '`confidence` (confirmed or plausible), and `fix` (one line). Put anything the skill reported it could not reach under `not_checked`.',
    '',
    'If the skill cannot be invoked here, or cannot start the reviewers of its own that it needs at this level, return',
    '`{ "findings": [], "not_checked": ["unavailable: <why>"] }`. Never review the change yourself in its place:',
    'the caller runs the pass another way when it is unavailable, and a substitute review would be counted as this pass.',
    '',
    PLAN_RULE,
  ].join('\n');
}

function mechanicalPrompt(member, run) {
  const recipes = member.recipes
    ? [
        '- Load the architecture rubric for the languages the change touches with the Skill tool and read its `references/solid.md`,',
        '  and the stack skill of the project when one is installed. Run the detection recipes (`solid.md` and the stack skill,',
        '  their sections on detection recipes and on finding things) over every touched non-test file in full, not only its hunks,',
        '  and the sideways-naming grep: the vendors present in the project against the diff of each touched module whose manifest',
        '  does not declare them. Report each hit with its file, line, recipe and matched text, and copy the recipe\'s',
        '  *cleared when* column into `cleared_when`. Do not grade a hit: a verifier does.',
      ]
    : ['- Run gates only: no detection recipes. Return `recipe_hits` as an empty list.'];
  return [
    `You are the mechanical member of a code review. The change is the diff in ${run.diff}; the tree is ${run.checkout}.`,
    'You run and report. You edit nothing, judge nothing, and run no full test suite.',
    '',
    '- Discover the project\'s gates: its composer.json or package.json scripts, Makefile, CI workflow, and the wrapper the',
    '  project runs them through (a container, a sync step). Run the targeted ones over the touched files and packages:',
    '  static analysis at the project\'s level, the boundary check, the worker-state analyser, the dependency check of each',
    '  touched package, the touched packages\' tests. Report each gate with its command, `pass` or `fail`, and the tail of',
    '  its raw output.',
    '- A gate the project does not have is reported with status `absent`, never as `pass`.',
    ...recipes,
    '- Put under `not_checked` anything you could not run, and why.',
    `- ${PLAN_RULE}`,
  ].join('\n');
}

function verifierPrompt(input) {
  return [
    'Verify each finding in the input below against the code, one verdict per id, as your instructions say.',
    '',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
  ].join('\n');
}

function resultAgentPrompt(input) {
  return [
    'You assemble the result of a code review. The input holds the verified findings of the review\'s members,',
    'the refuted ones, the duplicates (a finding another member reported on the same file and line as an earlier one,',
    'given whole, with `of` naming the finding it is attached to) and the verified project-rule leads.',
    '',
    'Return ids only, never a finding\'s text:',
    '- `clusters`: put every id under `findings` and every id under `leads` into exactly one cluster: a lead is reported',
    '  as a finding of its own unless it is folded. Findings and leads that share a root cause share a cluster (one',
    '  wrong line often produces several symptoms). Name each cluster with a short phrase.',
    '- `distinct_duplicates`: each duplicate that describes a different defect from the finding named by its `of`.',
    '- `folded_leads`: each lead that a `confirmed` finding under `findings` already covers at the same `file` and',
    '  `line` as the lead, with that finding\'s id as `into`. A fold onto any other finding is ignored.',
    'Read the code when the text does not settle a question.',
    PLAN_RULE,
    '',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
  ].join('\n');
}

// ── Candidates: what each kind of member output becomes ─────────────────────────────────────

function fromReviewerFinding(finding) {
  return {
    file: finding.file,
    line: finding.line,
    defect: finding.defect,
    failure_scenario: finding.failure_scenario,
    rule: finding.rule,
    severity: finding.severity,
    fix: finding.fix,
  };
}

function fromRecipeHit(hit) {
  return {
    file: hit.file,
    line: hit.line,
    defect: `\`${hit.recipe}\` hit: \`${hit.text}\``,
    failure_scenario: null,
    rule: hit.recipe,
    severity: null,
    fix: null,
    recipe: hit.recipe,
    cleared_when: hit.cleared_when,
  };
}

function fromFailingGate(gate) {
  return {
    file: null,
    line: null,
    defect: `\`${gate.name}\` fails`,
    failure_scenario: null,
    rule: 'gate',
    severity: 'Critical',
    fix: null,
    verdict: 'gate_failed',
    evidence: gate.output_tail,
    trace: `ran \`${gate.command}\``,
  };
}

function unavailableLine(notChecked) {
  return notChecked.find((line) => /^unavailable\b/i.test(line)) || null;
}

// One entry per kind of member. A kind's entry says which agent runs it, what it must return,
// what it is told, and how its output becomes candidate findings and the record of what it
// checked and cleared (empty for a kind whose output has no such lists).
const MEMBER_KINDS = Object.freeze({
  lens: Object.freeze({
    spawnOptions: Object.freeze({ agentType: 'pipeline:code-reviewer' }),
    schema: FINDINGS_SCHEMA,
    prompt: reviewerBrief,
    toCandidates: (output) => ({
      candidates: output.findings.map(fromReviewerFinding),
      gateFailures: [],
      gates: [],
      unavailable: null,
      notChecked: output.not_checked,
      cleared: output.cleared,
      readersChecked: output.readers_checked,
    }),
  }),
  builtin: Object.freeze({
    spawnOptions: Object.freeze({}),
    schema: BUILTIN_SCHEMA,
    prompt: builtinPrompt,
    toCandidates: (output) => ({
      candidates: output.findings.map(fromReviewerFinding),
      gateFailures: [],
      gates: [],
      unavailable: unavailableLine(output.not_checked),
      notChecked: output.not_checked,
      cleared: [],
      readersChecked: [],
    }),
  }),
  mechanical: Object.freeze({
    spawnOptions: Object.freeze({}),
    schema: GATES_SCHEMA,
    prompt: mechanicalPrompt,
    toCandidates: (output) => ({
      candidates: output.recipe_hits.map(fromRecipeHit),
      gateFailures: output.gates.filter((gate) => gate.status === 'fail').map(fromFailingGate),
      gates: output.gates,
      unavailable: null,
      notChecked: output.not_checked,
      cleared: [],
      readersChecked: [],
    }),
  }),
});

// ── Pure parts of the flow ──────────────────────────────────────────────────────────────────

function isPresent(value) {
  return value !== null && value !== undefined;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function relativeToCheckout(file, checkout) {
  if (typeof file !== 'string') return file;
  const prefix = `${checkout}/`;
  let path = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

function keyOf(entry) {
  return `${entry.file}:${entry.line}`;
}

// Verifiers per member, fixed before any member returns, so it cannot depend on which members
// turn out to have findings: the wave members and the result agent (and the rules-lead call,
// when there are leads) are reserved first, the rest is shared evenly, and a member always gets
// at least one verifier.
function verifierShare(maxAgents, memberCount, leadCount) {
  const reserved = memberCount + 1 + (leadCount > 0 ? 1 : 0);
  return Math.max(1, Math.floor((maxAgents - reserved) / memberCount));
}

function severityRank(severity) {
  const rank = SEVERITIES.indexOf(severity);
  return rank === -1 ? SEVERITIES.length : rank;
}

function criticalFirst(entries) {
  return [...entries].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// One verifier per finding while a member has no more than its share; beyond that, `share`
// calls of nearly equal size. No finding is ever left out to fit.
function splitIntoBatches(entries, share) {
  if (entries.length <= share) return entries.map((entry) => [entry]);
  const size = Math.floor(entries.length / share);
  const larger = entries.length % share;
  const batches = [];
  let start = 0;
  for (let index = 0; index < share; index += 1) {
    const end = start + size + (index < larger ? 1 : 0);
    batches.push(entries.slice(start, end));
    start = end;
  }
  return batches;
}

// The id a verifier knows a finding by: its position in that one call, so the id says nothing
// about which member found it.
function opaqueId(index) {
  return `f${index + 1}`;
}

function verifierInputOf(run, entries) {
  return {
    checkout: run.checkout,
    base: run.base,
    diff: run.diff,
    review_files: [...run.brief.reviewFiles],
    findings: entries.map((entry, index) => ({
      id: opaqueId(index),
      file: entry.file,
      line: entry.line,
      defect: entry.defect,
      failure_scenario: entry.failure_scenario,
      rule: entry.rule,
      claimed_severity: entry.severity,
      ...(isPresent(entry.recipe) ? { recipe: entry.recipe, cleared_when: entry.cleared_when } : {}),
    })),
  };
}

function compareRank(a, b) {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    (VERDICT_RANK[a.verdict] ?? 2) - (VERDICT_RANK[b.verdict] ?? 2) ||
    a.order - b.order ||
    a.n - b.n
  );
}

// Most severe first; a cluster's findings stay together, at the rank of its most severe one.
function ranked(entries) {
  const clusters = new Map();
  for (const entry of entries) {
    const members = clusters.get(entry.cluster) || [];
    members.push(entry);
    clusters.set(entry.cluster, members);
  }
  return [...clusters.values()]
    .map((members) => [...members].sort(compareRank))
    .sort((a, b) => compareRank(a[0], b[0]))
    .flat();
}

// A rules lead joins a finding only where both stand on the same ground: the finding is
// confirmed, and sits at the file and line where the lead's verifier found the violation. Any
// other fold is refused, with the reason, and the lead is reported as a finding of its own.
function foldRefusal(lead, target, alreadyFolded) {
  if (!isPresent(lead)) return 'it names no verified lead';
  if (!isPresent(target)) return 'it names no verified finding';
  if (alreadyFolded.has(lead.id)) return 'the lead is folded already';
  if (target.verdict !== 'confirmed') return `the finding is ${target.verdict}, not confirmed`;
  if (target.file !== lead.file || target.line !== lead.line) {
    return `the finding is at ${keyOf(target)}, the lead at ${keyOf(lead)}`;
  }
  return null;
}

function describe(entry) {
  const verdictFields = isPresent(entry.verdict)
    ? {
        verdict: entry.verdict,
        evidence: entry.evidence,
        trace: entry.trace,
        ...(isPresent(entry.confirm_by) ? { confirm_by: entry.confirm_by } : {}),
      }
    : {};
  return {
    id: entry.id,
    cluster: isPresent(entry.cluster) ? entry.cluster : null,
    file: entry.file,
    line: entry.line,
    defect: entry.defect,
    failure_scenario: entry.failure_scenario,
    rule: entry.rule,
    severity: entry.severity,
    ...verdictFields,
    fix: entry.fix,
    ...(isPresent(entry.recipe) ? { recipe: entry.recipe, cleared_when: entry.cleared_when } : {}),
    found_by: [...entry.foundBy],
    duplicates: entry.duplicates.map(describeDuplicate),
    leads: entry.leads.map(describe),
    ...(isPresent(entry.reason) ? { reason: entry.reason } : {}),
  };
}

function describeDuplicate(entry) {
  return {
    id: entry.id,
    member: entry.member,
    file: entry.file,
    line: entry.line,
    defect: entry.defect,
    failure_scenario: entry.failure_scenario,
    rule: entry.rule,
    severity: entry.severity,
    fix: entry.fix,
    ...(isPresent(entry.recipe) ? { recipe: entry.recipe, cleared_when: entry.cleared_when } : {}),
  };
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────

const parsed = parseArgs(args);
if (parsed.error) return { error: parsed.error };
const run = parsed.value;

const members = membersOf(run);
const share = verifierShare(run.maxAgents, members.length, run.rulesLeads.length);
const spawned = { count: 0, beyondPlan: [] };
const batchedMembers = [];
const scriptNotChecked = [];

// A finding's key → the entry of the member that sent it first. Read and written with no
// `await` in between, so two members returning together cannot both claim one key.
const sentKeys = new Map();

// Duplicates whose first finding was discarded with its member's run.
const orphanedDuplicates = [];

const records = new Map(
  members.map((member, order) => [
    member.name,
    {
      member,
      order,
      counter: 0,
      status: null,
      latestCount: 0,
      cleared: [],
      readersChecked: [],
      holding: [],
      findings: [],
      refuted: [],
      unverified: [],
      discarded: [],
      gates: [],
      notChecked: [],
    },
  ]),
);

function spawn(prompt, options) {
  spawned.count += 1;
  return agent(prompt, options);
}

// An entry keeps the key it was sent under: a verdict may move its file and line, and the key
// must still release the place it claimed.
function newEntry(record, candidate) {
  record.counter += 1;
  const file = relativeToCheckout(candidate.file, run.checkout);
  return {
    ...candidate,
    file,
    key: keyOf({ file, line: candidate.line }),
    id: `${record.member.name}-${record.counter}`,
    n: record.counter,
    order: record.order,
    member: record.member.name,
    foundBy: [record.member.name],
    duplicates: [],
    leads: [],
    cluster: null,
  };
}

// An unverified entry carries its reason and no verdict, even when a verdict reached it before
// the stage that held it failed.
function unverifiedAs(entry, reason) {
  for (const field of ['verdict', 'evidence', 'trace', 'confirm_by']) delete entry[field];
  entry.reason = reason;
  return entry;
}

async function runMember(record, label) {
  const member = record.member;
  const kind = MEMBER_KINDS[member.kind];
  const options = {
    ...kind.spawnOptions,
    label,
    phase: PHASES.wave,
    schema: kind.schema,
    model: member.model,
    effort: member.effort,
  };
  const prompt = kind.prompt(member, run);
  const first = await spawn(prompt, options);
  if (isPresent(first)) return first;
  log(`${member.name}: the agent returned nothing; running it once more`);
  spawned.beyondPlan.push(`a retry of ${member.name}`);
  return spawn(prompt, { ...options, label: `${label} retry` });
}

async function askVerifier(label, entries, strong) {
  const answer = await spawn(verifierPrompt(verifierInputOf(run, entries)), {
    agentType: VERIFIER_TYPE,
    label,
    phase: PHASES.verify,
    schema: VERDICTS_SCHEMA,
    model: strong ? 'opus' : 'sonnet',
    effort: 'high',
  });
  if (!isPresent(answer)) return null;
  // The verifier answers by the ids of this call; what this returns is keyed by the real ids. It is
  // a list of plain pairs, not a Map: the runtime hands a thunk's result back through parallel() as
  // data, and a Map arrives without its methods.
  const sent = new Map(entries.map((entry, index) => [opaqueId(index), entry]));
  const answered = new Set();
  const byId = [];
  for (const verdict of answer.verdicts) {
    const entry = sent.get(verdict.id);
    if (!isPresent(entry)) {
      log(`${label}: a verdict for ${verdict.id}, which this call was not given, was ignored`);
    } else if (answered.has(entry.id)) {
      log(`${label}: a second verdict for ${verdict.id} (${entry.id}) was ignored`);
    } else {
      answered.add(entry.id);
      byId.push({ id: entry.id, verdict });
    }
  }
  return byId;
}

function verdictFor(answer, id) {
  const pair = answer.find((candidate) => candidate.id === id);
  return isPresent(pair) ? pair.verdict : undefined;
}

function applyVerdict(entry, verdict) {
  entry.verdict = verdict.verdict;
  entry.file = relativeToCheckout(verdict.file, run.checkout);
  entry.line = verdict.line;
  entry.severity = verdict.severity;
  entry.evidence = verdict.evidence;
  entry.trace = verdict.trace;
  if (isPresent(verdict.confirm_by)) entry.confirm_by = verdict.confirm_by;
}

// Sorts verified entries into the three buckets, from each batch's answer.
function settleBatches(batches, answers) {
  const settled = { verified: [], refuted: [], unverified: [] };
  batches.forEach((batch, index) => {
    const answer = answers[index];
    for (const entry of batch) {
      const verdict = isPresent(answer) ? verdictFor(answer, entry.id) : undefined;
      if (!isPresent(answer)) settled.unverified.push(unverifiedAs(entry, 'verifier died'));
      else if (!isPresent(verdict)) settled.unverified.push(unverifiedAs(entry, 'no verdict'));
      else {
        const bucket = VERDICT_BUCKET[verdict.verdict];
        if (!isPresent(bucket)) throw new Error(`unknown verdict "${verdict.verdict}" for ${entry.id}`);
        applyVerdict(entry, verdict);
        settled[bucket].push(entry);
      }
    }
  });
  return settled;
}

// Verifies one run of a member. No finding is committed to the member's record here: the caller
// commits the run, or sets it aside when the member reviewed another tree. What the run says it
// cleared, which readers it checked and the gates it ran are recorded as returned, replacing an
// earlier run's, so a verification that fails still leaves them in the result.
async function verifyRun(record, output, labelPrefix) {
  const name = record.member.name;
  const produced = MEMBER_KINDS[record.member.kind].toCandidates(output);
  record.cleared = [...produced.cleared];
  record.readersChecked = [...produced.readersChecked];
  record.gates = [...produced.gates];
  const gateFindings = produced.gateFailures.map((candidate) => newEntry(record, candidate));
  record.holding.push(...gateFindings);

  const toVerify = [];
  const attached = [];
  for (const candidate of produced.candidates) {
    const entry = newEntry(record, candidate);
    const key = entry.key;
    const first = sentKeys.get(key);
    if (isPresent(first) && first.member !== name) {
      first.duplicates.push(entry);
      attached.push({ parent: first, entry });
    } else {
      if (!isPresent(first)) sentKeys.set(key, entry);
      toVerify.push(entry);
      record.holding.push(entry);
    }
  }

  const batches = splitIntoBatches(criticalFirst(toVerify), share);
  if (batches.length < toVerify.length) {
    log(`${name}: ${toVerify.length} findings verified in ${batches.length} batches`);
    if (!batchedMembers.includes(name)) batchedMembers.push(name);
  }
  const answers = await parallel(
    batches.map((batch, index) => () =>
      askVerifier(
        `${labelPrefix} ${index + 1}/${batches.length}`,
        batch,
        run.changeClass === 'L' || batch.some((entry) => entry.severity === 'Critical'),
      ),
    ),
  );
  const settled = settleBatches(batches, answers);
  return {
    gateFindings,
    ...settled,
    attached,
    gates: produced.gates,
    notChecked: produced.notChecked,
    unavailable: produced.unavailable,
    count: gateFindings.length + produced.candidates.length,
    anotherTree: settled.refuted.some((entry) => entry.verdict === 'not_in_tree'),
  };
}

function commitRun(record, result) {
  record.findings.push(...result.gateFindings, ...result.verified);
  record.refuted.push(...result.refuted);
  record.unverified.push(...result.unverified);
  record.gates = result.gates;
  record.notChecked.push(...result.notChecked);
  record.latestCount = result.count;
  record.holding = [];
}

function removeFrom(list, item) {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
}

function isNotInTree(entry) {
  return entry.verdict === 'not_in_tree';
}

// A run that reviewed another tree is doubted, not thrown away, and the result stays whole:
// - its failing gates are findings as they stand, with their output, and its gates are the
//   member's: a gate's output does not depend on which tree a recipe hit cited;
// - its `not_in_tree` entries go to `discarded` with the reason;
// - its refuted entries stay refuted, with their proof;
// - everything else it produced (a confirmed or plausible finding, an entry no verdict reached, a
//   duplicate it attached to another member's finding, taken back from there) goes to
//   `unverified` for the session to triage;
// - a finding of another member attached to any doubted or discarded entry has lost the
//   verification it relied on, so it becomes unverified on its own;
// - what the run says it cleared and which readers it checked are dropped: they were read in
//   another tree;
// - its keys are released, so a later member's finding on the same line is verified on its own.
function setAsideRun(record, result, reason) {
  const name = record.member.name;
  const takenBack = result.attached.map(({ parent, entry }) => {
    removeFrom(parent.duplicates, entry);
    removeFrom(orphanedDuplicates, entry);
    return entry;
  });
  const own = [...result.gateFindings, ...result.verified, ...result.refuted, ...result.unverified];
  for (const entry of own) {
    if (sentKeys.get(entry.key) === entry) sentKeys.delete(entry.key);
  }
  const phantoms = result.refuted.filter(isNotInTree);
  const doubted = [...result.verified, ...result.unverified, ...takenBack];
  for (const parent of [...phantoms, ...doubted]) {
    for (const orphan of parent.duplicates) {
      orphanedDuplicates.push(unverifiedAs(orphan, `duplicate of ${parent.id}, whose member reviewed another tree`));
    }
    parent.duplicates = [];
  }
  record.findings.push(...result.gateFindings);
  record.gates = result.gates;
  record.unverified.push(...doubted.map((entry) => unverifiedAs(entry, `member reviewed another tree: ${name}`)));
  record.refuted.push(...result.refuted.filter((entry) => !isNotInTree(entry)));
  record.discarded.push({ member: name, reason, findings: phantoms });
  record.cleared = [];
  record.readersChecked = [];
  record.latestCount = result.count;
  record.holding = [];
}

function markDead(record, why) {
  record.status = 'dead';
  record.cleared = [];
  record.readersChecked = [];
  record.notChecked.push(`${why}; this pass did not run`);
}

// Verifies a member's output; when a finding of it cites a file or line that exists neither in
// the checkout nor at the base, the member reviewed another tree and is run once more.
async function settleMember(record, output) {
  const name = record.member.name;
  try {
    if (!isPresent(output)) return markDead(record, 'no output after one retry');
    const first = await verifyRun(record, output, `verify ${name}`);
    if (!first.anotherTree) {
      commitRun(record, first);
      record.status = isPresent(first.unavailable) ? 'unavailable' : 'ok';
      return;
    }
    setAsideRun(record, first, 'reviewed another tree; rerun');
    log(`${name}: a finding cites a file or line in neither the checkout nor the base; running the member once more`);
    spawned.beyondPlan.push(`a rerun of ${name} and its verification`);
    record.status = 'dead';
    const again = await runMember(record, `${name} rerun`);
    if (!isPresent(again)) return markDead(record, 'the rerun returned nothing after one retry');
    const second = await verifyRun(record, again, `verify ${name} rerun`);
    if (second.anotherTree) {
      setAsideRun(record, second, 'reviewed another tree again on the rerun');
      record.status = 'discarded';
      return;
    }
    commitRun(record, second);
    record.status = 'rerun';
  } catch (error) {
    const message = messageOf(error);
    log(`${name}: verification failed (${message}); its findings are reported unverified`);
    record.unverified.push(...record.holding.map((entry) => unverifiedAs(entry, `stage failed: ${message}`)));
    record.holding = [];
    record.notChecked.push(`verification failed: ${message}`);
    if (!isPresent(record.status)) record.status = 'ok';
  }
}

async function verifyRulesLeads() {
  const leads = run.rulesLeads.map((lead, index) => ({
    file: null,
    line: null,
    defect: lead.item,
    failure_scenario: null,
    rule: lead.item,
    severity: null,
    fix: null,
    id: `${RULES_MEMBER}-${index + 1}`,
    n: index + 1,
    order: members.length,
    member: RULES_MEMBER,
    foundBy: [RULES_MEMBER],
    duplicates: [],
    leads: [],
    cluster: null,
  }));
  if (leads.length === 0) return { verified: [], refuted: [], unverified: [] };
  try {
    const answer = await askVerifier('verify rules', leads, run.changeClass === 'L');
    return settleBatches([leads], [answer]);
  } catch (error) {
    const message = messageOf(error);
    return { verified: [], refuted: [], unverified: leads.map((lead) => unverifiedAs(lead, `stage failed: ${message}`)) };
  }
}

phase(PHASES.wave);
const leadsVerified = verifyRulesLeads();
const pipelined = await pipeline(
  members,
  (member) => runMember(records.get(member.name), member.name),
  (output, member) => settleMember(records.get(member.name), output),
);
const leads = await leadsVerified;

// A member whose first stage threw comes back from the pipeline as `null` with no status: its
// output was never seen, so there is nothing to verify and nothing to report but the loss.
members.forEach((member, index) => {
  const record = records.get(member.name);
  if (!isPresent(record.status)) {
    markDead(record, pipelined[index] === null ? 'the member stage failed' : 'the member stage ended without a status');
  }
});

const allRecords = [...records.values()];
const memberFindings = allRecords.flatMap((record) => record.findings);
const refutedEntries = [...allRecords.flatMap((record) => record.refuted), ...leads.refuted];
const unverifiedEntries = [
  ...allRecords.flatMap((record) => record.unverified),
  ...orphanedDuplicates,
  ...leads.unverified,
];
const withDuplicates = [...memberFindings, ...refutedEntries, ...unverifiedEntries];
const attachedDuplicates = withDuplicates.flatMap((parent) => parent.duplicates.map((entry) => ({ parent, entry })));

// ── Result ──────────────────────────────────────────────────────────────────────────────────

phase(PHASES.result);
const needsResultAgent = memberFindings.length + leads.verified.length + attachedDuplicates.length > 0;
const resultInput = {
  findings: memberFindings.map((entry) => ({
    id: entry.id,
    file: entry.file,
    line: entry.line,
    defect: entry.defect,
    failure_scenario: entry.failure_scenario,
    rule: entry.rule,
    severity: entry.severity,
    verdict: entry.verdict,
    evidence: entry.evidence,
  })),
  refuted: refutedEntries.map((entry) => ({
    id: entry.id,
    file: entry.file,
    line: entry.line,
    defect: entry.defect,
    verdict: entry.verdict,
    evidence: entry.evidence,
  })),
  duplicates: attachedDuplicates.map(({ parent, entry }) => ({ ...describeDuplicate(entry), of: parent.id })),
  leads: leads.verified.map((entry) => ({
    id: entry.id,
    defect: entry.defect,
    verdict: entry.verdict,
    file: entry.file,
    line: entry.line,
    evidence: entry.evidence,
  })),
};
// A result agent that throws (a spent token target, a closed transport) is one that did not run:
// the findings are still ranked in code, and the run keeps everything it has paid for.
async function askResultAgent(input) {
  try {
    return await spawn(resultAgentPrompt(input), {
      label: 'result',
      phase: PHASES.result,
      schema: RESULT_AGENT_SCHEMA,
      model: 'opus',
      effort: 'medium',
    });
  } catch (error) {
    log(`result agent: failed (${messageOf(error)}); the findings are ranked in code without clusters`);
    return null;
  }
}

const grouping = needsResultAgent ? await askResultAgent(resultInput) : null;
const resultAgentRan = isPresent(grouping);
if (needsResultAgent && !resultAgentRan) scriptNotChecked.push('result agent did not run; clusters not formed');

const clusterOf = new Map();
for (const group of resultAgentRan ? grouping.clusters : []) {
  for (const id of group.ids) {
    if (!clusterOf.has(id)) clusterOf.set(id, group.cluster);
  }
}

// A duplicate judged a different defect, or every duplicate when no agent judged them, leaves the
// finding it was attached to and is reported unverified for the session to settle.
const distinctIds = new Set(
  resultAgentRan
    ? grouping.distinct_duplicates.map((pair) => pair.id)
    : attachedDuplicates.map(({ entry }) => entry.id),
);
for (const { parent, entry } of attachedDuplicates) {
  if (!distinctIds.has(entry.id)) continue;
  parent.duplicates.splice(parent.duplicates.indexOf(entry), 1);
  unverifiedEntries.push(unverifiedAs(entry, `same line as ${parent.id}, different defect`));
}

const findingById = new Map(memberFindings.map((entry) => [entry.id, entry]));
const leadById = new Map(leads.verified.map((entry) => [entry.id, entry]));
const foldedLeadIds = new Set();
for (const fold of resultAgentRan ? grouping.folded_leads : []) {
  const lead = leadById.get(fold.lead);
  const target = findingById.get(fold.into);
  const refused = foldRefusal(lead, target, foldedLeadIds);
  if (isPresent(refused)) {
    log(`result agent: folding ${fold.lead} into ${fold.into} ignored: ${refused}`);
    continue;
  }
  foldedLeadIds.add(lead.id);
  target.leads.push(lead);
  if (!target.foundBy.includes(RULES_MEMBER)) target.foundBy.push(RULES_MEMBER);
}

const reportedFindings = [...memberFindings, ...leads.verified.filter((lead) => !foldedLeadIds.has(lead.id))];
for (const entry of reportedFindings) {
  if (clusterOf.has(entry.id)) {
    entry.cluster = clusterOf.get(entry.id);
  } else {
    entry.cluster = entry.id;
    if (resultAgentRan) scriptNotChecked.push(`${entry.id}: in no cluster of the result agent; given a cluster of its own`);
  }
}
for (const entry of refutedEntries) {
  if (clusterOf.has(entry.id)) entry.cluster = clusterOf.get(entry.id);
}

const overBy = Math.max(0, spawned.count - run.maxAgents);
if (overBy > 0) {
  const why = spawned.beyondPlan.length > 0 ? spawned.beyondPlan.join(', ') : 'every member gets at least one verifier';
  log(`agents: ${spawned.count} spawned, ${overBy} over the budget of ${run.maxAgents} (${why})`);
}

return {
  mode: run.mode,
  ...(run.mode === 'delta' ? { round: run.round } : {}),
  class: run.changeClass,
  members: allRecords.map((record) => ({
    name: record.member.name,
    model: record.member.model,
    effort: record.member.effort,
    status: record.status,
    findings: record.latestCount,
    cleared: record.cleared,
    readers_checked: record.readersChecked,
  })),
  findings: ranked(reportedFindings).map(describe),
  refuted: refutedEntries.map(describe),
  unverified: unverifiedEntries.map(describe),
  discarded: allRecords.flatMap((record) =>
    record.discarded.map((group) => ({ member: group.member, reason: group.reason, findings: group.findings.map(describe) })),
  ),
  gates: allRecords.flatMap((record) => record.gates),
  not_checked: [
    ...allRecords.flatMap((record) => record.notChecked.map((line) => `${record.member.name}: ${line}`)),
    ...scriptNotChecked,
  ],
  budget: { max_agents: run.maxAgents, used: spawned.count, batched: batchedMembers, over_by: overBy },
};
