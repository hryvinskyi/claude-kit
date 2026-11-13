import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { installSchedule, loadCommands, reloadCommands, removeCommands } from '../../src/delivery/launchd-install.ts';
import { SEARCH_PATH, jobEnvironment, writeLauncher } from '../../src/delivery/schedule-files.ts';
import type { JobOptions } from '../../src/delivery/schedule-files.ts';
import {
  enableCommands,
  installSystemdUnits,
  reloadCommands as reloadUnitCommands,
  removeCommands as removeUnitCommands,
} from '../../src/delivery/systemd-install.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';

/**
 * A directory name that every one of the three formats has to carry as it is: a
 * space, both quotes, an ampersand and angle brackets, a variable, two command
 * substitutions, a percent sign and a backslash. A path that loses or runs any of
 * it reaches the wrong file, or runs `touch` in the job's directory.
 */
const HOSTILE = 'it\'s "q" & <x> $HOME $(touch pwned) `touch pwned` 50% \\x';

type Sandbox = {
  directory: string;
  /** The hostile directory every path lives under. */
  root: string;
  options: JobOptions;
  /** Where the stand-in command writes what it was started with. */
  record: string;
};

/**
 * Every path of a schedule under the hostile directory: the home, the state
 * directory, the Node binary and the installed command, which records its
 * arguments and the two variables the launcher hands it.
 */
async function sandbox(body: (space: Sandbox) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-schedule-'));
  try {
    const root = join(directory, HOSTILE);
    const home = join(root, 'home');
    const commandPath = join(home, '.local', 'bin', 'board-queue');
    const nodePath = join(root, 'node bin', 'node');
    executable(nodePath, ['#!/bin/sh', 'exit 0']);
    executable(commandPath, [
      '#!/bin/sh',
      'for arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$0.argv"',
      'printf \'scheduled=%s\\nnode=%s\\n\' "$BOARD_QUEUE_SCHEDULED" "$BOARD_QUEUE_NODE" >> "$0.argv"',
      'printf \'config=%s\\nxdg=%s\\n\' "$BOARD_QUEUE_CONFIG" "$XDG_CONFIG_HOME" >> "$0.argv"',
    ]);
    const options: JobOptions = {
      home,
      nodePath,
      stateDir: join(root, 'state'),
      commandPath,
      environment: [],
      searchPath: [],
      instance: null,
    };
    await body({ directory, root, options, record: `${commandPath}.argv` });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function executable(file: string, lines: readonly string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...lines, ''].join('\n'), 'utf8');
  chmodSync(file, 0o755);
}

/**
 * Runs a job's command line the way its scheduler would: a scheduler's bare
 * environment, plus what the job description itself sets.
 */
function runJob(space: Sandbox, argv: readonly string[], jobEnvironment: Readonly<Record<string, string>> = {}): void {
  const [program, ...args] = argv;
  assert.ok(program !== undefined, 'the job names no program');
  const ran = spawnSync(program, args, {
    cwd: space.directory,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: space.options.home, ...jobEnvironment },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readFileSync(space.record, 'utf8').split('\n'), [
    'tick',
    'scheduled=1',
    `node=${space.options.nodePath}`,
    `config=${jobEnvironment['BOARD_QUEUE_CONFIG'] ?? ''}`,
    `xdg=${jobEnvironment['XDG_CONFIG_HOME'] ?? ''}`,
    '',
  ]);
  assert.equal(existsSync(join(space.directory, 'pwned')), false, 'a path was run as a command');
}

function hasCommand(name: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).status === 0;
}

/** `Key=value` lines of a unit file, by key; a key set twice is a test failure. */
function unitSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (line.startsWith('[') || line.startsWith('#') || at < 0) {
      continue;
    }
    const key = line.slice(0, at);
    assert.equal(settings.has(key), false, `${key} is set twice`);
    settings.set(key, line.slice(at + 1));
  }
  return settings;
}

function setting(settings: Map<string, string>, key: string): string {
  const value = settings.get(key);
  assert.ok(value !== undefined, `the unit sets no ${key}`);
  return value;
}

/** What systemd makes of `%` when it loads a unit: `%%` is a percent sign, anything else a specifier. */
function withoutSpecifiers(value: string): string {
  return value.replace(/%(.?)/gs, (_whole: string, next: string) => {
    assert.equal(next, '%', `systemd would expand the specifier %${next} in ${value}`);
    return '%';
  });
}

const UNIT_ESCAPES = new Map([['\\', '\\'], ['"', '"'], ['\'', '\'']]);

/** The words systemd splits a command line or an Environment= value into, quotes and escapes resolved. */
function unitWords(value: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote = '';
  for (let at = 0; at < value.length; at += 1) {
    const char = value.charAt(at);
    if (char === '\\') {
      at += 1;
      const escaped = UNIT_ESCAPES.get(value.charAt(at));
      assert.ok(escaped !== undefined, `an escape this test does not know in ${value}`);
      word = (word ?? '') + escaped;
    } else if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else {
        word = (word ?? '') + char;
      }
    } else if (char === '"' || char === '\'') {
      quote = char;
      word = word ?? '';
    } else if (char === ' ') {
      if (word !== null) {
        words.push(word);
      }
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  assert.equal(quote, '', `an unclosed quote in ${value}`);
  if (word !== null) {
    words.push(word);
  }
  return words;
}

/** What systemd makes of `$` in an ExecStart= word when it starts the job: `$$` is a dollar sign. */
function withoutVariables(word: string): string {
  return word.replace(/\$(\$|\{?[A-Za-z_])/g, (_whole: string, next: string) => {
    assert.equal(next, '$', `systemd would substitute a variable in ${word}`);
    return '$';
  });
}

describe('schedule files of a home whose path holds every character a format reads', () => {
  it('writes a launcher that the shell reads and that runs the command with the Node it names', async () => {
    await sandbox((space) => {
      const launcher = writeLauncher(space.options);

      const parsed = spawnSync('/bin/sh', ['-n', launcher.launcherPath], { encoding: 'utf8' });

      assert.equal(parsed.status, 0, parsed.stderr);
      runJob(space, ['/bin/sh', launcher.launcherPath]);
    });
  });

  it('writes a macOS job description that is valid and reads back every path as it was given',
    { skip: hasCommand('plutil') ? false : 'plutil is a macOS command' }, async () => {
      await sandbox((space) => {
        const installation = installSchedule(space.options);

        const lint = spawnSync('plutil', ['-lint', installation.plistPath], { encoding: 'utf8' });
        const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', installation.plistPath], { encoding: 'utf8' });

        assert.equal(lint.status, 0, lint.stdout + lint.stderr);
        assert.equal(json.status, 0, json.stderr);
        const job: unknown = JSON.parse(json.stdout);
        assert.deepEqual(job, {
          Label: 'com.user.board-queue',
          ProgramArguments: ['/bin/sh', installation.launcherPath],
          StartInterval: 300,
          RunAtLoad: true,
          StandardOutPath: installation.logPath,
          StandardErrorPath: installation.logPath,
          WorkingDirectory: space.options.stateDir,
          EnvironmentVariables: { PATH: SEARCH_PATH },
        });
        runJob(space, ['/bin/sh', installation.launcherPath]);
      });
    });

  it('writes a Linux service whose settings systemd reads back as the paths they were given', async () => {
    await sandbox((space) => {
      const installation = installSystemdUnits({ ...space.options, configHome: null });
      const settings = unitSettings(readFileSync(installation.servicePath, 'utf8'));

      const command = unitWords(withoutSpecifiers(setting(settings, 'ExecStart'))).map(withoutVariables);

      assert.deepEqual(command, ['/bin/sh', installation.launcherPath]);
      assert.equal(withoutSpecifiers(setting(settings, 'WorkingDirectory')), space.options.stateDir);
      assert.equal(withoutSpecifiers(setting(settings, 'StandardOutput')), `append:${installation.logPath}`);
      assert.equal(withoutSpecifiers(setting(settings, 'StandardError')), `append:${installation.logPath}`);
      assert.deepEqual(unitWords(withoutSpecifiers(setting(settings, 'Environment'))), [`PATH=${SEARCH_PATH}`]);
      runJob(space, command);
    });
  });

  it('refuses a Linux unit for a path that a unit file has no way to write', async () => {
    await sandbox((space) => {
      const options = { ...space.options, stateDir: join(space.options.stateDir, 'two\nlines'), configHome: null };

      assert.throws(() => installSystemdUnits(options), RefusedByRule);
      assert.equal(existsSync(join(options.home, '.config', 'systemd', 'user', 'board-queue.service')), false);
    });
  });

  it('refuses a macOS job description for a path that XML has no way to write', async () => {
    await sandbox((space) => {
      const options = { ...space.options, stateDir: join(space.options.stateDir, 'bell\u0007') };

      assert.throws(() => installSchedule(options), RefusedByRule);
      assert.equal(existsSync(join(options.home, 'Library', 'LaunchAgents', 'com.user.board-queue.plist')), false);
    });
  });
});

/** What the install found: a configuration and a configuration home under the hostile directory. */
function carried(space: Sandbox): JobOptions['environment'] {
  return [
    ['BOARD_QUEUE_CONFIG', join(space.root, 'boards', 'config.json')],
    ['XDG_CONFIG_HOME', join(space.root, 'xdg')],
  ];
}

function plistOf(file: string): unknown {
  const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed: unknown = JSON.parse(json.stdout);
  return parsed;
}

const MACOS = { skip: hasCommand('plutil') ? false : 'plutil is a macOS command' };

describe('the environment an install hands to the pass its job starts', () => {
  it('reaches the pass the macOS job starts, every character as it was', MACOS, async () => {
    await sandbox((space) => {
      const environment = carried(space);
      const installation = installSchedule({ ...space.options, environment });

      const job = z.object({ EnvironmentVariables: z.record(z.string(), z.string()) }).parse(plistOf(installation.plistPath));

      assert.deepEqual(job.EnvironmentVariables, { PATH: SEARCH_PATH, ...Object.fromEntries(environment) });
      runJob(space, ['/bin/sh', installation.launcherPath], job.EnvironmentVariables);
    });
  });

  it('reaches the pass the Linux service starts, every character as it was', async () => {
    await sandbox((space) => {
      const environment = carried(space);
      const installation = installSystemdUnits({ ...space.options, environment, configHome: null });
      const settings = unitSettings(readFileSync(installation.servicePath, 'utf8'));

      const words = unitWords(withoutSpecifiers(setting(settings, 'Environment')));
      const command = unitWords(withoutSpecifiers(setting(settings, 'ExecStart'))).map(withoutVariables);

      assert.deepEqual(words, [`PATH=${SEARCH_PATH}`, ...environment.map(([name, value]) => `${name}=${value}`)]);
      const jobEnvironment = Object.fromEntries(words.map((word) => {
        const at = word.indexOf('=');
        return [word.slice(0, at), word.slice(at + 1)];
      }));
      runJob(space, command, jobEnvironment);
    });
  });
});

describe('scheduled jobs of two installs on one machine', () => {
  it('gives an install at another location a macOS job of its own, beside the default one', async () => {
    await sandbox((space) => {
      const first = installSchedule(space.options);
      const before = readFileSync(first.plistPath, 'utf8');

      const second = installSchedule({ ...space.options, instance: '0123456789ab' });

      assert.equal(first.label, 'com.user.board-queue');
      assert.equal(second.label, 'com.user.board-queue.0123456789ab');
      assert.equal(second.plistPath, join(space.options.home, 'Library', 'LaunchAgents', `${second.label}.plist`));
      assert.equal(readFileSync(first.plistPath, 'utf8'), before, 'the second install left the first job alone');
      assert.ok(existsSync(second.plistPath));
      assert.ok([...loadCommands(second), ...reloadCommands(second), ...removeCommands(second)]
        .every((line) => !line.endsWith('/com.user.board-queue')));
      assert.ok(reloadCommands(second).some((line) => line.endsWith(`/${second.label}`)));
      assert.ok(removeCommands(second).some((line) => line.endsWith(`/${second.label}`)));
    });
  });

  it('names its macOS job the same every time it runs, so installing again replaces it', MACOS, async () => {
    await sandbox((space) => {
      const options = { ...space.options, instance: '0123456789ab' };
      installSchedule(options);

      const again = installSchedule(options);

      const job = z.object({ Label: z.string() }).parse(plistOf(again.plistPath));
      assert.equal(job.Label, again.label);
    });
  });

  it('points out a job under the default name when it installs one under another', async () => {
    await sandbox((space) => {
      const elsewhere = { ...space.options, instance: '0123456789ab' };
      assert.equal(installSchedule(elsewhere).earlierJobPath, null);

      const first = installSchedule(space.options);
      const second = installSchedule(elsewhere);

      assert.equal(first.earlierJobPath, null, 'the default job is never its own earlier one');
      assert.equal(second.earlierJobPath, first.plistPath);
    });
  });

  it('gives an install at another location Linux units of their own, the timer starting its own service', async () => {
    await sandbox((space) => {
      const first = installSystemdUnits({ ...space.options, configHome: null });
      const before = readFileSync(first.servicePath, 'utf8');

      const second = installSystemdUnits({ ...space.options, instance: '0123456789ab', configHome: null });
      const timer = unitSettings(readFileSync(second.timerPath, 'utf8'));

      assert.equal(first.timerUnit, 'board-queue.timer');
      assert.equal(second.serviceUnit, 'board-queue-0123456789ab.service');
      assert.equal(second.timerUnit, 'board-queue-0123456789ab.timer');
      assert.equal(setting(timer, 'Unit'), second.serviceUnit);
      assert.equal(readFileSync(first.servicePath, 'utf8'), before, 'the second install left the first service alone');
      assert.ok(enableCommands(second).some((line) => line.endsWith(` ${second.timerUnit}`)));
      assert.ok(reloadUnitCommands(second).some((line) => line.endsWith(` ${second.timerUnit}`)));
      assert.ok(removeUnitCommands(second).some((line) => line.endsWith(` ${second.timerUnit}`)));
      assert.equal(second.earlierJobPath, first.timerPath);
    });
  });
});

/**
 * Runs each printed command through a shell, as a person pasting it would, with
 * `launchctl`, `systemctl` and `sleep` standing in as recorders: what each
 * received, one argument per line, and a line of its own after each call.
 * `launchctl print` answers that the job is not loaded, or, with `stillLoaded`,
 * that it is, every time it is asked. `rm` is the real one.
 */
function runPrinted(space: Sandbox, commands: readonly string[], stillLoaded = false): string[] {
  const fakes = join(space.directory, 'fakes');
  const record = join(space.directory, 'printed.argv');
  for (const name of ['launchctl', 'systemctl', 'sleep']) {
    executable(join(fakes, name), [
      '#!/bin/sh',
      `printf '%s\\n' "${name}" "$@" -- >> "$PRINTED"`,
      '[ "$1" != print ] || [ "$STILL_LOADED" = yes ]',
    ]);
  }
  for (const line of commands) {
    const ran = spawnSync('/bin/sh', ['-c', line], {
      cwd: space.directory,
      encoding: 'utf8',
      env: { PATH: `${fakes}:/usr/bin:/bin`, PRINTED: record, STILL_LOADED: stillLoaded ? 'yes' : 'no' },
      timeout: 20_000,
    });
    assert.equal(ran.status, 0, `${line}\n${ran.stderr}`);
  }
  assert.equal(existsSync(join(space.directory, 'pwned')), false, 'a printed command ran part of a path');
  return existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((line) => line !== '') : [];
}

const UID = String(process.getuid?.() ?? '');

describe('the commands an install prints, for a home whose path holds every character a shell reads', () => {
  it('starts, reloads and removes the macOS job they name, with every path reaching its command whole', async () => {
    await sandbox((space) => {
      const installation = installSchedule(space.options);

      const started = runPrinted(space, loadCommands(installation));
      const reloaded = runPrinted(space, reloadCommands(installation)).slice(started.length);

      assert.deepEqual(started, ['launchctl', 'bootstrap', `gui/${UID}`, installation.plistPath, '--']);
      // launchd reads a job description only when the job is bootstrapped, so a
      // job that is loaded already is unloaded first, and registered again once
      // launchd says it has gone; restarting it would run the description it
      // read before.
      assert.deepEqual(reloaded, [
        'launchctl', 'bootout', `gui/${UID}/${installation.label}`, '--',
        'launchctl', 'print', `gui/${UID}/${installation.label}`, '--',
        'launchctl', 'bootstrap', `gui/${UID}`, installation.plistPath, '--',
      ]);
      assert.ok(existsSync(installation.plistPath));
      runPrinted(space, removeCommands(installation));
      assert.equal(existsSync(installation.plistPath), false, 'the printed rm missed the job description');
    });
  });

  it('gives up waiting for a job that stays loaded after a failed bootout, and still bootstraps it', async () => {
    await sandbox((space) => {
      const installation = installSchedule(space.options);

      const reloaded = runPrinted(space, reloadCommands(installation), true);

      const asked = reloaded.filter((word) => word === 'print').length;
      const slept = reloaded.filter((word) => word === 'sleep').length;
      assert.equal(asked, 30, 'the wait asks launchd a bounded number of times');
      assert.equal(slept, 30, 'the wait sleeps a second after each answer that the job is still there');
      assert.deepEqual(reloaded.slice(-5), ['launchctl', 'bootstrap', `gui/${UID}`, installation.plistPath, '--']);
    });
  });

  it('starts, reloads and removes the Linux units they name, with every path reaching its command whole', async () => {
    await sandbox((space) => {
      const installation = installSystemdUnits({ ...space.options, configHome: null });

      const started = runPrinted(space, enableCommands(installation));
      const reloaded = runPrinted(space, reloadUnitCommands(installation)).slice(started.length);

      assert.deepEqual(started, [
        'systemctl', '--user', 'daemon-reload', '--',
        'systemctl', '--user', 'enable', '--now', installation.timerUnit, '--',
      ]);
      assert.deepEqual(reloaded, [
        'systemctl', '--user', 'daemon-reload', '--',
        'systemctl', '--user', 'restart', installation.timerUnit, '--',
      ]);
      runPrinted(space, removeUnitCommands(installation));
      assert.equal(existsSync(installation.servicePath), false, 'the printed rm missed the service');
      assert.equal(existsSync(installation.timerPath), false, 'the printed rm missed the timer');
    });
  });
});

describe('the search path a scheduled pass starts with', () => {
  it('looks in the directories of the install\'s own search path first, then in the fixed ones, each once', async () => {
    await sandbox((space) => {
      const own = ['/home/acme/.local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin'];

      const environment = jobEnvironment({ ...space.options, searchPath: own });

      const fixed = SEARCH_PATH.split(':').filter((directory) => !own.includes(directory));
      assert.deepEqual(environment[0], ['PATH', [...own, ...fixed].join(':')]);
    });
  });

  it('reaches the pass the Linux service starts as the one search path it was given', async () => {
    await sandbox((space) => {
      const own = [join(space.root, 'tools bin')];
      const installation = installSystemdUnits({ ...space.options, searchPath: own, configHome: null });
      const settings = unitSettings(readFileSync(installation.servicePath, 'utf8'));

      const words = unitWords(withoutSpecifiers(setting(settings, 'Environment')));

      assert.deepEqual(words, [`PATH=${[...own, SEARCH_PATH].join(':')}`]);
    });
  });
});
