import { z } from 'zod';
import { isRepoFullName } from './issue-ref.ts';

/**
 * The board's statuses that claims on the coordination server stand for. A claim
 * event whose status is not named here moves no row.
 */
export const ClaimStatusesSchema = z
  .object({
    /** A person started the work. */
    claimed: z.string().trim().min(1),
    /** The work was put down without being finished, by its holder or by an admin. */
    released: z.string().trim().min(1),
    /** Somebody took over a claim that had gone stale; the claimed status when not named. */
    takenOver: z.string().trim().min(1).optional(),
    /** The work waits on a review of its pull requests. */
    review: z.string().trim().min(1).optional(),
    /** The review ended without finishing the work; the claimed status when not named. */
    reviewEnded: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Whose moves a worker's mirror files. `all`: every move, in the one worker
 * whose login is `mirrorOwner`. `own`: in every person's worker, only the moves
 * that person caused, so each move is filed once, under the login of whoever made
 * it, and spends that person's allowance.
 */
export const MirrorScopeSchema = z.enum(['all', 'own']);

export const MirrorConfigSchema = z
  .object({
    /** Off unless a deployment turns it on. */
    enabled: z.boolean().default(false),
    scope: MirrorScopeSchema.default('all'),
    status: ClaimStatusesSchema,
    /** Whether the holder of a claim is also assigned to the issue. */
    assignees: z.boolean().default(true),
  })
  .strict();

/** Severity prefixes and the priority each stands for; the coordination server's own default is 2. */
const DEFAULT_PRIORITIES: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };

export const ImporterConfigSchema = z
  .object({
    /** Off unless a deployment turns it on, in the same one worker as the mirror. */
    enabled: z.boolean().default(false),
    /** The name the coordination server files the board's items under. */
    source: z.string().trim().min(1).default('board'),
    /** The shortest gap between two imports; the board is read once per import. */
    everyMinutes: z.number().int().min(15).default(15),
    /** An import only reads the board with at least this much of the graph allowance left. */
    minRemaining: z.number().int().nonnegative().default(1000),
    /** Most dependency answers one import asks for; the rest wait for the next one, oldest first. */
    maxRequestsPerTick: z.number().int().positive().max(100).default(100),
    /** The smallest gap between two dependency requests. */
    paceMs: z.number().int().min(1000).default(1000),
    /**
     * The board's Module options and the areas each stands for on the coordination
     * server, written as it writes them (`repo:area`, or a bare area). A Module with
     * no entry hints at nothing.
     */
    modules: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).default({}),
    /**
     * Severity option prefixes and the priority each stands for, 0 soonest. An
     * option no prefix fits, and an empty Severity, give the server's default.
     */
    priorities: z.record(z.string().trim().min(1), z.number().int().min(0).max(4)).default(DEFAULT_PRIORITIES),
  })
  .strict();

/**
 * What the forge jobs read and write on GitHub on the coordination server's
 * behalf: the pull requests of each repository kept in step and how they ended,
 * the commit status the server wants on its members' pull requests, what each
 * claimed branch changes, and the workflow runs a slot hold waits for. Off unless
 * a deployment turns it on; it is meant for one service that runs under an
 * identity of its own, not for a person's worker.
 */
export const ForgeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The smallest gap between two requests to GitHub. */
    paceMs: z.number().int().min(1000).default(1000),
    /**
     * How far behind its cursor a listing of pull requests reads again. The listing
     * has no "since" and GitHub's clock is not this machine's.
     */
    overlapMinutes: z.number().int().min(1).max(60).default(10),
    /** A pass asks GitHub nothing more once the REST allowance it spends is below this. */
    minRemaining: z.number().int().nonnegative().default(500),
    /**
     * Most commit statuses one pass writes. Every status counts against GitHub's
     * content-creation limit, which the queue's own writes spend too; the rest are
     * written by the next pass.
     */
    maxStatusWritesPerPass: z.number().int().positive().max(35).default(20),
    /**
     * Most commit statuses written in any hour, by every pass together, so the
     * queue's own writes keep room under the same limit.
     */
    maxStatusWritesPerHour: z.number().int().positive().default(300),
    /** A pass asks GitHub nothing more once it has run this long: by default before the next tick is due. */
    maxPassMinutes: z.number().int().min(1).max(25).default(4),
    /**
     * Whether the jobs may run under a person's credential. They write statuses every
     * reader of a repository sees and spend the allowance of whoever they run as, so
     * by default they start only where the calls go out as an App.
     */
    allowPersonalToken: z.boolean().default(false),
  })
  .strict();

const EnvironmentVariable = z.string().trim()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'name an environment variable, such as DIBS_TOKEN');

/**
 * Where the coordination server's token comes from, per source, beside the word
 * that names it. Never the token itself.
 */
export type DibsTokenSources = {
  /** The variable that holds it, or whose `_FILE` twin names a file that does. */
  env: { readonly env: string };
  /** The login the dibs command line tool stored on this machine for the configured server and project. */
  'dibs-login': Record<never, never>;
};

export type DibsTokenSourceName = keyof DibsTokenSources;

export type DibsTokenSource<K extends DibsTokenSourceName = DibsTokenSourceName> = {
  [P in K]: { readonly from: P } & DibsTokenSources[P];
}[K];

export const DibsTokenSourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('env'), env: EnvironmentVariable }).strict(),
  z.object({ from: z.literal('dibs-login') }).strict(),
]);

/**
 * What this worker keeps in step with a coordination server: claims there moving
 * rows here, and the board's open work and what blocks it reported there.
 *
 * The importer and the forge jobs copy one system's state onto another on the
 * whole team's behalf, so they run in exactly one worker: the one whose GitHub
 * login is `mirrorOwner`. A configuration copied to another machine names
 * somebody else and starts neither there. The mirror runs there too, unless its
 * scope is `own`, which runs it in every person's worker for that person's moves.
 *
 * The token's source is named once, by `token` or by the older `tokenEnv`, and
 * read as `token` either way.
 */
export const SyncConfigSchema = z
  .object({
    /**
     * The coordination server's address. It carries no user or password: the token
     * travels in a variable of its own, and an address is written into every log
     * line and status report that names the server.
     */
    server: z.string().trim().url()
      .refine(withoutCredentials, 'name the server without a user or password in its address')
      .transform((url) => url.replace(/\/+$/, '')),
    /** The project on that server. */
    project: z.string().trim().min(1),
    /** The variable holding the token for that project, never the token: the older spelling of an `env` token. */
    tokenEnv: EnvironmentVariable.optional(),
    /** Where the token for that project comes from. */
    token: DibsTokenSourceSchema.optional(),
    /** The GitHub login of the one worker that runs the importer, the forge jobs and an `all` mirror. */
    mirrorOwner: z.string().trim().min(1),
    /** The repositories whose issues are kept in step; each must be carried by a configured board. */
    repos: z.array(z.string().trim().refine(isRepoFullName, 'a repository is written owner/name')).min(1),
    mirror: MirrorConfigSchema.optional(),
    importer: ImporterConfigSchema.default({}),
    forge: ForgeConfigSchema.default({}),
  })
  .strict()
  .transform(({ tokenEnv, token, ...sync }, context) => {
    if (tokenEnv !== undefined && token !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'name the token by token or by tokenEnv, not both',
      });
      return z.NEVER;
    }
    const source: DibsTokenSource | undefined = token
      ?? (tokenEnv === undefined ? undefined : { from: 'env', env: tokenEnv });
    if (source === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'name where the token comes from: token { "from": "env", "env": "DIBS_TOKEN" } '
          + 'or { "from": "dibs-login" }',
      });
      return z.NEVER;
    }
    return { ...sync, token: source };
  });

export type SyncConfig = z.infer<typeof SyncConfigSchema>;
export type MirrorConfig = z.infer<typeof MirrorConfigSchema>;
export type ImporterConfig = z.infer<typeof ImporterConfigSchema>;
export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;
export type ClaimStatuses = z.infer<typeof ClaimStatusesSchema>;
export type MirrorScope = z.infer<typeof MirrorScopeSchema>;

function withoutCredentials(address: string): boolean {
  try {
    const url = new URL(address);
    return url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * Whether the mirror is on and files only the moves of this worker's own person,
 * which is the one job that does not wait for this worker to be `mirrorOwner`'s.
 */
export function mirrorsOwnMoves(sync: SyncConfig): boolean {
  return sync.mirror?.enabled === true && sync.mirror.scope === 'own';
}

/** A job that runs only in `mirrorOwner`'s worker. */
export type OwnerJob = 'mirror' | 'importer' | 'forge';

/** The jobs switched on that run only in `mirrorOwner`'s worker. */
export function ownerJobsOf(sync: SyncConfig): OwnerJob[] {
  const on: Readonly<Record<OwnerJob, boolean>> = {
    mirror: sync.mirror?.enabled === true && sync.mirror.scope === 'all',
    importer: sync.importer.enabled,
    forge: sync.forge.enabled,
  };
  return (['mirror', 'importer', 'forge'] as const).filter((job) => on[job]);
}

/** Whether any job is switched on; with none, nothing about the server is ever asked. */
export function syncIsOn(sync: SyncConfig): boolean {
  return sync.mirror?.enabled === true || sync.importer.enabled || sync.forge.enabled;
}
