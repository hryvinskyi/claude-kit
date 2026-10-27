import { z } from 'zod';
import { ReadbackMismatch } from '../errors.ts';
import { IssueRef } from '../issue-ref.ts';
import type { ActionKind, ActionResult, ExecutionContext } from './action-kind.ts';
import { IssueNumberSchema, RepoSchema } from './fields.ts';

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** GitHub assigns at most ten people to one issue, and takes at most ten in one call. */
const MAX_LOGINS = 10;

const LoginsSchema = z.array(z.string().trim().regex(LOGIN, 'a login is letters, digits and single hyphens'))
  .max(MAX_LOGINS);

const shape = z
  .object({
    repo: RepoSchema,
    issue: IssueNumberSchema,
    add: LoginsSchema.default([]),
    remove: LoginsSchema.default([]),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.add.length === 0 && payload.remove.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['add'], message: 'name a login to add or to remove' });
    }
    const added = new Set(payload.add.map(folded));
    for (const login of payload.remove) {
      if (added.has(folded(login))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remove'],
          message: `${login} is both added and removed; name it once`,
        });
      }
    }
  });

export type AssigneesPayload = z.infer<typeof shape>;

const DESCRIBE = [
  'Change who an issue is assigned to. Name the repository as owner/name, the issue number, and the logins',
  'to add and to remove; everybody else stays assigned. The change is confirmed by reading the issue back: a',
  'login GitHub would not assign — somebody without access to the repository — blocks the action and says',
  'so, rather than reading as done. Two of these waiting on the same issue merge into one, the later request',
  'winning for any login both name.',
].join(' ');

/** Adds and removes assignees on an issue and reads the issue back. */
export class AssigneesKind implements ActionKind {
  readonly name = 'issue.assignees';
  readonly describe = DESCRIBE;
  readonly payloadSchema: z.ZodType<AssigneesPayload, z.ZodTypeDef, unknown> = shape;

  issueRefOf(payload: unknown): IssueRef | null {
    const parsed = this.payloadSchema.parse(payload);
    return IssueRef.of(parsed.repo, parsed.issue);
  }

  statusAskedFor(): null {
    return null;
  }

  /**
   * Login by login, the later request decides: a login it adds is no longer
   * removed, and one it removes is no longer added.
   */
  coalesce(existing: unknown, incoming: unknown): unknown {
    const before = this.payloadSchema.parse(existing);
    const after = this.payloadSchema.parse(incoming);
    const addedLater = new Set(after.add.map(folded));
    const removedLater = new Set(after.remove.map(folded));
    const add = unique([...before.add.filter((login) => !removedLater.has(folded(login))), ...after.add]);
    const remove = unique([...before.remove.filter((login) => !addedLater.has(folded(login))), ...after.remove]);
    if (add.length > MAX_LOGINS || remove.length > MAX_LOGINS) {
      return null;
    }
    return { repo: after.repo, issue: after.issue, add, remove } satisfies AssigneesPayload;
  }

  /**
   * The additions go first, then the removals, each only when there is something
   * to send; the issue is read back once, and a login that is not where the
   * request put it is reported with what the issue says instead.
   */
  async execute(payload: unknown, ctx: ExecutionContext): Promise<ActionResult> {
    const parsed = this.payloadSchema.parse(payload);
    const ref = IssueRef.of(parsed.repo, parsed.issue);
    if (parsed.add.length > 0) {
      await ctx.issues.addAssignees(ref, parsed.add);
    }
    if (parsed.remove.length > 0) {
      if (parsed.add.length > 0) {
        await ctx.sleeper.sleep(ctx.paceMs);
      }
      await ctx.issues.removeAssignees(ref, parsed.remove);
    }
    const after = await ctx.issues.get(ref);
    const assigned = new Set(after.assignees.map(folded));
    const shown = after.assignees.length === 0 ? 'nobody' : after.assignees.join(', ');
    for (const login of parsed.add) {
      if (!assigned.has(folded(login))) {
        throw new ReadbackMismatch('assignees', `${login} assigned`, shown);
      }
    }
    for (const login of parsed.remove) {
      if (assigned.has(folded(login))) {
        throw new ReadbackMismatch('assignees', `${login} not assigned`, shown);
      }
    }
    return { summary: `${ref.toString()}: assigned to ${shown}` };
  }
}

/** GitHub compares logins without regard to case. */
function folded(login: string): string {
  return login.toLowerCase();
}

function unique(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const login of logins) {
    if (!seen.has(folded(login))) {
      seen.add(folded(login));
      kept.push(login);
    }
  }
  return kept;
}
