import type { TokenRefusalSink } from './sync-ports.ts';

/** What a pass heard about the coordination server refusing its token. */
export interface TokenRefusalRecord {
  /** The first refusal since the last time this was asked, or null; asking forgets it. */
  takeRefusal(): string | null;
}

/**
 * The refusals of the coordination server's token, kept until the pass that
 * met them takes them, so a pass reports only the refusals of its own calls.
 */
export class TokenRefusals implements TokenRefusalSink, TokenRefusalRecord {
  #first: string | null = null;

  tokenRefused(reason: string): void {
    this.#first ??= reason;
  }

  takeRefusal(): string | null {
    const first = this.#first;
    this.#first = null;
    return first;
  }
}
