import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Clock, Logger, TokenProvider } from '../application/ports.ts';
import type { BoardOwnerType } from '../domain/board-directory.ts';
import { BoardQueueError, RefusedByRule, TransientFailure } from '../domain/errors.ts';
import { decodeWire, type FetchLike } from './github-http.ts';
import { redactSecrets } from './redaction.ts';

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'board-queue';
/** An installation token lives an hour; this leaves ten minutes of slack. */
const DEFAULT_CACHE_TTL_SEC = 50 * 60;
/** The window an App's own assertion is good for, and the clock skew it allows. */
const JWT_BACKDATE_SEC = 60;
const JWT_LIFETIME_SEC = 9 * 60;
/** How long one of the App's own calls may take before it is given up on. */
const APP_CALL_TIMEOUT_MS = 10_000;

/**
 * The variable that names the App's key file, and the older one that some
 * installations still use for the same thing.
 *
 * It is a path, never the key. A key pasted into an environment variable is read
 * by every child process, ends up in a crash dump the moment anything prints its
 * environment, and cannot be given file permissions of its own — so a value that
 * looks like a key is refused rather than used, and no message here ever repeats
 * what either variable holds.
 */
const KEY_PATH_VAR = 'GITHUB_APP_PRIVATE_KEY_PATH';
const KEY_VAR = 'GITHUB_APP_PRIVATE_KEY';
const PEM_OPENING = '-----BEGIN';

/** Where an installation is looked up depends on the kind of account that owns the board. */
const INSTALLATION_PATH: Record<BoardOwnerType, (owner: string) => string> = {
  organization: (owner) => `/orgs/${owner}/installation`,
  user: (owner) => `/users/${owner}/installation`,
};

const ExitStatus = z.object({ status: z.number() });
const InstallationPayload = z.object({ id: z.number().int() });
const AccessTokenPayload = z.object({ token: z.string().min(1) });
const AppPayload = z.object({ slug: z.string().trim().min(1) });

/** Running a command, narrow enough for a test to stand in for. */
export type CommandRunner = (command: string, args: readonly string[]) => string;

const runCommand: CommandRunner = (command, args) =>
  execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The credential of whoever is logged in to the command line tool.
 *
 * The output of a failed run is never quoted: it is the one place a credential
 * could be printed, and the exit code says everything a person needs to act on.
 */
export class GhCliTokenProvider implements TokenProvider {
  private readonly run: CommandRunner;

  constructor(run: CommandRunner = runCommand) {
    this.run = run;
  }

  async token(): Promise<string> {
    let output: string;
    try {
      output = this.run('gh', ['auth', 'token']);
    } catch (cause) {
      throw new TransientFailure(`\`gh auth token\` failed ${exitPhrase(cause)}`);
    }
    const token = output.trim();
    if (token === '') {
      throw new TransientFailure('`gh auth token` answered nothing');
    }
    return token;
  }

  invalidate(): void {
    // The command line tool holds the credential itself; the next run re-reads it.
  }
}

export type AppTokenDeps = {
  appId: string;
  privateKeyPath: string;
  installationId?: string | null;
  owner: string;
  ownerType: BoardOwnerType;
  fetchImpl?: FetchLike;
  clock?: Clock;
  apiBaseUrl?: string;
  userAgent?: string;
};

export type AppTokenBoard = {
  owner: string;
  ownerType: BoardOwnerType;
};

export type AppTokenFromEnvOptions = {
  /**
   * Whether the installation the environment names may be used. It names one
   * installation, which belongs to one account, so it is only right for a board
   * of that account; true by default.
   */
  pinnedInstallation?: boolean;
  fetchImpl?: FetchLike;
  clock?: Clock;
};

/**
 * An installation token, minted from the App's own key.
 *
 * It matters which allowance the board writes are billed to: an App has an
 * hourly allowance of its own, so a queue running on one leaves the person's
 * allowance alone for everything else. The assertion is signed here rather than
 * by a library — it is a header, a payload and one signature — and both calls go
 * to plain HTTP rather than through the shared transport, which cannot help: it
 * needs the very credential this produces.
 *
 * No message from here quotes the key or the token; each one names the step that
 * failed, which is what tells a person whether the App, the installation or the
 * network is at fault.
 */
export class AppTokenProvider implements TokenProvider {
  private readonly appId: string;
  private readonly privateKeyPath: string;
  private readonly installationId: string | null;
  private readonly owner: string;
  private readonly ownerType: BoardOwnerType;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(deps: AppTokenDeps) {
    this.appId = deps.appId;
    this.privateKeyPath = deps.privateKeyPath;
    this.installationId = deps.installationId ?? null;
    this.owner = deps.owner;
    this.ownerType = deps.ownerType;
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.clock = deps.clock ?? { now: () => new Date() };
    this.baseUrl = (deps.apiBaseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  }

  /**
   * Answers nothing when the deployment names no App — which is what lets the
   * chain fall through to the command line tool instead of failing.
   */
  static fromEnv(
    env: Record<string, string | undefined>,
    board: AppTokenBoard,
    options: AppTokenFromEnvOptions = {},
  ): AppTokenProvider | null {
    const appId = (env['GITHUB_APP_ID'] ?? '').trim();
    const privateKeyPath = keyPathIn(env);
    if (appId === '' || privateKeyPath === null) {
      return null;
    }
    const installationId = options.pinnedInstallation === false
      ? ''
      : (env['GITHUB_APP_INSTALLATION_ID'] ?? '').trim();
    return new AppTokenProvider({
      appId,
      privateKeyPath,
      installationId: installationId === '' ? null : installationId,
      owner: board.owner,
      ownerType: board.ownerType,
      fetchImpl: options.fetchImpl,
      clock: options.clock,
    });
  }

  async token(): Promise<string> {
    const assertion = this.signAssertion();
    const installationId = this.installationId ?? await this.lookUpInstallation(assertion);
    const step = 'minting an installation credential';
    const payload = await this.call('POST', `/app/installations/${installationId}/access_tokens`, assertion, step);
    return decodeWire(AccessTokenPayload, payload, step).token;
  }

  invalidate(): void {
    // Every call mints a fresh credential; the caching wrapper is what holds one.
  }

  /**
   * The login GitHub shows for what this App does — its slug and `[bot]` — read
   * from GitHub with an assertion only the App's key can sign. It names who holds
   * the key, which a configuration file cannot: a copied file says anything, a
   * copied file without the key answers nothing here.
   */
  async appLogin(): Promise<string> {
    const step = 'reading which App the key belongs to';
    const payload = await this.call('GET', '/app', this.signAssertion(), step);
    return `${decodeWire(AppPayload, payload, step).slug}[bot]`;
  }

  private signAssertion(): string {
    let pem: string;
    try {
      pem = readFileSync(this.privateKeyPath, 'utf8');
    } catch {
      throw new TransientFailure(`the file named by ${KEY_PATH_VAR} could not be read`);
    }
    const seconds = Math.floor(this.clock.now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iat: seconds - JWT_BACKDATE_SEC,
      exp: seconds + JWT_LIFETIME_SEC,
      iss: this.appId,
    }));
    const signingInput = `${header}.${claims}`;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      signer.end();
      return `${signingInput}.${signer.sign(pem).toString('base64url')}`;
    } catch {
      throw new TransientFailure(`the key in the file named by ${KEY_PATH_VAR} could not sign an assertion`);
    }
  }

  private async lookUpInstallation(assertion: string): Promise<string> {
    const step = `looking up the App installation on ${this.owner}`;
    const payload = await this.call('GET', INSTALLATION_PATH[this.ownerType](this.owner), assertion, step);
    return String(decodeWire(InstallationPayload, payload, step).id);
  }

  private async call(method: string, path: string, assertion: string, step: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${assertion}`,
          accept: 'application/vnd.github+json',
          'user-agent': this.userAgent,
        },
        signal: AbortSignal.timeout(APP_CALL_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new TransientFailure(`${step} could not be reached: ${sentenceOf(cause)}`);
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new TransientFailure(`${step} answered ${String(response.status)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TransientFailure(`${step} answered something that is not JSON`);
    }
  }
}

export type AccountCredentialsDeps = {
  env: Record<string, string | undefined>;
  /** Every configured board; the accounts behind them decide whether a pinned installation can apply. */
  boards: readonly AppTokenBoard[];
  logger: Logger;
  clock: Clock;
  /** The source tried once the App has refused or is not configured; one is made per account. */
  fallback?: () => TokenProvider;
  fetchImpl?: FetchLike;
};

/**
 * One credential per account that owns a configured board.
 *
 * An App is installed account by account, and an installation's credential reaches
 * only that account's boards and repositories, so a board is written with the
 * credential of the account that owns it. Two boards of one account share one
 * chain, and so one cached credential. The installation the environment may pin
 * belongs to a single account: it is used only when every configured board belongs
 * to one account, and otherwise each account looks its own installation up.
 *
 * Nothing is minted here; each chain mints when a call first needs it.
 */
export class AccountCredentials {
  readonly #deps: AccountCredentialsDeps;
  readonly #pinnedInstallation: boolean;
  readonly #chains = new Map<string, TokenProvider>();
  readonly #apps = new Map<string, TokenProvider | null>();

  constructor(deps: AccountCredentialsDeps) {
    this.#deps = deps;
    this.#pinnedInstallation = new Set(deps.boards.map((board) => board.owner.toLowerCase())).size <= 1;
  }

  /** The credential chain of the account that owns this board. */
  for(board: AppTokenBoard): TokenProvider {
    const account = board.owner.toLowerCase();
    const held = this.#chains.get(account);
    if (held !== undefined) {
      return held;
    }
    const chain = this.#chainFor(board);
    this.#chains.set(account, chain);
    return chain;
  }

  /**
   * The App's own credential for the account that owns this board, with nothing to
   * fall back to, or nothing when the deployment names no App. What is reached
   * through it is reached as the App or not at all: a call that would quietly go
   * out under a person's credential instead fails.
   */
  appFor(board: AppTokenBoard): TokenProvider | null {
    const account = board.owner.toLowerCase();
    if (this.#apps.has(account)) {
      return this.#apps.get(account) ?? null;
    }
    let app: AppTokenProvider | null;
    try {
      app = AppTokenProvider.fromEnv(this.#deps.env, board, {
        pinnedInstallation: this.#pinnedInstallation,
        fetchImpl: this.#deps.fetchImpl,
        clock: this.#deps.clock,
      });
    } catch (error) {
      this.#deps.logger.warn('the App named in the environment cannot be used', { reason: sentenceOf(error) });
      app = null;
    }
    const provider = app === null ? null : new CachingTokenProvider(app, this.#deps.clock);
    this.#apps.set(account, provider);
    return provider;
  }

  #chainFor(board: AppTokenBoard): TokenProvider {
    const { env, logger, clock } = this.#deps;
    const app = AppTokenProvider.fromEnv(env, board, {
      pinnedInstallation: this.#pinnedInstallation,
      fetchImpl: this.#deps.fetchImpl,
      clock,
    });
    const fallback = this.#deps.fallback?.() ?? new GhCliTokenProvider();
    const sources: TokenProvider[] = app === null ? [fallback] : [app, fallback];
    return new CachingTokenProvider(new FallbackTokenProvider(sources, logger), clock);
  }
}

/**
 * Holds a credential for as long as it is good for.
 *
 * Two callers asking at once share one minting: a process that starts several
 * calls at the same moment must not spend the App's allowance several times for
 * the same credential.
 */
export class CachingTokenProvider implements TokenProvider {
  private readonly inner: TokenProvider;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private held: { token: string; mintedAt: Date } | null = null;
  private pending: Promise<string> | null = null;

  constructor(inner: TokenProvider, clock: Clock, ttlSec: number = DEFAULT_CACHE_TTL_SEC) {
    this.inner = inner;
    this.clock = clock;
    this.ttlMs = ttlSec * 1000;
  }

  async token(): Promise<string> {
    const held = this.held;
    if (held !== null && this.clock.now().getTime() - held.mintedAt.getTime() < this.ttlMs) {
      return held.token;
    }
    const inFlight = this.pending;
    if (inFlight !== null) {
      return inFlight;
    }
    const mintedAt = this.clock.now();
    const attempt = this.inner.token()
      .then((token) => {
        this.held = { token, mintedAt };
        return token;
      })
      .finally(() => {
        if (this.pending === attempt) {
          this.pending = null;
        }
      });
    this.pending = attempt;
    return attempt;
  }

  invalidate(): void {
    this.held = null;
    this.pending = null;
    this.inner.invalidate();
  }
}

/**
 * The configured sources in order of preference; the first that answers wins.
 * When none does, the failure names every way that was tried, because "no
 * credential" is the one failure a person always has to fix by hand.
 */
export class FallbackTokenProvider implements TokenProvider {
  private readonly providers: readonly TokenProvider[];
  private readonly logger: Logger | null;
  private said = false;

  constructor(providers: readonly TokenProvider[], logger: Logger | null = null) {
    this.providers = [...providers];
    this.logger = logger;
  }

  async token(): Promise<string> {
    const refusals: string[] = [];
    for (const provider of this.providers) {
      try {
        const token = await provider.token();
        if (refusals.length > 0) {
          this.report(refusals);
        }
        return token;
      } catch (cause) {
        refusals.push(sentenceOf(cause));
      }
    }
    if (refusals.length === 0) {
      throw new TransientFailure('no credential source is configured');
    }
    throw new TransientFailure(`no credential could be obtained: ${refusals.join('; ')}`);
  }

  invalidate(): void {
    for (const provider of this.providers) {
      provider.invalidate();
    }
  }

  /**
   * Says once that the preferred source was passed over.
   *
   * Which source answered decides whose hourly allowance every call is billed to,
   * and the work goes on perfectly well either way — which is exactly why nobody
   * notices. Weeks of writes can land on the wrong allowance before anything
   * looks wrong, so the first time it happens it is written down.
   */
  private report(refusals: readonly string[]): void {
    if (this.said) {
      return;
    }
    this.said = true;
    this.logger?.warn('a credential source ahead of this one refused; the calls are billed elsewhere now', {
      passedOver: refusals.length,
      reason: refusals[0] ?? 'the reason was not stated',
    });
  }
}

/**
 * The file the App's key lives in, or nothing when this deployment names no App.
 *
 * The newer variable wins where both are set. The older one is accepted only
 * while it holds what it always should have held — a path — because a key passed
 * by value would be interpolated into the first error message that mentions it,
 * and from there into the log and the queue.
 */
function keyPathIn(env: Record<string, string | undefined>): string | null {
  const named = (env[KEY_PATH_VAR] ?? '').trim();
  if (named !== '') {
    return named;
  }
  const older = (env[KEY_VAR] ?? '').trim();
  if (older === '') {
    return null;
  }
  if (older.includes(PEM_OPENING)) {
    throw new RefusedByRule(
      `${KEY_VAR} holds the key itself rather than a path to it. Write the key to a file, `
      + `chmod 600 it, and name that file in ${KEY_PATH_VAR}.`,
    );
  }
  return older;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function exitPhrase(cause: unknown): string {
  const parsed = ExitStatus.safeParse(cause);
  return parsed.success ? `with exit code ${String(parsed.data.status)}` : 'and could not be run';
}

function sentenceOf(cause: unknown): string {
  if (cause instanceof BoardQueueError) {
    return redactSecrets(cause.describe());
  }
  if (cause instanceof Error) {
    return redactSecrets(cause.message);
  }
  return 'the reason was not stated';
}
