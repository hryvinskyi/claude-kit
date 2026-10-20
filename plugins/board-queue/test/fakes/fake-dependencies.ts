import type {
  DependencyAnswer,
  DependencyCache,
  DependencyFetch,
  DependencyList,
  DependencyReader,
  LinkedIssue,
} from '../../src/application/sync-ports.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';
import type { IssueRef } from '../../src/domain/issue-ref.ts';

type Held = { issues: LinkedIssue[]; etag: string | null };

/**
 * GitHub's dependency lists, in memory. Each list answers with a tag, and a
 * request that hands the current tag back is answered "unchanged", the way the
 * real endpoints answer a repeat.
 */
export class FakeDependencyReader implements DependencyReader {
  readonly asked: { list: DependencyList; ref: string; etag: string | null }[] = [];
  readonly #lists = new Map<string, Held>();
  readonly #scripted: BoardQueueError[] = [];
  /** Lists that answer without a tag, the way an endpoint that keeps none would. */
  readonly untagged = new Set<string>();
  #version = 0;

  set(list: DependencyList, ref: IssueRef, issues: readonly LinkedIssue[]): this {
    this.#version += 1;
    const key = keyOf(list, ref);
    this.#lists.set(key, {
      issues: [...issues],
      etag: this.untagged.has(key) ? null : `"v${String(this.#version)}"`,
    });
    return this;
  }

  /** The next request is refused with this, whatever it asks for. */
  failNext(error: BoardQueueError): this {
    this.#scripted.push(error);
    return this;
  }

  read(list: DependencyList, ref: IssueRef, etag: string | null): Promise<DependencyAnswer> {
    this.asked.push({ list, ref: ref.toString(), etag });
    const scripted = this.#scripted.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
    const held = this.#lists.get(keyOf(list, ref)) ?? { issues: [], etag: '"empty"' };
    if (etag !== null && held.etag === etag) {
      return Promise.resolve({ changed: false, etag });
    }
    return Promise.resolve({ changed: true, etag: held.etag, issues: [...held.issues] });
  }
}

/** The kept answers, without a database. */
export class InMemoryDependencyCache implements DependencyCache {
  readonly #held = new Map<string, DependencyFetch>();

  get(list: DependencyList, ref: IssueRef): Promise<DependencyFetch | null> {
    return Promise.resolve(this.#held.get(keyOf(list, ref)) ?? null);
  }

  put(list: DependencyList, ref: IssueRef, fetch: DependencyFetch): Promise<void> {
    this.#held.set(keyOf(list, ref), fetch);
    return Promise.resolve();
  }
}

export function dependencyKey(list: DependencyList, ref: IssueRef): string {
  return keyOf(list, ref);
}

function keyOf(list: DependencyList, ref: IssueRef): string {
  return `${list}:${ref.key()}`;
}
