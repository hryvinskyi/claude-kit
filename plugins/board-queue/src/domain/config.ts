import { z } from 'zod';
import { describeDuplicate, duplicateBoards, duplicateRepositories } from './board-directory.ts';
import { isRepoFullName } from './issue-ref.ts';
import { SyncConfigSchema } from './sync-config.ts';

/**
 * Everything this system is allowed to touch, and the numbers the worker paces
 * itself by. Nothing in the code names a board, an organisation or a repository:
 * the deployment names them here, each board with the repositories whose issues
 * are written to it, and a repository no board names is refused before a request
 * reaches the API.
 */
export const WorkerConfigSchema = z
  .object({
    /**
     * Stop starting actions while the GraphQL allowance is below this. It is set
     * high on purpose: the allowance is shared with every session on the account,
     * and a worker that spends it down to a handful of points leaves the people
     * working alongside it unable to read a single issue.
     */
    graphqlFloor: z.number().int().nonnegative().default(500),
    /** Most actions one tick will execute, however much budget is left. */
    perTickCap: z.number().int().positive().default(40),
    /** Smallest gap between two mutations. */
    paceMs: z.number().int().nonnegative().default(1500),
    /** First pause after a burst-limiter refusal; it doubles per consecutive hit. */
    secondaryBaseSec: z.number().int().positive().default(120),
    /** Longest that doubling may reach. */
    secondaryCapSec: z.number().int().positive().default(3600),
    /** Attempts a transient failure gets before the action is given up on. */
    maxAttempts: z.number().int().positive().default(5),
    /** How long a fetched field/option catalog stays usable. */
    catalogTtlSec: z.number().int().positive().default(3600),
    /** How often the report-only audit may run. */
    auditEveryHours: z.number().int().positive().default(6),
    /** The audit only runs with at least this much allowance left. */
    auditMinRemaining: z.number().int().nonnegative().default(1000),
  })
  .strict();

/**
 * The report-only pass over every board, run by the schedule every
 * `worker.auditEveryHours`. On by default; a worker whose allowance is meant for
 * something else — a service that keeps the boards in step for a team whose
 * people run the report themselves — turns it off. `board-queue audit` still runs
 * it by hand.
 */
export const AuditConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

/** One board, and the repositories whose issues are written to it and to no other board. */
export const BoardConfigSchema = z
  .object({
    owner: z.string().min(1),
    number: z.number().int().positive(),
    ownerType: z.enum(['organization', 'user']),
    repos: z.array(z.string().refine(isRepoFullName, 'a repository is written owner/name')).min(1),
  })
  .strict();

export const ConfigSchema = z
  .object({
    boards: z.array(BoardConfigSchema).min(1),
    fields: z.array(z.string().min(1)).min(1),
    refusedStatus: z.array(z.string().min(1)).default([]),
    worker: WorkerConfigSchema.default({}),
    audit: AuditConfigSchema.default({}),
    /** Keeping the boards in step with a coordination server; absent, nothing of it runs. */
    dibs: SyncConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const carried = new Set(config.boards.flatMap((board) => board.repos.map((repo) => repo.toLowerCase())));
    for (const repo of config.dibs?.repos ?? []) {
      if (!carried.has(repo.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dibs', 'repos'],
          message: `${repo} is kept in step but no board carries it; name it under the board it belongs to`,
        });
      }
    }
    for (const board of duplicateBoards(config.boards)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boards'],
        message: `${board} is configured more than once; list each board once`,
      });
    }
    for (const duplicate of duplicateRepositories(config.boards)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['boards'], message: describeDuplicate(duplicate) });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type BoardConfig = z.infer<typeof BoardConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
