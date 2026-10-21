import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { BEAT_OUTCOMES } from '../application/service-beat.ts';
import type { ServiceBeat } from '../application/service-beat.ts';
import type { BeatStore } from '../application/service-loop.ts';

/** A beat as the file holds it, checked whole before anything reads it. */
const ServiceBeatSchema = z
  .object({
    pid: z.number().int().positive(),
    startedAt: z.string().datetime(),
    intervalMs: z.number().int().positive(),
    passDeadlineMs: z.number().int().positive(),
    passes: z.number().int().nonnegative(),
    passStartedAt: z.string().datetime().nullable(),
    passEndedAt: z.string().datetime().nullable(),
    outcome: z.enum(BEAT_OUTCOMES).nullable(),
    detail: z.string().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    stoppedAt: z.string().datetime().nullable(),
  })
  .strict() satisfies z.ZodType<ServiceBeat>;

/**
 * The service's heartbeat as a small file in the state directory. Each write goes
 * to a file beside it and is renamed over the old one, so a reader never sees half
 * a beat; the file is the owner's alone, like everything else kept there.
 */
export class FileBeatStore implements BeatStore {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  write(beat: ServiceBeat): void {
    const next = `${this.#file}.next`;
    writeFileSync(next, `${JSON.stringify(beat, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(next, this.#file);
  }

  /**
   * The last beat written, or nothing when there is none. A file that is not a
   * beat reads as none, which the health check answers as unhealthy.
   */
  read(): ServiceBeat | null {
    let text: string;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    const parsed = ServiceBeatSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
}
