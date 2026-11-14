import path from 'node:path';
import ts from 'typescript';

/**
 * The dependency rule over the source tree: each layer imports only itself and
 * the layers inside it. Type-only imports and re-exports count, because a type
 * names its layer as surely as a value does.
 */
export type Layer = 'domain' | 'application' | 'infrastructure' | 'delivery';

const LAYERS: readonly Layer[] = ['domain', 'application', 'infrastructure', 'delivery'];

const MAY_IMPORT = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  delivery: ['domain', 'application', 'infrastructure', 'delivery'],
} as const satisfies Record<Layer, readonly Layer[]>;

/** The layer a file under `srcRoot` belongs to, or null for a file in none of them. */
export function layerOf(srcRoot: string, file: string): Layer | null {
  const top = path.relative(srcRoot, file).split(path.sep)[0];
  return LAYERS.find((layer) => layer === top) ?? null;
}

/**
 * Every edge in this source that reaches a layer its file's layer may not depend
 * on, written `from → to` with both paths relative to `srcRoot`.
 */
export function violationsIn(srcRoot: string, file: string, source: string): string[] {
  const from = layerOf(srcRoot, file);
  if (from === null) {
    return [];
  }
  const allowed: readonly Layer[] = MAY_IMPORT[from];
  return ts.preProcessFile(source, true, true).importedFiles
    .map((imported) => imported.fileName)
    .filter((name) => name.startsWith('.'))
    .map((name) => path.resolve(path.dirname(file), name))
    .filter((target) => {
      const to = layerOf(srcRoot, target);
      return to !== null && !allowed.includes(to);
    })
    .map((target) => `${path.relative(srcRoot, file)} → ${path.relative(srcRoot, target)}`);
}
