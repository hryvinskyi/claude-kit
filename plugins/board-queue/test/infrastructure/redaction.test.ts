import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from '../../src/infrastructure/redaction.ts';

const KEY_LINES = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAsomethingverysecretindeed',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '-----END RSA PRIVATE KEY-----',
];

describe('what a credential looks like', () => {
  it('removes the token shapes GitHub issues', () => {
    const redacted = redactSecrets('the call carried ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and github_pat_xyz123');
    assert.equal(redacted.includes('ghs_'), false);
    assert.equal(redacted.includes('github_pat_'), false);
  });

  it('removes a token of the coordination server', () => {
    const redacted = redactSecrets('the call carried dibs_' + 'a1B2-c3_'.repeat(5) + ' and nothing else');
    assert.equal(redacted, 'the call carried [redacted] and nothing else');
  });

  it('removes a key block whatever its line breaks are made of', () => {
    // A key read from a file still has its newlines; one that came through an
    // environment variable often has the two characters a backslash and an n.
    for (const separator of ['\n', '\\n']) {
      const redacted = redactSecrets(`the App key is ${KEY_LINES.join(separator)} and that is all`);
      assert.equal(redacted.includes('MIIEowIBAAKCAQEAsomethingverysecretindeed'), false, separator);
      assert.equal(redacted.includes('BEGIN RSA'), false, separator);
      assert.match(redacted, /^the App key is \[redacted\] and that is all$/);
    }
  });

  it('removes the header a credential travels in, whatever shape the credential is', () => {
    const redacted = redactSecrets('sent authorization: Bearer v1.' + '9f8a7b6c5d4e3f2a'.repeat(2) + '1b0c9d8e');
    assert.equal(redacted.includes('9f8a7b6c5d4e3f2a'), false);
    assert.match(redacted, /\[redacted\]/);
  });

  it('leaves text that only looks technical alone', () => {
    const sentence = 'Severity has no option matching "S9"; it accepts: S1 · blocking, S2 · broken';
    assert.equal(redactSecrets(sentence), sentence);
    assert.equal(redactSecrets('Bearer with me'), 'Bearer with me');
  });
});
