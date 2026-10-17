import type { BoardKey } from '../domain/board-directory.ts';
import type { CachedCatalog, FieldCatalog } from '../domain/catalog.ts';
import type { ActionRepository, CatalogStore } from './ports.ts';

/**
 * One board's catalog slot in the queue's store, offered as the narrow port a
 * gateway asks for: somewhere to keep that board's vocabulary between runs. A
 * gateway has no business knowing what else that store holds, and nothing else
 * has business reaching the gateway's cache.
 */
export class RepositoryCatalogStore implements CatalogStore {
  readonly #repository: ActionRepository;
  readonly #board: BoardKey;

  constructor(repository: ActionRepository, board: BoardKey) {
    this.#repository = repository;
    this.#board = board;
  }

  get(): Promise<CachedCatalog | null> {
    return this.#repository.getCatalog(this.#board);
  }

  put(catalog: FieldCatalog, fetchedAt: Date): Promise<void> {
    return this.#repository.putCatalog(this.#board, catalog, fetchedAt);
  }
}
