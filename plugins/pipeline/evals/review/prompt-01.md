Run `/pipeline:review --no-fix` on this checkout: the change is the uncommitted work in its working
tree, and its base is the commit `main` points at. Return the review's report as your answer.

When the review has reported, copy the workflow's own result file, `review-workflow.json` — the
result as the wave returned it, which the review writes once and never edits — byte for byte (`cp`,
not retyped) to `eval-result.json` at the root of this checkout. Do not copy `review-result.json`:
triage edits that one even under `--no-fix`. If the review wrote no `review-workflow.json`, write
none, and say so at the end of the report.
