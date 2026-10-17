import { UnknownKind } from '../errors.ts';
import type { ActionKind } from './action-kind.ts';

/**
 * The closed set of things this system knows how to do, resolved by name.
 *
 * A name nobody registered fails loudly and lists what is registered: a typo in a
 * caller must never become an action that sits in the queue doing nothing.
 */
export class KindRegistry {
  readonly #byName: Map<string, ActionKind>;

  constructor(kinds: readonly ActionKind[]) {
    this.#byName = new Map<string, ActionKind>();
    for (const kind of kinds) {
      if (this.#byName.has(kind.name)) {
        throw new Error(`two action kinds are registered as "${kind.name}"`);
      }
      this.#byName.set(kind.name, kind);
    }
  }

  get(name: string): ActionKind {
    const kind = this.#byName.get(name);
    if (kind === undefined) {
      throw new UnknownKind(name, this.names());
    }
    return kind;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  names(): string[] {
    return [...this.#byName.keys()];
  }

  all(): ActionKind[] {
    return [...this.#byName.values()];
  }
}
