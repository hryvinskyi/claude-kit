import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, keys, message } from '../../src/messages.js';
import { QUOTE_REASONS } from '../../src/quote.js';
import { POSTCODE_REASONS } from '../../src/postcode.js';

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

test('every reason a request is refused for is worded in every language', () => {
  for (const reason of [...QUOTE_REASONS, ...POSTCODE_REASONS]) {
    for (const language of LANGUAGES) {
      assert.notEqual(message(reason, language), reason, `${reason} has no wording in ${language}`);
    }
  }
});

test('a language the product does not ship answers the key', () => {
  assert.equal(message('too_heavy', 'fr'), 'too_heavy');
});
