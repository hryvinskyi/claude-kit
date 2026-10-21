import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { PassOutcome } from '../../src/application/service-beat.ts';
import type { PassRunner } from '../../src/application/service-loop.ts';
import { passEnvironment, runService, serviceHealth, stopOnSignals } from '../../src/delivery/service-runtime.ts';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { FileBeatStore } from '../../src/infrastructure/file-beat-store.ts';
import { beatPath } from '../../src/infrastructure/paths.ts';
import { writeAppKey } from '../fixtures/app-key.ts';
import { syncConfig } from '../fixtures/sync.ts';

const PACKAGE = join(import.meta.dirname, '..', '..');
const ENTRY = join(PACKAGE, 'bin', 'board-queue.ts');
const SERVICE_UNDER_TEST = join(PACKAGE, 'test', 'fixtures', 'service-entry.ts');
const TOKEN = 'dibs_imp_tttttttttttttttttttttttt';

type Place = { directory: string; stateDir: string; configPath: string; keyPath: string; privateKey: string };

function place(t: TestContext): Place {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-service-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(syncConfig), 'utf8');
  const { path: keyPath, privateKey } = writeAppKey(directory);
  return { directory, stateDir: join(directory, 'state'), configPath, keyPath, privateKey };
}

function serviceEnv(where: Place, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_INSTALLATION_ID: '7890',
    GITHUB_APP_PRIVATE_KEY_PATH: where.keyPath,
    DIBS_TEST_TOKEN: TOKEN,
    ...overrides,
  };
}

/** A pass that says it went well, after doing whatever the test needs done in the middle of one. */
class InlinePass implements PassRunner {
  passes = 0;
  readonly #during: () => void;

  constructor(during: () => void) {
    this.#during = during;
  }

  async run(): Promise<PassOutcome> {
    this.passes += 1;
    this.#during();
    return { kind: 'finished', exitCode: 0 };
  }
}

describe('the worker as a long-running service', () => {
  it('refuses to start without the App\'s key, and runs no pass', async (t) => {
    const where = place(t);
    const pass = new InlinePass(() => undefined);
    const lines: string[] = [];

    await assert.rejects(() => runService({
      env: serviceEnv(where, { GITHUB_APP_PRIVATE_KEY_PATH: undefined }),
      config: syncConfig,
      stateDir: where.directory,
      cliEntry: ENTRY,
      nodePath: process.execPath,
      log: { line: (text) => lines.push(text) },
      stop: new AbortController().signal,
      pid: 77,
      pass,
    }), RefusedByRule);

    assert.equal(pass.passes, 0);
    assert.deepEqual(lines, []);
    assert.equal(existsSync(beatPath(where.directory)), false);
  });

  it('says what it runs as without the key, its path or the server\'s token, and is healthy while it runs', async (t) => {
    const where = place(t);
    const stop = new AbortController();
    const lines: string[] = [];
    let healthDuringPass: string | null = null;
    const pass = new InlinePass(() => {
      healthDuringPass = JSON.stringify(serviceHealth(where.directory));
      stop.abort('SIGTERM');
    });

    const { beat: last } = await runService({
      env: serviceEnv(where),
      config: syncConfig,
      stateDir: where.directory,
      cliEntry: ENTRY,
      nodePath: process.execPath,
      log: { line: (text) => lines.push(text) },
      stop: stop.signal,
      pid: 77,
      pass,
    });

    assert.equal(lines[0], 'starting as GitHub App 123456, installation 7890, its key mode 0400; a pass every 300 s');
    for (const line of lines) {
      assert.equal(line.includes(where.keyPath), false, line);
      assert.equal(line.includes(TOKEN), false, line);
      assert.equal(line.includes('PRIVATE KEY'), false, line);
    }
    assert.equal(pass.passes, 1);
    assert.equal(healthDuringPass, JSON.stringify({
      healthy: true,
      reason: `started at ${last.startedAt}; the first pass has not ended yet`,
    }));
    assert.deepEqual(new FileBeatStore(beatPath(where.directory)).read(), last);
    assert.match(serviceHealth(where.directory).reason, /the service stopped at/);
  });

  it('stops on the first SIGTERM or SIGINT', () => {
    const terminated = new EventEmitter();
    const interrupted = new EventEmitter();
    const onTerm = stopOnSignals(terminated);
    const onInt = stopOnSignals(interrupted);

    assert.equal(onTerm.aborted, false);
    terminated.emit('SIGTERM');
    interrupted.emit('SIGINT');

    assert.equal(onTerm.aborted, true);
    assert.equal(onTerm.reason, 'SIGTERM');
    assert.equal(onInt.reason, 'SIGINT');
  });

  it('runs each pass as a scheduled one, judged by the App, with the rest of its environment', () => {
    assert.deepEqual(passEnvironment({ PATH: '/usr/bin', BOARD_QUEUE_IDENTITY: 'gh' }), {
      PATH: '/usr/bin',
      BOARD_QUEUE_SCHEDULED: '1',
      BOARD_QUEUE_IDENTITY: 'app',
    });
  });
});

type Running = { exited: Promise<{ code: number | null; out: string; err: string }>; kill(): void };

function startService(where: Place, extra: Record<string, string>): Running {
  const child = spawn(process.execPath, [SERVICE_UNDER_TEST], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      BOARD_QUEUE_CONFIG: where.configPath,
      BOARD_QUEUE_STATE_DIR: where.stateDir,
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY_PATH: where.keyPath,
      DIBS_TEST_TOKEN: TOKEN,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const exited = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, out, err });
    });
  });
  return { exited, kill: () => child.kill('SIGTERM') };
}

/** Waits until the service's heartbeat says a pass is under way. */
async function untilAPassRuns(stateDir: string): Promise<void> {
  const beats = new FileBeatStore(beatPath(stateDir));
  for (let tries = 0; tries < 200; tries += 1) {
    const beat = beats.read();
    if (beat !== null && beat.passStartedAt !== null) {
      return;
    }
    await delay(25);
  }
  throw new Error('no pass started');
}

describe('the service process, stopped by a signal', () => {
  it('lets the running pass finish inside the grace, then exits cleanly', async (t) => {
    const where = place(t);
    const service = startService(where, { FAKE_TICK_MODE: 'sleep:400', FIXTURE_GRACE_MS: '5000' });
    await untilAPassRuns(where.stateDir);

    service.kill();
    const { code, out, err } = await service.exited;

    assert.equal(code, 0, err);
    assert.match(out, /^pass 1 ended ok after/m);
    assert.match(out, /^stopped$/m);
    const last = new FileBeatStore(beatPath(where.stateDir)).read();
    assert.equal(last?.outcome, 'ok');
    assert.notEqual(last?.stoppedAt, null);
  });

  it('abandons a pass that outlives the grace, and still exits cleanly', async (t) => {
    const where = place(t);
    const service = startService(where, { FAKE_TICK_MODE: 'wait', FIXTURE_GRACE_MS: '200' });
    await untilAPassRuns(where.stateDir);

    service.kill();
    const { code, out, err } = await service.exited;

    assert.equal(code, 0, err);
    assert.match(out, /^pass 1 ended abandoned after .*: the service was told to stop and the pass did not finish in time$/m);
    assert.equal(new FileBeatStore(beatPath(where.stateDir)).read()?.consecutiveFailures, 0);
  });

  it('refuses to start without a readable key and says so in one line', async (t) => {
    const where = place(t);
    const child = spawn(process.execPath, [ENTRY, 'service'], {
      env: {
        PATH: '/nonexistent',
        BOARD_QUEUE_CONFIG: where.configPath,
        BOARD_QUEUE_STATE_DIR: where.stateDir,
        GITHUB_APP_ID: '123456',
        GITHUB_APP_PRIVATE_KEY_PATH: join(where.directory, 'absent.pem'),
        DIBS_TEST_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    assert.equal(code, 1);
    assert.equal(err, 'the file named by GITHUB_APP_PRIVATE_KEY_PATH is not there, or this account cannot read it\n');
    assert.equal(existsSync(beatPath(where.stateDir)), false);
  });

  it('answers the container\'s health check from the heartbeat alone', async (t) => {
    const where = place(t);
    const ask = async (): Promise<{ code: number | null; out: string; err: string }> => {
      const child = spawn(process.execPath, [ENTRY, 'health'], {
        env: { PATH: '/nonexistent', BOARD_QUEUE_STATE_DIR: where.stateDir, BOARD_QUEUE_CONFIG: join(where.directory, 'none.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
      const code = await new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });
      return { code, out, err };
    };

    const before = await ask();
    new FileBeatStore(beatPath(where.stateDir)).write({
      pid: 1,
      startedAt: new Date().toISOString(),
      intervalMs: 300_000,
      passDeadlineMs: 1_200_000,
      passes: 0,
      passStartedAt: new Date().toISOString(),
      passEndedAt: null,
      outcome: null,
      detail: null,
      consecutiveFailures: 0,
      stoppedAt: null,
    });
    const during = await ask();

    assert.deepEqual(before, { code: 1, out: '', err: 'the service is unhealthy: the service has written no heartbeat\n' });
    assert.equal(during.code, 0, during.err);
    assert.match(during.out, /^healthy: started at .*; the first pass has not ended yet\n$/);
  });
});
