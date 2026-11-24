---
name: test-value
description: "What a test is for, and how to tell a test that earns its place from one that does not: it states a rule of the product, it fails when that rule breaks, and nothing cheaper fails too. Load BEFORE writing or changing any test (in a feature, a bug fix, a review's fix), when reviewing the tests of a change, and when a suite has grown too large or too slow to trust (/pipeline:tighten-tests). Holds the three questions, how the levels divide the proof, the rows a parameterised test needs, the classes of test that prove nothing or prove it twice — restates, tool, dead, vacuous, file-read, implementation, gate, duplicate, level, fixture — with what clears each, the verdict a judged test gets, what makes a surviving test, and the proof a removal owes."
---

# What a test is for

A test is a proof that runs. It earns its place when it answers three questions, and it is judged by
nothing else — not by how many assertions it holds, not by the coverage it adds, not by how careful
its name is.

1. **Rule.** What rule of the product does it state? A rule is something a person or another program
   relies on and a change could break by mistake: a refusal, a calculation, an order, a permission, a
   message, a stored value, a state a record may not enter. A rule can be said in one sentence that
   names no method. *"The getter returns the field"* is not a rule. It is the code, read aloud.
2. **Red.** Which defect makes it fail? Name one change to the production code that breaks the rule.
   The test must fail on it. A test that stays green while its rule is broken proves nothing,
   whatever its name says.
3. **Only.** What else fails on that defect? The compiler or the static analyser at the project's
   level, the build step that reads the file, another test. When something cheaper already fails on
   every defect this test fails on, the test adds cost and no proof.

A suite is as strong as the defects it catches, and each of them needs catching once. Every test
beyond that is paid for on every run, read by everyone who changes the code, and rewritten with every
refactor. A suite that grows faster than the product's rules is growing in tests that answer none of
the three questions. The number of tests a change adds is not a measure of anything.

A stack plugin's architecture skill adds its framework's spelling: what each level costs there and
what its build already proves.

## Writing a test

Before the first line of a test:

1. **Say its rule** in one sentence that names no method. With no rule to say, write no test.
2. **Look for the proof that exists.** Search the tests for the method, the message, the route, the
   rule's words. A test that already fails on the defect is extended with the case it lacks or left
   as it is. A second test of the same rule is never written beside it.
3. **Choose the level** (below): the lowest one that can show the defect.
4. **Write it to fail.** Name the defect it must catch and see it fail on that defect. For behaviour
   that does not exist yet, the first run is that failure. For behaviour that exists, break the code
   once, see the failure, and take the break back.
5. **Assert an outcome** somebody observes: a returned value, a response, a stored row, a message
   sent, an event published. An absence is asserted beside a presence in the same fixture, or it
   passes when the whole result is empty.

Never written, because each answers none of the three questions:

- a read-back of what the test itself put in: a getter after a constructor, a default that is the
  declared default, `instanceof` on what was built two lines above;
- a test of the language, the framework or a library;
- a test of what a gate rejects earlier: a type, an interface, a missing method or service;
- a test that reads a project file and asserts its text or structure;
- a second row for a branch another row already takes.

## How the levels divide the proof

The lowest level that can show a defect is where its cases live.

- **The cases of a rule** — every branch, boundary and refusal of a calculation, a validation, a
  state machine, a mapping — are proven where the rule is written, with no framework, no database
  and no network. That level is fast enough to hold every case.
- **A higher level proves what only it can: that the parts are joined.** A *joining fact* is a fact
  that holds only when two parts are put together: the route reaches the handler; the handler's
  refusal becomes this response; the template prints the field; the listener hears the event; the
  query runs on the real database and its constraint holds; the transaction commits; the permission
  closes the address. Each joining fact is proven once, with one representative case.
- **When a project requires two levels for a change, the two tests prove different things.** The
  lower one holds the cases. The higher one holds the joining facts the change adds. The higher one
  never repeats the table: twenty refusals at the lower level and one refusal through the route prove
  what twenty refusals through the route prove, at a hundredth of the cost.
- A rule proven through an expensive level case by case, with no joining fact at stake, belongs one
  level down.

A fixture that is expensive to build — a booted application, a compiled container, a migrated
database, a browser — is built once for the tests that only read it. A parameterised test pays its
fixture once per row: rows that change nothing in the fixture are a loop inside one test, or a table
one level down. A test that needs a configuration of its own takes one that other tests already
build, when one answers the same question.

## Rows of a parameterised test

- One row for each **equivalence class** — a set of inputs the code treats the same way, because
  they take the same branch — and one for each **boundary**: the last value on one side, the first
  on the other.
- Two values of an open range that take the same branch are one row. Before a row is added, name
  the branch it takes that no other row takes.
- **A closed set the code names is a table, one row for each member**: every case of an enum, every
  error code, every status. Members that share an answer today each keep their row, because the row
  says that member's answer was decided: a member given a branch of its own by mistake turns only
  its own row red.
- A product of two lists is right only where the code makes the two interact. Where they are
  independent — every refusal at every endpoint that shares one validator — N rows of one and M of
  the other prove what N × M prove.

## The classes

What a test that does not earn its place looks like. A hit is read before it is judged, and the
*cleared when* column decides.

| Class | What it looks like | Cleared when |
|---|---|---|
| **restates** — no rule | The assertions read the production line back: a getter returns the constructor's argument, a constant or an enum case has its literal value, a value object holds what was assigned, a default is the declared default. | The value passes through a transformation, a validation or a derivation; an invariant relates two values (*a record never changed was last changed when it was made*); or the literal is a published contract — a stored value, a field on the wire, a code a client matches on — which is pinned once, where the contract is defined. |
| **tool** — no rule of the product | It proves the language, the framework, the ORM or a library: a read-only property refuses a write, a typed parameter refuses another type, a container returns a service, a request with a malformed field is answered by the framework itself. | The product configures the tool, and the test proves the effect of that configuration. |
| **dead** — runs nowhere | Skipped wherever the suite runs (a service it needs is in no environment that runs it), marked incomplete, guarding a branch no caller can reach, or testing what no longer exists. | It runs in a place the project's suite runs — name the place. |
| **vacuous** — a rule, no proof | It cannot fail when its rule breaks: it asserts a stub's canned answer; it computes the expected value with the code under test; it asserts an absence with no presence beside it; it asserts inside a branch or a loop that may not run; it repeats what an earlier assertion already decided; it expects a refusal that another check produces first, for everyone; its name promises more than its body checks. | A defect that breaks the rule turns it red — shown by a run, not argued. |
| **file-read** — a rule, no proof | It reads a project file — configuration, wiring, a template, source, a migration, a translation — and asserts its text or structure. The file can say the right thing while the application does the wrong one. | Never. The rule is proven by what consumes the file: a real build, a real render, a real run. |
| **implementation** — pins how, not what | It fails when the code is rewritten and its behaviour holds: call counts and call order on collaborators with no outcome asserted, a private member reached through reflection, the exact text of a query, of markup or of a log line that nobody depends on. | The call is the outcome (*exactly one message is sent*), or the text is a contract another system reads. |
| **gate** — proven by the build | The defect it would catch is rejected earlier by a gate that runs on that path: the type checker, the analyser at the project's level, the boundary checker, a schema validation, the container or bundle build. | The gate does not run on that path, or not at that strictness. Check the configuration; never assume it. |
| **duplicate** — proven twice | Another test fails on every defect this one fails on. Its shapes: a test whose assertions a sibling repeats and extends; a table repeated at a second level; an end-to-end case whose halves are proven apart while another case proves the join; a module's copy of a suite-wide check; rows of one equivalence class; a product of independent factors; a precondition asserted again in every test of a class. | A defect exists that only this test catches: an input that takes another branch, a member of a closed set with a row of its own, a path the other test does not travel (another route, the real container where the other builds the object by hand, the real database where the other uses a fake), an assertion the other does not make — a field of the answer, a count, an order, an element that must be absent. |
| **level** — proven at the wrong level | Logic with no joining fact at stake, proven case by case through the framework, the database or HTTP: a table that belongs one level down, whether or not the lower table exists yet. Or the reverse: a joining rebuilt at a lower level out of stand-ins, while the test of the real joining asserts the same. | A joining fact is at stake in every case. For the reverse: the stand-in takes a branch the real collaborator cannot be made to take (its failure, its timeout). |
| **fixture** — pays the fixture again | Each row or each test rebuilds an expensive fixture that none of them changes; or a test builds a configuration of its own where a shared one answers the same question. | The rows change the fixture, or the configuration differs in what the test is about. |

## Judging a test

A test often holds several claims, and they rarely share a class. **Judge claim by claim.**

1. Read the test whole: the method, its parameter rows, its setup, the helpers it calls, its base
   class. Read the production code it runs, far enough to know what each assertion depends on.
2. Look for the other proofs of each claim: the other tests of the same class, its sibling files, the
   same module's other level, the suite-wide tests. Search for the production method's name, the
   message's text, the rule's words. This is the step readers skip.
3. For each claim, answer the three questions. Name its class, or none.
4. Give the test the verdict its claims need together:

| Verdict | When |
|---|---|
| `keep` | Every claim earns its place. |
| `trim` | Some claims earn their place and others do not: rows of one class, assertions that read back. Say which lines or rows go. |
| `delete` | No claim would be lost: each one restates, proves the tool, is dead, or is proven elsewhere — the surviving proof named for each. |
| `rewrite` | A claim states a real rule that this test does not prove and no other test does. Say what the rewritten test does and which defect it must fail on. **A vacuous test of a real rule is never deleted on the ground that it proves nothing: the rule is unproven, and that is the finding.** |
| `move` | The claims are proven, at too high a price. Say what goes down a level, which joining fact keeps one case, or which fixture is shared. The lower table need not exist yet: the move writes it first, and the costly rows leave when it is red on the mutation and green without it. |
| `unsure` | Reading cannot settle it. Say what run would. |

The default is `keep`. Any other verdict carries the burden of proof and quotes the lines that prove
it, each with its path and line: the production line a test reads back, the surviving test, the stub
that holds the canned answer.

A **survivor** is the test that goes on proving a rule once another test is gone. Three things make
one:

- **It is kept as it is.** Two tests never leave on each other's word.
- **It asserts the rule.** A test that fails on the defect only because its fixture happens to cross
  the same line, while it asserts something else, is no survivor: the next change to that fixture
  takes the proof away and nothing says so.
- **It stands at the level where the rule belongs.** Of two proofs of one rule at two levels, the
  lower one holds the cases and stays; the higher one is the duplicate, and it is cut down to its
  joining fact. A test of a rule never leaves as a `duplicate` because a costlier test covers it.
  The reverse has a class of its own and is rare: a low-level test that rebuilds a joining out of
  stand-ins — a handler called by hand over a fake store — repeats, with less, what the test of the
  real joining asserts. It is `level`, and the test of the real joining is its survivor.

For every verdict a run can prove, name the **mutation**: the smallest change to the production code
that breaks the rule.

### The verdict entry

One object per judged test, in a JSON array; `pipeline-suite check` holds the array to this shape.

```json
{
  "file": "tests/unit/billing/late-fee.test.js",
  "test": "charges nothing on the due date",
  "verdict": "keep | trim | delete | rewrite | move | unsure",
  "class": "none | restates | tool | dead | vacuous | file-read | implementation | gate | duplicate | level | fixture | other",
  "rule": "the rule in one sentence, or \"none\"",
  "evidence": [{ "path": "src/billing/late-fee.js", "line": 42, "quote": "the line as it reads" }],
  "survivors": [{ "path": "tests/unit/billing/fees.test.js", "line": 18, "test": "is free until the due date has passed" }],
  "gate": "the gate that rejects the defect, and the rule or level that does it",
  "mutation": "src/billing/late-fee.js:42 — compare with >= in place of >",
  "action": "what the trim, the rewrite or the move does",
  "cases": 1,
  "settle_by": "for unsure: the run that would settle it",
  "proof": { "kind": "run | gate | read | list", "result": "what it showed", "logs": ["the kept output"] }
}
```

`file` is relative to the checkout, and `test` is the test's name as the runner reports it (`*` for
every test of the file). `class` is the class of the claim that decides the verdict, and `none` for a
kept test. `survivors` is owed by every `duplicate`, and by every `delete` of a `vacuous`,
`file-read`, `implementation`, `level` or `fixture` test: the test that proves the rule once this one
is gone — for `implementation`, the outcome that the pinned calls serve. `gate` is owed by class
`gate`. `mutation` is owed by every class a run proves (below). `cases` is how many cases leave the
suite. `proof` is filled in when the proof exists.

## The proof a verdict owes

No test leaves a suite, and none is rewritten, on a reading alone.

| Class | Proof, before the test leaves or changes |
|---|---|
| restates, tool | **A second reading** (`read`): a reader in a fresh context, told to defend the test and not told how sure the first one was, looks for a defect only this test catches and finds none. |
| dead | **The runner's own word** (`list`): its listing or its skip output, from where the project's suite runs; or the search that shows its subject is gone. |
| gate | **The gate fails** (`gate`) on the mutation, and its output is kept. Where the gate cannot run, a second reading, with the gate's rule named. |
| duplicate, level | **The survivor fails** (`run`): with the mutation applied, each surviving test goes red; then the mutation is taken back. A survivor that stays green was not one. |
| vacuous, file-read, implementation, fixture | **Red, then green** (`run`): with the mutation applied, the old test still passes — which is its defect — and the rewritten one fails; with the mutation taken back, the rewritten one passes. |

Three things hold for the batch as a whole:

- **The production code is the same before and after**, byte for byte. A mutation is applied from a
  patch file and taken back from the same file. A test that cannot be made honest without a new seam
  in the production code is reported with the seam it needs, and stays as it is.
- **Every test that left the suite is in the verdicts.** A run before and a run after are compared
  test by test (`pipeline-suite diff --verdicts`): a test that a move or a rename took out of the
  runner's sight looks, in a green run, exactly like one deleted on purpose.
- **Where the project runs mutation testing for a level, the escaped mutants do not grow** over the
  production files the batch's tests cover.

## Looking for candidates

A sweep lists candidates; it never judges. The searches for PHP, JavaScript and TypeScript, and
Python are in `references/recipes.md`, each with what clears a hit. Most of what a suite carries
twice has no textual mark: a duplicate is found by reading two tests side by side, which is why the
cost ranking (`pipeline-suite census`) and not a grep decides where the reading starts.
