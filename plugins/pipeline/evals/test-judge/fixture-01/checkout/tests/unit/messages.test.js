import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, keys, message } from '../../src/messages.js';

test('every message is worded in every language', () => {
  assert.ok(keys().length > 0);
  for (const key of keys()) {
    for (const language of LANGUAGES) {
      const worded = message(key, language);
      assert.notEqual(worded, key, `${key} has no wording in ${language}`);
      assert.notEqual(worded.trim(), '', `${key} is empty in ${language}`);
    }
  }
});

test('a language the product does not ship answers the key', () => {
  assert.equal(message('too_heavy', 'fr'), 'too_heavy');
});
