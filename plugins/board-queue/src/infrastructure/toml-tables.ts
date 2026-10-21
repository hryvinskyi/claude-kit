import { RefusedByRule } from '../domain/errors.ts';

/** A value of the TOML this reader understands: a string or a boolean. */
export type TomlScalar = string | boolean;

/** One table: its keys and their values. */
export type TomlTable = Record<string, TomlScalar>;

/** A document: the keys before any header, and each array of tables by its name. */
export type TomlDocument = {
  readonly root: TomlTable;
  readonly arrays: Readonly<Record<string, readonly TomlTable[]>>;
};

const KEY_CHAR = /[A-Za-z0-9_-]/;
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['"', '"'], ['\\', '\\'],
]);
/** How many hex digits each code point escape takes. */
const CODE_POINT_DIGITS: ReadonlyMap<string, number> = new Map([['u', 4], ['U', 8]]);

/**
 * The small part of TOML a file of credentials is written in: comments, arrays of
 * tables (`[[name]]`), and keys whose values are strings — basic or literal, on one
 * line or on several (`"""…"""`, `'''…'''`) — or booleans. Anything else is
 * refused rather than guessed at.
 *
 * A refusal names the line and what is wrong with it, never the line's text: such
 * a file holds secrets, and a message that quoted it would repeat one. `named`
 * says how the file is spoken of.
 */
export function parseTomlTables(text: string, named: string): TomlDocument {
  return new Reader(text, named).document();
}

class Reader {
  readonly #text: string;
  readonly #named: string;
  #at = 0;

  constructor(text: string, named: string) {
    this.#text = text;
    this.#named = named;
  }

  /**
   * Tables are read into maps, never into objects keyed by what the file says, so
   * a key such as `constructor` or `__proto__` is a key like any other.
   */
  document(): TomlDocument {
    const root = new Map<string, TomlScalar>();
    const arrays = new Map<string, Map<string, TomlScalar>[]>();
    let current = root;
    for (this.#skipBlank(); this.#at < this.#text.length; this.#skipBlank()) {
      if (this.#text.startsWith('[[', this.#at)) {
        const name = this.#header();
        if (root.has(name)) {
          throw this.#refusal('starts tables under a name that already holds a value');
        }
        current = new Map();
        arrays.set(name, [...(arrays.get(name) ?? []), current]);
      } else {
        const key = this.#key();
        if (current.has(key) || (current === root && arrays.has(key))) {
          throw this.#refusal('names a key the table already holds');
        }
        current.set(key, this.#value());
      }
      this.#endOfLine();
    }
    return {
      root: Object.fromEntries(root),
      arrays: Object.fromEntries([...arrays].map(([name, tables]) => [
        name,
        tables.map((one) => Object.fromEntries(one)),
      ])),
    };
  }

  /** Blank lines, the spaces around them and whole-line comments. */
  #skipBlank(): void {
    for (;;) {
      this.#skipSpaces();
      const char = this.#text[this.#at];
      if (char === '\n' || char === '\r') {
        this.#at += 1;
      } else if (char === '#') {
        this.#skipComment();
      } else {
        return;
      }
    }
  }

  #skipSpaces(): void {
    while (this.#text[this.#at] === ' ' || this.#text[this.#at] === '\t') {
      this.#at += 1;
    }
  }

  #skipComment(): void {
    while (this.#at < this.#text.length && this.#text[this.#at] !== '\n') {
      this.#at += 1;
    }
  }

  /** What may follow a header or a value on its line: spaces and a comment. */
  #endOfLine(): void {
    this.#skipSpaces();
    if (this.#text[this.#at] === '#') {
      this.#skipComment();
    }
    const char = this.#text[this.#at];
    if (char !== undefined && char !== '\n' && char !== '\r') {
      throw this.#refusal('holds something after its value');
    }
  }

  #header(): string {
    this.#at += 2;
    this.#skipSpaces();
    const name = this.#bareKey();
    this.#skipSpaces();
    if (name === '' || !this.#text.startsWith(']]', this.#at)) {
      throw this.#refusal('is neither a [[table]] header nor a key = value line this reader understands');
    }
    this.#at += 2;
    return name;
  }

  #key(): string {
    const key = this.#bareKey();
    this.#skipSpaces();
    if (key === '' || this.#text[this.#at] !== '=') {
      throw this.#refusal('is neither a [[table]] header nor a key = value line this reader understands');
    }
    this.#at += 1;
    this.#skipSpaces();
    return key;
  }

  #bareKey(): string {
    const start = this.#at;
    while (KEY_CHAR.test(this.#text[this.#at] ?? '')) {
      this.#at += 1;
    }
    return this.#text.slice(start, this.#at);
  }

  #value(): TomlScalar {
    if (this.#text.startsWith('"""', this.#at)) {
      return this.#multiLineBasic();
    }
    if (this.#text.startsWith('\'\'\'', this.#at)) {
      return this.#multiLineLiteral();
    }
    if (this.#text[this.#at] === '"') {
      return this.#basic();
    }
    if (this.#text[this.#at] === '\'') {
      return this.#literal();
    }
    return this.#boolean();
  }

  #basic(): string {
    const line = this.#line();
    let value = '';
    for (this.#at += 1; this.#at < this.#text.length; this.#at += 1) {
      const char = this.#text[this.#at] ?? '';
      if (char === '"') {
        this.#at += 1;
        return value;
      }
      if (char === '\n') {
        break;
      }
      value += char === '\\' ? this.#escape() : char;
    }
    throw this.#refusal('opens a string it never closes', line);
  }

  #literal(): string {
    const line = this.#line();
    const end = this.#text.indexOf('\'', this.#at + 1);
    const newline = this.#text.indexOf('\n', this.#at + 1);
    if (end < 0 || (newline >= 0 && newline < end)) {
      throw this.#refusal('opens a string it never closes', line);
    }
    const value = this.#text.slice(this.#at + 1, end);
    this.#at = end + 1;
    return value;
  }

  /**
   * `"""…"""`: a newline right after the opening is dropped, escapes are read as
   * in a basic string, and a backslash at the end of a line drops it and the
   * blanks after it. Up to two quotes before the closing three belong to the value.
   */
  #multiLineBasic(): string {
    const line = this.#line();
    this.#at += 3;
    this.#dropOpeningNewline();
    let value = '';
    while (this.#at < this.#text.length) {
      if (this.#text.startsWith('"""', this.#at)) {
        return value + this.#closing('"');
      }
      const char = this.#text[this.#at] ?? '';
      if (char === '\\' && this.#lineEndingBackslash()) {
        continue;
      }
      value += char === '\\' ? this.#escape() : char;
      this.#at += 1;
    }
    throw this.#refusal('opens a string it never closes', line);
  }

  /** `'''…'''`: a newline right after the opening is dropped, and nothing else is read as anything but itself. */
  #multiLineLiteral(): string {
    const line = this.#line();
    this.#at += 3;
    this.#dropOpeningNewline();
    const end = this.#text.indexOf('\'\'\'', this.#at);
    if (end < 0) {
      throw this.#refusal('opens a string it never closes', line);
    }
    const value = this.#text.slice(this.#at, end);
    this.#at = end;
    return value + this.#closing('\'');
  }

  #dropOpeningNewline(): void {
    if (this.#text.startsWith('\r\n', this.#at)) {
      this.#at += 2;
    } else if (this.#text[this.#at] === '\n') {
      this.#at += 1;
    }
  }

  /** The closing three quotes, and the up to two quotes of the value just before them. */
  #closing(quote: string): string {
    let run = 0;
    while (this.#text[this.#at + run] === quote) {
      run += 1;
    }
    if (run > 5) {
      throw this.#refusal('closes a string with more quotes than TOML allows');
    }
    this.#at += run;
    return quote.repeat(run - 3);
  }

  /** A backslash followed by blanks and a line end: it and every blank up to the next character are dropped. */
  #lineEndingBackslash(): boolean {
    let probe = this.#at + 1;
    while (this.#text[probe] === ' ' || this.#text[probe] === '\t') {
      probe += 1;
    }
    if (this.#text[probe] !== '\n' && this.#text[probe] !== '\r') {
      return false;
    }
    while ([' ', '\t', '\n', '\r'].includes(this.#text[probe] ?? '')) {
      probe += 1;
    }
    this.#at = probe;
    return true;
  }

  /** The character an escape stands for; leaves the position on the escape's last character. */
  #escape(): string {
    const escape = this.#text[this.#at + 1] ?? '';
    const simple = ESCAPES.get(escape);
    if (simple !== undefined) {
      this.#at += 1;
      return simple;
    }
    const digits = CODE_POINT_DIGITS.get(escape) ?? 0;
    const hex = this.#text.slice(this.#at + 2, this.#at + 2 + digits);
    if (digits === 0 || !new RegExp(`^[0-9A-Fa-f]{${String(digits)}}$`).test(hex)) {
      throw this.#refusal('holds an escape TOML does not define');
    }
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      throw this.#refusal('escapes a character that does not exist');
    }
    this.#at += 1 + digits;
    return String.fromCodePoint(point);
  }

  #boolean(): boolean {
    const word = /^(true|false)(?=[ \t\r\n#]|$)/.exec(this.#text.slice(this.#at, this.#at + 6));
    if (word === null) {
      throw this.#refusal('holds a value that is neither a string nor true or false');
    }
    this.#at += word[0].length;
    return word[1] === 'true';
  }

  #line(): number {
    let line = 1;
    for (let index = 0; index < this.#at; index += 1) {
      line += this.#text[index] === '\n' ? 1 : 0;
    }
    return line;
  }

  #refusal(what: string, line = this.#line()): RefusedByRule {
    return new RefusedByRule(`line ${String(line)} of ${this.#named} ${what}`);
  }
}
