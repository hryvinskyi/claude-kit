import { createHash } from 'node:crypto';

/** The two places that make one install of the queue a different one from another. */
export type ScheduleLocations = {
  /** The configuration file the pass reads, as an absolute path. */
  readonly configPath: string;
  /** The directory the queue keeps its state in, as an absolute path. */
  readonly stateDir: string;
};

/** Long enough that two installs on one machine never meet; short enough to read in a job's name. */
const NAME_LENGTH = 12;

/**
 * What sets this install's scheduled job apart from another install's on the
 * same machine, or nothing for the default locations.
 *
 * The answer follows from the locations alone, so installing again for the
 * same configuration and queue names the same job and replaces it, while an
 * install for another configuration or another queue gets a job of its own
 * instead of overwriting the first one's. The default locations keep the plain
 * name, so the job already loaded under it is the one an install at those
 * places replaces.
 */
export function scheduleInstance(at: ScheduleLocations, defaults: ScheduleLocations): string | null {
  if (at.configPath === defaults.configPath && at.stateDir === defaults.stateDir) {
    return null;
  }
  return createHash('sha256')
    .update(JSON.stringify([at.configPath, at.stateDir]))
    .digest('hex')
    .slice(0, NAME_LENGTH);
}
