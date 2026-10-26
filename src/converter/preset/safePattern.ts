// Patterns from a preset (the appendix's dropLines, the caption labels) are untrusted: a repository can ship a
// preset, and a regular expression with catastrophic backtracking would freeze the extension host
// (docs/DESIGN.md#presets). They are therefore never given to JavaScript's RegExp. This module reads them in a restricted language
// and matches them by simulating the pattern's automaton (Thompson's construction), which takes time linear in
// the text for any pattern: no backtracking at all. Pure code, no native module.
//
// The language is the plain core of regular expressions, so ordinary presets need no change: literals and
// escaped characters, ".", classes "[a-z]" and "[^...]", the escapes \d \D \s \S \w \W \b \B \t \n \r \f \v
// \xHH \uHHHH, the anchors ^ and $, groups "(...)" and "(?:...)", alternation "|", and the quantifiers * + ? {m}
// {m,} {m,n} (a trailing "?" for laziness is accepted and makes no difference to a yes-or-no match). Refused:
// back-references, look-arounds, named groups, flags.
//
// Linear is not enough on the extension host's thread: each character costs a step for
// every live state. So the work is capped three ways: a pattern has at most 300 characters, 200 automaton states and
// repeats of at most 100; a text longer than 4,000 characters is not tested; and one conversion may spend at most
// PATTERN_BUDGET steps on all its patterns (each character read and each automaton state visited is a step), after
// which every test answers "no match" and the converter warns. Texts are read in place, never copied.
// A pattern anchored with ^ stops at the first character that cannot continue it.

export interface SafePattern {
  readonly source: string;
  /** True when the pattern matches somewhere in the text (as RegExp.test does, without flags). */
  test(text: string): boolean;
}

export class PatternError extends Error {}

export const MAX_PATTERN_LENGTH = 300;
export const MAX_STATES = 200;
export const MAX_REPEAT = 100;

type CharTest = (cp: number) => boolean;
type Node =
  | { t: 'char'; test: CharTest }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; alts: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'assert'; kind: 'bol' | 'eol' | 'word' | 'nonword' };

const isWord = (cp: number) => (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
const isDigit = (cp: number) => cp >= 48 && cp <= 57;
const SPACES = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isSpace = (cp: number) => SPACES.has(cp) || (cp >= 0x2000 && cp <= 0x200a);
const isLineEnd = (cp: number) => cp === 10 || cp === 13 || cp === 0x2028 || cp === 0x2029;

class Parser {
  private i = 0;
  constructor(private readonly cps: number[]) {}

  private peek(): number | undefined {
    return this.cps[this.i];
  }
  private next(): number {
    const c = this.cps[this.i++];
    if (c === undefined) {
      throw new PatternError('the pattern ends too early');
    }
    return c;
  }
  private eat(ch: string): boolean {
    if (this.peek() === ch.codePointAt(0)) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const node = this.alt();
    if (this.i < this.cps.length) {
      throw new PatternError(`unexpected "${String.fromCodePoint(this.cps[this.i])}"`);
    }
    return node;
  }

  private alt(): Node {
    const alts = [this.seq()];
    while (this.eat('|')) {
      alts.push(this.seq());
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }

  private seq(): Node {
    const items: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== 0x7c && c !== 0x29; c = this.peek()) {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { t: 'seq', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === 0x2a) {
      [min, max] = [0, Infinity];
    } else if (c === 0x2b) {
      [min, max] = [1, Infinity];
    } else if (c === 0x3f) {
      [min, max] = [0, 1];
    } else if (c === 0x7b) {
      const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(String.fromCodePoint(...this.cps.slice(this.i, this.i + 11)));
      if (!m) {
        return atom; // a literal "{", as RegExp reads it without the u flag
      }
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (max < min) {
        throw new PatternError('a {m,n} quantifier with n below m');
      }
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        throw new PatternError(`a {m,n} quantifier above ${MAX_REPEAT}`);
      }
      this.i += m[0].length - 1;
    } else {
      return atom;
    }
    this.i++;
    this.eat('?'); // laziness: no difference for a yes-or-no match
    if (atom.t === 'assert') {
      throw new PatternError('a quantifier after an anchor');
    }
    const following = String.fromCodePoint(...this.cps.slice(this.i, this.i + 11));
    if (this.peek() === 0x2a || this.peek() === 0x2b || this.peek() === 0x3f || /^\{\d{1,4}(,\d{0,4})?\}/.test(following)) {
      throw new PatternError('two quantifiers in a row');
    }
    return { t: 'rep', node: atom, min, max };
  }

  private atom(): Node {
    const c = this.next();
    switch (c) {
      case 0x28: {
        // "(": a group; "(?:" non-capturing; other "(?" forms (look-arounds, named groups) are refused.
        if (this.eat('?')) {
          if (!this.eat(':')) {
            throw new PatternError('look-arounds and named groups are not supported');
          }
        }
        const inner = this.alt();
        if (!this.eat(')')) {
          throw new PatternError('a group is not closed');
        }
        return inner;
      }
      case 0x29:
        throw new PatternError('an unmatched ")"');
      case 0x5b:
        return this.charClass();
      case 0x2e:
        return { t: 'char', test: (cp) => !isLineEnd(cp) };
      case 0x5e:
        return { t: 'assert', kind: 'bol' };
      case 0x24:
        return { t: 'assert', kind: 'eol' };
      case 0x2a:
      case 0x2b:
      case 0x3f:
        throw new PatternError('a quantifier with nothing before it');
      case 0x5c:
        return this.escape();
      default:
        return { t: 'char', test: (cp) => cp === c };
    }
  }

  /** The class escapes \d \D \s \S \w \W as a test, else undefined. */
  private classEscape(ch: string): CharTest | undefined {
    switch (ch) {
      case 'd':
        return isDigit;
      case 'D':
        return (cp) => !isDigit(cp);
      case 's':
        return isSpace;
      case 'S':
        return (cp) => !isSpace(cp);
      case 'w':
        return isWord;
      case 'W':
        return (cp) => !isWord(cp);
      default:
        return undefined;
    }
  }

  /** A single-character escape after "\" (its character code); `c` is the character after the backslash. */
  private charEscape(c: number, inClass: boolean): number {
    const ch = String.fromCodePoint(c);
    const simple: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11 };
    if (ch in simple) {
      return simple[ch];
    }
    if (ch === 'b' && inClass) {
      return 8;
    }
    if (ch === '0' && !isDigit(this.peek() ?? -1)) {
      return 0;
    }
    if (ch === 'x' || ch === 'u') {
      const n = ch === 'x' ? 2 : 4;
      const hex = String.fromCodePoint(...this.cps.slice(this.i, this.i + n));
      if (hex.length !== n || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new PatternError(`\\${ch} needs ${n} hexadecimal digits`);
      }
      this.i += n;
      return parseInt(hex, 16);
    }
    if (/[0-9]/.test(ch) || ch === 'k') {
      throw new PatternError('back-references are not supported');
    }
    if (/[A-Za-z]/.test(ch)) {
      throw new PatternError(`the escape \\${ch} is not supported`);
    }
    return c; // an escaped punctuation character stands for itself
  }

  /** An escape outside a class: a class escape, an assertion (\b \B) or one character. */
  private escape(): Node {
    const c = this.next();
    const ch = String.fromCodePoint(c);
    const cls = this.classEscape(ch);
    if (cls) {
      return { t: 'char', test: cls };
    }
    if (ch === 'b') {
      return { t: 'assert', kind: 'word' };
    }
    if (ch === 'B') {
      return { t: 'assert', kind: 'nonword' };
    }
    const v = this.charEscape(c, false);
    return { t: 'char', test: (cp) => cp === v };
  }

  private charClass(): Node {
    const negate = this.eat('^');
    const parts: CharTest[] = [];
    let first = true;
    for (;;) {
      const c = this.next();
      if (c === 0x5d && !first) {
        break;
      }
      first = false;
      let lo: number;
      if (c === 0x5c) {
        const e = this.next();
        const cls = this.classEscape(String.fromCodePoint(e));
        if (cls) {
          parts.push(cls);
          continue;
        }
        if (e === 0x42) {
          throw new PatternError('\\B inside a class');
        }
        lo = this.charEscape(e, true);
      } else {
        lo = c;
      }
      // A range "a-z"; a "-" just before "]" is a literal.
      if (this.peek() === 0x2d && this.cps[this.i + 1] !== undefined && this.cps[this.i + 1] !== 0x5d) {
        this.i++;
        let hi = this.next();
        if (hi === 0x5c) {
          const e = this.next();
          if (this.classEscape(String.fromCodePoint(e))) {
            throw new PatternError('a range ends in a class escape');
          }
          hi = this.charEscape(e, true);
        }
        if (hi < lo) {
          throw new PatternError('a range out of order');
        }
        const [a, b] = [lo, hi];
        parts.push((cp) => cp >= a && cp <= b);
      } else {
        const v = lo;
        parts.push((cp) => cp === v);
      }
    }
    return { t: 'char', test: negate ? (cp) => !parts.some((p) => p(cp)) : (cp) => parts.some((p) => p(cp)) };
  }
}

// ---- Thompson's automaton -------------------------------------------------------------------------------

type State =
  | { k: 'char'; test: CharTest; out: number }
  | { k: 'split'; out: number; out2: number }
  | { k: 'assert'; kind: 'bol' | 'eol' | 'word' | 'nonword'; out: number }
  | { k: 'match' };

class Builder {
  readonly states: State[] = [];
  private add(s: State): number {
    if (this.states.length >= MAX_STATES) {
      throw new PatternError(`the pattern is too large (over ${MAX_STATES} states)`);
    }
    this.states.push(s);
    return this.states.length - 1;
  }

  /** Builds `node` so that it continues to `next`; returns its entry state. */
  build(node: Node, next: number): number {
    switch (node.t) {
      case 'char':
        return this.add({ k: 'char', test: node.test, out: next });
      case 'assert':
        return this.add({ k: 'assert', kind: node.kind, out: next });
      case 'seq': {
        let entry = next;
        for (let i = node.items.length - 1; i >= 0; i--) {
          entry = this.build(node.items[i], entry);
        }
        return entry;
      }
      case 'alt': {
        const entries = node.alts.map((a) => this.build(a, next));
        let entry = entries[entries.length - 1];
        for (let i = entries.length - 2; i >= 0; i--) {
          entry = this.add({ k: 'split', out: entries[i], out2: entry });
        }
        return entry;
      }
      case 'rep': {
        let entry = next;
        if (node.max === Infinity) {
          // x* : a split that loops through x.
          const loop = this.add({ k: 'split', out: -1, out2: next });
          const body = this.build(node.node, loop);
          (this.states[loop] as { out: number }).out = body;
          entry = loop;
        } else {
          for (let i = node.min; i < node.max; i++) {
            const body = this.build(node.node, entry);
            entry = this.add({ k: 'split', out: body, out2: next });
          }
        }
        for (let i = 0; i < node.min; i++) {
          entry = this.build(node.node, entry);
        }
        return entry;
      }
    }
  }
}

// ---- The work budget ------------------------------------------------------------------------------------

/**
 * The work a conversion may spend on preset patterns, in automaton steps (a state visited at one character).
 * About 10 to 25 ms on the development laptop; the converter is synchronous, so one budget is active at a time.
 */
export const PATTERN_BUDGET = 1_000_000;

/** Text longer than this (in characters) is not tested: the pattern counts as not matching, with a warning. */
export const MAX_TEXT_LENGTH = 4000;

export interface PatternBudget {
  /** Steps left. */
  left: number;
  /** The budget ran out: every later test answered "no match". */
  exhausted: boolean;
  /** Texts not tested because they were longer than MAX_TEXT_LENGTH. */
  tooLong: number;
  /** Time spent in tests (milliseconds), for the log and the tests. */
  ms: number;
}

let active: PatternBudget | undefined;

/**
 * Runs `fn` (a conversion) with a budget for every preset-pattern test inside it. Without one, each test gets a
 * budget of its own, so a single test is bounded too.
 */
export function withPatternBudget<T>(fn: () => T, limit = PATTERN_BUDGET): { value: T; budget: PatternBudget } {
  const previous = active;
  const budget: PatternBudget = { left: limit, exhausted: false, tooLong: 0, ms: 0 };
  active = budget;
  try {
    return { value: fn(), budget };
  } finally {
    active = previous;
  }
}

// ---- Matching -------------------------------------------------------------------------------------------

const K_CHAR = 0;
const K_SPLIT = 1;
const K_ASSERT = 2;
const K_MATCH = 3;
const A_BOL = 0;
const A_EOL = 1;
const A_WORD = 2;
const A_NONWORD = 3;

/** Reads a preset pattern; throws PatternError with a plain reason when it is outside the language or too large. */
export function compileSafePattern(source: string): SafePattern {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(`the pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  const ast = new Parser([...source].map((c) => c.codePointAt(0) as number)).parse();
  const builder = new Builder();
  const match = builder.states.length;
  builder.states.push({ k: 'match' });
  const start = builder.build(ast, match);
  const states = builder.states;

  // The automaton as flat arrays, with each character test tabled for ASCII.
  const n = states.length;
  const kind = new Uint8Array(n);
  const out = new Int32Array(n);
  const out2 = new Int32Array(n);
  const assertion = new Uint8Array(n);
  const ascii = new Uint8Array(n * 128);
  const tests: (CharTest | undefined)[] = new Array(n);
  states.forEach((st, i) => {
    if (st.k === 'char') {
      kind[i] = K_CHAR;
      out[i] = st.out;
      tests[i] = st.test;
      for (let cp = 0; cp < 128; cp++) {
        ascii[i * 128 + cp] = st.test(cp) ? 1 : 0;
      }
    } else if (st.k === 'split') {
      kind[i] = K_SPLIT;
      out[i] = st.out;
      out2[i] = st.out2;
    } else if (st.k === 'assert') {
      kind[i] = K_ASSERT;
      out[i] = st.out;
      assertion[i] = st.kind === 'bol' ? A_BOL : st.kind === 'eol' ? A_EOL : st.kind === 'word' ? A_WORD : A_NONWORD;
    } else {
      kind[i] = K_MATCH;
    }
  });

  // Anchored: every way from the start meets "^" before anything else, so a match can only start at 0.
  const anchored = (() => {
    const seen = new Uint8Array(n);
    const stack = [start];
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (seen[i]) {
        continue;
      }
      seen[i] = 1;
      if (kind[i] === K_SPLIT) {
        stack.push(out[i], out2[i]);
      } else if (!(kind[i] === K_ASSERT && assertion[i] === A_BOL)) {
        return false;
      }
    }
    return true;
  })();

  const mark = new Uint32Array(n);
  let stamp = 0;
  const stack = new Int32Array(2 * n + 2);
  let current = new Int32Array(n);
  let next = new Int32Array(n);

  return {
    source,
    test(text: string): boolean {
      const budget = active ?? { left: PATTERN_BUDGET, exhausted: false, tooLong: 0, ms: 0 };
      if (budget.exhausted) {
        return false;
      }
      if (text.length > MAX_TEXT_LENGTH) {
        budget.tooLong++;
        return false;
      }
      const started = performance.now();
      try {
        return run(budget, text);
      } finally {
        budget.ms += performance.now() - started;
      }
    },
  };

  /**
   * One search over `text`, read in place one code point at a time (no copy), every character counted as a step:
   * the budget covers the scan as well as the automaton.
   */
  function run(budget: PatternBudget, text: string): boolean {
    const length = text.length;
    let steps = 0;
    let count = 0;
    // The code points before and at the position, -1 at the ends (for \b and \B).
    let before = -1;
    let at = length > 0 ? (text.codePointAt(0) as number) : -1;
    let pos = 0;
    /** Adds the closure of state `s` at the position `pos` to `list` (from index `from`); returns the new count. */
    const close = (list: Int32Array, from: number, s: number): number => {
      let size = from;
      let top = 0;
      stack[top++] = s;
      while (top > 0) {
        const i = stack[--top];
        if (mark[i] === stamp) {
          continue;
        }
        mark[i] = stamp;
        steps++;
        const k = kind[i];
        if (k === K_SPLIT) {
          stack[top++] = out2[i];
          stack[top++] = out[i];
        } else if (k === K_ASSERT) {
          const a = assertion[i];
          let ok: boolean;
          if (a === A_BOL) {
            ok = pos === 0;
          } else if (a === A_EOL) {
            ok = pos === length;
          } else {
            const boundary = (before >= 0 && isWord(before)) !== (at >= 0 && isWord(at));
            ok = a === A_WORD ? boundary : !boundary;
          }
          if (ok) {
            stack[top++] = out[i];
          }
        } else {
          list[size++] = i;
        }
      }
      return size;
    };
    if (stamp > 0xffff0000) {
      mark.fill(0);
      stamp = 0;
    }
    stamp++;
    for (;;) {
      // A match may start at every position (an unanchored search), or only at 0.
      if (pos === 0 || !anchored) {
        count = close(current, count, start);
      }
      for (let j = 0; j < count; j++) {
        if (kind[current[j]] === K_MATCH) {
          budget.left -= steps;
          return true;
        }
      }
      if (pos >= length || (count === 0 && anchored)) {
        break;
      }
      steps++; // the character itself
      if (steps > budget.left) {
        budget.left = 0;
        budget.exhausted = true;
        return false;
      }
      const cp = at;
      const width = cp > 0xffff ? 2 : 1;
      before = cp;
      pos += width;
      at = pos < length ? (text.codePointAt(pos) as number) : -1;
      stamp++;
      let size = 0;
      for (let j = 0; j < count; j++) {
        const i = current[j];
        steps++;
        if (kind[i] === K_CHAR && (cp < 128 ? ascii[i * 128 + cp] === 1 : (tests[i] as CharTest)(cp))) {
          size = close(next, size, out[i]);
        }
      }
      [current, next] = [next, current];
      count = size;
    }
    budget.left -= steps;
    return false;
  }
}
