import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidIssueRef, RefusedByRule } from '../../src/domain/errors.ts';
import { IssueRef, isRepoFullName } from '../../src/domain/issue-ref.ts';
import { testRepos } from '../fixtures/config.ts';

describe('IssueRef', () => {
  it('parses the short form', () => {
    const ref = IssueRef.parse('example-org/first-repo#12');
    assert.equal(ref.owner, 'example-org');
    assert.equal(ref.repo, 'first-repo');
    assert.equal(ref.number, 12);
  });

  it('parses an issue address', () => {
    const ref = IssueRef.parse('https://github.com/example-org/first-repo/issues/237');
    assert.equal(ref.toString(), 'example-org/first-repo#237');
  });

  it('builds from a repository name and a number', () => {
    assert.equal(IssueRef.of('example-org/first-repo', 8).toString(), 'example-org/first-repo#8');
  });

  it('formats itself and its address', () => {
    const ref = IssueRef.of('example-org/first-repo', 5);
    assert.equal(ref.repoFullName(), 'example-org/first-repo');
    assert.equal(ref.url(), 'https://github.com/example-org/first-repo/issues/5');
    assert.equal(ref.key(), 'example-org/first-repo#5');
  });

  it('refuses anything malformed', () => {
    for (const text of ['', 'first-repo#12', 'example-org/first-repo', 'example-org/first-repo#0',
      'example-org/first-repo#-3', 'example-org/first-repo#x', 'https://github.com/example-org/first-repo/pull/12',
      'example org/first repo#1']) {
      assert.throws(() => IssueRef.parse(text), InvalidIssueRef, `expected "${text}" to be refused`);
    }
  });

  it('refuses a number that is not a positive integer', () => {
    assert.throws(() => IssueRef.of('example-org/first-repo', 0), InvalidIssueRef);
    assert.throws(() => IssueRef.of('example-org/first-repo', 1.5), InvalidIssueRef);
    assert.throws(() => IssueRef.of('example-org-first-repo', 1), InvalidIssueRef);
  });

  it('compares owner and repository without regard to case', () => {
    const one = IssueRef.parse('Example-Org/First-Repo#12');
    const other = IssueRef.parse('example-org/first-repo#12');
    assert.ok(one.equals(other));
    assert.ok(one.sameRepo(other));
    assert.ok(!one.equals(IssueRef.parse('example-org/first-repo#13')));
    assert.ok(!one.sameRepo(IssueRef.parse('example-org/other-repo#12')));
  });

  it('answers with the spelling the configuration uses', () => {
    const ref = IssueRef.parse('EXAMPLE-USER/SECOND-REPO#4').canonical(testRepos);
    assert.equal(ref.repoFullName(), 'Example-User/second-repo');
    assert.equal(ref.number, 4);
  });

  it('refuses a repository nobody configured', () => {
    assert.throws(
      () => IssueRef.parse('someone/elses-repo#1').canonical(testRepos),
      (error: unknown) => error instanceof RefusedByRule
        && error.message.includes('example-org/first-repo'),
    );
  });

  it('recognises a repository full name', () => {
    assert.ok(isRepoFullName('example-org/first-repo'));
    assert.ok(!isRepoFullName('first-repo'));
    assert.ok(!isRepoFullName('example-org/first-repo/extra'));
  });
});
