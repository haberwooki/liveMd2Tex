// Our own markdown-it block rules: display math blocks ($$...$$ and \[...\] that may hold lines markdown-it
// would otherwise read as lists or headings), raw LaTeX environments (pandoc's raw_tex at block level, blank
// lines allowed inside), pandoc fenced divs (::: {.class} ... :::), pandoc line blocks (| lines), and Obsidian
// %% comment blocks %%. Every token carries its source map, for the line map and for data-line in the HTML view.

import type MarkdownIt from 'markdown-it';
import { parseAttributeList, scanAttributeBlock, type Attributes } from '../attributes';
import { findEnvironmentEnd } from './inline';

type StateBlock = MarkdownIt.StateBlock;

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function tooIndented(state: StateBlock, line: number): boolean {
  return state.sCount[line] - state.blkIndent >= 4;
}

/** A line's text with at most the block's indentation removed (keeps the author's indentation inside). */
function rawLine(state: StateBlock, line: number): string {
  const text = state.src.slice(state.bMarks[line], state.eMarks[line]);
  let strip = 0;
  while (strip < state.blkIndent && strip < text.length && (text[strip] === ' ' || text[strip] === '\t')) {
    strip++;
  }
  return text.slice(strip);
}

// ---------------------------------------------------------------------------------------------------------

export function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (tooIndented(state, startLine)) {
    return false;
  }
  const first = lineText(state, startLine);
  let opener: string;
  let closer: string;
  if (first.startsWith('$$')) {
    opener = '$$';
    closer = '$$';
  } else if (first.startsWith('\\[')) {
    opener = '\\[';
    closer = '\\]';
  } else {
    return false;
  }
  const parts: string[] = [];
  let line = startLine;
  let text = first.slice(opener.length);
  let attrs: Attributes | undefined;
  for (;;) {
    const at = findCloser(text, closer);
    if (at >= 0) {
      parts.push(text.slice(0, at));
      const rest = text.slice(at + closer.length).trim();
      if (rest !== '') {
        const scanned = rest.startsWith('{') ? scanAttributeBlock(rest, 0) : undefined;
        if (!scanned || scanned.end !== rest.length) {
          return false; // more text after the math: leave it to the paragraph and the inline rule
        }
        attrs = scanned.attrs;
      }
      break;
    }
    parts.push(text);
    line++;
    if (line >= endLine || state.isEmpty(line) || state.sCount[line] < state.blkIndent) {
      return false;
    }
    text = lineText(state, line);
  }
  const content = parts.join('\n');
  if (content.trim() === '') {
    return false;
  }
  if (silent) {
    return true;
  }
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.map = [startLine, line + 1];
  token.markup = opener;
  token.content = content;
  token.meta = { attrs };
  state.line = line + 1;
  return true;
}

function findCloser(text: string, closer: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && closer !== '\\]') {
      i++;
      continue;
    }
    if (text.startsWith(closer, i)) {
      return i;
    }
    if (text[i] === '\\') {
      i++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------

export function latexBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (tooIndented(state, startLine)) {
    return false;
  }
  const first = lineText(state, startLine);
  const m = /^\\begin\{([^{}]+)\}/.exec(first);
  if (!m) {
    return false;
  }
  // Join the lines up to the end of the container and find the matching \end{env}.
  const lines: string[] = [];
  let last = -1;
  const env = m[1];
  for (let line = startLine; line < endLine; line++) {
    if (line > startLine && !state.isEmpty(line) && state.sCount[line] < state.blkIndent) {
      break;
    }
    lines.push(line === startLine ? first : rawLine(state, line));
    const joined = lines.join('\n');
    const end = findEnvironmentEnd(joined, m[0].length, joined.length, env);
    if (end >= 0) {
      if (joined.slice(end).trim() !== '' && !/^\s*%/.test(joined.slice(end))) {
        return false; // text after \end{env} on its line: an inline environment inside a paragraph
      }
      last = line;
      break;
    }
  }
  if (last < 0) {
    return false;
  }
  if (silent) {
    return true;
  }
  const token = state.push('latex_block', '', 0);
  token.block = true;
  token.map = [startLine, last + 1];
  token.content = lines.join('\n');
  token.info = env;
  state.line = last + 1;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// ::: {#id .class key=value}   or   ::: warning   ...   :::

const DIV_OPEN = /^(:{3,})\s*(.*?)\s*:*\s*$/;
const DIV_CLOSE = /^:{3,}\s*$/;

/** The attributes of a fenced-div opener line, or undefined if the line is not one. */
export function divOpenerAttributes(text: string): Attributes | undefined {
  const m = DIV_OPEN.exec(text);
  if (!m || m[2] === '') {
    return undefined;
  }
  const spec = m[2];
  if (spec.startsWith('{')) {
    const scanned = scanAttributeBlock(spec, 0);
    return scanned && scanned.end === spec.length ? scanned.attrs : undefined;
  }
  if (/^[\w-]+$/.test(spec)) {
    return parseAttributeList(`.${spec}`);
  }
  return undefined;
}

export function fencedDiv(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (tooIndented(state, startLine)) {
    return false;
  }
  const attrs = divOpenerAttributes(lineText(state, startLine));
  if (!attrs) {
    return false;
  }
  if (silent) {
    return true;
  }
  let depth = 1;
  let line = startLine + 1;
  let closed = false;
  for (; line < endLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) {
      break;
    }
    const text = lineText(state, line);
    if (DIV_CLOSE.test(text)) {
      depth--;
      if (depth === 0) {
        closed = true;
        break;
      }
    } else if (divOpenerAttributes(text)) {
      depth++;
    }
  }
  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = 'fenced_div' as typeof state.parentType;
  state.lineMax = line;
  const open = state.push('div_open', 'div', 1);
  open.block = true;
  open.map = [startLine, closed ? line + 1 : line];
  open.meta = { attrs };
  open.markup = ':::';
  state.md.block.tokenize(state, startLine + 1, line);
  const close = state.push('div_close', 'div', -1);
  close.block = true;
  close.map = [closed ? line : line - 1, closed ? line + 1 : line];
  close.markup = ':::';
  state.parentType = oldParent;
  state.lineMax = oldLineMax;
  state.line = closed ? line + 1 : line;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// | line blocks (pandoc's line_blocks)

const TABLE_DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function lineBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (tooIndented(state, startLine)) {
    return false;
  }
  const first = lineText(state, startLine);
  if (!/^\|( |$)/.test(first)) {
    return false;
  }
  if (startLine + 1 < endLine && TABLE_DELIMITER_ROW.test(lineText(state, startLine + 1))) {
    return false; // a pipe table
  }
  // A line that is one cell of a table ("| a | b |") is not a line block.
  if (/\|\s*$/.test(first) && first.length > 1) {
    return false;
  }
  if (silent) {
    return true;
  }
  const entries: { text: string; line: number; indent: number }[] = [];
  let line = startLine;
  for (; line < endLine; line++) {
    if (state.isEmpty(line)) {
      break;
    }
    const text = lineText(state, line);
    if (/^\|( |$)/.test(text)) {
      const body = text.slice(2);
      const indent = body.length - body.trimStart().length;
      entries.push({ text: body.trimStart(), line, indent });
    } else if (entries.length > 0 && /^\s/.test(state.src.slice(state.bMarks[line], state.eMarks[line]))) {
      const lastEntry = entries[entries.length - 1];
      lastEntry.text += `\n${text}`;
    } else {
      break;
    }
  }
  const open = state.push('line_block_open', 'div', 1);
  open.block = true;
  open.map = [startLine, line];
  for (const entry of entries) {
    const inline = state.push('inline', '', 0);
    inline.content = entry.text;
    inline.map = [entry.line, entry.line + 1 + (entry.text.match(/\n/g)?.length ?? 0)];
    inline.children = [];
    inline.meta = { indent: entry.indent };
  }
  const close = state.push('line_block_close', 'div', -1);
  close.block = true;
  state.line = line;
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// %% Obsidian comment blocks %%

export function commentBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (tooIndented(state, startLine)) {
    return false;
  }
  const first = lineText(state, startLine);
  if (!first.startsWith('%%')) {
    return false;
  }
  let line = startLine;
  let text = first.slice(2);
  for (;;) {
    const at = text.indexOf('%%');
    if (at >= 0) {
      if (text.slice(at + 2).trim() !== '') {
        return false;
      }
      break;
    }
    line++;
    if (line >= endLine) {
      return false;
    }
    text = lineText(state, line);
  }
  if (silent) {
    return true;
  }
  const token = state.push('comment_block', '', 0);
  token.block = true;
  token.hidden = true;
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}
