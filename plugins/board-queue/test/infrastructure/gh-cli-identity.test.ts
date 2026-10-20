import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GhCliIdentity } from '../../src/infrastructure/gh-cli-identity.ts';

describe('the login this machine runs as', () => {
  it('is read from the command line tool\'s own configuration, nothing over the network', async () => {
    const asked: string[][] = [];
    const identity = new GhCliIdentity((command, args) => {
      asked.push([command, ...args]);
      return 'alice\n';
    });

    assert.equal(await identity.login(), 'alice');
    assert.deepEqual(asked, [['gh', 'config', 'get', '-h', 'github.com', 'user']]);
  });

  it('is none when the tool is missing or signed in to nobody', async () => {
    const missing = new GhCliIdentity(() => {
      throw new Error('spawn gh ENOENT');
    });
    const nobody = new GhCliIdentity(() => '\n');

    assert.equal(await missing.login(), null);
    assert.equal(await nobody.login(), null);
  });
});
