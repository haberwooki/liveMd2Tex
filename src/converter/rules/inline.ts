// Our own markdown-it inline rules for the converter's dialect (docs/DESIGN.md#converter). Each follows pandoc's documented
// behaviour (pandoc's MANUAL, "Pandoc's Markdown"): tex_math_dollars, tex_math_single_backslash, raw_tex,
// citations, bracketed_spans, link_attributes, inline_code_attributes, raw_attribute, superscript, subscript,
// mark (==text==), and the Obsidian habits (wikilinks, embeds, %%comments%%). Rules are pure; they record what
// they find on tokens and leave the writing to the LaTeX writer (and to the HTML view plugin).

import type MarkdownIt from 'markdown-it';
import { scanAttributeBlock, type Attributes } from '../attributes';

type StateInline = MarkdownIt.StateInline;

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isLetter = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/** Index of the brace or bracket that closes the group opened at src[pos], honouring backslash escapes. */
export function matchingClose(src: string, pos: number, max = src.length): number {
  const open = src[pos];
  const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : '';
  if (!close) {
    return -1;
  }
  let depth = 0;
  for (let i = pos; i < max; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------
// Math: $...$, $$...$$, \(...\), \[...\]

/** Finds the closing "$$" of display math, skipping escaped dollars. */
function findDoubleDollar(src: string, from: number, max: number): number {
  for (let i = from; i < max - 1; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      i++;
      continue;
    }
    if (c === 0x24 && src.charCodeAt(i + 1) === 0x24) {
      return i;
    }
  }
  return -1;
}

function findBackslashClose(src: string, from: number, max: number, closer: string): number {
  for (let i = from; i < max - 1; i++) {
    if (src[i] === '\\') {
      if (src[i + 1] === closer) {
        return i;
      }
      i++;
    }
  }
  return -1;
}

/** Optional " {#eq:id}" after display math; returns the attributes and the new position. */
function trailingAttributes(src: string, pos: number, max: number): { attrs?: Attributes; end: number } {
  let i = pos;
  while (i < max && (src[i] === ' ' || src[i] === '\t')) {
    i++;
  }
  if (src[i] === '{') {
    const scanned = scanAttributeBlock(src, i, max);
    if (scanned) {
      return { attrs: scanned.attrs, end: scanned.end };
    }
  }
  return { end: pos };
}

export function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  const max = state.posMax;
  const code = src.charCodeAt(pos);

  if (code === 0x24 /* $ */) {
    if (src.charCodeAt(pos + 1) === 0x24) {
      const end = findDoubleDollar(src, pos + 2, max);
      if (end < 0 || src.slice(pos + 2, end).trim() === '') {
        return false;
      }
      const after = trailingAttributes(src, end + 2, max);
      if (!silent) {
        const token = state.push('math_display', 'math', 0);
        token.markup = '$$';
        token.content = src.slice(pos + 2, end);
        token.meta = { attrs: after.attrs };
      }
      state.pos = after.attrs ? after.end : end + 2;
      return true;
    }
    // GitHub's inline form $`...`$.
    if (src[pos + 1] === '`') {
      const end = src.indexOf('`$', pos + 2);
      if (end > pos + 2 && end < max) {
        if (!silent) {
          const token = state.push('math_inline', 'math', 0);
          token.markup = '$';
          token.content = src.slice(pos + 2, end);
        }
        state.pos = end + 2;
        return true;
      }
    }
    // Inline: the opening $ has a non-space on its right; the closing $ a non-space on its left and no digit
    // after it. As in pandoc's parser, the first $ ends the attempt: a $ after a space, or a closer followed by a
    // digit, means this is not math (so "$20,000 and $30,000" stays text).
    if (pos + 1 >= max || isSpace(src.charCodeAt(pos + 1))) {
      return false;
    }
    for (let i = pos + 1; i < max; i++) {
      const c = src.charCodeAt(i);
      if (c === 0x5c) {
        i++;
        continue;
      }
      if (c === 0x24) {
        if (isSpace(src.charCodeAt(i - 1)) || isDigit(src.charCodeAt(i + 1))) {
          return false;
        }
        if (!silent) {
          const token = state.push('math_inline', 'math', 0);
          token.markup = '$';
          token.content = src.slice(pos + 1, i);
        }
        state.pos = i + 1;
        return true;
      }
    }
    return false;
  }

  if (code === 0x5c /* \ */) {
    const next = src[pos + 1];
    if (next !== '(' && next !== '[') {
      return false;
    }
    const closer = next === '(' ? ')' : ']';
    const end = findBackslashClose(src, pos + 2, max, closer);
    if (end < 0) {
      return false;
    }
    if (next === '(') {
      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.markup = '\\(';
        token.content = src.slice(pos + 2, end);
      }
      state.pos = end + 2;
      return true;
    }
    const after = trailingAttributes(src, end + 2, max);
    if (!silent) {
      const token = state.push('math_display', 'math', 0);
      token.markup = '\\[';
      token.content = src.slice(pos + 2, end);
      token.meta = { attrs: after.attrs };
    }
    state.pos = after.attrs ? after.end : end + 2;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Raw TeX (pandoc's raw_tex): a backslash and letters, with any balanced [..] and {..} arguments that follow
// at once; \begin{env}...\end{env} as one piece. Must run before markdown-it's escape rule.

/** End index of a raw TeX command starting at src[pos] === '\\', or -1. */
export function scanRawTexCommand(src: string, pos: number, max = src.length): number {
  if (src[pos] !== '\\' || !isLetter(src.charCodeAt(pos + 1))) {
    return -1;
  }
  let i = pos + 1;
  while (i < max && isLetter(src.charCodeAt(i))) {
    i++;
  }
  const name = src.slice(pos + 1, i);
  if (src[i] === '*') {
    i++;
  }
  // An \end that closes a \begin is consumed with it (below, or by the raw LaTeX block rule). One standing
  // alone, like a \begin without its \end, would break the whole document, so neither is raw: both stay text.
  if (name === 'end' && src[i] === '{') {
    return -1;
  }
  if (name === 'begin') {
    if (src[i] !== '{') {
      return -1;
    }
    const nameEnd = matchingClose(src, i, max);
    if (nameEnd < 0) {
      return -1;
    }
    const env = src.slice(i + 1, nameEnd);
    const end = findEnvironmentEnd(src, nameEnd + 1, max, env);
    return end;
  }
  for (;;) {
    const ch = src[i];
    if (ch !== '{' && ch !== '[') {
      break;
    }
    const close = matchingClose(src, i, max);
    if (close < 0) {
      break;
    }
    i = close + 1;
  }
  return i;
}

/** Index just after the \end{env} that closes an environment whose body starts at `from`, or -1. */
export function findEnvironmentEnd(src: string, from: number, max: number, env: string): number {
  const beginTag = `\\begin{${env}}`;
  const endTag = `\\end{${env}}`;
  let depth = 1;
  let i = from;
  while (i < max) {
    const nextBegin = src.indexOf(beginTag, i);
    const nextEnd = src.indexOf(endTag, i);
    if (nextEnd < 0 || nextEnd >= max) {
      return -1;
    }
    if (nextBegin >= 0 && nextBegin < nextEnd) {
      depth++;
      i = nextBegin + beginTag.length;
      continue;
    }
    depth--;
    i = nextEnd + endTag.length;
    if (depth === 0) {
      return i;
    }
  }
  return -1;
}

export function rawTexInline(state: StateInline, silent: boolean): boolean {
  const end = scanRawTexCommand(state.src, state.pos, state.posMax);
  if (end < 0) {
    return false;
  }
  if (!silent) {
    const token = state.push('latex_inline', '', 0);
    token.content = state.src.slice(state.pos, end);
  }
  state.pos = end;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Code spans that keep their line breaks (CommonMark turns them into spaces; the line map needs them).

export function backticks(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x60) {
    return false;
  }
  const max = state.posMax;
  let pos = start + 1;
  while (pos < max && src.charCodeAt(pos) === 0x60) {
    pos++;
  }
  const marker = src.slice(start, pos);
  let matchEnd = pos;
  let matchStart: number;
  while ((matchStart = src.indexOf('`', matchEnd)) !== -1 && matchStart < max) {
    matchEnd = matchStart + 1;
    while (matchEnd < max && src.charCodeAt(matchEnd) === 0x60) {
      matchEnd++;
    }
    if (matchEnd - matchStart === marker.length) {
      if (!silent) {
        const raw = src.slice(pos, matchStart);
        let content = raw.replace(/\n/g, ' ');
        let lines = raw;
        if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
          lines = lines.slice(1, -1);
        }
        const token = state.push('code_inline', 'code', 0);
        token.markup = marker;
        token.content = content;
        token.meta = { lines };
      }
      state.pos = matchEnd;
      return true;
    }
  }
  if (!silent) {
    state.pending += marker;
  }
  state.pos = pos;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Citations and cross-references (pandoc citations; pandoc-crossref keys fig:, tbl:, eq:, sec:, lst:)

export interface CitationItem {
  key: string;
  prefix: string;
  suffix: string;
  suppressAuthor: boolean;
}

export interface CitationMeta {
  /** 'authoryear': "[Surname 2020; Other 2019a]" (a preset's rule); the others are pandoc's. */
  mode: 'bracketed' | 'intext' | 'authoryear';
  items: CitationItem[];
  source: string;
}

/**
 * "[Surname 2020; Other-Name 2019a]": capitalised surnames (letters, dots, hyphens) and four-digit years with an
 * optional letter. The key rule: the surname lowercased without dots or hyphens, then the year ("Other-Name
 * 2019a" -> "othername2019a").
 */
// A space or a line break between surname and year (the paragraph may wrap there).
const AUTHOR_YEAR = /\[([A-Z][A-Za-z.-]+\s+\d{4}[a-z]?(?:\s*;\s*[A-Z][A-Za-z.-]+\s+\d{4}[a-z]?)*)\]/y;

export function authorYearKey(entry: string): string {
  const m = /([A-Za-z.-]+)\s+(\d{4}[a-z]?)/.exec(entry.trim());
  return m ? m[1].replace(/[.-]/g, '').toLowerCase() + m[2] : entry.trim();
}

export function citationAuthorYear(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '[') {
    return false;
  }
  AUTHOR_YEAR.lastIndex = state.pos;
  const m = AUTHOR_YEAR.exec(state.src);
  if (!m || m.index + m[0].length > state.posMax) {
    return false;
  }
  if (!silent) {
    const token = state.push('citation', '', 0);
    token.meta = {
      mode: 'authoryear',
      items: m[1].split(';').map((part) => ({ key: authorYearKey(part), prefix: '', suffix: '', suppressAuthor: false })),
      source: m[1], // as written: a line break in it is kept in the output, for the line map
    } satisfies CitationMeta;
  }
  state.pos += m[0].length;
  return true;
}

const KEY_PUNCT = ':.#$%&-+?<>~/';

/** Scans a citation key starting at src[i] (just after '@'); returns [key, end] or undefined. */
export function scanCitationKey(src: string, i: number): [string, number] | undefined {
  if (src[i] === '{') {
    const close = src.indexOf('}', i + 1);
    if (close <= i + 1) {
      return undefined;
    }
    return [src.slice(i + 1, close), close + 1];
  }
  if (!isWordChar(src[i])) {
    return undefined;
  }
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (isWordChar(ch)) {
      j++;
    } else if (KEY_PUNCT.includes(ch) && isWordChar(src[j + 1])) {
      j += 2;
    } else {
      break;
    }
  }
  return [src.slice(i, j), j];
}

/** Splits text at top-level semicolons (not inside braces or brackets). */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    } else if (ch === sep && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** Parses the inside of a bracketed citation, or returns undefined if it is not one. */
export function parseCitationGroup(inner: string): CitationItem[] | undefined {
  if (!inner.includes('@')) {
    return undefined;
  }
  const items: CitationItem[] = [];
  for (const part of splitTopLevel(inner, ';')) {
    let found: CitationItem | undefined;
    for (let at = part.indexOf('@'); at >= 0; at = part.indexOf('@', at + 1)) {
      const dash = part[at - 1] === '-';
      const before = dash ? at - 1 : at;
      if (before > 0 && !/\s/.test(part[before - 1])) {
        continue;
      }
      const scanned = scanCitationKey(part, at + 1);
      if (!scanned) {
        continue;
      }
      const [key, end] = scanned;
      const suffix = part
        .slice(end)
        .trim()
        .replace(/^,\s*/, '');
      found = { key, prefix: part.slice(0, before).trim(), suffix, suppressAuthor: dash };
      break;
    }
    if (!found) {
      return undefined;
    }
    items.push(found);
  }
  return items.length > 0 ? items : undefined;
}

export function citationBracketed(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src[pos] !== '[' || src[pos + 1] === '^' || src[pos + 1] === '[') {
    return false;
  }
  const close = matchingClose(src, pos, state.posMax);
  if (close < 0) {
    return false;
  }
  const next = src[close + 1];
  if (next === '(' || next === '[' || next === '{') {
    return false;
  }
  const items = parseCitationGroup(src.slice(pos + 1, close));
  if (!items) {
    return false;
  }
  if (!silent) {
    const token = state.push('citation', '', 0);
    token.meta = { mode: 'bracketed', items, source: src.slice(pos, close + 1) } satisfies CitationMeta;
  }
  state.pos = close + 1;
  return true;
}

export function citationInText(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src[pos] !== '@') {
    return false;
  }
  const prev = pos > 0 ? src[pos - 1] : '';
  if (isWordChar(prev) || prev === '@' || prev === '\\') {
    return false;
  }
  const scanned = scanCitationKey(src, pos + 1);
  if (!scanned) {
    return false;
  }
  const [key, end] = scanned;
  let stop = end;
  let suffix = '';
  // "@key [p. 33]": a locator in brackets right after the key.
  if (src[end] === ' ' && src[end + 1] === '[') {
    const close = matchingClose(src, end + 1, state.posMax);
    const inner = close > 0 ? src.slice(end + 2, close) : '';
    const after = close > 0 ? src[close + 1] : '';
    if (close > 0 && !inner.includes('@') && after !== '(' && after !== '[' && after !== '{') {
      suffix = inner.trim();
      stop = close + 1;
    }
  }
  if (!silent) {
    const token = state.push('citation', '', 0);
    token.meta = {
      mode: 'intext',
      items: [{ key, prefix: '', suffix, suppressAuthor: false }],
      source: src.slice(pos, stop),
    } satisfies CitationMeta;
  }
  state.pos = stop;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// ==highlight== (delimiter pairs, as markdown-it does for ~~strikethrough~~)

export function markTokenize(state: StateInline, silent: boolean): boolean {
  const marker = state.src.charCodeAt(state.pos);
  if (silent || marker !== 0x3d) {
    return false;
  }
  const scanned = state.scanDelims(state.pos, true);
  const len = scanned.length;
  if (len < 2) {
    return false;
  }
  // Only a run of exactly two is a delimiter (as GFM has it for ~~): "===" rules and the "+=====+" border of a
  // grid table stay text.
  if (len > 2) {
    state.push('text', '', 0).content = '='.repeat(len);
    state.pos += len;
    return true;
  }
  state.push('text', '', 0).content = '==';
  state.delimiters.push({
    marker,
    length: 0,
    token: state.tokens.length - 1,
    end: -1,
    open: scanned.can_open,
    close: scanned.can_close,
  });
  state.pos += len;
  return true;
}

function markPairs(state: StateInline, delimiters: MarkdownIt.Delimiter[]): void {
  const lone: number[] = [];
  for (const start of delimiters) {
    if (start.marker !== 0x3d || start.end === -1) {
      continue;
    }
    const end = delimiters[start.end];
    const open = state.tokens[start.token];
    open.type = 'mark_open';
    open.tag = 'mark';
    open.nesting = 1;
    open.markup = '==';
    open.content = '';
    const close = state.tokens[end.token];
    close.type = 'mark_close';
    close.tag = 'mark';
    close.nesting = -1;
    close.markup = '==';
    close.content = '';
    const before = state.tokens[end.token - 1];
    if (before.type === 'text' && before.content === '=') {
      lone.push(end.token - 1);
    }
  }
  // A lone '=' left by an odd run belongs after the closing tag.
  while (lone.length) {
    const i = lone.pop() as number;
    let j = i + 1;
    while (j < state.tokens.length && state.tokens[j].type === 'mark_close') {
      j++;
    }
    j--;
    if (i !== j) {
      [state.tokens[i], state.tokens[j]] = [state.tokens[j], state.tokens[i]];
    }
  }
}

export function markPostProcess(state: StateInline): void {
  markPairs(state, state.delimiters);
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters) {
      markPairs(state, meta.delimiters);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// ^superscript^ and ~subscript~ (no unescaped whitespace inside; ~~ is strikeout)

function supSub(marker: string, type: 'sup' | 'sub') {
  return (state: StateInline, silent: boolean): boolean => {
    const src = state.src;
    const start = state.pos;
    if (src[start] !== marker || src[start + 1] === marker || (marker === '^' && src[start + 1] === '[')) {
      return false;
    }
    if (marker === '~' && src[start - 1] === '~') {
      return false;
    }
    for (let i = start + 1; i < state.posMax; i++) {
      const ch = src[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (/\s/.test(ch)) {
        return false;
      }
      if (ch === marker) {
        if (i === start + 1 || src[i + 1] === marker) {
          return false;
        }
        if (!silent) {
          const token = state.push(type, type, 0);
          token.markup = marker;
          token.content = src.slice(start + 1, i).replace(/\\(.)/g, '$1');
        }
        state.pos = i + 1;
        return true;
      }
    }
    return false;
  };
}

export const superscript = supSub('^', 'sup');
export const subscript = supSub('~', 'sub');

// ---------------------------------------------------------------------------------------------------------
// Obsidian: [[wikilinks]], ![[embeds]], %%comments%%

export interface WikiMeta {
  target: string;
  alias?: string;
  /** Heading or block reference after '#'. */
  anchor?: string;
}

function parseWiki(inner: string): WikiMeta | undefined {
  if (inner.trim() === '' || /[[\]\n]/.test(inner)) {
    return undefined;
  }
  const bar = inner.indexOf('|');
  const left = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : undefined;
  const hash = left.indexOf('#');
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const anchor = hash >= 0 ? left.slice(hash + 1).trim() : undefined;
  return { target, alias: alias || undefined, anchor: anchor || undefined };
}

export function wikilink(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  const embed = src[pos] === '!';
  const open = embed ? pos + 1 : pos;
  if (src[open] !== '[' || src[open + 1] !== '[') {
    return false;
  }
  const close = src.indexOf(']]', open + 2);
  if (close < 0 || close >= state.posMax) {
    return false;
  }
  const meta = parseWiki(src.slice(open + 2, close));
  if (!meta) {
    return false;
  }
  if (!silent) {
    const token = state.push(embed ? 'wikiembed' : 'wikilink', '', 0);
    token.meta = meta as unknown as Record<string, unknown>;
    token.content = src.slice(pos, close + 2);
  }
  state.pos = close + 2;
  return true;
}

export function obsidianComment(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src[pos] !== '%' || src[pos + 1] !== '%') {
    return false;
  }
  const end = src.indexOf('%%', pos + 2);
  if (end < 0 || end + 2 > state.posMax) {
    return false;
  }
  if (!silent) {
    const token = state.push('comment', '', 0);
    token.content = src.slice(pos + 2, end);
    token.hidden = true;
  }
  state.pos = end + 2;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// [bracketed spans]{.class} and attributes after images, links and code spans

export function bracketedSpan(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src[pos] !== '[' || src[pos + 1] === '^' || src[pos + 1] === '[') {
    return false;
  }
  const close = matchingClose(src, pos, state.posMax);
  if (close < 0 || src[close + 1] !== '{') {
    return false;
  }
  const scanned = scanAttributeBlock(src, close + 1, state.posMax);
  if (!scanned) {
    return false;
  }
  if (!silent) {
    const oldMax = state.posMax;
    const open = state.push('span_open', 'span', 1);
    open.meta = { attrs: scanned.attrs };
    state.pos = pos + 1;
    state.posMax = close;
    state.md.inline.tokenize(state);
    state.push('span_close', 'span', -1);
    state.posMax = oldMax;
  }
  state.pos = scanned.end;
  return true;
}

const ATTRIBUTE_TARGETS = new Set(['image', 'link_close', 'code_inline', 'wikiembed']);

export function trailingInlineAttributes(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '{' || state.pending !== '' || state.tokens.length === 0) {
    return false;
  }
  const last = state.tokens[state.tokens.length - 1];
  if (!ATTRIBUTE_TARGETS.has(last.type)) {
    return false;
  }
  const scanned = scanAttributeBlock(state.src, state.pos, state.posMax);
  if (!scanned) {
    return false;
  }
  if (!silent) {
    if (last.type === 'code_inline' && scanned.attrs.rawFormat) {
      last.type = 'raw_inline';
      last.info = scanned.attrs.rawFormat;
    } else {
      last.meta = { ...(last.meta ?? {}), attrs: scanned.attrs };
    }
  }
  state.pos = scanned.end;
  return true;
}
