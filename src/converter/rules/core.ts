// Core rules that run after block parsing and before inline parsing: heading attributes ({#sec:id}, {-}),
// GitHub alerts and Obsidian callouts (> [!NOTE] Title), and pandoc table captions (a "Table: ..." or ": ..."
// paragraph just before or after a pipe table, with {#tbl:id}).

import type MarkdownIt from 'markdown-it';
import { splitTrailingAttributes, type Attributes } from '../attributes';

type StateCore = MarkdownIt.StateCore;
type Token = MarkdownIt.Token;

export function headingAttributes(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open') {
      continue;
    }
    const inline = tokens[i + 1];
    const split = splitTrailingAttributes(inline.content);
    if (split.attrs && !split.attrs.rawFormat) {
      inline.content = split.text;
      tokens[i].meta = { ...(tokens[i].meta ?? {}), attrs: split.attrs };
    }
  }
}

export interface CalloutMeta {
  type: string;
  title: string;
  fold: '' | '+' | '-';
}

const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

export function callouts(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 3; i++) {
    const quote = tokens[i];
    if (quote.type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open') {
      continue;
    }
    const inline = tokens[i + 2];
    const newline = inline.content.indexOf('\n');
    const firstLine = newline >= 0 ? inline.content.slice(0, newline) : inline.content;
    const m = CALLOUT.exec(firstLine);
    if (!m) {
      continue;
    }
    quote.meta = {
      ...(quote.meta ?? {}),
      callout: { type: m[1].toLowerCase(), title: m[3].trim(), fold: m[2] as CalloutMeta['fold'] } satisfies CalloutMeta,
    };
    if (newline < 0) {
      tokens.splice(i + 1, 3); // the marker line was the whole paragraph
      continue;
    }
    inline.content = inline.content.slice(newline + 1);
    for (const t of [tokens[i + 1], inline]) {
      if (t.map) {
        t.map = [t.map[0] + 1, t.map[1]];
      }
    }
  }
}

export interface TableCaption {
  text: string;
  /** 0-based source line of the caption paragraph. */
  line: number;
  attrs?: Attributes;
}

const CAPTION = /^(?:[Tt]able:|:)[ \t]+/;

function captionAt(tokens: Token[], i: number, level: number): boolean {
  return (
    i >= 0 &&
    i + 2 < tokens.length &&
    tokens[i].type === 'paragraph_open' &&
    tokens[i].level === level &&
    tokens[i + 1].type === 'inline' &&
    tokens[i + 2].type === 'paragraph_close' &&
    CAPTION.test(tokens[i + 1].content)
  );
}

export function tableCaptions(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const table = tokens[i];
    if (table.type !== 'table_open' || table.meta?.caption) {
      continue;
    }
    let close = i + 1;
    while (close < tokens.length && !(tokens[close].type === 'table_close' && tokens[close].level === table.level)) {
      close++;
    }
    let at = -1;
    if (captionAt(tokens, i - 3, table.level)) {
      at = i - 3;
    } else if (captionAt(tokens, close + 1, table.level)) {
      at = close + 1;
    }
    if (at < 0) {
      continue;
    }
    const inline = tokens[at + 1];
    const split = splitTrailingAttributes(inline.content.replace(CAPTION, ''));
    table.meta = {
      ...(table.meta ?? {}),
      caption: { text: split.text, line: tokens[at].map?.[0] ?? table.map?.[0] ?? 0, attrs: split.attrs } satisfies TableCaption,
    };
    tokens.splice(at, 3);
    if (at < i) {
      i -= 3;
    }
  }
}

/**
 * GFM's extended www autolinks ("www.example.org" in text becomes a link to http://www.example.org). linkify-it
 * 6 turns fuzzy links off by default, and turning them on would also link "fit.py" (.py is a country domain),
 * so this rule takes only what GFM takes: a "www." address after a space, an opening bracket or start of text.
 */
export function wwwAutolinks(state: StateCore): void {
  const pattern = /(^|[\s*_~(])(www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#][^\s<]*)?)/g;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) {
      continue;
    }
    const children: Token[] = [];
    let depth = 0;
    for (const t of block.children) {
      if (t.type === 'link_open') {
        depth++;
      } else if (t.type === 'link_close') {
        depth--;
      }
      if (t.type !== 'text' || depth > 0 || !t.content.includes('www.')) {
        children.push(t);
        continue;
      }
      let last = 0;
      const text = (content: string) => {
        if (content) {
          const token = new state.Token('text', '', 0);
          token.content = content;
          children.push(token);
        }
      };
      for (const m of t.content.matchAll(pattern)) {
        let url = m[2].replace(/[?!.,:*_~]+$/, '');
        while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) {
          url = url.slice(0, -1);
        }
        const start = (m.index ?? 0) + m[1].length;
        text(t.content.slice(last, start));
        const open = new state.Token('link_open', 'a', 1);
        open.attrs = [['href', state.md.normalizeLink(`http://${url}`)]];
        open.markup = 'linkify';
        open.info = 'auto';
        children.push(open);
        text(url);
        const close = new state.Token('link_close', 'a', -1);
        close.markup = 'linkify';
        close.info = 'auto';
        children.push(close);
        last = start + url.length;
      }
      text(t.content.slice(last));
    }
    block.children = children;
  }
}

/**
 * Splits one pipe-table row the way GFM does, except that "\|" inside $...$ math keeps its backslash, so a norm
 * written $\|A\|$ in a cell stays a norm (GFM unescapes every "\|" in a row, for text and code alike).
 */
export function splitTableRow(row: string): string[] {
  let text = row.trim();
  const cells: string[] = [];
  let current = '';
  let inMath = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      current += inMath ? '\\|' : '|';
      i++;
      continue;
    }
    if (ch === '\\') {
      current += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '$') {
      inMath = !inMath;
    }
    if (ch === '|' && !inMath) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length && cells[0].trim() === '' && text.startsWith('|')) {
    cells.shift();
  }
  text = text.replace(/\\\|/g, '');
  if (cells.length && cells[cells.length - 1].trim() === '' && text.endsWith('|')) {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

/** Core rule: restores "\|" inside math in table cells (see splitTableRow). Runs before inline parsing. */
export function tableMathPipes(state: StateCore): void {
  const tokens = state.tokens;
  let lines: string[] | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tr = tokens[i];
    if (tr.type !== 'tr_open' || !tr.map) {
      continue;
    }
    lines ??= state.src.split('\n');
    const source = (lines[tr.map[0]] ?? '').replace(/^(?:\s{0,3}>\s?)*\s*/, '');
    if (!source.includes('\\|') || !source.includes('$')) {
      continue;
    }
    const inlines: Token[] = [];
    for (let j = i + 1; j < tokens.length && tokens[j].type !== 'tr_close'; j++) {
      if ((tokens[j].type === 'th_open' || tokens[j].type === 'td_open') && tokens[j + 1]?.type === 'inline') {
        inlines.push(tokens[j + 1]);
      }
    }
    const cells = splitTableRow(source);
    // A "$" that is a currency sign can pair up wrongly; then keep markdown-it's split.
    if (cells.length !== inlines.length) {
      continue;
    }
    inlines.forEach((inline, k) => (inline.content = cells[k]));
  }
}
