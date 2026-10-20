import { z } from 'zod';
import type { Logger } from '../application/ports.ts';
import { NoAnswer, RefusedByRule, TransientFailure } from '../domain/errors.ts';
import type { FetchLike } from './github-http.ts';
import { redactSecrets } from './redaction.ts';

/** Every call is answered within this, or it is a call that failed. */
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'board-queue';
const SERVER_FAULT = 500;

const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type DibsHttpDeps = {
  /** The server's address, without a trailing slash. */
  server: string;
  /** The integration's token, read when a call needs it. */
  token: () => string;
  logger: Logger;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** What the server answered: its status, its body, and the code and details of a refusal. */
export type DibsAnswer = {
  readonly status: number;
  readonly json: unknown;
  readonly code: string | null;
  readonly details: Record<string, unknown>;
};

/**
 * One exchange with the coordination server: the integration's token, a deadline,
 * and the server's answer read whatever it was. A call that could not be made is a
 * `NoAnswer` naming what was asked, never the token; reading what a successful
 * answer means is the caller's.
 */
export class DibsTransport {
  readonly #server: string;
  readonly #token: () => string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(deps: DibsHttpDeps) {
    this.#server = deps.server.replace(/\/+$/, '');
    this.#token = deps.token;
    this.#fetch = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async call(method: string, path: string, subject: string, body?: unknown): Promise<DibsAnswer> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token()}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#server}${path}`, init);
      text = await response.text();
    } catch (cause) {
      throw new NoAnswer(`${subject} could not be reached: ${causeOf(cause)}`);
    }
    const json = parsedJson(text);
    const envelope = ErrorEnvelope.safeParse(json);
    return {
      status: response.status,
      json,
      code: envelope.success ? envelope.data.error.code : null,
      details: envelope.success ? envelope.data.error.details ?? {} : {},
    };
  }

  /**
   * The body of a successful answer; any other is a failure naming the server's
   * code for it. A fault of the server's own (a 5xx) is the server not answering;
   * a 4xx is a refusal of this one request.
   */
  ok(answer: DibsAnswer, subject: string): unknown {
    if (answer.status >= 200 && answer.status < 300) {
      return answer.json;
    }
    const code = answer.code === null ? '' : ` (${answer.code})`;
    if (answer.status >= SERVER_FAULT) {
      throw new NoAnswer(`${subject} met a fault of the coordination server: ${String(answer.status)}${code}`);
    }
    throw new TransientFailure(`${subject} was refused by the coordination server: ${String(answer.status)}${code}`);
  }

  /** An answer read into the shape the caller expects, or a failure naming where it was not that shape. */
  decode<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, subject: string): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
    const first = parsed.error.issues[0];
    const at = first === undefined || first.path.length === 0 ? 'the answer' : first.path.join('.');
    throw new TransientFailure(`${subject} answered an unexpected shape at ${at}`);
  }

  /** A successful answer, read into the shape the caller expects. */
  async read<T>(
    method: string,
    path: string,
    subject: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const answer = await this.call(method, path, subject, body);
    return this.decode(schema, this.ok(answer, subject), subject);
  }
}

function parsedJson(text: string): unknown {
  if (text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function causeOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' ? 'no answer within the deadline' : redactSecrets(cause.message);
  }
  return 'the reason was not stated';
}

/**
 * The integration's token, read from the environment variable the configuration
 * names. The variable is read at the moment of a call, so a worker that keeps in
 * step with nothing never asks for it, and its value is never repeated anywhere.
 */
export function tokenFromEnvironment(env: Readonly<Record<string, string | undefined>>, name: string): () => string {
  return () => {
    const value = (env[name] ?? '').trim();
    if (value === '') {
      throw new RefusedByRule(`${name} holds no token for the coordination server; set it in the worker's environment`);
    }
    return value;
  };
}
