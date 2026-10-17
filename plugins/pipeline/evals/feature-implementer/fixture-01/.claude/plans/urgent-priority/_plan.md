# Implementation Plan — Urgent priority level

## Context

The todo module sorts tasks for the dashboard. Product wants a dedicated **urgent** level
that always outranks any numeric weight.

## Task table

| # | Task | Depends on |
|---|------|------------|
| 1 | Support the `urgent` level in the sorter | — |

## Task 1 — support `urgent` in the sorter

In `packages/todo/src/Service/TaskSorter.php`, extend the existing public method
`sortByPriority()` so that tasks carrying `'priority' => 'urgent'` always sort ahead of
all others regardless of weight (invariant 2). Preserve the current tie-breaking behavior
for non-urgent tasks. Update its unit test in `packages/todo/tests/` accordingly. Do not
touch any other file.
