import { catalogField, catalogOf } from '../fakes/fake-board-gateway.ts';
import type { FieldCatalog } from '../../src/domain/catalog.ts';

/**
 * A board whose option labels carry prose, the way the real one does: matching a
 * wanted text against them is a prefix question, and several of them deliberately
 * share a first letter so that guessing has something to fail at.
 */
export function boardCatalog(): FieldCatalog {
  return catalogOf(
    catalogField('Status', ['Todo', 'In Progress', 'In Review', 'Done']),
    catalogField('Severity', ['S1 · blocking', 'S2 · broken · no workaround', 'S3 · cosmetic']),
    catalogField('Module', ['Checkout', 'Catalog']),
    catalogField('Environment', ['staging', 'production']),
    catalogField('Defect type', ['Bug', 'Regression']),
  );
}
