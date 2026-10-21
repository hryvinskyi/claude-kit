import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefusedByRule } from '../../src/domain/errors.ts';
import { parseTomlTables } from '../../src/infrastructure/toml-tables.ts';

const SECRET = 'dibs_secretsecretsecretsecretsecretsecret';

function refusalOf(text: string): string {
  try {
    parseTomlTables(text, 'the file');
  } catch (error) {
    assert.ok(error instanceof RefusedByRule);
    return error.describe();
  }
  assert.fail('the text was read');
}

describe('reading the TOML a credentials file is written in', () => {
  it('reads arrays of tables, as the dibs tool writes them', () => {
    const document = parseTomlTables([
      '[[credential]]',
      'server = "https://dibs.example.com"',
      'project = "acme"',
      `token = "${SECRET}"`,
      '',
      '[[credential]]',
      'server = "https://other.example.com"',
      'project = "globex"',
      'keychain = true',
      '',
    ].join('\n'), 'the file');

    assert.deepEqual(document, {
      root: {},
      arrays: {
        credential: [
          { server: 'https://dibs.example.com', project: 'acme', token: SECRET },
          { server: 'https://other.example.com', project: 'globex', keychain: true },
        ],
      },
    });
  });

  it('reads comments, keys before any header, literal strings, escapes and Windows line ends', () => {
    const document = parseTomlTables([
      '# written by hand',
      'version = \'1\'  # a literal string',
      '[[ credential ]]',
      'server = "https://dibs.example.com/a\\u00e9\\"b\\\\" # trailing',
      'keychain = false',
    ].join('\r\n'), 'the file');

    assert.deepEqual(document, {
      root: { version: '1' },
      arrays: { credential: [{ server: 'https://dibs.example.com/aé"b\\', keychain: false }] },
    });
  });

  it('refuses what it does not understand by line, never repeating the line', () => {
    for (const [text, says] of [
      [`[credential]\ntoken = "${SECRET}"`, /line 1 of the file is neither a \[\[table\]\] header/],
      [`[[credential]]\ntoken = ${SECRET}`, /line 2 of the file holds a value that is neither a string nor true or false/],
      [`[[credential]]\ntoken = "${SECRET}`, /line 2 of the file opens a string it never closes/],
      [`[[credential]]\ntoken = "${SECRET}" "again"`, /line 2 of the file holds something after its value/],
      [`[[credential]]\ntoken = "${SECRET}"\ntoken = "${SECRET}"`, /line 3 of the file names a key the table already holds/],
      [`[[credential]]\ntoken = "\\q${SECRET}"`, /line 2 of the file holds an escape TOML does not define/],
      [`[[credential]]\ntoken = "\\ud800${SECRET}"`, /line 2 of the file escapes a character that does not exist/],
      [`count = 3\n[[credential]]`, /line 1 of the file holds a value that is neither/],
      [`credential = "x"\n[[credential]]`, /line 2 of the file starts tables under a name that already holds a value/],
    ] as const) {
      const refusal = refusalOf(text);
      assert.match(refusal, says);
      assert.ok(!refusal.includes(SECRET), refusal);
    }
  });

  it('reads what the dibs tool\'s writer emits for strings with quotes, backslashes and line ends', () => {
    // Printed by the toml crate the dibs command line tool writes its file with
    // (toml 1.1.8, toml::to_string over the same shape).
    const head = '[[credential]]\nserver = "https://dibs.example.com"\nproject = "acme"\n';
    const quoted = `${head}token = '''dibs_has"quote\\and'apostrophe'''\n`;
    const lines = `${head}token = """\nline one\nline two"""\n`;
    const both = `${head}token = """\nit's "x"\nnext"""\n`;

    assert.equal(tokenOf(quoted), 'dibs_has"quote\\and\'apostrophe');
    assert.equal(tokenOf(lines), 'line one\nline two');
    assert.equal(tokenOf(both), 'it\'s "x"\nnext');
  });

  it('reads the rest of TOML\'s multi-line strings: escapes, a backslash at a line end, quotes before the close', () => {
    const document = parseTomlTables([
      '[[credential]]',
      'one = """\\',
      '    joined \\u00e9\\n"""',
      'two = """ends in two quotes"""""',
      'three = \'\'\'',
      'raw \\n kept\'\'\'',
    ].join('\n'), 'the file');

    assert.deepEqual(document.arrays['credential'], [{ one: 'joined é\n', two: 'ends in two quotes""', three: 'raw \\n kept' }]);
  });

  it('reads a key that is a name of every object as a key like any other', () => {
    const document = parseTomlTables('[[constructor]]\n__proto__ = "x"\ntoString = true\n', 'the file');

    assert.deepEqual(Object.keys(document.arrays), ['constructor']);
    assert.equal(document.arrays['constructor']?.[0]?.['__proto__'], 'x');
    assert.equal(document.arrays['constructor']?.[0]?.['toString'], true);
  });

  it('refuses a multi-line string it never closes, on the line it opens', () => {
    assert.equal(refusalOf(`[[credential]]\ntoken = """\n${SECRET}\n`), 'line 2 of the file opens a string it never closes');
    assert.equal(refusalOf(`[[credential]]\ntoken = '''${SECRET}`), 'line 2 of the file opens a string it never closes');
  });
});

function tokenOf(text: string): unknown {
  return parseTomlTables(text, 'the file').arrays['credential']?.[0]?.['token'];
}
