import path from 'node:path';
import { RefusedByRule } from '../domain/errors.ts';
import { SEARCH_PATH, render, templateNamed, write, writeLauncher } from './schedule-files.ts';
import type { Launcher, ScheduleOptions } from './schedule-files.ts';

/** The unit names the user's service manager knows the job by. */
export const SERVICE_UNIT = 'board-queue.service';
export const TIMER_UNIT = 'board-queue.timer';

export type SystemdInstallation = Launcher & {
  /** The one-shot service that runs a pass. */
  servicePath: string;
  /** The timer that starts the service on the interval. */
  timerPath: string;
};

export type SystemdOptions = ScheduleOptions & {
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
  const unitDir = path.join(options.configHome ?? path.join(options.home, '.config'), 'systemd', 'user');
  const installation: SystemdInstallation = {
    ...launcher,
    servicePath: path.join(unitDir, SERVICE_UNIT),
    timerPath: path.join(unitDir, TIMER_UNIT),
  };
  const service = render(templateNamed('board-queue.service.template'), {
    LAUNCHER: insideCommandQuotes(installation.launcherPath),
    WORKDIR: unitPath(installation.workDir),
    PATH: insideQuotes(SEARCH_PATH),
    LOG: unitPath(installation.logPath),
  });
  const timer = render(templateNamed('board-queue.timer.template'), {
    INTERVAL: unitText(String(installation.intervalSec)),
    SERVICE: unitText(SERVICE_UNIT),
  });
  write(installation.servicePath, service);
  write(installation.timerPath, timer);
  return installation;
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
export function enableCommands(): string[] {
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${TIMER_UNIT}`,
  ];
}
