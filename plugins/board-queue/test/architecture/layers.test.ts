import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { layerOf, violationsIn } from '../../scripts/layer-rule.ts';

const SRC = path.resolve('/project/src');

describe('the layer rule', () => {
  it('catches a domain module that names a port from the application layer', () => {
    const file = path.join(SRC, 'domain', 'kinds', 'example.ts');
    const source = "import type { Clock } from '../../application/ports.ts';\nexport type Uses = Clock;\n";
    assert.deepEqual(violationsIn(SRC, file, source), [
      `${path.join('domain', 'kinds', 'example.ts')} → ${path.join('application', 'ports.ts')}`,
    ]);
  });

  it('catches a re-export that reaches outward as surely as an import', () => {
    const file = path.join(SRC, 'application', 'example.ts');
    const source = "export { GitHubRestIssues } from '../infrastructure/github-rest-issues.ts';\n";
    assert.deepEqual(violationsIn(SRC, file, source), [
      `${path.join('application', 'example.ts')} → ${path.join('infrastructure', 'github-rest-issues.ts')}`,
    ]);
  });

  it('lets an outer layer import an inner one, and a layer import itself', () => {
    const file = path.join(SRC, 'delivery', 'example.ts');
    const source = [
      "import type { Action } from '../domain/action.ts';",
      "import { GitHubRestIssues } from '../infrastructure/github-rest-issues.ts';",
      "import { render } from './render.ts';",
    ].join('\n');
    assert.deepEqual(violationsIn(SRC, file, source), []);
  });

  it('ignores packages, and files that sit in no layer', () => {
    const inDomain = path.join(SRC, 'domain', 'example.ts');
    assert.deepEqual(violationsIn(SRC, inDomain, "import { z } from 'zod';\n"), []);
    const outside = path.join(SRC, 'example.ts');
    assert.equal(layerOf(SRC, outside), null);
    assert.deepEqual(violationsIn(SRC, outside, "import { x } from './application/ports.ts';\n"), []);
  });
});
