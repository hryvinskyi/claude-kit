/**
 * Parsers for configuration that reaches a script from markup or from an API response.
 * Each one returns a typed value or throws ContractError naming the path it rejected.
 */
export class ContractError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = 'ContractError';
    this.path = path;
  }
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ContractError(path, 'a string');
  return value;
}

export function int(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ContractError(path, 'an integer');
  return value;
}
