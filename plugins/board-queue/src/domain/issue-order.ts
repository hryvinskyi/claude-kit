import type { Action, ActionState } from './action.ts';

/**
 * The states in which an action keeps every action filed after it on the same
 * issue from running.
 *
 * Queued and running are the plain cases: it has not happened yet. Failed and
 * blocked are the ones that matter: the action stopped and waits for a person,
 * and the work filed after it — the close that follows its evidence comment —
 * must wait with it, or the issue ends up in a state nobody filed. Such an issue
 * moves again when the action in front is retried (back to queued) or cancelled.
 *
 * Held is deliberately absent. A held action waits on something outside the
 * queue, often a deploy days away, and it was filed knowing that; it starts to
 * hold its issue once it is released and becomes queued. Done, skipped and
 * cancelled have ended and hold nothing.
 *
 * A queued action its filer deferred holds less than that until its date comes
 * (`IssueOrder`).
 */
export const ISSUE_HOLDING_STATES = ['queued', 'running', 'failed', 'blocked'] as const satisfies readonly ActionState[];

/**
 * The states of an action that may still write to its issue: those that hold it,
 * and held, which writes once it is released.
 *
 * A request folded into an older action runs at that action's place in the line,
 * so it is folded only into the last action on its issue in one of these states:
 * folding it past one would let that one's older values land after the request's.
 * That includes a held action: released before the next drain, it takes its place
 * in the line between the two requests it was filed between. Released later, it
 * writes after whatever ran meanwhile — which is what holding it means.
 */
export const STILL_TO_RUN_STATES = [...ISSUE_HOLDING_STATES, 'held'] as const satisfies readonly ActionState[];

/** The states that hold an issue until a person retries or cancels the action. */
const STOPPED_STATES: readonly ActionState[] = ['failed', 'blocked'];

/** The states an action waiting behind a stopped one can be in. */
const WAITING_STATES: readonly ActionState[] = ['queued', 'held'];

const HOLDING: readonly ActionState[] = ISSUE_HOLDING_STATES;

export function holdsItsIssue(state: ActionState): boolean {
  return HOLDING.includes(state);
}

/** What the order of an issue's actions reads of each one. */
export type OrderedAction = {
  readonly kind: string;
  readonly payload: unknown;
  readonly state: ActionState;
  readonly attempts: number;
  readonly notBefore: Date | null;
};

/** What the order of an issue's actions needs to know of a kind. */
export type OrderedKind = {
  readonly name: string;
  /** Whether its actions wait for deferred work filed before them, whatever that work writes. */
  readonly awaitsDeferredWork: boolean;
  /** What a payload of it writes; empty for nothing a later action could overwrite, null when it cannot tell. */
  writeTargets(payload: unknown): readonly string[] | null;
};

/**
 * Whether an action is waiting for a date its filer gave it: queued, never run,
 * and the date still to come. A wait after a failure is never this, because an
 * action waits after a failure only once a run has counted an attempt against it.
 */
export function isDeferred(action: OrderedAction, now: Date): boolean {
  return action.state === 'queued'
    && action.attempts === 0
    && action.notBefore !== null
    && action.notBefore.getTime() > now.getTime();
}

/** An action that waits for deferred work filed before it on its issue, and the moment it may run at the soonest. */
export type DeferredWait = {
  action: Action;
  /** The deferred actions in front of it, oldest first. */
  behind: readonly Action[];
  /** When the last of them comes due. */
  until: Date;
};

/**
 * The order the actions on one issue run in.
 *
 * Actions on one issue run in the order they were filed, so a comment lands
 * before the close that follows it: an action waits while an older one on its
 * issue is in a state that holds it (`ISSUE_HOLDING_STATES`). One kind of wait is
 * narrower. An action its filer deferred to a date holds back two sorts of later
 * action: those of a kind that awaits deferred work — a close, which must not end
 * an issue before what was filed in front of it has landed — and those that write
 * something the deferred action writes too — a board field, an assignee — which
 * would otherwise run first and be overwritten by the older value when its date
 * comes. Everything else filed after it runs in its own turn: the filer put the
 * deferred action off, not the issue. Once its date has come it holds its issue
 * like any queued action, and among the actions that are ready the order they
 * were filed in is kept. A kind this order was not told of is taken to await
 * deferred work and to write everything, so nothing overtakes on a guess.
 */
export class IssueOrder {
  readonly #kinds: ReadonlyMap<string, OrderedKind>;

  constructor(kinds: Iterable<OrderedKind>) {
    this.#kinds = new Map([...kinds].map((kind) => [kind.name, kind]));
  }

  /** Whether `earlier`, filed before `later` on the same issue, keeps `later` from running now. */
  holdsBack(earlier: OrderedAction, later: OrderedAction, now: Date): boolean {
    if (!holdsItsIssue(earlier.state)) {
      return false;
    }
    if (!isDeferred(earlier, now)) {
      return true;
    }
    const kind = this.#kinds.get(later.kind);
    return kind === undefined || kind.awaitsDeferredWork || this.#overwrites(earlier, later);
  }

  /**
   * The queued actions that wait for deferred work in front of them, given actions
   * in the order they were filed: each with the deferred actions it waits for and
   * the date the last of them comes due, before which it cannot run whatever else
   * stands in front of it.
   */
  deferredWaits(actionsInFilingOrder: readonly Action[], now: Date): DeferredWait[] {
    const waits: DeferredWait[] = [];
    const lanes = new Map<string, Action[]>();
    for (const action of actionsInFilingOrder) {
      const lane = laneOf(action);
      const earlier = lanes.get(lane) ?? [];
      if (action.state === 'queued') {
        const behind = earlier.filter((one) => isDeferred(one, now) && this.holdsBack(one, action, now));
        const until = latestDate(behind);
        if (until !== null) {
          waits.push({ action, behind, until });
        }
      }
      earlier.push(action);
      lanes.set(lane, earlier);
    }
    return waits;
  }

  /** Whether the deferred action, landing later, would write over something the later one writes. */
  #overwrites(deferred: OrderedAction, later: OrderedAction): boolean {
    const written = this.#targetsOf(deferred);
    if (written !== null && written.length === 0) {
      return false;
    }
    const writing = this.#targetsOf(later);
    if (written === null || writing === null) {
      return true;
    }
    return writing.some((target) => written.includes(target));
  }

  #targetsOf(action: OrderedAction): readonly string[] | null {
    const kind = this.#kinds.get(action.kind);
    return kind === undefined ? null : kind.writeTargets(action.payload);
  }
}

function latestDate(actions: readonly Action[]): Date | null {
  let latest: Date | null = null;
  for (const action of actions) {
    const date = action.notBefore;
    if (date !== null && (latest === null || date.getTime() > latest.getTime())) {
      latest = date;
    }
  }
  return latest;
}

/** An action waiting its turn, and every stopped action filed before it on its issue, oldest first. */
export type WaitingAction = {
  action: Action;
  inFront: readonly Action[];
};

/**
 * One issue whose actions stopped moving: every stopped action with work filed
 * after it, oldest first, and that work. The oldest is the front.
 */
export type StoppedIssue = {
  front: Action;
  stopped: readonly Action[];
  waiting: readonly WaitingAction[];
};

/**
 * The issues held up by failed or blocked actions, given actions in the order
 * they were filed.
 *
 * A queued or held action waits behind every stopped action filed before it on
 * its issue, because each of them holds the issue on its own: retrying the
 * nearer one runs nothing while an older one still stands in front of it. Every
 * one of them has to be retried or cancelled, the oldest first, before the work
 * behind them runs. The front of an issue is its oldest stopped action; a stopped
 * action filed after the last waiting one holds nothing up and is not counted.
 * An issue whose stopped actions have nothing behind them is not listed. Actions
 * that name no issue form one line of their own, as they do when the queue
 * orders them.
 */
export function stoppedIssues(actionsInFilingOrder: readonly Action[]): StoppedIssue[] {
  const lanes = new Map<string, { stopped: Action[]; waiting: WaitingAction[] }>();
  for (const action of actionsInFilingOrder) {
    const lane = laneOf(action);
    const issue = lanes.get(lane);
    if (STOPPED_STATES.includes(action.state)) {
      if (issue === undefined) {
        lanes.set(lane, { stopped: [action], waiting: [] });
      } else {
        issue.stopped.push(action);
      }
    } else if (WAITING_STATES.includes(action.state)) {
      issue?.waiting.push({ action, inFront: [...issue.stopped] });
    }
  }
  const stoppedIssues: StoppedIssue[] = [];
  for (const { waiting } of lanes.values()) {
    const last = waiting.at(-1);
    const front = last?.inFront[0];
    if (last !== undefined && front !== undefined) {
      stoppedIssues.push({ front, stopped: last.inFront, waiting });
    }
  }
  return stoppedIssues;
}

function laneOf(action: Action): string {
  return action.issueRef === null ? '' : action.issueRef.key();
}
