import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { buildContainer } from '../../src/delivery/container.ts';
import type { Container } from '../../src/delivery/container.ts';
import { Action } from '../../src/domain/action.ts';
import { OptionNotFound } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import type { Config } from '../../src/domain/config.ts';
import { THIRD, testConfig, twoBoardConfig } from '../fixtures/config.ts';

const PACKAGE = join(import.meta.dirname, '..', '..');
const ENTRY = join(PACKAGE, 'bin', 'board-queue.ts');
const FIRST = 'example-org/first-repo';
const DAY_MS = 24 * 60 * 60 * 1000;

type Spoken = { code: number; out: string; err: string };

type RunOptions = {
  stdin?: string;
  /** Somewhere other than this machine's own home, for the command that writes into one. */
  home?: string;
  env?: Record<string, string>;
};

/**
 * The command line as a person or a script meets it: another process, its own
 * database, its own configuration, and nothing of this test's inside it.
 *
 * Only the commands that stay on this machine are exercised here. The two that
 * reach the board are proved where the gateways can be stood in for; spawning a
 * process to find out what happens without a network proves nothing about either.
 */
class Workspace {
  readonly directory: string;
  readonly stateDir: string;
  readonly configPath: string;

  constructor(config: unknown = testConfig) {
    this.directory = mkdtempSync(join(tmpdir(), 'board-queue-cli-'));
    this.stateDir = join(this.directory, 'state');
    this.configPath = join(this.directory, 'config.json');
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<Spoken> {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: {
        ...process.env,
        BOARD_QUEUE_STATE_DIR: this.stateDir,
        BOARD_QUEUE_CONFIG: this.configPath,
        ...(options.home === undefined ? {} : { HOME: options.home }),
        ...(options.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(options.stdin ?? '');
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => {
        resolve(status ?? 0);
      });
    });
    return { code, out, err };
  }

  /** Puts rows in the queue no command can produce on its own — a dead end, a long wait. */
  async seed(fill: (container: Container) => Promise<void>): Promise<void> {
    const container = buildContainer({ config: testConfig, stateDir: this.stateDir });
    try {
      await fill(container);
    } finally {
      container.close();
    }
  }

  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

async function workspace(work: (space: Workspace) => Promise<void>, config: unknown = testConfig): Promise<void> {
  const space = new Workspace(config);
  try {
    await work(space);
  } finally {
    space.cleanup();
  }
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

async function fileSetFields(space: Workspace, issue: number, status: string): Promise<string> {
  const filed = await space.run(['enqueue', '--repo', FIRST, '--issue', String(issue), '--status', status, '--json']);
  assert.equal(filed.code, 0, filed.err);
  const parsed: unknown = JSON.parse(filed.out);
  const id = (parsed as { id: string }).id;
  return id;
}

/** An action that stopped for a reason only a person can clear. */
async function seedBlocked(space: Workspace, issue: number): Promise<string> {
  const id = globalThis.crypto.randomUUID();
  await space.seed(async (container) => {
    const now = container.clock.now();
    const action = Action.enqueue({
      id,
      kind: 'board.set-fields',
      payload: { repo: FIRST, issue, fields: { severity: 'S9' } },
      issueRef: IssueRef.of(FIRST, issue),
      origin: 'a test',
      now,
    });
    await container.repository.insert(action);
    action.start(now);
    action.block(now, new OptionNotFound('Severity', 'S9', ['S1 · blocking', 'S2 · broken']));
    await container.repository.update(action);
  });
  return id;
}

/** A move somebody held for a deploy and never released. */
async function seedHeld(space: Workspace, issue: number, ageDays: number): Promise<string> {
  const id = globalThis.crypto.randomUUID();
  await space.seed(async (container) => {
    const filed = new Date(container.clock.now().getTime() - ageDays * DAY_MS);
    await container.repository.insert(Action.enqueue({
      id,
      kind: 'board.set-fields',
      payload: { repo: FIRST, issue, fields: { status: 'In progress' } },
      issueRef: IssueRef.of(FIRST, issue),
      origin: 'a test',
      now: filed,
      hold: true,
    }));
  });
  return id;
}

describe('the queue on a command line', () => {
  it('files a request piped in whole, and one typed as words', async () => {
    await workspace(async (space) => {
      const piped = await space.run(['enqueue'], {
        stdin: JSON.stringify({
          kind: 'issue.comment',
          payload: { repo: FIRST, issue: 12, body: 'the fix is on staging' },
          origin: 'a shim',
        }),
      });
      const typed = await space.run(['enqueue', '--repo', FIRST, '--issue', '12', '--status', 'Triage']);

      assert.equal(piped.code, 0, piped.err);
      assert.match(piped.out, /^queued [0-9a-f-]{36}$/m);
      assert.equal(typed.code, 0, typed.err);
      assert.match(typed.out, /^queued [0-9a-f-]{36}$/m);
    });
  });

  it('folds a second request for the same issue into the one already waiting', async () => {
    await workspace(async (space) => {
      const first = await fileSetFields(space, 12, 'Triage');
      const second = await space.run(['enqueue', '--repo', FIRST, '--issue', '12', '--module', 'Checkout']);

      assert.equal(second.code, 0, second.err);
      assert.match(second.out, new RegExp(`coalesced into ${first}`));
    });
  });

  it('refuses a repository the configuration does not name, saying which it does', async () => {
    await workspace(async (space) => {
      const refused = await space.run(['enqueue', '--repo', 'somebody/elses-repo', '--issue', '3', '--status', 'Triage']);

      assert.equal(refused.code, 1);
      assert.match(refused.err, /not a configured repository/);
      assert.equal(refused.out, '');
    });
  });

  it('files work for a repository on either board, and refuses one neither carries naming all that are', async () => {
    await workspace(async (space) => {
      const onTheSecond = await space.run(['enqueue', '--repo', 'example-user/THIRD-repo', '--issue', '4', '--status', 'Todo']);
      const onTheFirst = await space.run(['enqueue', '--repo', FIRST, '--issue', '4', '--status', 'Todo']);
      const nowhere = await space.run(['enqueue', '--repo', 'somebody/elses-repo', '--issue', '3', '--status', 'Todo']);
      const listed = await space.run(['list', '--repo', THIRD, '--json']);

      assert.equal(onTheSecond.code, 0, onTheSecond.err);
      assert.equal(onTheFirst.code, 0, onTheFirst.err);
      assert.equal(nowhere.code, 1);
      assert.match(nowhere.err, new RegExp(`this queue writes to example-org/first-repo, Example-User/second-repo, ${THIRD}`));
      assert.match(listed.out, new RegExp(`"ref": "${THIRD}#4"`));
    }, twoBoardConfig);
  });

  it('refuses to start on a configuration where two boards claim one repository', async () => {
    const [first, second] = twoBoardConfig.boards;
    assert.ok(first !== undefined && second !== undefined);
    const claimedTwice: Config = { ...twoBoardConfig, boards: [first, { ...second, repos: [...second.repos, FIRST] }] };
    await workspace(async (space) => {
      const status = await space.run(['status']);

      assert.equal(status.code, 1);
      assert.match(status.err, /example-org\/first-repo is named by example-org\/7 and example-user\/3/);
      assert.equal(status.out, '');
    }, claimedTwice);
  });

  it('lists what is in the queue as the values a script reads', async () => {
    await workspace(async (space) => {
      // Filed two days ago, so it is first in a listing that reads in the order
      // things were filed.
      await seedHeld(space, 77, 2);
      await fileSetFields(space, 12, 'Triage');
      await space.run(['enqueue'], {
        stdin: JSON.stringify({ kind: 'issue.comment', payload: { repo: FIRST, issue: 41, body: 'a note' } }),
      });

      const listed = await space.run(['list', '--json']);
      const parsed = JSON.parse(listed.out) as { kind: string; ref: string; state: string }[];
      const narrowed = await space.run(['list', '--kind', 'issue.comment', '--json']);
      const bothStates = await space.run(['list', '--state', 'queued,held', '--json']);
      const heldOnly = await space.run(['list', '--state', 'held', '--json']);

      assert.equal(listed.code, 0, listed.err);
      assert.deepEqual(parsed.map((action) => action.kind), ['board.set-fields', 'board.set-fields', 'issue.comment']);
      assert.deepEqual(parsed.map((action) => action.ref), [`${FIRST}#77`, `${FIRST}#12`, `${FIRST}#41`]);
      assert.equal((JSON.parse(narrowed.out) as unknown[]).length, 1);
      assert.equal((JSON.parse(bothStates.out) as unknown[]).length, 3);
      assert.deepEqual((JSON.parse(heldOnly.out) as { state: string }[]).map((action) => action.state), ['held']);
    });
  });

  it('accounts for every state, including the ones nothing is in', async () => {
    await workspace(async (space) => {
      await fileSetFields(space, 12, 'Triage');
      await seedBlocked(space, 41);

      const status = await space.run(['status', '--json']);
      const view = JSON.parse(status.out) as {
        counts: Record<string, number>;
        blocked: { lastError: string }[];
      };

      assert.equal(status.code, 0, status.err);
      assert.equal(view.counts.queued, 1);
      assert.equal(view.counts.blocked, 1);
      assert.equal(view.counts.cancelled, 0);
      assert.match(view.blocked[0]?.lastError ?? '', /no option matching "S9"/);
    });
  });

  it('releases what was held, cancels what is not wanted, and retries a dead end', async () => {
    await workspace(async (space) => {
      const held = await seedHeld(space, 12, 1);
      const blocked = await seedBlocked(space, 41);
      const queued = await fileSetFields(space, 77, 'Triage');

      const released = await space.run(['release', held]);
      const retried = await space.run(['retry', blocked]);
      const cancelled = await space.run(['cancel', queued]);
      const nothingLeft = await space.run(['retry', '--blocked']);

      assert.equal(released.code, 0, released.err);
      assert.equal(lines(released.out)[0], `released ${held} → queued`);
      assert.equal(lines(retried.out)[0], `retrying ${blocked} → queued`);
      assert.equal(lines(cancelled.out)[0], `cancelled ${queued} → cancelled`);
      assert.equal(lines(nothingLeft.out)[0], 'nothing is blocked');
    });
  });

  it('retries every dead end at once, naming each one it moved', async () => {
    await workspace(async (space) => {
      const first = await seedBlocked(space, 12);
      const second = await seedBlocked(space, 41);

      const retried = await space.run(['retry', '--blocked']);

      assert.equal(retried.code, 0, retried.err);
      assert.deepEqual(lines(retried.out).sort(), [`retrying ${first}`, `retrying ${second}`].sort());
    });
  });

  it('says nothing at the start of a session with nothing outstanding', async () => {
    await workspace(async (space) => {
      const quiet = await space.run(['brief', '--repo', FIRST]);

      assert.equal(quiet.code, 0, quiet.err);
      assert.equal(quiet.out, '');
    });
  });

  it('says nothing about a repository this queue does not carry', async () => {
    await workspace(async (space) => {
      await fileSetFields(space, 12, 'Triage');

      const elsewhere = await space.run(['brief', '--repo', 'somebody/elses-repo']);

      assert.equal(elsewhere.code, 0, elsewhere.err);
      assert.equal(elsewhere.out, '');
    });
  });

  it('counts the outstanding work of one repository, oldest wait included', async () => {
    await workspace(async (space) => {
      await fileSetFields(space, 12, 'Triage');
      await seedHeld(space, 41, 3);
      await seedHeld(space, 42, 12);

      const spoken = await space.run(['brief', '--repo', FIRST]);

      assert.equal(spoken.code, 0, spoken.err);
      assert.deepEqual(lines(spoken.out), ['[BOARD QUEUE] queued 1 · held 2 (oldest 12.0d) · blocked 0 · failed 0']);
    });
  });

  it('names the work that is waiting for a date, and when it comes round', async () => {
    await workspace(async (space) => {
      await fileSetFields(space, 12, 'Triage');
      const runsOn = new Date(Date.now() + 5 * DAY_MS).toISOString();
      const filed = await space.run([
        'enqueue', '--repo', FIRST, '--issue', '41', '--status', 'Triage', '--not-before', runsOn,
      ]);
      assert.equal(filed.code, 0, filed.err);

      const status = await space.run(['status']);
      const spoken = await space.run(['brief', '--repo', FIRST]);

      assert.match(status.out, /^delayed .* — runs .* \(in 5\.0d\), filed by /m);
      assert.match(lines(spoken.out)[0] ?? '', /delayed 1 \(next in 5\.0d\)/);
    });
  });

  it('refuses a date so far off that nobody would see the action again', async () => {
    await workspace(async (space) => {
      const runsOn = new Date(Date.now() + 40 * DAY_MS).toISOString();

      const refused = await space.run([
        'enqueue', '--repo', FIRST, '--issue', '41', '--status', 'Triage', '--not-before', runsOn,
      ]);

      assert.equal(refused.code, 1);
      assert.match(refused.err, /30 days/);
    });
  });

  it('names the first dead end on a second line, with what stopped it', async () => {
    await workspace(async (space) => {
      await seedBlocked(space, 41);

      const spoken = await space.run(['brief', '--repo', FIRST]);
      const said = lines(spoken.out);

      assert.equal(said.length, 2);
      assert.equal(said[0], '[BOARD QUEUE] queued 0 · held 0 · blocked 1 · failed 0');
      assert.match(said[1] ?? '', new RegExp(`^\\[BOARD QUEUE\\] blocked ${FIRST}#41 — Severity has no option`));
    });
  });

  it('answers a command nobody has with the usage and a code a script can read', async () => {
    await workspace(async (space) => {
      const unknown = await space.run(['polish-the-board']);
      const nothing = await space.run([]);

      assert.equal(unknown.code, 2);
      assert.match(unknown.err, /there is no command called "polish-the-board"/);
      assert.match(unknown.err, /usage: board-queue <command>/);
      assert.equal(unknown.out, '');
      assert.equal(nothing.code, 2);
    });
  });

  it('refuses a pass that the schedule did not start', async () => {
    await workspace(async (space) => {
      const spoken = await space.run(['tick']);
      assert.equal(spoken.code, 1);
      assert.match(spoken.err, /run by the schedule, not by hand/);
      assert.match(spoken.err, /BOARD_QUEUE_SCHEDULED=1/);
      assert.equal(spoken.out, '');
    });
  });

  it('runs a pass when the schedule says it started it', async () => {
    await workspace(async (space) => {
      // With the queue empty a pass touches nothing but the allowance probe, and
      // without a credential that probe is what stops it: the report is still
      // printed, exit 0, because a pass that could not run is an answer.
      const spoken = await space.run(['tick', '--json'], { env: { BOARD_QUEUE_SCHEDULED: '1', PATH: '/nonexistent' } });
      assert.equal(spoken.code, 0, spoken.err);
      assert.doesNotMatch(spoken.err, /run by the schedule, not by hand/);
    });
  });

  it('writes a schedule of absolute paths that the system can read, and a launcher it can run', async () => {
    await workspace(async (space) => {
      const home = join(space.directory, 'home');
      const command = fakeCommand(home);

      const installed = await space.run(['install-launchd'], { home });
      const plistPath = join(home, 'Library', 'LaunchAgents', 'com.user.board-queue.plist');
      const launcherPath = join(space.stateDir, 'board-queue-tick.sh');
      const plist = readFileSync(plistPath, 'utf8');
      const launcher = readFileSync(launcherPath, 'utf8');
      const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });

      assert.equal(installed.code, 0, installed.err);
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
      assert.match(plist, /<string>com\.user\.board-queue<\/string>/);
      assert.match(plist, /<integer>300<\/integer>/);
      assert.match(plist, new RegExp(`<string>${launcherPath}</string>`));
      assert.match(plist, new RegExp(`<string>${join(space.stateDir, 'launchd.log')}</string>`));
      assert.match(plist, /\/opt\/homebrew\/bin:/);
      // Everything a schedule is given has to be absolute: it starts with none of
      // the surroundings that make a relative path mean anything.
      for (const path of plist.matchAll(/<string>([^<]+)<\/string>/g)) {
        const value = path[1] ?? '';
        assert.ok(value.startsWith('/') || value.startsWith('com.user.'), `${value} is not absolute`);
      }
      assertLauncherRunsThroughTheCommand(launcher, launcherPath, command);
      assert.match(installed.out, new RegExp(`launchctl bootstrap gui/\\$\\(id -u\\) ${plistPath}`));
      assert.match(installed.out, /launchctl kickstart -k gui\/\$\(id -u\)\/com\.user\.board-queue/);
    });
  });

  it('writes Linux user units that start the same launcher on the same interval', async () => {
    await workspace(async (space) => {
      const home = join(space.directory, 'home');
      const command = fakeCommand(home);

      const installed = await space.run(['install-systemd'], { home, env: { XDG_CONFIG_HOME: '' } });
      const unitDir = join(home, '.config', 'systemd', 'user');
      const service = readFileSync(join(unitDir, 'board-queue.service'), 'utf8');
      const timer = readFileSync(join(unitDir, 'board-queue.timer'), 'utf8');
      const launcherPath = join(space.stateDir, 'board-queue-tick.sh');

      assert.equal(installed.code, 0, installed.err);
      assert.match(service, /^Type=oneshot$/m);
      assert.match(service, new RegExp(`^ExecStart=/bin/sh "${launcherPath}"$`, 'm'));
      assert.match(service, new RegExp(`^WorkingDirectory=${space.stateDir}$`, 'm'));
      assert.match(service, new RegExp(`^StandardOutput=append:${join(space.stateDir, 'launchd.log')}$`, 'm'));
      assert.match(timer, /^OnUnitActiveSec=300s$/m);
      assert.match(timer, /^Unit=board-queue\.service$/m);
      assert.match(timer, /^WantedBy=timers\.target$/m);
      assert.doesNotMatch(service + timer, /\{\{/);
      assertLauncherRunsThroughTheCommand(readFileSync(launcherPath, 'utf8'), launcherPath, command);
      assert.match(installed.out, /systemctl --user daemon-reload/);
      assert.match(installed.out, /systemctl --user enable --now board-queue\.timer/);
    });
  });

  it('puts the units under the configuration directory the environment names', async () => {
    await workspace(async (space) => {
      const home = join(space.directory, 'home');
      fakeCommand(home);
      const configHome = join(space.directory, 'xdg');

      const installed = await space.run(['install-systemd'], { home, env: { XDG_CONFIG_HOME: configHome } });

      assert.equal(installed.code, 0, installed.err);
      assert.ok(existsSync(join(configHome, 'systemd', 'user', 'board-queue.timer')));
    });
  });

  it('refuses to write a schedule that would run a command that is not installed', async () => {
    await workspace(async (space) => {
      const home = join(space.directory, 'home');
      mkdirSync(home, { recursive: true });

      const installed = await space.run(['install-launchd'], { home });

      assert.equal(installed.code, 1);
      assert.match(installed.err, /no board-queue command at .*\.local\/bin\/board-queue/);
      assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.user.board-queue.plist')), false);
    });
  });

  it('runs a pass through the command, as the schedule would, with the variable that permits it', async () => {
    await workspace(async (space) => {
      const home = join(space.directory, 'home');
      const command = fakeCommand(home);
      await space.run(['install-launchd'], { home });

      const ran = spawnSync('/bin/sh', [join(space.stateDir, 'board-queue-tick.sh')], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: home },
      });

      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(readFileSync(`${command}.argv`, 'utf8').split('\n').filter(Boolean),
        ['tick', 'scheduled=1', `node=${process.execPath}`]);
    });
  });
});

/**
 * Stands in for the installed `board-queue` command: it records what it was asked
 * to run, and the two variables the launcher hands it, beside itself.
 */
function fakeCommand(home: string): string {
  const command = join(home, '.local', 'bin', 'board-queue');
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, [
    '#!/bin/sh',
    'for arg in "$@"; do printf \'%s\\n\' "$arg"; done > "$0.argv"',
    'printf \'scheduled=%s\\nnode=%s\\n\' "$BOARD_QUEUE_SCHEDULED" "$BOARD_QUEUE_NODE" >> "$0.argv"',
    '',
  ].join('\n'), 'utf8');
  chmodSync(command, 0o755);
  return command;
}

function assertLauncherRunsThroughTheCommand(launcher: string, launcherPath: string, command: string): void {
  // The launcher is the only thing that may start a pass, and it says so
  // through the variable the program checks.
  assert.match(launcher, /^BOARD_QUEUE_SCHEDULED=1$/m);
  assert.match(launcher, /^export BOARD_QUEUE_SCHEDULED$/m);
  assert.match(launcher, new RegExp(`^COMMAND='${command}'$`, 'm'));
  assert.match(launcher, /^NODE='\/.+'$/m);
  assert.match(launcher, /^exec "\$COMMAND" tick$/m);
  assert.ok((statSync(launcherPath).mode & 0o111) !== 0, 'the launcher is not executable');
}
