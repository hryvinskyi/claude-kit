/**
 * Parsers for configuration that reaches a script from markup or from an API response.
 * Each one returns a typed value or throws ContractError naming the path it rejected, so a
 * widget never runs on a shape it did not expect.
 */
export class ContractError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a JSON object from an attribute of `element`. */
export function jsonAttribute(element: Element, name: string): Record<string, unknown> {
  const raw = element.getAttribute(name);
  if (raw === null) throw new ContractError(name, 'an attribute');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new ContractError(name, `JSON (${String(cause)})`);
  }
  if (!isRecord(value)) throw new ContractError(name, 'a JSON object');
  return value;
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ContractError(path, 'a string');
  return value;
}

export function int(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ContractError(path, 'an integer');
  return value;
}

export function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new ContractError(path, `one of ${allowed.join(', ')}`);
  return found;
}
