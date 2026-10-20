/** A repository as the coordination server lists it: its own id, and the path of the remote it is cloned from. */
export type CoordinatedRepository = {
  readonly id: string;
  /** `owner/name`, from the remote the server records; null for the one repository of a project that lists none. */
  readonly remotePath: string | null;
};

/**
 * Which repository of the coordination server each forge repository is.
 *
 * The server names a repository by an id of its own, and keys a claim's branches
 * by it; the forge names it `owner/name`. A listed repository is matched through
 * the path of its remote. A project that lists no repository has one, with no
 * remote, and it stands for the forge repository only when exactly one is kept in
 * step: with several, there is no telling which, and none is guessed.
 */
export class RepositoryMap {
  readonly #idOf: ReadonlyMap<string, string>;

  private constructor(pairs: readonly (readonly [string, string])[]) {
    this.#idOf = new Map(pairs);
  }

  static of(listed: readonly CoordinatedRepository[], forgeRepos: readonly string[]): RepositoryMap {
    const kept = forgeRepos.map((repo) => repo.toLowerCase());
    const pairs: (readonly [string, string])[] = [];
    for (const repository of listed) {
      if (repository.remotePath !== null) {
        const repo = repository.remotePath.toLowerCase();
        if (kept.includes(repo)) {
          pairs.push([repo, repository.id]);
        }
      }
    }
    const [only] = listed;
    const [one] = kept;
    if (listed.length === 1 && only !== undefined && only.remotePath === null && kept.length === 1 && one !== undefined) {
      pairs.push([one, only.id]);
    }
    return new RepositoryMap(pairs);
  }

  /** The server's id for a forge repository, or nothing when the server does not list it. */
  idOf(repo: string): string | null {
    return this.#idOf.get(repo.toLowerCase()) ?? null;
  }
}
