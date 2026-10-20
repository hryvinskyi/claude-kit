/** One run of a forge workflow, as the forge lists the runs of a commit. */
export type WorkflowRun = {
  readonly id: number;
  /** The workflow's file, `.github/workflows/deploy.yml`; null when the forge names none. */
  readonly path: string | null;
  /** The workflow's display name. */
  readonly name: string | null;
  /** `queued`, `in_progress`, `completed`, … */
  readonly status: string;
  /** How a completed run ended (`success`, `failure`, `cancelled`, …); null until it has. */
  readonly conclusion: string | null;
  readonly createdAt: Date;
  readonly headSha: string;
};

/**
 * Whether a run is of the workflow whose file a hold names: the file name
 * (`deploy.yml`) or the file's path, matched exactly.
 */
export function isRunOfFile(run: WorkflowRun, workflow: string): boolean {
  const path = run.path === null ? null : withoutRef(run.path);
  return path !== null && (path === workflow || baseName(path) === workflow);
}

/**
 * The runs of the workflow a hold names. A hold names its workflow as a person
 * writes it: its file is matched first, and a display name only when the file
 * matches nothing and exactly one workflow carries that name — two workflows may
 * share one, and a guess would end a hold on the wrong run.
 */
export function runsOf(runs: readonly WorkflowRun[], workflow: string): WorkflowRun[] {
  const byFile = runs.filter((run) => isRunOfFile(run, workflow));
  if (byFile.length > 0) {
    return byFile;
  }
  const named = runs.filter((run) => run.name === workflow);
  const carriers = new Set(named.map((run) => (run.path === null ? null : withoutRef(run.path))));
  return carriers.size === 1 ? named : [];
}

/**
 * How the run a hold waits for ended, or nothing while it has not: the latest run
 * of the hold's own workflow for the hold's commit, once it completed. A run of
 * another workflow on the same commit ends nothing, and an older run that finished
 * does not end a hold whose latest run is still going.
 */
export function finishedRunOf(
  runs: readonly WorkflowRun[],
  workflow: string,
  sha: string,
): { readonly conclusion: string } | null {
  const commit = sha.toLowerCase();
  const own = runsOf(runs.filter((run) => run.headSha.toLowerCase().startsWith(commit)), workflow);
  let latest: WorkflowRun | null = null;
  for (const run of own) {
    if (latest === null || isLater(run, latest)) {
      latest = run;
    }
  }
  if (latest === null || latest.status !== 'completed' || latest.conclusion === null) {
    return null;
  }
  return { conclusion: latest.conclusion };
}

function isLater(run: WorkflowRun, than: WorkflowRun): boolean {
  const difference = run.createdAt.getTime() - than.createdAt.getTime();
  return difference === 0 ? run.id > than.id : difference > 0;
}

/** A path the forge may suffix with the ref it was read at (`…/deploy.yml@refs/heads/main`). */
function withoutRef(path: string): string {
  const at = path.indexOf('@');
  return at < 0 ? path : path.slice(0, at);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}
