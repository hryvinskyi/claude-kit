import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnknownKind } from '../../src/domain/errors.ts';
import { defaultKindRegistry, defaultKinds } from '../../src/domain/kinds/default-kinds.ts';
import { KindRegistry } from '../../src/domain/kinds/registry.ts';
import { SetFieldsKind } from '../../src/domain/kinds/set-fields.ts';
import { VerifyKind } from '../../src/domain/kinds/verify.ts';
import { CommentKind } from '../../src/domain/kinds/comment.ts';
import { CloseKind } from '../../src/domain/kinds/close.ts';
import { testConfig } from '../fixtures/config.ts';

const setFields = new SetFieldsKind(testConfig);
const verify = new VerifyKind(testConfig);
const comment = new CommentKind();
const close = new CloseKind();

function refuses(kind: { payloadSchema: { safeParse: (value: unknown) => { success: boolean } } }, payload: unknown): void {
  assert.equal(kind.payloadSchema.safeParse(payload).success, false);
}

describe('board.set-fields', () => {
  it('takes a repository, an issue number and at least one field', () => {
    const parsed = setFields.payloadSchema.parse({
      repo: 'example-org/first-repo',
      issue: 12,
      fields: { status: 'In Progress', type: 'Bug' },
    });
    assert.deepEqual(parsed, {
      repo: 'example-org/first-repo',
      issue: 12,
      fields: { status: 'In Progress', type: 'Bug' },
    });
  });

  it('refuses a payload that would write nothing, or write somewhere unintended', () => {
    refuses(setFields, { repo: 'first-repo', issue: 12, fields: { status: 'In Progress' } });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 0, fields: { status: 'In Progress' } });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 1.5, fields: { status: 'In Progress' } });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 12, fields: {} });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 12, fields: { status: '  ' } });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 12, fields: { priority: 'high' } });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 12 });
    refuses(setFields, { repo: 'example-org/first-repo', issue: 12, fields: { status: 'x' }, extra: 1 });
  });

  it('refuses the status the board would auto-close on, in any case, while it is being asked for', () => {
    for (const status of ['Done', 'done', 'DONE']) {
      const result = setFields.payloadSchema.safeParse({
        repo: 'example-org/first-repo',
        issue: 12,
        fields: { status },
      });
      assert.equal(result.success, false);
      assert.ok(!result.success && result.error.issues[0]?.message.includes('auto-close'));
      assert.ok(!result.success && result.error.issues[0]?.path.join('.') === 'fields');
    }
  });

  it('names the issue it is about', () => {
    const ref = setFields.issueRefOf({
      repo: 'example-org/first-repo',
      issue: 12,
      fields: { status: 'In Progress' },
    });
    assert.equal(ref?.toString(), 'example-org/first-repo#12');
  });

  it('merges two waiting requests field by field, the later one winning', () => {
    const merged = setFields.coalesce(
      { repo: 'example-org/first-repo', issue: 12, fields: { status: 'In Progress', severity: 'S3' } },
      { repo: 'example-org/first-repo', issue: 12, fields: { severity: 'S1', module: 'Checkout' } },
    );
    assert.deepEqual(merged, {
      repo: 'example-org/first-repo',
      issue: 12,
      fields: { status: 'In Progress', severity: 'S1', module: 'Checkout' },
    });
  });
});

describe('board.verify', () => {
  it('expects any status, including the one writes refuse', () => {
    const parsed = verify.payloadSchema.parse({
      repo: 'example-org/first-repo',
      issue: 237,
      expect: { status: 'Done' },
    });
    assert.deepEqual(parsed.expect, { status: 'Done' });
  });

  it('takes an optional membership expectation and refuses an unknown field', () => {
    assert.equal(
      verify.payloadSchema.parse({ repo: 'example-org/first-repo', issue: 1, expect: { status: 'Backlog' }, onBoard: false }).onBoard,
      false,
    );
    refuses(verify, { repo: 'example-org/first-repo', issue: 1, expect: { priority: 'high' } });
    refuses(verify, { repo: 'example-org/first-repo', issue: 1, expect: {} });
    refuses(verify, { repo: 'example-org/first-repo', issue: 1 });
  });

  it('needs nothing to compare when it asserts the issue is deliberately absent', () => {
    const parsed = verify.payloadSchema.parse({ repo: 'example-org/first-repo', issue: 1, onBoard: false });
    assert.equal(parsed.onBoard, false);
    assert.equal(parsed.expect, undefined);
    // Every other shape is a question with no question in it.
    refuses(verify, { repo: 'example-org/first-repo', issue: 1, onBoard: true });
  });

  it('never merges: two questions have two answers', () => {
    assert.equal(verify.coalesce({ a: 1 }, { b: 2 }), null);
    assert.equal(verify.issueRefOf({ repo: 'example-org/first-repo', issue: 1, expect: { status: 'x' } })?.number, 1);
  });
});

describe('issue.comment and issue.close', () => {
  it('takes a comment body that says something', () => {
    assert.equal(
      comment.payloadSchema.parse({ repo: 'example-org/first-repo', issue: 3, body: 'tested on staging' }).body,
      'tested on staging',
    );
    refuses(comment, { repo: 'example-org/first-repo', issue: 3, body: '' });
    refuses(comment, { repo: 'example-org/first-repo', issue: 3 });
    assert.equal(comment.coalesce({ a: 1 }, { b: 2 }), null);
    assert.equal(comment.issueRefOf({ repo: 'example-org/first-repo', issue: 3, body: 'x' })?.number, 3);
  });

  it('refuses a body longer than the one GitHub accepts', () => {
    // A longer body comes back as a 422, which reads as a fault of the moment and
    // would be retried five times before the action gave up. The length is a rule
    // of this system too, and it belongs where the person who typed it can see it.
    const tooLong = 'x'.repeat(65_537);
    refuses(comment, { repo: 'example-org/first-repo', issue: 3, body: tooLong });
    refuses(close, { repo: 'example-org/first-repo', issue: 3, reason: 'completed', comment: tooLong });
    assert.equal(
      comment.payloadSchema.parse({ repo: 'example-org/first-repo', issue: 3, body: 'x'.repeat(65_536) }).body.length,
      65_536,
    );
  });

  it('takes one of the two reasons an issue is closed for', () => {
    const parsed = close.payloadSchema.parse({
      repo: 'example-org/first-repo',
      issue: 3,
      reason: 'not_planned',
      comment: 'superseded',
    });
    assert.equal(parsed.reason, 'not_planned');
    assert.equal(close.payloadSchema.parse({ repo: 'example-org/first-repo', issue: 3, reason: 'completed' }).comment, undefined);
    refuses(close, { repo: 'example-org/first-repo', issue: 3, reason: 'wontfix' });
    refuses(close, { repo: 'example-org/first-repo', issue: 3 });
    assert.equal(close.coalesce({ a: 1 }, { b: 2 }), null);
    assert.equal(close.issueRefOf({ repo: 'example-org/first-repo', issue: 3, reason: 'completed' })?.number, 3);
  });
});

describe('KindRegistry', () => {
  it('resolves the kinds this system ships with', () => {
    const registry = defaultKindRegistry(testConfig);
    assert.deepEqual(
      registry.names(),
      ['board.set-fields', 'board.verify', 'issue.comment', 'issue.close', 'issue.assignees'],
    );
    assert.equal(registry.all().length, 5);
    assert.equal(registry.get('issue.close').name, 'issue.close');
    assert.ok(registry.has('board.verify'));
    assert.ok(!registry.has('board.magic'));
  });

  it('fails loudly on a name nobody registered, and lists the names it knows', () => {
    assert.throws(
      () => defaultKindRegistry(testConfig).get('board.magic'),
      (error: unknown) => error instanceof UnknownKind
        && error.wanted === 'board.magic'
        && error.describe().includes('board.set-fields'),
    );
  });

  it('refuses two kinds registered under one name', () => {
    assert.throws(() => new KindRegistry([new CommentKind(), new CommentKind()]), /two action kinds/);
  });

  it('gives every kind a paragraph that teaches the caller the rules', () => {
    for (const kind of defaultKinds(testConfig)) {
      assert.ok(kind.describe.length > 200, `${kind.name} needs a description`);
      assert.ok(kind.name.includes('.'));
    }
  });
});
