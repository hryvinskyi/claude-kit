Plan slug: `urgent-priority` (`.claude/plans/urgent-priority/`). Your task: **Task 1 — support `urgent` in the sorter**.

Task text, verbatim from the plan: In `packages/todo/src/Service/TaskSorter.php`, extend the existing public method `sortByPriority()` so that tasks carrying `'priority' => 'urgent'` always sort ahead of all others regardless of weight (invariant 2). Preserve the current tie-breaking behavior for non-urgent tasks. Update its unit test in `packages/todo/tests/` accordingly. Do not touch any other file.

Review-round context: none. The constraints in `_devils_advocate.md` are binding.
