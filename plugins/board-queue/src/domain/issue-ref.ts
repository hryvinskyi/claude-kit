import { InvalidIssueRef, RefusedByRule } from './errors.ts';

/** GitHub owners are letters, digits and hyphens. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** Repository names additionally allow a dot and an underscore. */
const REPO = /^[A-Za-z0-9._-]+$/;
const SHORT = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const URL = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

/**
 * One issue on one repository.
 *
 * The board carries several repositories and their numbers collide, so a number
 * on its own names nothing: everything in this system addresses an issue by
 * repository *and* number. Owner and repository names compare case-insensitively
 * because GitHub treats them so; the spelling that gets persisted is the one the
 * configuration uses, which `canonical()` supplies.
 */
export class IssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;

  constructor(owner: string, repo: string, number: number) {
    if (!OWNER.test(owner) || !REPO.test(repo)) {
      throw new InvalidIssueRef(`${owner}/${repo}`);
    }
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new InvalidIssueRef(`${owner}/${repo}#${String(number)}`);
    }
    this.owner = owner;
    this.repo = repo;
    this.number = number;
  }

  /** Accepts `owner/repo#12` and the issue's web address. */
  static parse(text: string): IssueRef {
    const trimmed = text.trim();
    const match = SHORT.exec(trimmed) ?? URL.exec(trimmed);
    if (match === null) {
      throw new InvalidIssueRef(text);
    }
    const [, owner = '', repo = '', number = ''] = match;
    return new IssueRef(owner, repo, Number(number));
  }

  /** `repoFullName` is `owner/name`, the spelling every payload uses. */
  static of(repoFullName: string, number: number): IssueRef {
    const parts = repoFullName.trim().split('/');
    if (parts.length !== 2) {
      throw new InvalidIssueRef(repoFullName);
    }
    const [owner = '', repo = ''] = parts;
    return new IssueRef(owner, repo, number);
  }

  repoFullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  toString(): string {
    return `${this.repoFullName()}#${String(this.number)}`;
  }

  url(): string {
    return `https://github.com/${this.owner}/${this.repo}/issues/${String(this.number)}`;
  }

  /** Lower-cased, for use as a map key or a stored matching column. */
  key(): string {
    return this.toString().toLowerCase();
  }

  sameRepo(other: IssueRef): boolean {
    return this.repoFullName().toLowerCase() === other.repoFullName().toLowerCase();
  }

  equals(other: IssueRef): boolean {
    return this.number === other.number && this.sameRepo(other);
  }

  /**
   * The same issue, spelled the way the configuration spells its repository.
   * A repository nobody configured is refused here rather than reaching the API.
   */
  canonical(repos: readonly string[]): IssueRef {
    const mine = this.repoFullName().toLowerCase();
    for (const configured of repos) {
      if (configured.toLowerCase() === mine) {
        return IssueRef.of(configured, this.number);
      }
    }
    throw new RefusedByRule(
      `${this.repoFullName()} is not a configured repository; this queue writes to ${repos.join(', ')}`,
    );
  }
}

/** True when the text reads `owner/name`; used by the payload schemas. */
export function isRepoFullName(text: string): boolean {
  const parts = text.split('/');
  if (parts.length !== 2) {
    return false;
  }
  const [owner = '', repo = ''] = parts;
  return OWNER.test(owner) && REPO.test(repo);
}
