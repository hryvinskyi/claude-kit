import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';
import type { CarriedVariable } from './schedule-environment.ts';
import { earlierJob, jobEnvironment, render, shellWord, templateNamed, write, writeLauncher } from './schedule-files.ts';
import type { JobOptions, Launcher } from './schedule-files.ts';

/** What the units of an install at the default places are called, before the suffix that says which unit. */
const UNIT_STEM = 'board-queue';

/** What the user's service manager knows an install's units by, and where they are. */
export type SystemdUnitNames = {
  /** The name the user's service manager knows the one-shot service by. */
  readonly serviceUnit: string;
  /** The name it knows the timer by, and the name every command below names. */
  readonly timerUnit: string;
  /** The one-shot service that runs a pass. */
  readonly servicePath: string;
  /** The timer that starts the service on the interval. */
  readonly timerPath: string;
};

export type SystemdInstallation = Launcher & SystemdUnitNames & {
  /** A timer under the default name these units stand beside, for a person to look at; null when there is none. */
  earlierJobPath: string | null;
};

/**
 * The names of an install's units — the default stem, or the default stem with
 * the install's own name after it — under the user's unit directory of
 * `configHome` (`$XDG_CONFIG_HOME` when absolute), or of `~/.config`.
 */
export function systemdUnitNames(home: string, configHome: string | null, instance: string | null): SystemdUnitNames {
  const unitDir = path.join(configHome ?? path.join(home, '.config'), 'systemd', 'user');
  const stem = instance === null ? UNIT_STEM : `${UNIT_STEM}-${instance}`;
  return {
    serviceUnit: `${stem}.service`,
    timerUnit: `${stem}.timer`,
    servicePath: path.join(unitDir, `${stem}.service`),
    timerPath: path.join(unitDir, `${stem}.timer`),
  };
}

export type SystemdOptions = JobOptions & {
  /** `$XDG_CONFIG_HOME`, when the environment names an absolute one. */
  configHome: string | null;
};

/**
 * Writes the Linux user units — a one-shot service and the timer that starts
 * it — and the launcher the service runs, and answers what went where.
 *
 * As with the macOS job, nothing is enabled here: the person runs the commands
 * this prints, which are also the ones that show or stop the job later.
 */
export function installSystemdUnits(options: SystemdOptions): SystemdInstallation {
  const launcher = writeLauncher(options);
  const installation: SystemdInstallation = {
    ...launcher,
    ...systemdUnitNames(options.home, options.configHome, options.instance),
    earlierJobPath: earlierJob(options.instance, systemdUnitNames(options.home, options.configHome, null).timerPath),
  };
  const service = render(templateNamed('board-queue.service.template'), {
    LAUNCHER: insideCommandQuotes(installation.launcherPath),
    WORKDIR: unitPath(installation.workDir),
    ENVIRONMENT: unitEnvironment(jobEnvironment(options)),
    LOG: unitPath(installation.logPath),
  });
  const timer = render(templateNamed('board-queue.timer.template'), {
    INTERVAL: unitText(String(installation.intervalSec)),
    SERVICE: unitText(installation.serviceUnit),
  });
  write(installation.servicePath, service);
  write(installation.timerPath, timer);
  return installation;
}

/** The value of `Environment=`: one double-quoted `NAME=value` word per variable. */
function unitEnvironment(variables: readonly CarriedVariable[]): string {
  return variables.map(([name, value]) => `"${insideQuotes(`${name}=${value}`)}"`).join(' ');
}

/**
 * A value as unit-file text. systemd reads `%` as the start of a specifier in
 * every setting, so a percent sign is doubled; a control character would end
 * the line or corrupt it, and has no escape, so the unit is refused instead.
 */
function unitText(value: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new RefusedByRule(
      `a systemd unit cannot hold ${JSON.stringify(value)}: a unit file has no way to write a control `
      + 'character; choose a state directory and home without one',
    );
  }
  return value.replaceAll('%', '%%');
}

/**
 * A path as the whole value of a setting that takes one path and no quotes
 * (`WorkingDirectory=`, `StandardOutput=append:`). Such a value runs to the end
 * of the line, so spaces and quotes stand for themselves; what does not survive
 * is whitespace at either end, which systemd strips, and a backslash at the end,
 * which joins the next line on.
 */
function unitPath(value: string): string {
  if (value.trim() !== value || value.endsWith('\\')) {
    throw new RefusedByRule(
      `a systemd unit cannot hold the path ${JSON.stringify(value)}: it begins or ends with a character `
      + 'a unit file setting loses; choose a state directory and home without one',
    );
  }
  return unitText(value);
}

/**
 * A value as the inside of a double-quoted word of a setting that splits its
 * value into words (`Environment=`), where a backslash escapes the next
 * character.
 */
function insideQuotes(value: string): string {
  return unitText(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * A value as the inside of a double-quoted word of `ExecStart=`, which also
 * substitutes `$NAME` from the environment when it starts the job; `$$` is a
 * dollar sign.
 */
function insideCommandQuotes(value: string): string {
  return insideQuotes(value).replaceAll('$', () => '$$');
}

/** The commands that make the service manager read the units and start the timer. */
export function enableCommands(installation: SystemdUnitNames): string[] {
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${installation.timerUnit}`,
  ];
}

/**
 * The commands that make a timer enabled already run from units that changed:
 * the service manager reads them again, and the timer restarts with them.
 */
export function reloadCommands(installation: SystemdUnitNames): string[] {
  return [
    'systemctl --user daemon-reload',
    `systemctl --user restart ${installation.timerUnit}`,
  ];
}

/**
 * The commands that stop the timer and remove both units, in the order they are
 * run. They name this install's units, so another install's stay.
 */
export function removeCommands(installation: SystemdUnitNames): string[] {
  return [
    `systemctl --user disable --now ${installation.timerUnit}`,
    `rm ${shellWord(installation.servicePath)} ${shellWord(installation.timerPath)}`,
    'systemctl --user daemon-reload',
  ];
}
