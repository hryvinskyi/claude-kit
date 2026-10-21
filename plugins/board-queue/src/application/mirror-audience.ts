import { stillStands } from '../domain/sync/claim-moves.ts';
import type { IssueMove, LiveState } from '../domain/sync/claim-moves.ts';
import type { MirrorScope } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { LocalIdentity, WorkMember } from './sync-ports.ts';

/**
 * Whose a move is, as this worker sees it: its own person's; nobody's — no person's
 * worker can file it, so the owner's worker does; or somebody else's, whose own
 * worker files it.
 */
export type Share = 'mine' | 'orphan' | 'others';

/** Each item's live claim, read from the server at most once per run and only when a move needs it. */
export interface LiveClaims {
  of(item: number): Promise<LiveState>;
}

/** Whose moves one run of the mirror files. */
export type Audience = {
  /** The member whose moves this worker files; null when it files everybody's. */
  readonly filedFor: string | null;
  /** Whose a move is whose last event this member caused. */
  shareOf(actor: string | null): Share;
  /** Whether a move this worker would file still stands on the server, so filing it moves nothing back. */
  stillStands(move: IssueMove, live: LiveClaims): Promise<boolean>;
};

/** Why a mirror of one's own moves files nothing this run. */
export type AudienceRefusal = 'login-unreadable' | 'no-member' | 'ambiguous';

export type AudienceAnswer =
  | {
    readonly ok: true;
    readonly audience: Audience;
    /** Something wrong with the configuration that this run worked around, to be said at every run. */
    readonly warning: string | null;
  }
  /** The mirror files nothing this run, for this reason. */
  | { readonly ok: false; readonly reason: string; readonly refusal: AudienceRefusal };

/** The project's members, as the audience is found among them. */
export interface MemberDirectory {
  members(): Promise<readonly WorkMember[]>;
}

/** Who the mirror of this worker files for, decided once per run. */
export interface MirrorAudience {
  resolve(members: MemberDirectory): Promise<AudienceAnswer>;
}

const EVERYONE: Audience = {
  filedFor: null,
  shareOf: () => 'mine',
  // One worker files every move in the order of the log, so no move of its own
  // can come after another's.
  stillStands: () => Promise.resolve(true),
};

/** Every move, whoever caused it: the mirror of the one worker that keeps the boards in step for the team. */
export const everyone: MirrorAudience = {
  resolve: () => Promise.resolve({ ok: true, audience: EVERYONE, warning: null }),
};

const sameLogin = (one: string, other: string): boolean => one.trim().toLowerCase() === other.trim().toLowerCase();

/**
 * Only the moves of the person this worker runs as: the member of the project
 * whose GitHub login is the one this machine is signed in as. Every person's
 * worker runs such a mirror, so each move is filed once, by its author's worker,
 * under its author's login. The owner's worker also files the moves no person's
 * worker can: those whose author the log does not name, or who is no member with a
 * GitHub login — a member removed since, or one who never named a login.
 *
 * Workers drain on their own schedules, so a move is filed only while the server
 * still shows the state it left: an old page read late never undoes what another
 * worker filed since.
 *
 * A login that cannot be read, that no member names, or that two members name,
 * files nothing, and says why.
 */
export class OwnMoves implements MirrorAudience {
  readonly #identity: LocalIdentity;
  readonly #mirrorOwner: string;

  constructor(identity: LocalIdentity, mirrorOwner: string) {
    this.#identity = identity;
    this.#mirrorOwner = mirrorOwner;
  }

  async resolve(directory: MemberDirectory): Promise<AudienceAnswer> {
    let login: string | null;
    try {
      login = await this.#identity.login();
    } catch (error) {
      return {
        ok: false,
        refusal: 'login-unreadable',
        reason: `this worker's GitHub login could not be read: ${describeUnknown(error)}`,
      };
    }
    const signedIn = (login ?? '').trim();
    if (signedIn === '') {
      return {
        ok: false,
        refusal: 'login-unreadable',
        reason: 'this worker\'s GitHub login could not be read, so whose moves are this person\'s is not known; '
          + 'sign the GitHub command line tool in',
      };
    }
    const members = await directory.members();
    const handles = members.filter((member) => member.login !== null && sameLogin(member.login, signedIn))
      .map((member) => member.handle);
    const [handle, ...others] = handles;
    if (handle === undefined) {
      return {
        ok: false,
        refusal: 'no-member',
        reason: `this worker runs as ${signedIn}, and no member of the project names that GitHub login; `
          + 'the mirror files nothing here until an admin sets it as the member\'s external login',
      };
    }
    if (others.length > 0) {
      return {
        ok: false,
        refusal: 'ambiguous',
        reason: `${handles.join(', ')} all name ${signedIn} as their GitHub login, so whose moves are this `
          + 'worker\'s is not known; an admin keeps one of them',
      };
    }
    const isOwner = sameLogin(signedIn, this.#mirrorOwner);
    const withLogin = new Set(members.filter((member) => member.login !== null).map((member) => member.handle));
    const ownerIsAMember = members
      .some((member) => member.login !== null && sameLogin(member.login, this.#mirrorOwner));
    return {
      ok: true,
      audience: {
        filedFor: handle,
        shareOf: (actor) => {
          if (actor === handle) {
            return 'mine';
          }
          return isOwner && (actor === null || !withLogin.has(actor)) ? 'orphan' : 'others';
        },
        stillStands: async (move, live) => stillStands(move, await live.of(move.item)),
      },
      warning: isOwner || ownerIsAMember
        ? null
        : `no member of the project names ${this.#mirrorOwner}, the configured owner, as their GitHub login, so `
          + 'the moves no person\'s worker files — of removed members and of members without a GitHub login — '
          + 'are filed by nobody; check mirrorOwner',
    };
  }
}

/** The audience each scope stands for. */
export const MIRROR_AUDIENCES: {
  readonly [K in MirrorScope]: (identity: LocalIdentity, mirrorOwner: string) => MirrorAudience;
} = {
  all: () => everyone,
  own: (identity, mirrorOwner) => new OwnMoves(identity, mirrorOwner),
};
