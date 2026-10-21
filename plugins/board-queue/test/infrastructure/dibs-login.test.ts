import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { dibsCredentialsPath, normalServer, tokenFromDibsLogin } from '../../src/infrastructure/dibs-login.ts';

const TOKEN = 'dibs_loginloginloginloginloginloginlogin';
const OTHER = 'dibs_otherotherotherotherotherotherother';

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'board-queue-dibs-login-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Writes the file the way `dibs login` does: in a directory of the account's own, readable by nobody else. */
function writeLogin(directory: string, text: string, mode = 0o600): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'credentials.toml');
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function entry(server: string, project: string, value: string): string {
  return `[[credential]]\nserver = "${server}"\nproject = "${project}"\n${value}\n\n`;
}

function refusalOf(read: () => string): string {
  try {
    read();
  } catch (error) {
    assert.ok(error instanceof RefusedByRule);
    return error.describe();
  }
  assert.fail('a token was read');
}

describe('where the dibs tool keeps its logins', () => {
  const deps = { server: 'https://dibs.example.com', project: 'widgets' };

  it('is the directory DIBS_CONFIG_DIR names, whatever else is set', () => {
    assert.equal(
      dibsCredentialsPath({ ...deps, env: { DIBS_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/x', HOME: '/h' }, platform: 'linux' }),
      '/c/credentials.toml',
    );
  });

  it('is under XDG_CONFIG_HOME, else under ~/.config, on macOS as on Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      assert.equal(
        dibsCredentialsPath({ ...deps, env: { XDG_CONFIG_HOME: '/x', HOME: '/h' }, platform }),
        '/x/dibs/credentials.toml',
      );
      assert.equal(
        dibsCredentialsPath({ ...deps, env: { DIBS_CONFIG_DIR: ' ', HOME: '/h' }, platform }),
        '/h/.config/dibs/credentials.toml',
      );
      assert.equal(
        dibsCredentialsPath({ ...deps, env: {}, platform, home: () => '/home/alice' }),
        '/home/alice/.config/dibs/credentials.toml',
      );
    }
  });
});

describe('the token a dibs login stored', () => {
  it('is the one stored for the configured server and project, whichever way the server is spelled', (t) => {
    const directory = scratch(t);
    writeLogin(directory, entry('https://dibs.example.com', 'globex', `token = "${OTHER}"`)
      + entry('https://dibs.example.com', 'widgets', `token = "${TOKEN}"`)
      + entry('https://other.example.com', 'widgets', `token = "${OTHER}"`));

    const read = tokenFromDibsLogin({ server: 'HTTPS://Dibs.Example.com:443/', project: 'widgets', env: { DIBS_CONFIG_DIR: directory } });

    assert.equal(read(), TOKEN);
  });

  it('is read at each call, so a login renewed since is the one sent', (t) => {
    const directory = scratch(t);
    const read = tokenFromDibsLogin({ server: 'https://dibs.example.com', project: 'widgets', env: { DIBS_CONFIG_DIR: directory } });
    writeLogin(directory, entry('https://dibs.example.com', 'widgets', `token = "${OTHER}"`));
    assert.equal(read(), OTHER);

    writeLogin(directory, entry('https://dibs.example.com', 'widgets', `token = "${TOKEN}"`));

    assert.equal(read(), TOKEN);
  });

  it('is refused for a login of another server or project, naming what the file holds and never a token', (t) => {
    const directory = scratch(t);
    writeLogin(directory, entry('https://dibs.example.com/', 'globex', `token = "${OTHER}"`)
      + entry('https://other.example.com', 'widgets', `token = "${OTHER}"`));

    const refusal = refusalOf(tokenFromDibsLogin({
      server: 'https://dibs.example.com',
      project: 'widgets',
      env: { DIBS_CONFIG_DIR: directory },
    }));

    assert.equal(
      refusal,
      'the dibs login file holds no login for widgets on https://dibs.example.com '
      + '(it holds: globex on https://dibs.example.com, widgets on https://other.example.com); '
      + 'run dibs login for widgets on that server, or name the token in an environment variable',
    );
  });

  it('is refused for a login kept in the operating system\'s credential store, saying why', (t) => {
    const directory = scratch(t);
    writeLogin(directory, entry('https://dibs.example.com', 'widgets', 'keychain = true'));

    const refusal = refusalOf(tokenFromDibsLogin({
      server: 'https://dibs.example.com',
      project: 'widgets',
      env: { DIBS_CONFIG_DIR: directory },
    }));

    assert.match(refusal, /kept in the operating system's credential store \(dibs login --keychain\), which a scheduled worker cannot read; sign in again without --keychain/);
  });

  it('is refused on Windows, saying so plainly, and for a configured server that is no address', (t) => {
    const directory = scratch(t);
    writeLogin(directory, entry('https://dibs.example.com', 'widgets', `token = "${TOKEN}"`)
      + entry('not an address', 'widgets', `token = "${OTHER}"`));

    assert.equal(
      refusalOf(tokenFromDibsLogin({
        server: 'https://dibs.example.com',
        project: 'widgets',
        env: { DIBS_CONFIG_DIR: directory },
        platform: 'win32',
      })),
      'a stored dibs login is not read on Windows; name the token in an environment variable instead',
    );
    assert.match(
      refusalOf(tokenFromDibsLogin({ server: 'not an address either', project: 'widgets', env: { DIBS_CONFIG_DIR: directory } })),
      /is no server address a dibs login is stored under/,
    );
  });

  it('is refused when the file can be read by anybody else, or is not there', (t) => {
    const directory = scratch(t);
    const read = tokenFromDibsLogin({ server: 'https://dibs.example.com', project: 'widgets', env: { DIBS_CONFIG_DIR: directory } });
    assert.match(refusalOf(read), /the dibs login file is not there, or this account cannot read it/);

    writeLogin(directory, entry('https://dibs.example.com', 'widgets', `token = "${TOKEN}"`), 0o644);

    const refusal = refusalOf(read);
    assert.match(refusal, /the dibs login file is mode 644; take every permission away from its group/);
    assert.ok(!refusal.includes(TOKEN));
  });

  it('is refused when the file holds no logins the dibs tool would write, or no token a login holds', (t) => {
    const directory = scratch(t);
    const read = tokenFromDibsLogin({ server: 'https://dibs.example.com', project: 'widgets', env: { DIBS_CONFIG_DIR: directory } });
    for (const [text, says] of [
      [`${entry('https://dibs.example.com', 'widgets', `token = "${TOKEN}"`)}colour = "blue"\n`, /holds something other than dibs logins/],
      ['[[profile]]\nname = "x"\n', /holds something other than dibs logins/],
      [entry('https://dibs.example.com', 'widgets', 'keychain = false'), /the dibs login for widgets on https:\/\/dibs.example.com holds no token/],
      [entry('https://dibs.example.com', 'widgets', 'token = "dibs_has a space"'), /holds no valid token/],
      [`[[credential]]\nserver = "https://dibs.example.com"\nproject = widgets\ntoken = "${TOKEN}"\n`, /line 3 of the dibs login file/],
    ] as const) {
      writeLogin(directory, text);
      const refusal = refusalOf(read);
      assert.match(refusal, says);
      assert.ok(!refusal.includes(TOKEN), refusal);
    }
  });
});

describe('the one spelling of a server', () => {
  it('lower-cases scheme and host and drops a default port and trailing slashes, keeping a path', () => {
    assert.equal(normalServer('HTTPS://Dibs.Example.COM:443/'), 'https://dibs.example.com');
    assert.equal(normalServer(' https://dibs.example.com:8443/team// '), 'https://dibs.example.com:8443/team');
    assert.equal(normalServer('http://localhost:8080'), 'http://localhost:8080');
    assert.equal(normalServer('ftp://dibs.example.com'), null);
    assert.equal(normalServer('not an address'), null);
  });
});
