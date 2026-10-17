import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const PACKAGE = join(import.meta.dirname, '..', '..');

type Ran = { code: number; out: string; err: string };

/**
 * The two shell commands that start this package — `bin/board-queue` and
 * `bin/board-queue-mcp` — run as a person, a schedule or a session would run
 * them, against a home directory of the test's own.
 *
 * Node itself is stood in for by a script that records the arguments and the
 * credential variables it was started with, so what is proved is what the
 * wrapper hands over, not what the queue then does with it.
 */
class Sandbox {
  readonly directory: string;
  readonly home: string;
  readonly recorder: string;

  constructor() {
    this.directory = mkdtempSync(join(tmpdir(), 'board-queue-wrappers-'));
    this.home = join(this.directory, 'home');
    mkdirSync(this.home, { recursive: true });
    this.recorder = join(this.directory, 'bin', 'node');
    executable(this.recorder, [
      '#!/bin/sh',
      'out="$RECORD_TO"',
      'for arg in "$@"; do printf \'arg=%s\\n\' "$arg"; done > "$out"',
      'printf \'app=%s\\n\' "${GITHUB_APP_ID:-}" >> "$out"',
    ]);
  }

  run(command: string, args: readonly string[], env: Record<string, string> = {}): Ran & { recorded: string[] } {
    const record = join(this.directory, `record-${String(Math.random()).slice(2)}`);
    const ran = spawnSync(command, [...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dirname(this.recorder)}:/usr/bin:/bin`,
        HOME: this.home,
        RECORD_TO: record,
        ...env,
      },
    });
    const recorded = existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
    return { code: ran.status ?? 1, out: ran.stdout, err: ran.stderr, recorded };
  }

  secrets(path: string, mode: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'GITHUB_APP_ID=4242\n', 'utf8');
    chmodSync(path, mode);
  }

  /** A copy of the package's wrappers with no dependencies installed beside them. */
  bareCopy(): string {
    const copy = join(this.directory, 'cache-copy');
    mkdirSync(copy, { recursive: true });
    cpSync(join(PACKAGE, 'bin'), join(copy, 'bin'), { recursive: true });
    cpSync(join(PACKAGE, 'lib'), join(copy, 'lib'), { recursive: true });
    return copy;
  }

  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function executable(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function inSandbox(run: (box: Sandbox) => void): void {
  const box = new Sandbox();
  try {
    run(box);
  } finally {
    box.close();
  }
}

const COMMAND = join(PACKAGE, 'bin', 'board-queue');
const MCP = join(PACKAGE, 'bin', 'board-queue-mcp');

describe('the board-queue command', () => {
  it('runs the command line entry point beside it with every argument', () => {
    inSandbox((box) => {
      const ran = box.run(COMMAND, ['list', '--json', '--issue', '7']);

      assert.equal(ran.code, 0, ran.err);
      assert.deepEqual(ran.recorded, [
        `arg=${join(PACKAGE, 'bin', 'board-queue.ts')}`, 'arg=list', 'arg=--json', 'arg=--issue', 'arg=7', 'app=',
      ]);
    });
  });

  it('starts the Node it is told to, and the one on the search path when that one is gone', () => {
    inSandbox((box) => {
      const pinned = join(box.directory, 'pinned', 'node');
      executable(pinned, ['#!/bin/sh', 'printf \'pinned\\n\' > "$RECORD_TO"']);

      assert.deepEqual(box.run(COMMAND, ['help'], { BOARD_QUEUE_NODE: pinned }).recorded, ['pinned']);
      assert.equal(box.run(COMMAND, ['help'], { BOARD_QUEUE_NODE: join(box.directory, 'gone') }).recorded[1], 'arg=help');
    });
  });

  it('reads the App credential for a scheduled pass, and for nothing else', () => {
    inSandbox((box) => {
      box.secrets(join(box.home, '.config', 'board-queue', 'board-queue.env'), 0o600);

      assert.ok(box.run(COMMAND, ['tick']).recorded.includes('app=4242'));
      assert.ok(box.run(COMMAND, ['status']).recorded.includes('app='));
    });
  });

  it('reads the credential from the previous secrets file when there is no current one', () => {
    inSandbox((box) => {
      box.secrets(join(box.home, '.claude', 'secrets', 'board-queue.env'), 0o600);

      assert.ok(box.run(COMMAND, ['tick']).recorded.includes('app=4242'));
    });
  });

  it('skips a credential file other accounts can read, and says how to fix it', () => {
    inSandbox((box) => {
      const file = join(box.home, '.config', 'board-queue', 'board-queue.env');
      box.secrets(file, 0o644);

      const ran = box.run(COMMAND, ['tick']);

      assert.ok(ran.recorded.includes('app='));
      assert.match(ran.err, new RegExp(`${file} is mode 644, not 600; it was not read \\(chmod 600 it\\)`));
    });
  });

  it('honours a credential file the environment names', () => {
    inSandbox((box) => {
      const file = join(box.directory, 'elsewhere.env');
      box.secrets(file, 0o600);

      assert.ok(box.run(COMMAND, ['tick'], { BOARD_QUEUE_ENV: file }).recorded.includes('app=4242'));
    });
  });
});

describe('a copy of the package without its dependencies', () => {
  it('hands the call to the installed command once', () => {
    inSandbox((box) => {
      const copy = box.bareCopy();
      const installed = join(box.home, '.local', 'bin', 'board-queue');
      executable(installed, [
        '#!/bin/sh',
        'for arg in "$@"; do printf \'arg=%s\\n\' "$arg"; done > "$RECORD_TO"',
        'printf \'forwarded=%s\\n\' "$BOARD_QUEUE_FORWARDED" >> "$RECORD_TO"',
      ]);

      const ran = box.run(join(copy, 'bin', 'board-queue'), ['status', '--json']);

      assert.equal(ran.code, 0, ran.err);
      assert.deepEqual(ran.recorded, ['arg=status', 'arg=--json', 'forwarded=1']);
    });
  });

  it('stops with the step that fixes it when nothing is installed to hand it to', () => {
    inSandbox((box) => {
      const copy = box.bareCopy();

      const ran = box.run(join(copy, 'bin', 'board-queue'), ['status']);

      assert.equal(ran.code, 1);
      assert.match(ran.err, /dependencies are not installed in .*; run: npm ci --prefix/);
      assert.deepEqual(ran.recorded, []);
    });
  });

  it('does not hand the call on a second time when the installed command is just as bare', () => {
    inSandbox((box) => {
      const copy = box.bareCopy();
      const installed = join(box.home, '.local', 'bin', 'board-queue');
      executable(installed, ['#!/bin/sh', `exec "${join(copy, 'bin', 'board-queue')}" "$@"`]);

      const ran = box.run(join(copy, 'bin', 'board-queue'), ['status']);

      assert.equal(ran.code, 1);
      assert.match(ran.err, /dependencies are not installed/);
    });
  });
});

describe('the board-queue MCP server command', () => {
  it('starts the server entry point beside it with the App credential', () => {
    inSandbox((box) => {
      box.secrets(join(box.home, '.config', 'board-queue', 'board-queue.env'), 0o600);

      const ran = box.run(MCP, []);

      assert.equal(ran.code, 0, ran.err);
      assert.deepEqual(ran.recorded, [`arg=${join(PACKAGE, 'bin', 'board-queue-mcp.ts')}`, 'app=4242']);
    });
  });

  it('hands a copy without dependencies to the installed server command', () => {
    inSandbox((box) => {
      const copy = box.bareCopy();
      const installed = join(box.home, '.local', 'bin', 'board-queue-mcp');
      executable(installed, ['#!/bin/sh', 'printf \'installed server\\n\' > "$RECORD_TO"']);

      assert.deepEqual(box.run(join(copy, 'bin', 'board-queue-mcp'), []).recorded, ['installed server']);
    });
  });
});
