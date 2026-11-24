The project in `{{COPY}}/checkout` has a test suite that its owner finds too large. `{{COPY}}/brief/tests.json` lists
its tests: for each, the file, the test's name, the line it starts at, and the seconds it took in the last run.
`{{COPY}}/brief/gates.md` says what the project's build checks before any test runs.

For every test on the list, decide whether the suite needs it as it stands. Read the test, the code it runs and the
other tests before you decide. Work read-only in the checkout: change no file there, and run nothing.

Write your answers to `{{COPY}}/out/verdicts.json`: a JSON array with one object for each test on the list, in the
list's order, holding

- `file` and `test`, as the list has them;
- `verdict`: `keep`, `trim` (part of it should go), `delete`, `rewrite` (it should be written again so that it
  proves something), `move` (it belongs at another level), or `unsure`;
- `class`: one word for the reason, `none` for `keep`;
- `reason`: one or two sentences.

That file is the only one you write. Your last message says how many of each verdict you gave.
