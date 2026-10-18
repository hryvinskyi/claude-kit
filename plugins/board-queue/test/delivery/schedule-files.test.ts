import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { installSchedule } from '../../src/delivery/launchd-install.ts';
import { SEARCH_PATH, writeLauncher } from '../../src/delivery/schedule-files.ts';
import type { ScheduleOptions } from '../../src/delivery/schedule-files.ts';
import { installSystemdUnits } from '../../src/delivery/systemd-install.ts';
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
  options: ScheduleOptions;
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
    ]);
    const options: ScheduleOptions = { home, nodePath, stateDir: join(root, 'state'), commandPath };
    await body({ directory, options, record: `${commandPath}.argv` });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function executable(file: string, lines: readonly string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...lines, ''].join('\n'), 'utf8');
  chmodSync(file, 0o755);
}

/** Runs a job's command line the way its scheduler would, with a scheduler's bare environment. */
function runJob(space: Sandbox, argv: readonly string[]): void {
  const [program, ...args] = argv;
  assert.ok(program !== undefined, 'the job names no program');
  const ran = spawnSync(program, args, {
    cwd: space.directory,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: space.options.home },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readFileSync(space.record, 'utf8').split('\n').filter(Boolean),
    ['tick', 'scheduled=1', `node=${space.options.nodePath}`]);
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
