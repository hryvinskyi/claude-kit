import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { commands, Flags } from '../../src/delivery/cli.ts';
import { buildContainer } from '../../src/delivery/container.ts';
import type { ContainerOverrides } from '../../src/delivery/container.ts';
import { ConfigSchema } from '../../src/domain/config.ts';
import type { Config } from '../../src/domain/config.ts';
import { FakeBoardGateway, catalogField, catalogOf } from '../fakes/fake-board-gateway.ts';
import { FakeCoordination } from '../fakes/fake-coordination.ts';
import { FakeDependencyReader } from '../fakes/fake-dependencies.ts';
import { FakeForge } from '../fakes/fake-forge.ts';
import { FakeForgeCoordination } from '../fakes/fake-forge-coordination.ts';
import { FakeIssueGateway } from '../fakes/fake-issue-gateway.ts';
import { FakeClock, FakeSleeper } from '../fakes/in-memory-time.ts';
import { writeAppKey } from '../fixtures/app-key.ts';
import { testConfig } from '../fixtures/config.ts';
import { syncConfig } from '../fixtures/sync.ts';

const ENTRY = join(import.meta.dirname, '..', '..', 'bin', 'board-queue.ts');
const TOKEN = 'dibs_imp_pppppppppppppppppppppppp';

type Spoken = { code: number; out: string[]; err: string[] };

/** The environment variables a pass reads from its process, set for one test and put back after it. */
function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  const before: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  });
}

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-service-pass-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function overrides(login: () => Promise<string | null>, extra: ContainerOverrides = {}): ContainerOverrides {
  const board = new FakeBoardGateway({ catalog: catalogOf(catalogField('Status', ['Todo', 'In Progress'])) });
  const clock = new FakeClock('2026-03-02T09:00:00.000Z');
  return {
    lanes: () => ({ board, issues: new FakeIssueGateway([]) }),
    clock,
    sleeper: new FakeSleeper(clock),
    coordination: new FakeCoordination(),
    dependencies: new FakeDependencyReader(),
    identity: { login },
    ...extra,
  };
}

/** One scheduled pass through the command line's own `tick`, on a real queue file. */
async function tickWith(t: TestContext, config: Config, stand: ContainerOverrides): Promise<Spoken> {
  const stateDir = scratch(t);
  const container = buildContainer({ config, stateDir, overrides: stand });
  t.after(() => {
    container.close();
  });
  const command = commands['tick'];
  assert.ok(command !== undefined);
  const spoken: Spoken = { code: 0, out: [], err: [] };
  const code = await command.run({
    positionals: [],
    flags: new Flags({}, command.usage),
    out: (line) => spoken.out.push(line),
    err: (line) => spoken.err.push(line),
    container: () => container,
    stdin: () => Promise.resolve(''),
    home: tmpdir(),
    cwd: tmpdir(),
    nodePath: process.execPath,
    configHome: null,
  });
  spoken.code = typeof code === 'number' ? code : 0;
  return spoken;
}

function asTheService(t: TestContext, extra: Record<string, string | undefined> = {}): void {
  const keyDir = scratch(t);
  withEnvironment(t, {
    BOARD_QUEUE_SCHEDULED: '1',
    BOARD_QUEUE_IDENTITY: 'app',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_INSTALLATION_ID: undefined,
    GITHUB_APP_PRIVATE_KEY_PATH: writeAppKey(keyDir).path,
    DIBS_TEST_TOKEN: TOKEN,
    DIBS_TEST_TOKEN_FILE: undefined,
    ...extra,
  });
}

describe('a pass of the service that declines its job', () => {
  it('ends with the code for an App that is not the configured owner, and says so', async (t) => {
    asTheService(t);

    const spoken = await tickWith(t, syncConfig, overrides(() => Promise.resolve('example-other[bot]')));

    assert.equal(spoken.code, 4);
    assert.match(spoken.err.join('\n'), /^the service declined its job: the GitHub App is not the configured owner — this worker runs as example-other\[bot\]/);
  });

  it('ends with the code for an identity that could not be read', async (t) => {
    asTheService(t);

    const spoken = await tickWith(t, syncConfig, overrides(() => Promise.reject(new Error('reading which App the key belongs to answered 401'))));

    assert.equal(spoken.code, 3);
    assert.match(spoken.err.join('\n'), /the GitHub App's login could not be read — .*answered 401/);
  });

  it('ends with the code for forge jobs that would not run under the App', async (t) => {
    asTheService(t);
    const forgeOnly = ConfigSchema.parse({
      ...testConfig,
      dibs: { ...syncConfig.dibs, mirror: undefined, importer: { enabled: false }, forge: { enabled: true } },
    });

    const spoken = await tickWith(t, forgeOnly, overrides(() => Promise.resolve('alice'), {
      forge: new FakeForge(),
      forgeCoordination: new FakeForgeCoordination(),
      forgeIdentity: { usesAppIdentity: () => false },
    }));

    assert.equal(spoken.code, 5);
    assert.match(spoken.err.join('\n'), /the forge jobs would not run under the App's credential/);
  });

  it('ends with the code for refused credentials, before anything else runs, when its key went missing', async (t) => {
    asTheService(t, { GITHUB_APP_PRIVATE_KEY_PATH: join(tmpdir(), 'no-such-dir-for-board-queue', 'app.pem') });
    let asked = false;

    const spoken = await tickWith(t, syncConfig, overrides(() => {
      asked = true;
      return Promise.resolve('alice');
    }));

    assert.equal(spoken.code, 6);
    assert.equal(asked, false);
    assert.match(spoken.err.join('\n'), /the App's key or the coordination server's token was refused — the file named by GITHUB_APP_PRIVATE_KEY_PATH is not there/);
  });

  it('ends cleanly when it does its job', async (t) => {
    asTheService(t);

    const spoken = await tickWith(t, syncConfig, overrides(() => Promise.resolve('alice')));

    assert.equal(spoken.code, 0, spoken.err.join('\n'));
    assert.deepEqual(spoken.err, []);
  });

  it('is an ordinary answer on a person\'s machine, which simply is not the owner', async (t) => {
    withEnvironment(t, { BOARD_QUEUE_SCHEDULED: '1', BOARD_QUEUE_IDENTITY: undefined });

    const spoken = await tickWith(t, syncConfig, overrides(() => Promise.resolve('bob')));

    assert.equal(spoken.code, 0);
    assert.deepEqual(spoken.err, []);
  });

  it('exits with that code as a process, which is what the service\'s schedule reads', async (t) => {
    const directory = scratch(t);
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify(syncConfig), 'utf8');
    const child = spawn(process.execPath, [ENTRY, 'tick'], {
      env: {
        PATH: '/nonexistent',
        BOARD_QUEUE_CONFIG: configPath,
        BOARD_QUEUE_STATE_DIR: join(directory, 'state'),
        BOARD_QUEUE_SCHEDULED: '1',
        BOARD_QUEUE_IDENTITY: 'app',
        GITHUB_APP_ID: '123456',
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

    assert.equal(code, 6, err);
    assert.match(err, /set GITHUB_APP_PRIVATE_KEY_PATH/);
  });
});
