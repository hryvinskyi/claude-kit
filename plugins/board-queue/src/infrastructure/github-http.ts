import { z } from 'zod';
import type { ZodType, ZodTypeDef } from 'zod';
import type { Logger, TokenProvider } from '../application/ports.ts';
import {
  type BoardQueueError,
  CredentialRejected,
  IssueNotFound,
  NoAnswer,
  PrimaryRateLimited,
  SecondaryRateLimited,
  TransientFailure,
} from '../domain/errors.ts';
import { RateBudget } from '../domain/rate-budget.ts';
import type { RateResource } from '../domain/rate-budget.ts';
import { redactSecrets } from './redaction.ts';

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'board-queue';
const REST_API_VERSION = '2022-11-28';
/** The answer to a conditional request whose tag still holds. */
const NOT_MODIFIED = 304;

/** The one call this package makes to the network, narrow enough to stand in for. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type GitHubHttpDeps = {
  tokens: TokenProvider;
  logger: Logger;
  /**
   * Where the allowance each answer reports is written down. Transports that spend
   * one account's allowance share one, so whichever of them answered last speaks
   * for all of them; a transport handed none keeps its own.
   */
  ledger?: BudgetLedger;
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  userAgent?: string;
};

export type RestResult = {
  data: unknown;
  /** The address of the next page, as the `Link` header gave it, or null. */
  nextPageUrl: string | null;
  /** The answer's version tag, which a later conditional request hands back. */
  etag: string | null;
  /**
   * True when a conditional request was answered "unchanged": there is no body,
   * and the answer the tag was taken from still holds.
   */
  notModified: boolean;
  /**
   * True when a call was answered with one of the statuses it said mean "not
   * there": there is no body, and the thing asked about is not there.
   */
  missing: boolean;
  /** When the API says it answered, from its own clock; null when it did not say. */
  servedAt: Date | null;
};

const GraphqlEnvelope = z
  .object({
    data: z.unknown().optional(),
    errors: z
      .array(
        z
          .object({
            type: z.string().optional(),
            message: z.string().optional(),
            // Which part of the answer the error is about, which is what lets a
            // caller carry on with the parts that did answer.
            path: z.array(z.union([z.string(), z.number()])).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const RateLimitPayload = z.object({
  rateLimit: z.object({ cost: z.number() }).passthrough(),
});

export type GraphqlError = {
  type?: string | undefined;
  message?: string | undefined;
  path?: readonly (string | number)[] | undefined;
};

/**
 * Whether a "not found" from a call means the issue the call names is missing.
 *
 * The graph answers `NOT_FOUND` for anything it will not resolve, and only the
 * caller knows what it asked for: the same word means "that issue is gone" when
 * an issue was named and "one row of a listing could not be read" when the board
 * was. Reading the second as the first blocks work on an issue that is perfectly
 * fine, and blocked work waits for a person who has nothing to fix.
 */
export type SubjectScope = 'issue' | 'other';

export type CallOptions = {
  /** What a "not found" answer means for this call; anything but an issue by default. */
  readonly scope?: SubjectScope;
  /**
   * Graph errors the caller can carry on without, asked of each error in turn.
   * Every error must be tolerated for the answer to count as one; a call that
   * tolerates nothing is refused by any error at all, which is the default.
   */
  readonly tolerates?: (error: GraphqlError) => boolean;
  /**
   * The version tag of an answer the caller already holds. The API answers
   * "unchanged" without a body when it still holds, and such an answer to a
   * request carrying a credential is not counted against the hourly allowance.
   */
  readonly ifNoneMatch?: string;
  /**
   * Statuses that are an answer rather than a refusal: a branch deleted after a
   * merge is not there (404), a commit another repository holds is no commit here
   * (422), and saying so is all the caller needs to hear.
   */
  readonly absentOn?: readonly number[];
};

/**
 * Everything known about a call the API refused, in the terms the rules below
 * ask questions in. A refusal is a non-2xx answer or a GraphQL `errors` entry —
 * a 2xx is a success however little allowance it reports left, because the last
 * successful write of an hour carries a remaining of zero and re-running it
 * would post a second comment.
 */
type Refusal = {
  readonly subject: string;
  readonly scope: SubjectScope;
  readonly status: number;
  readonly bodyText: string;
  readonly errors: readonly GraphqlError[];
  readonly budget: RateBudget | null;
  readonly retryAfterSec: number | null;
};

type RefusalRule = {
  readonly name: string;
  matches(refusal: Refusal): boolean;
  toError(refusal: Refusal): BoardQueueError;
};

function bodyMentions(refusal: Refusal, ...needles: readonly string[]): boolean {
  const haystack = refusal.bodyText.toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function hasErrorType(refusal: Refusal, accepts: (type: string) => boolean): boolean {
  return refusal.errors.some((error) => typeof error.type === 'string' && accepts(error.type));
}

function isRefusedStatus(refusal: Refusal): boolean {
  return refusal.status === 403 || refusal.status === 429;
}

/**
 * Asked in order; the first rule that recognises the refusal names it.
 *
 * The burst limiter comes first because it says so in words, and its text also
 * contains "rate limit": read by the generic rule while the hourly allowance
 * happens to stand at zero, a burst refusal would look like exhaustion and stop
 * the queue until the top of the hour for something that clears in a minute.
 */
const REFUSAL_RULES: readonly RefusalRule[] = [
  {
    name: 'burst limiter',
    matches: (refusal) =>
      bodyMentions(refusal, 'secondary rate limit', 'abuse detection', 'abuse-detection')
      || (isRefusedStatus(refusal) && refusal.retryAfterSec !== null),
    toError: (refusal) => new SecondaryRateLimited(refusal.retryAfterSec),
  },
  {
    name: 'rate limit',
    matches: (refusal) =>
      hasErrorType(refusal, (type) => type.startsWith('RATE_LIMIT'))
      || (isRefusedStatus(refusal) && bodyMentions(refusal, 'rate limit', 'ratelimit')),
    // The API writes the same sentence for both limiters; only the headers tell
    // them apart. No remaining count at all is read as the cheaper of the two.
    toError: (refusal) =>
      refusal.budget !== null && refusal.budget.isExhausted()
        ? new PrimaryRateLimited(refusal.budget.resetAt)
        : new SecondaryRateLimited(refusal.retryAfterSec),
  },
  {
    name: 'missing permission',
    matches: (refusal) =>
      hasErrorType(refusal, (type) => type === 'INSUFFICIENT_SCOPES')
      || (refusal.status === 403 && bodyMentions(refusal, 'scopes')),
    // A credential the API will never accept for this call, whatever the work was.
    // It is the queue's problem rather than the action's: every action would meet
    // the same answer, so the queue waits for a credential that can get in and
    // says which permission the answer asked for.
    toError: (refusal) => new CredentialRejected(
      refusal.subject,
      `the credential lacks a permission the call needs — ${redactSecrets(firstSentenceOf(refusal))}`,
    ),
  },
  {
    name: 'missing subject',
    matches: (refusal) => refusal.scope === 'issue'
      && (refusal.status === 404 || hasErrorType(refusal, (type) => type === 'NOT_FOUND')),
    toError: (refusal) => new IssueNotFound(refusal.subject),
  },
  {
    name: 'server fault',
    matches: (refusal) => refusal.status >= 500,
    toError: (refusal) => new NoAnswer(`${refusal.subject} answered ${String(refusal.status)}`),
  },
  {
    name: 'refused query',
    matches: (refusal) => refusal.errors.length > 0,
    toError: (refusal) =>
      new TransientFailure(`${refusal.subject} was refused: ${redactSecrets(firstSentenceOf(refusal))}`),
  },
];

const RestMessage = z.object({ message: z.string() });

/** What the answer said first, which is the part worth quoting to a person. */
function firstSentenceOf(refusal: Refusal): string {
  const first = refusal.errors[0];
  return first?.message ?? first?.type ?? messageInBody(refusal.bodyText) ?? 'no reason';
}

/** REST says what it refused in a `message` of its own, where the graph uses `errors`. */
function messageInBody(bodyText: string): string | null {
  const parsed = tryParseJson(bodyText);
  if (!parsed.parsed) {
    return null;
  }
  const said = RestMessage.safeParse(parsed.value);
  return said.success ? said.data.message : null;
}

function classifyRefusal(refusal: Refusal): BoardQueueError {
  for (const rule of REFUSAL_RULES) {
    if (rule.matches(refusal)) {
      return rule.toError(refusal);
    }
  }
  return new TransientFailure(`${refusal.subject} answered ${String(refusal.status)}`);
}

type Outcome = {
  status: number;
  ok: boolean;
  text: string;
  budget: RateBudget | null;
  header: (name: string) => string | null;
};

type CallSpec = {
  url: string;
  method: string;
  resource: RateResource;
  subject: string;
  accept: string;
  body?: string | undefined;
  extraHeaders?: Record<string, string>;
};

/**
 * What the API last said was left of each allowance. It is written by every answer
 * and read without spending anything.
 */
export class BudgetLedger {
  readonly #budgets = new Map<RateResource, RateBudget>();

  /** Filed under the allowance the call spent, which is not always the one the answer names. */
  remember(resource: RateResource, budget: RateBudget): void {
    this.#budgets.set(resource, budget);
  }

  last(resource: RateResource): RateBudget | null {
    return this.#budgets.get(resource) ?? null;
  }
}

/**
 * The transport every gateway here shares: bearer auth, the allowance read off
 * every answer, and one vocabulary of failures for the queue to decide from.
 * It knows nothing about boards or issues — the shape of a payload is the
 * caller's business, the meaning of a refusal is this class's.
 */
export class GitHubHttp {
  private readonly tokens: TokenProvider;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly ledger: BudgetLedger;

  constructor(deps: GitHubHttpDeps) {
    this.tokens = deps.tokens;
    this.logger = deps.logger;
    this.ledger = deps.ledger ?? new BudgetLedger();
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (deps.apiBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** What the last answer on this allowance said, without spending anything. */
  lastBudget(resource: RateResource): RateBudget | null {
    return this.ledger.last(resource);
  }

  /** Records an allowance learned from a payload rather than from the headers. */
  rememberBudget(budget: RateBudget): void {
    this.ledger.remember(budget.resource, budget);
  }

  async graphql(
    query: string,
    variables: Record<string, unknown>,
    subject?: string,
    options: CallOptions = {},
  ): Promise<unknown> {
    const operation = operationNameOf(query);
    const label = subject ?? operation ?? 'a graph query';
    const outcome = await this.send({
      url: `${this.baseUrl}/graphql`,
      method: 'POST',
      resource: 'graphql',
      subject: label,
      accept: 'application/json',
      body: JSON.stringify({ query, variables, operationName: operation }),
    });
    const parsed = tryParseJson(outcome.text);
    const envelope = parsed.parsed ? GraphqlEnvelope.safeParse(parsed.value) : null;
    const errors: readonly GraphqlError[] = envelope?.success === true ? envelope.data.errors ?? [] : [];
    // An answer the caller can live with: the parts that failed are ones it said
    // it could do without, and the rest of the payload is exactly as good as an
    // answer with no errors at all. Refusing the whole page over one unreadable
    // row is how a listing stops the queue for something nobody can fix.
    const tolerated = errors.length > 0 && options.tolerates !== undefined
      && errors.every((error) => options.tolerates?.(error) === true);
    this.logger.info('graph call', {
      operation: operation ?? label,
      status: outcome.status,
      remaining: outcome.budget?.remaining ?? null,
      cost: costOf(envelope?.success === true ? envelope.data.data : undefined),
      errors: errors.length,
    });
    if (outcome.ok && (errors.length === 0 || tolerated)) {
      if (envelope === null || !envelope.success) {
        throw new TransientFailure(`${label} answered something that is not a graph response`);
      }
      if (tolerated) {
        this.logger.warn('part of an answer could not be read and was skipped', {
          operation: operation ?? label,
          skipped: errors.length,
        });
      }
      return envelope.data.data ?? null;
    }
    throw classifyRefusal({
      subject: label,
      scope: options.scope ?? 'other',
      status: outcome.status,
      bodyText: outcome.text,
      errors,
      budget: outcome.budget,
      retryAfterSec: numericHeader(outcome.header('retry-after')),
    });
  }

  /** `path` is either `/repos/…` or a whole address, as a `Link` header gives it. */
  async rest(
    method: string,
    path: string,
    body?: unknown,
    subject?: string,
    options: CallOptions = {},
  ): Promise<RestResult> {
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    const shown = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url;
    const label = subject ?? `${method} ${shown.split('?')[0] ?? shown}`;
    if (!this.sameHostAsTheApi(url)) {
      // A `Link` header is written by whatever answered, and this call carries a
      // bearer credential. An address somewhere else is not followed, whoever
      // suggested it.
      throw new TransientFailure(`${label} pointed at another host, which this credential is never sent to`);
    }
    const extraHeaders: Record<string, string> = { 'x-github-api-version': REST_API_VERSION };
    if (options.ifNoneMatch !== undefined) {
      extraHeaders['if-none-match'] = options.ifNoneMatch;
    }
    const outcome = await this.send({
      url,
      method,
      resource: 'core',
      subject: label,
      accept: 'application/vnd.github+json',
      body: body === undefined ? undefined : JSON.stringify(body),
      extraHeaders,
    });
    this.logger.info('rest call', {
      method,
      path: shown,
      status: outcome.status,
      remaining: outcome.budget?.remaining ?? null,
    });
    const etag = outcome.header('etag');
    const servedAt = dateHeader(outcome.header('date'));
    if (outcome.status === NOT_MODIFIED && options.ifNoneMatch !== undefined) {
      return {
        data: null,
        nextPageUrl: null,
        etag: etag ?? options.ifNoneMatch,
        notModified: true,
        missing: false,
        servedAt,
      };
    }
    if (options.absentOn?.includes(outcome.status) === true) {
      return { data: null, nextPageUrl: null, etag: null, notModified: false, missing: true, servedAt };
    }
    if (!outcome.ok) {
      throw classifyRefusal({
        subject: label,
        scope: options.scope ?? 'other',
        status: outcome.status,
        bodyText: outcome.text,
        errors: [],
        budget: outcome.budget,
        retryAfterSec: numericHeader(outcome.header('retry-after')),
      });
    }
    const nextPageUrl = nextPageOf(outcome.header('link'));
    if (outcome.text.trim() === '') {
      return { data: null, nextPageUrl, etag, notModified: false, missing: false, servedAt };
    }
    const parsed = tryParseJson(outcome.text);
    if (!parsed.parsed) {
      throw new TransientFailure(`${label} answered something that is not JSON`);
    }
    return { data: parsed.value, nextPageUrl, etag, notModified: false, missing: false, servedAt };
  }

  /** Whether an address belongs to the API this transport was pointed at. */
  private sameHostAsTheApi(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  /**
   * One exchange, with the single retry a rejected credential earns: a token can
   * expire between minting and use, and that is the transport's business, not
   * the action's. A second rejection is reported as a credential failure of its
   * own, so the queue waits for a working login rather than blaming whatever was
   * being written for something it had no part in.
   */
  private async send(spec: CallSpec): Promise<Outcome> {
    let refreshed = false;
    for (;;) {
      const token = await this.tokens.token();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: spec.accept,
        'user-agent': this.userAgent,
        ...(spec.extraHeaders ?? {}),
      };
      if (spec.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const init: RequestInit = { method: spec.method, headers };
      if (spec.body !== undefined) {
        init.body = spec.body;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(spec.url, init);
      } catch (cause) {
        throw new NoAnswer(`${spec.subject} could not be reached: ${describeCause(cause)}`);
      }
      const headerOf = headerReader(response);
      const budget = RateBudget.fromHeaders(headerOf);
      if (budget !== null) {
        this.ledger.remember(spec.resource, budget);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        throw new NoAnswer(`${spec.subject} answered a body that could not be read: ${describeCause(cause)}`);
      }
      if (response.status === 401) {
        this.logger.warn('credential rejected', { subject: spec.subject, retrying: !refreshed });
        if (refreshed) {
          throw new CredentialRejected(spec.subject);
        }
        refreshed = true;
        this.tokens.invalidate();
        continue;
      }
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        text,
        budget,
        header: headerOf,
      };
    }
  }
}

/**
 * Turns a payload into the shape the caller expects, or reports a retryable
 * failure naming the call — an answer this adapter cannot read is a fault of the
 * moment, never a reason to write half of something.
 */
export function decodeWire<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const first = parsed.error.issues[0];
  const at = first === undefined || first.path.length === 0 ? 'the payload' : first.path.join('.');
  throw new TransientFailure(`${subject} answered an unexpected shape at ${at}`);
}

function headerReader(response: Response): (name: string) => string | null {
  const values: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    values[name.toLowerCase()] = value;
  });
  return (name) => values[name.toLowerCase()] ?? null;
}

function tryParseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  if (text.trim() === '') {
    return { parsed: false };
  }
  try {
    return { parsed: true, value: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false };
  }
}

function costOf(data: unknown): number | null {
  const parsed = RateLimitPayload.safeParse(data);
  return parsed.success ? parsed.data.rateLimit.cost : null;
}

function numericHeader(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** An HTTP date (`Mon, 02 Mar 2026 09:00:00 GMT`), or nothing for a header that is absent or not one. */
function dateHeader(raw: string | null): Date | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

const NEXT_PAGE = /<([^>]+)>\s*;\s*rel="next"/i;

function nextPageOf(link: string | null): string | null {
  if (link === null) {
    return null;
  }
  const match = NEXT_PAGE.exec(link);
  return match?.[1] ?? null;
}

const OPERATION_NAME = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/;

function operationNameOf(query: string): string | null {
  return OPERATION_NAME.exec(query)?.[1] ?? null;
}

/** A cause is shown as a sentence, never as an object that might quote a header. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return redactSecrets(cause.message);
  }
  return typeof cause === 'string' ? redactSecrets(cause) : 'the reason was not stated';
}
