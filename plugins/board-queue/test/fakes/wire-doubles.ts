import type { CachedCatalog, FieldCatalog } from '../../src/domain/catalog.ts';
import type { CatalogStore, LogFields, Logger, TokenProvider } from '../../src/application/ports.ts';

/** Hands out the scripted credentials in order and counts how often it was dropped. */
export class StubTokenProvider implements TokenProvider {
  invalidations = 0;
  private readonly tokens: string[];
  private index = 0;

  constructor(tokens: readonly string[] = ['ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    this.tokens = [...tokens];
  }

  async token(): Promise<string> {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)] ?? '';
  }

  invalidate(): void {
    this.invalidations += 1;
    this.index += 1;
  }
}

export type LoggedLine = { level: string; message: string; fields: LogFields };

export class RecordingLogger implements Logger {
  readonly lines: LoggedLine[] = [];

  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields: fields ?? {} });
  }

  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields: fields ?? {} });
  }

  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields: fields ?? {} });
  }
}

/** The catalog cache, without a database behind it. */
export class MemoryCatalogStore implements CatalogStore {
  reads = 0;
  writes = 0;
  private held: CachedCatalog | null = null;

  constructor(held: CachedCatalog | null = null) {
    this.held = held;
  }

  async get(): Promise<CachedCatalog | null> {
    this.reads += 1;
    return this.held;
  }

  async put(catalog: FieldCatalog, fetchedAt: Date): Promise<void> {
    this.writes += 1;
    this.held = { catalog, fetchedAt };
  }
}
