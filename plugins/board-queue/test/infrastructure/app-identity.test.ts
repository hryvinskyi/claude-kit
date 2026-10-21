import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { AppIdentity } from '../../src/infrastructure/app-identity.ts';
import type { AppSelf } from '../../src/infrastructure/app-identity.ts';

class ScriptedApp implements AppSelf {
  asked = 0;
  readonly #answers: (() => Promise<string>)[];

  constructor(...answers: (() => Promise<string>)[]) {
    this.#answers = answers;
  }

  appLogin(): Promise<string> {
    const answer = this.#answers[Math.min(this.asked, this.#answers.length - 1)];
    this.asked += 1;
    return answer === undefined ? Promise.reject(new Error('nothing scripted')) : answer();
  }
}

describe('the login of the App a service runs as', () => {
  it('is what the App says it is, asked once for the life of the process', async () => {
    const app = new ScriptedApp(async () => 'example-sync[bot]');
    const identity = new AppIdentity(() => app);

    assert.equal(await identity.login(), 'example-sync[bot]');
    assert.equal(await identity.login(), 'example-sync[bot]');
    assert.equal(app.asked, 1);
  });

  it('asks again after a failure rather than keeping it', async () => {
    const app = new ScriptedApp(
      async () => {
        throw new Error('reading which App the key belongs to answered 401');
      },
      async () => 'example-sync[bot]',
    );
    const identity = new AppIdentity(() => app);

    await assert.rejects(() => identity.login(), /answered 401/);
    assert.equal(await identity.login(), 'example-sync[bot]');
  });

  it('refuses, naming what to set, when the environment names no App', async () => {
    const identity = new AppIdentity(() => null);

    await assert.rejects(() => identity.login(), (error: unknown) => {
      assert.ok(error instanceof RefusedByRule);
      assert.match(error.describe(), /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH/);
      return true;
    });
  });
});
