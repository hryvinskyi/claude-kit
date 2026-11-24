# Looking for candidates — searches by language

These searches list **candidates**. Each hit is opened and judged by the three questions of
`SKILL.md`; the last column says what makes it innocent. A hit is never a verdict.

Patterns are ripgrep (`rg -n`; the Grep tool takes them as they are), passed in **single quotes**:
double quotes let the shell rewrite the backslashes, and the sweep then matches nothing without
saying so. In a table cell `\|` is Markdown's escape for `|`, dropped when you copy. Run a recipe on
a file known to hold a hit first: a sweep that finds nothing proves nothing until it has found
something. Give every search the project's test directories and nothing else.

Two things no search finds, and they are most of what a suite carries twice:

- **A duplicate proof** has no textual mark. It is found by reading two tests side by side. Start
  where `pipeline-suite census` puts the cost: the costliest files, and the widest parameter sets at
  an expensive level.
- **A test that restates** looks like any other assertion. It is found by reading the production line
  it mirrors.

The two counts at the end of each section are the nearest thing to a search for duplicates.

## PHP (PHPUnit)

Glob for every row: `-g '*Test.php'`.

| Class | Search | Innocent when |
|---|---|---|
| file-read | `file_get_contents\(\|Yaml::parse\|\bglob\(\|token_get_all\(\|simplexml_load\|->loadXML\(\|SplFileObject\|parse_ini_file\(` | the file is one the test wrote, a fixture the test owns, or what the code under test produced (an export, an upload) |
| restates, tool, gate | `new \\?Reflection(Class\|Method\|Property\|Enum\|NamedType)\(\|\b(method\|class\|interface\|enum\|property)_exists\(\|->isFinal\(\)\|->getAttributes\(\|->implementsInterface\(` | reflection is the means and not the claim: it walks every case of an enum, or every class of a kind, to hold each one to a rule that code runs |
| vacuous | `assertTrue\(\s*true\s*\)\|addToAssertionCount\(\|expectNotToPerformAssertions\(` | the claim is that a call does not throw, and a sibling test shows the input that does |
| dead | `markTestSkipped\(\|markTestIncomplete\(` | the condition is false in at least one place the project's suite runs — find the place |
| implementation | `setAccessible\(\|->getProperty\(\|->getMethod\(\|withConsecutive\(` and `-e '->expects\(\s*(self\|static\|\$this)(::\|->)(exactly\|atLeast\|atMost)\('` | the count is the outcome (*one message is sent, never two*), and no fake of the collaborator would show it more plainly |
| duplicate (product of factors) | `-U 'foreach \([^\n]*\) \{\s*\n\s*foreach \('` | the code makes the two factors interact |

One check copied into many files, and one table copied to a second level:

```sh
rg -o --no-filename 'function (test\w+)' -r '$1' -g '*Test.php' <test dirs> | sort | uniq -c | sort -rn | head -40
rg -o --no-filename 'public static function (\w+)\(\): (iterable|array|\\?Generator)' -r '$1' -g '*Test.php' <test dirs> | sort | uniq -c | sort -rn | head -40
```

A test name that stands in a dozen files is one check written a dozen times: innocent when each copy
runs different production code, a candidate for one suite-wide check when they all run the same. A
provider name that stands at two levels of one module is a table repeated.

## JavaScript and TypeScript (node:test, Jest, Vitest)

Glob for every row: `-g '*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}'`, with `-g '**/__tests__/**'` where the project keeps tests there.

| Class | Search | Innocent when |
|---|---|---|
| file-read | `readFileSync\(\|readFile\(\|readdirSync\(\|existsSync\(\|require\([^)]*\.(json\|ya?ml)['"]\)` | the file is a fixture the test owns or what the code under test wrote |
| restates, tool, gate | `toBeInstanceOf\(\|toBeDefined\(\)\|toBeTruthy\(\)\|expectTypeOf\(\|typeof [\w.]+ ===` | it is one assertion among others that state the rule; in a project that type-checks, a type-only assertion is the checker's work |
| vacuous | `expect\(true\)\|expect\.assertions\(0\)\|assert\.ok\(true\)` | never |
| dead | `\b(it\|test\|describe)\.(skip\|todo)\(\|\bx(it\|test\|describe)\(` | never in a suite that claims the behaviour is tested |
| implementation | `toHaveBeenCalledTimes\(\|toHaveBeenNthCalledWith\(\|mock\.calls\[\|toMatchSnapshot\(\|toMatchInlineSnapshot\(` | the call is the outcome; a snapshot holds a contract another system reads and is small enough to be read in review |
| rows to count | `\.each\(\|for \(const [^)]* of [^)]*\) \{?\s*(it\|test)\(` | each row takes a branch no other row takes, or is one member of a closed set |

```sh
rg -o --no-filename "(?:it|test)\(\s*['\"\`]([^'\"\`]+)" -r '$1' -g '*.{test,spec}.*' <test dirs> | sort | uniq -c | sort -rn | head -40
```

## Python (pytest, unittest)

Glob for every row: `-g 'test_*.py' -g '*_test.py'`.

| Class | Search | Innocent when |
|---|---|---|
| file-read | `\bopen\(\|\.read_text\(\|yaml\.safe_load\|json\.load\(\|tomllib\.load` | the file is a fixture the test owns or what the code under test wrote |
| restates, tool, gate | `assert isinstance\(\|assertIsInstance\(\|\bhasattr\(\|assert callable\(` | it is one assertion among others that state the rule; in a project that runs a type checker, the type is the checker's work |
| vacuous | `assert True\b\|assertTrue\(True\)\|^\s*pass\s*$` | never, in a test body |
| dead | `pytest\.mark\.skip\|pytest\.mark\.xfail\|unittest\.skip\|pytest\.skip\(\|self\.skipTest\(` | the condition is false in at least one place the project's suite runs |
| implementation | `assert_called_once_with\(\|call_args_list\|assert_has_calls\(\|mock_calls` | the call is the outcome |
| rows to count | `pytest\.mark\.parametrize\|subTest\(` | each row takes a branch no other row takes, or is one member of a closed set |

```sh
rg -o --no-filename 'def (test_\w+)' -r '$1' -g 'test_*.py' -g '*_test.py' <test dirs> | sort | uniq -c | sort -rn | head -40
```
