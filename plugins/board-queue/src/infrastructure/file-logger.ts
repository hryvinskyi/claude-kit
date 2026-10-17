import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock, LogFields, Logger } from '../application/ports.ts';
import { redactSecrets } from './redaction.ts';

/** The keys the line itself owns; an event's own field may not take them over. */
const RESERVED = new Set(['ts', 'level', 'msg']);

/** The log quotes what the API answered, so it is the owner's reading alone. */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/**
 * One JSON object per line, appended to a file a person or `jq` can read.
 *
 * Two rules make this safe to call from anywhere: every line goes through the
 * redaction pass, and a line that cannot be written is dropped instead of
 * thrown — a full disk must not end a tick, and the port offers no channel to
 * report a logging failure through.
 */
export class FileLogger implements Logger {
  private readonly filePath: string;
  private readonly clock: Clock;
  private directoryReady = false;

  constructor(filePath: string, clock: Clock) {
    this.filePath = filePath;
    this.clock = clock;
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: string, message: string, fields?: LogFields): void {
    const record: Record<string, unknown> = {
      ts: this.clock.now().toISOString(),
      level,
      msg: message,
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!RESERVED.has(key)) {
        record[key] = value;
      }
    }
    this.append(serialise(record));
  }

  private append(line: string): void {
    try {
      if (!this.directoryReady) {
        mkdirSync(dirname(this.filePath), { recursive: true, mode: OWNER_ONLY_DIR });
      }
      appendFileSync(this.filePath, `${redactSecrets(line)}\n`, { mode: OWNER_ONLY_FILE });
      if (!this.directoryReady) {
        // The mode above only applies to a file this call created; one written
        // before this rule existed carries whatever the umask gave it. Asked once
        // per process, because the answer does not change while it runs.
        chmodSync(this.filePath, OWNER_ONLY_FILE);
        this.directoryReady = true;
      }
    } catch {
      // A log line is never worth failing the work it describes.
    }
  }
}

/** A field that JSON cannot express costs its own value, never the whole line. */
function serialise(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      try {
        JSON.stringify(value);
        safe[key] = value;
      } catch {
        safe[key] = '[unserialisable]';
      }
    }
    return JSON.stringify(safe);
  }
}
