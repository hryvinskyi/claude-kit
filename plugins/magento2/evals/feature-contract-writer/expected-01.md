# Answer key — feature-contract-writer / fixture-01 (acme-store, TypeScript contract)

The same project and task as `feature-implementer/fixture-02`, planned in `/pipeline:feature`'s split
mode: Task 3 is `split`, and the contract is the test file alone (the module keeps its type and
function together, so there is no declaration file to freeze). A Sonnet implementer will later make
the tests green without being allowed to touch them, so the score is how many wrong
implementations the contract refuses.

| ID | Expectation | Artifact check |
|----|-------------|----------------|
| E1 | The contract exists at the named path, and the agent wrote **no** implementation or stub of `free-shipping-gap.ts` | scorer: *the contract exists and the agent wrote no implementation* |
| E2 | Red for the right reason: as delivered, the contract fails because the module is missing | scorer: *the contract is red as delivered* |
| E3 | A correct implementation passes it — the contract pins the task, not one way of writing it | scorer: *a correct implementation passes the contract* |
| E4 | It refuses every mutant the task text and binding constraints forbid: M1 negative gap, M2 unclamped progress, M3 zero threshold not qualifying, M4 rounding, M5 negative accepted, M6 error without the argument's name, M8 exact threshold not qualifying, M9 a plain `Error` | scorer: the eight non-hygiene mutant tests |
| E5 | Scope: only the test file is created; nothing else changes; no plan vocabulary (`invariant N`, `Task 3`, `per the plan`, `_devils_advocate`) in it; no commit, no vault edit | `diff -rq fixture-01 <copy>` lists exactly the test file; `grep -nEi 'invariant [0-9]\|task[ -]?[0-9]\|per the plan\|_plan\.md\|devil'` on it is empty |
| E6 | The tests run code: they import the module and call it — none reads a source file as text | read the test file |
| E7 | The report carries the deliverable's sections: *Frozen files* listing exactly the test file, a *Test map* in prose, the real *Red run* tail, *Implementation notes* naming the module path and its export surface, *Not pinned* | final report text |
| H1 | Hygiene: M7 (Infinity accepted) and M10 (zero threshold lets an invalid subtotal through) are refused too | scorer: the two `hygiene:` tests |

Run the scorer: `FIXTURE_ROOT=<copy> node --test <evals>/feature-contract-writer/verify-01.test.mts`

Scoring: PASS = E1–E7. H1 is hygiene — a careful contract writer pins those edges, a merely
correct one does not.

Failure modes this fixture is designed to catch: a stub or full implementation written "to show
the tests are satisfiable"; tests that pass with nothing implemented (a missing import caught and
ignored, an empty test body); a contract so loose a careless implementation passes it; one so tight
it pins an implementation detail and fails the reference (a message's exact wording, a property
order beyond `deepEqual`); `// invariant 3` in a test name.
