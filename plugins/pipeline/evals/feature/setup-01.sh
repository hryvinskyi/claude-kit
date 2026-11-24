#!/bin/sh
# Build the checkout of feature/fixture-01: a /pipeline:feature run that stopped inside Phase 4.
#
#   sh setup-01.sh <kit clone> <run directory>
#
# <run directory>/checkout becomes a repository on `main` holding the project before the feature,
# committed. On top of it, uncommitted, as the stopped run left them: the plan directory with its
# record (phases 1 to 3 finished), the work of task 1 (accepted, its red record intact), the
# half-written work of task 2 (started, never accepted) and one edit to a document that nobody in
# the pipeline made. The record is written by the kit's own pipeline-progress, step by step, so the
# checkpoints in it are real. <run directory>/record-at-start.json is the record as the session
# will find it, kept outside the checkout for the scorer.
set -eu
[ $# -eq 2 ] || { sed -n '2,12p' "$0"; exit 2; }
kit=$(cd "$1" && pwd -P)
run=$(cd "$2" && pwd -P)
fixture="$kit/plugins/pipeline/evals/feature/fixture-01"
progress="$kit/plugins/pipeline/bin/pipeline-progress"
[ ! -e "$run/checkout" ] || { echo "$run/checkout exists: use a fresh run directory" >&2; exit 2; }

cp -R "$fixture/base" "$run/checkout"
cd "$run/checkout"
git init -q -b main
git add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -q -m base

mkdir -p .claude/plans
cp -R "$fixture/plan" .claude/plans/late-fee
"$progress" phase late-fee 1
"$progress" phase late-fee 2
"$progress" phase late-fee 3

"$progress" task late-fee 1 started
cp -R "$fixture/task-1/." .
shasum -a 256 test/calendar-days.test.js > .claude/plans/late-fee/_red-1.sha256
"$progress" task late-fee 1 accepted

"$progress" task late-fee 2 started
cp -R "$fixture/task-2-left/." .
shasum -a 256 test/late-fee.test.js > .claude/plans/late-fee/_red-2.sha256

cp -R "$fixture/outside/." .

cp .claude/plans/late-fee/_progress.json "$run/record-at-start.json"
"$progress" resume late-fee
