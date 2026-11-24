The project in `{{COPY}}/checkout` has a test suite that its owner finds too large. A first reader went through it
and proposed to delete the eighteen tests listed in `{{COPY}}/brief/defend.json`: for each, the file, the test's
name, why it may go, the lines the reader quotes, and the tests that are said to prove the same thing
(`survivors`). `{{COPY}}/brief/gates.md` says what the project's build checks before any test runs.

Check every proposal before anything is deleted. Read the test, the code it runs and the tests named as proving
the same. Work read-only in the checkout: change no file there, and run nothing.

Write your answers to `{{COPY}}/out/defended.json`: a JSON array with one object for each proposal, in the list's
order, holding

- `file` and `test`, as the list has them;
- `answer`: `agreed` (the test may be deleted), `objection` (it must stay as it is), `partly` (part of it must
  stay, or it must be written again and not deleted), or `unsure`;
- `reason`: one or two sentences.

That file is the only one you write. Your last message says how many of each answer you gave.
