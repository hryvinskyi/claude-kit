import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import os from 'node:os';

/**
 * What a lock holder needs to know about processes to tell a live holder from a
 * dead one: where process ids are counted, and when a given process started.
 *
 * A process id alone says little. A container that restarts hands its first
 * processes the ids they had before, so a dead holder's id can belong to a new
 * process — or to the very process asking. And a process in another container,
 * or on the machine around it, is invisible here however alive it is. The start
 * time tells the first case apart; the place tells when the question cannot be
 * answered at all.
 */
export interface ProcessTable {
  /** The place process ids are counted in: this machine and, where the system has them, its pid namespace. */
  here(): string;
  /** When the process started, as the system words it; null when no such process is visible here. */
  startOf(pid: number): string | null;
}

/** A start time the system would not say, for a process it does say is there. */
export const UNKNOWN_START = 'unknown';

/**
 * The machine's own process table. On Linux both answers come from `/proc`; on a
 * system without it, the start time comes from `ps`, which every such system has.
 */
export class LocalProcessTable implements ProcessTable {
  here(): string {
    try {
      return `${os.hostname()}:${readlinkSync('/proc/self/ns/pid')}`;
    } catch {
      // No pid namespaces here: the machine itself is the place ids are counted in.
      return os.hostname();
    }
  }

  startOf(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const fromProc = startInProc(pid);
    if (fromProc !== 'no-proc') {
      return fromProc;
    }
    if (!signalReaches(pid)) {
      return null;
    }
    try {
      const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return started === '' ? null : started;
    } catch {
      return UNKNOWN_START;
    }
  }
}

/**
 * The start time `/proc/<pid>/stat` gives in its twenty-second field, counted
 * after the command name, which is parenthesised and may itself hold spaces;
 * `no-proc` when the system has no `/proc` at all.
 */
function startInProc(pid: number): string | null | 'no-proc' {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    // With /proc present, a process it does not list is not there.
    return procExists() ? null : 'no-proc';
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // The fields after the name start at the third, the state; the start time is the twenty-second.
  return fields[19] ?? UNKNOWN_START;
}

function procExists(): boolean {
  try {
    readFileSync('/proc/self/stat', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function signalReaches(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // "Not permitted" is still an answer that the process is there.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
