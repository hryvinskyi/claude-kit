import { z } from 'zod';
import type { Logger } from '../application/ports.ts';
import type {
  ClaimFeed,
  ClaimFeedPage,
  ImportAnswer,
  ImportBatch,
  ImportedItem,
  LiveClaim,
  WorkImport,
  WorkMember,
} from '../application/sync-ports.ts';
import { CursorExpired } from '../domain/errors.ts';
import type { ClaimEvent, ClaimEventKind } from '../domain/sync/claim-moves.ts';
import { DibsTransport } from './dibs-transport.ts';
import type { DibsHttpDeps } from './dibs-transport.ts';

export { tokenFromEnvironment } from './dibs-transport.ts';
export type { DibsHttpDeps } from './dibs-transport.ts';

const NOT_FOUND = 404;
const GONE = 410;

const PrunedThrough = z.object({ pruned_through: z.number().int().nonnegative() });

const EventSchema = z.object({
  id: z.number().int().positive(),
  kind: z.string(),
  payload: z.unknown(),
  members: z.record(z.string(), z.string()).default({}),
});

const EventPage = z.object({
  events: z.array(EventSchema),
  next: z.number().int().nonnegative().nullable(),
});

const HeldClaim = z.object({ item: z.number().int().positive(), member: z.number().int().positive() });
const TakenClaim = HeldClaim.extend({ previous: z.number().int().positive() });
/** `by` is the admin; null when the server's operator released the claim from its command line. */
const ForcedClaim = HeldClaim.extend({ by: z.number().int().positive().nullable().default(null) });

const MembersAnswer = z.object({
  members: z.array(z.object({ handle: z.string(), external_login: z.string().nullable().optional() })),
});

const ClaimsAnswer = z.object({
  claims: z.array(z.object({
    item: z.number().int().positive(),
    holder: z.string(),
    state: z.string(),
  })),
});

const ItemAnswer = z.object({ item: z.object({ id: z.number().int().positive(), ref: z.string().nullable() }) });

const ImportAnswerSchema = z.object({
  items: z.array(z.object({
    ref: z.string(),
    outcome: z.string(),
    dropped_hints: z.array(z.object({ area: z.string(), reason: z.string() })).default([]),
  })),
  closed: z.array(z.number().int()),
  refused_edges: z.array(z.object({ item: z.string(), blocked_by: z.string(), reason: z.string() })),
});

type MemberNames = Readonly<Record<string, string>>;

type Translate = (payload: unknown, members: MemberNames) => Omit<ClaimEvent, 'id' | 'kind'> | null;

/** The claim events of the log, and how each one's payload reads. */
const CLAIM_PAYLOADS: { readonly [K in ClaimEventKind]: Translate } = {
  claimed: held,
  taken_over: (payload, members) => {
    const parsed = TakenClaim.safeParse(payload);
    return parsed.success
      ? {
        item: parsed.data.item,
        member: members[String(parsed.data.member)] ?? null,
        previous: members[String(parsed.data.previous)] ?? null,
        by: null,
      }
      : null;
  },
  released: held,
  force_released: (payload, members) => {
    const parsed = ForcedClaim.safeParse(payload);
    return parsed.success
      ? {
        item: parsed.data.item,
        member: members[String(parsed.data.member)] ?? null,
        previous: null,
        by: parsed.data.by === null ? null : members[String(parsed.data.by)] ?? null,
      }
      : null;
  },
  review_started: held,
  review_ended: held,
};

function held(payload: unknown, members: MemberNames): Omit<ClaimEvent, 'id' | 'kind'> | null {
  const parsed = HeldClaim.safeParse(payload);
  return parsed.success
    ? { item: parsed.data.item, member: members[String(parsed.data.member)] ?? null, previous: null, by: null }
    : null;
}

function isClaimKind(kind: string): kind is ClaimEventKind {
  return Object.hasOwn(CLAIM_PAYLOADS, kind);
}

/**
 * The coordination server, as the mirror and the importer reach it: its event
 * log, its members, its items, and the import of the board's work.
 *
 * Its answers are a foreign model and stop here: an event's payload is read into
 * the claim events the mirror understands, member ids become handles, and every
 * other event of the log is counted and left behind. Each call has a deadline. A
 * failure is a `TransientFailure` naming what was asked and the server's code for
 * the refusal, never its text and never the token; a cursor behind what the log
 * keeps is a `CursorExpired`.
 */
export class DibsHttpClient implements ClaimFeed, WorkImport {
  readonly #http: DibsTransport;
  readonly #logger: Logger;

  constructor(deps: DibsHttpDeps) {
    this.#http = new DibsTransport(deps);
    this.#logger = deps.logger;
  }

  async page(after: number, limit: number): Promise<ClaimFeedPage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    const answer = await this.#http.call('GET', `/v1/events?${query.toString()}`, 'the event log');
    if (answer.status === GONE) {
      const pruned = PrunedThrough.safeParse(answer.details);
      if (pruned.success) {
        throw new CursorExpired(pruned.data.pruned_through);
      }
    }
    const page = this.#http.decode(EventPage, this.#http.ok(answer, 'the event log'), 'the event log');
    const claims: ClaimEvent[] = [];
    for (const event of page.events) {
      if (!isClaimKind(event.kind)) {
        continue;
      }
      const read = CLAIM_PAYLOADS[event.kind](event.payload, event.members);
      if (read === null) {
        this.#logger.warn('a claim event of the log could not be read and was passed over', {
          event: event.id,
          kind: event.kind,
        });
        continue;
      }
      claims.push({ id: event.id, kind: event.kind, ...read });
    }
    return { claims, shown: page.events.length, next: page.next };
  }

  async liveClaims(): Promise<LiveClaim[]> {
    const answer = await this.#http.call('GET', '/v1/claims', 'the live claims');
    return this.#http.decode(ClaimsAnswer, this.#http.ok(answer, 'the live claims'), 'the live claims').claims
      .map((claim) => ({ item: claim.item, holder: claim.holder, inReview: claim.state === 'in_review' }));
  }

  async members(): Promise<WorkMember[]> {
    const answer = await this.#http.call('GET', '/v1/members', 'the members');
    return this.#http.decode(MembersAnswer, this.#http.ok(answer, 'the members'), 'the members').members
      .map((member) => ({ handle: member.handle, login: member.external_login ?? null }));
  }

  async itemRef(id: number): Promise<string | null> {
    const subject = `the work item ${String(id)}`;
    const answer = await this.#http.call('GET', `/v1/items/${String(id)}`, subject);
    if (answer.status === NOT_FOUND) {
      return null;
    }
    return this.#http.decode(ItemAnswer, this.#http.ok(answer, subject), subject).item.ref;
  }

  async putItems(batch: ImportBatch): Promise<ImportAnswer> {
    const subject = 'the import of the board\'s work';
    const body = { source: batch.source, complete: batch.complete, items: batch.items.map(wireItem) };
    const answer = await this.#http.call('PUT', '/v1/items', subject, body);
    const parsed = this.#http.decode(ImportAnswerSchema, this.#http.ok(answer, subject), subject);
    const outcomes: Record<string, number> = {};
    for (const item of parsed.items) {
      outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
    }
    return {
      outcomes,
      closed: parsed.closed.length,
      refusedEdges: parsed.refused_edges.map((edge) => ({
        item: edge.item,
        blockedBy: edge.blocked_by,
        reason: edge.reason,
      })),
      droppedHints: parsed.items.flatMap((item) =>
        item.dropped_hints.map((hint) => ({ ref: item.ref, area: hint.area, reason: hint.reason }))),
    };
  }
}

/** An item in the server's own spelling: a carried blocker says only that it is one. */
function wireItem(item: ImportedItem): Record<string, unknown> {
  const base = { ref: item.ref, title: item.title, closed: item.closed };
  if (item.listing === null) {
    return { ...base, blocker: true };
  }
  const listed: Record<string, unknown> = {
    ...base,
    priority: item.listing.priority,
    areas_hint: [...item.listing.areasHint],
    blocked_by: [...item.listing.blockedBy],
  };
  if (item.listing.sourceStatus !== null) {
    listed['source_status'] = item.listing.sourceStatus;
  }
  return listed;
}
