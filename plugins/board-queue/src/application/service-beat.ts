import { DECLINES, declineOfExitCode } from './service-duty.ts';

/**
 * How one pass of the service ended, as the schedule saw it.
 *
 * `finished` is a pass that ran to its end and answered an exit code; `killed` one
 * that something outside the service ended; `abandoned` one the service itself
 * gave up on — its deadline passed, or the service was told to stop and the pass
 * outlived the grace it was given; `stuck` one that was killed and still did not
 * end, which only a fresh start of the service clears; `unstarted` one that could
 * not be started at all.
 */
export type PassOutcome =
  | { readonly kind: 'finished'; readonly exitCode: number }
  | { readonly kind: 'killed'; readonly signal: string }
  | { readonly kind: 'abandoned'; readonly reason: string }
  | { readonly kind: 'stuck'; readonly reason: string }
  | { readonly kind: 'unstarted'; readonly reason: string };

/** `declined`: the pass ran and declined the service's job; the detail says which way. */
export const BEAT_OUTCOMES = ['ok', 'failed', 'declined', 'abandoned'] as const;
export type BeatOutcome = (typeof BEAT_OUTCOMES)[number];

/**
 * What the service writes down about itself after every pass, for whoever asks
 * whether it is alive: the container's health check, a person on the host. It
 * carries the schedule it runs to, so the question can be answered without
 * knowing how the service was started. Moments are ISO-8601 strings.
 */
export type ServiceBeat = {
  pid: number;
  startedAt: string;
  intervalMs: number;
  passDeadlineMs: number;
  passes: number;
  passStartedAt: string | null;
  passEndedAt: string | null;
  outcome: BeatOutcome | null;
  detail: string | null;
  consecutiveFailures: number;
  stoppedAt: string | null;
};

/** Each way a pass can end, as the beat records it. */
const RECORDED: {
  [K in PassOutcome['kind']]: (outcome: Extract<PassOutcome, { kind: K }>) => {
    outcome: BeatOutcome;
    detail: string | null;
  };
} = {
  finished: (outcome) => {
    if (outcome.exitCode === 0) {
      return { outcome: 'ok', detail: null };
    }
    const decline = declineOfExitCode(outcome.exitCode);
    return decline === null
      ? { outcome: 'failed', detail: `the pass exited ${String(outcome.exitCode)}` }
      : { outcome: 'declined', detail: DECLINES[decline].says };
  },
  killed: (outcome) => ({ outcome: 'failed', detail: `the pass was ended by ${outcome.signal}` }),
  abandoned: (outcome) => ({ outcome: 'abandoned', detail: outcome.reason }),
  stuck: (outcome) => ({ outcome: 'abandoned', detail: outcome.reason }),
  unstarted: (outcome) => ({ outcome: 'failed', detail: `the pass could not be started: ${outcome.reason}` }),
};

function recorded<K extends PassOutcome['kind']>(outcome: Extract<PassOutcome, { kind: K }>): {
  outcome: BeatOutcome;
  detail: string | null;
} {
  const record: (one: Extract<PassOutcome, { kind: K }>) => { outcome: BeatOutcome; detail: string | null } =
    RECORDED[outcome.kind];
  return record(outcome);
}

/** The beat of a service that has just started and run nothing yet. */
export function firstBeat(input: {
  pid: number;
  at: Date;
  intervalMs: number;
  passDeadlineMs: number;
}): ServiceBeat {
  return {
    pid: input.pid,
    startedAt: input.at.toISOString(),
    intervalMs: input.intervalMs,
    passDeadlineMs: input.passDeadlineMs,
    passes: 0,
    passStartedAt: null,
    passEndedAt: null,
    outcome: null,
    detail: null,
    consecutiveFailures: 0,
    stoppedAt: null,
  };
}

export function passStarted(beat: ServiceBeat, at: Date): ServiceBeat {
  return { ...beat, passStartedAt: at.toISOString() };
}

/**
 * A pass that ended. A pass abandoned because the service was told to stop is
 * nobody's failure; one abandoned at its deadline, like one that failed, counts
 * toward the run of failures the health check reads.
 */
export function passEnded(beat: ServiceBeat, outcome: PassOutcome, at: Date, stopping: boolean): ServiceBeat {
  const { outcome: kind, detail } = recorded(outcome);
  const counts = kind === 'failed' || kind === 'declined' || (kind === 'abandoned' && !stopping);
  return {
    ...beat,
    passes: beat.passes + 1,
    passEndedAt: at.toISOString(),
    outcome: kind,
    detail,
    consecutiveFailures: kind === 'ok' ? 0 : beat.consecutiveFailures + (counts ? 1 : 0),
  };
}

export function stopped(beat: ServiceBeat, at: Date): ServiceBeat {
  return { ...beat, stoppedAt: at.toISOString() };
}

export type HealthPolicy = {
  /** This many failed passes in a row make the service unhealthy. */
  maxConsecutiveFailures: number;
  /** Slack beyond the longest a pass may take and the gap to the next one. */
  slackMs: number;
};

export const DEFAULT_HEALTH_POLICY: HealthPolicy = { maxConsecutiveFailures: 3, slackMs: 60_000 };

export type HealthVerdict = { readonly healthy: boolean; readonly reason: string };

/**
 * Whether the service that wrote this beat is doing its job.
 *
 * It is alive while something happened within one gap and one longest pass: the
 * service gives a pass up at its deadline, so a beat older than that is a service
 * that stopped scheduling. A service whose passes keep failing is running but
 * doing nothing, which is unhealthy too, and one whose last pass declined the
 * service's job — not the configured owner, no readable identity, credentials
 * refused — is unhealthy at once: every pass after it will decline the same way.
 */
export function healthOf(beat: ServiceBeat | null, now: Date, policy: HealthPolicy = DEFAULT_HEALTH_POLICY): HealthVerdict {
  if (beat === null) {
    return { healthy: false, reason: 'the service has written no heartbeat' };
  }
  if (beat.stoppedAt !== null) {
    return { healthy: false, reason: `the service stopped at ${beat.stoppedAt}` };
  }
  const lastSign = latest([beat.startedAt, beat.passStartedAt, beat.passEndedAt]);
  const silentMs = now.getTime() - lastSign.getTime();
  const limitMs = beat.intervalMs + beat.passDeadlineMs + policy.slackMs;
  if (silentMs > limitMs) {
    return {
      healthy: false,
      reason: `nothing has happened since ${lastSign.toISOString()}, longer than a pass and the gap after it`,
    };
  }
  if (beat.outcome === 'declined') {
    return { healthy: false, reason: `the last pass declined the service's job: ${beat.detail ?? 'no reason given'}` };
  }
  if (beat.consecutiveFailures >= policy.maxConsecutiveFailures) {
    return {
      healthy: false,
      reason: `the last ${String(beat.consecutiveFailures)} passes failed; the last: ${beat.detail ?? 'no reason given'}`,
    };
  }
  if (beat.passEndedAt === null) {
    return { healthy: true, reason: `started at ${beat.startedAt}; the first pass has not ended yet` };
  }
  return {
    healthy: true,
    reason: `${String(beat.passes)} passes; the last ended ${beat.outcome ?? 'somehow'} at ${beat.passEndedAt}`,
  };
}

function latest(moments: readonly (string | null)[]): Date {
  let found = new Date(0);
  for (const moment of moments) {
    if (moment !== null && new Date(moment).getTime() > found.getTime()) {
      found = new Date(moment);
    }
  }
  return found;
}
