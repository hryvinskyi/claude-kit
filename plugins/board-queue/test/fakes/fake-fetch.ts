import type { FetchLike } from '../../src/infrastructure/github-http.ts';

export type ScriptedResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** Serialised as JSON; `bodyText` wins when both are given. */
  body?: unknown;
  bodyText?: string;
  /** A call that never reached anything. */
  failWith?: Error;
};

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
  body: unknown;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown>;
};

/** A body that is neither a string nor absent is recorded as unreadable, never guessed. */
function bodyTextOf(body: RequestInit['body']): string | null {
  return typeof body === 'string' ? body : null;
}

function parsed(text: string | null): unknown {
  if (text === null || text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function graphqlPart(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...body };
  return record[key] ?? null;
}

/**
 * Answers a scripted list of responses and remembers what was asked.
 *
 * The responses are real `Response` objects, so the adapters read headers, text
 * and status exactly as they would from the network.
 */
export class FakeFetch {
  readonly calls: RecordedRequest[] = [];
  private readonly script: ScriptedResponse[];

  constructor(script: readonly ScriptedResponse[] = []) {
    this.script = [...script];
  }

  push(...responses: readonly ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const bodyText = bodyTextOf(init.body);
    const body = parsed(bodyText);
    const query = graphqlPart(body, 'query');
    const variables = graphqlPart(body, 'variables');
    const operationName = graphqlPart(body, 'operationName');
    this.calls.push({
      url,
      method: init.method ?? 'GET',
      headers,
      bodyText,
      body,
      query: typeof query === 'string' ? query : null,
      operationName: typeof operationName === 'string' ? operationName : null,
      variables: typeof variables === 'object' && variables !== null ? { ...variables } : {},
    });
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error(`no scripted answer left for ${init.method ?? 'GET'} ${url}`);
    }
    if (next.failWith !== undefined) {
      throw next.failWith;
    }
    const status = next.status ?? 200;
    const text = next.bodyText ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    const carriesBody = status !== 204 && status !== 304;
    return new Response(carriesBody ? text : null, { status, headers: next.headers ?? {} });
  };
}

/** The allowance headers a healthy answer carries. */
export function budgetHeaders(remaining: number, resetSeconds: number, resource = 'graphql'): Record<string, string> {
  return {
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-used': String(5000 - remaining),
    'x-ratelimit-reset': String(resetSeconds),
    'x-ratelimit-resource': resource,
  };
}
