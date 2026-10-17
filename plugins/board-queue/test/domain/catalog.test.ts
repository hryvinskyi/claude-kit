import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCatalogField, resolveOption } from '../../src/domain/catalog.ts';
import type { CatalogField, FieldCatalog } from '../../src/domain/catalog.ts';
import { AmbiguousOption, OptionNotFound } from '../../src/domain/errors.ts';

const severity: CatalogField = {
  id: 'f-severity',
  name: 'Severity',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'o-1', name: 'S1 · blocking · no workaround' },
    { id: 'o-2', name: 'S2 · broken · workaround exists' },
  ],
};

const module: CatalogField = {
  id: 'f-module',
  name: 'Module',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'o-3', name: 'Same label' },
    { id: 'o-4', name: 'Same label' },
  ],
};

const catalog: FieldCatalog = { projectId: 'p-1', fields: [severity, module] };

describe('the board catalog', () => {
  it('finds a field whatever case it is asked in', () => {
    assert.equal(findCatalogField(catalog, 'severity')?.id, 'f-severity');
    assert.equal(findCatalogField(catalog, ' Severity '), severity);
    assert.equal(findCatalogField(catalog, 'Environment'), null);
  });

  it('matches an option exactly, ignoring case', () => {
    assert.equal(resolveOption(severity, 's1 · blocking · no workaround').id, 'o-1');
  });

  it('accepts the beginning of a label when it fits one option only', () => {
    assert.equal(resolveOption(severity, 'S2').id, 'o-2');
    assert.equal(resolveOption(severity, ' s2 ').id, 'o-2');
  });

  it('refuses to guess between several options and says which ones', () => {
    assert.throws(
      () => resolveOption(severity, 'S'),
      (error: unknown) => error instanceof AmbiguousOption
        && error.matches.length === 2
        && error.accepted.length === 2
        && error.describe().includes('S1 · blocking · no workaround'),
    );
  });

  it('refuses two options that carry the same label rather than picking one', () => {
    assert.throws(() => resolveOption(module, 'Same label'), AmbiguousOption);
  });

  it('refuses a text that fits nothing and reports what the field accepts', () => {
    assert.throws(
      () => resolveOption(severity, 'urgent'),
      (error: unknown) => error instanceof OptionNotFound
        && error.field === 'Severity'
        && error.wanted === 'urgent'
        && error.accepted.length === 2,
    );
  });
});
