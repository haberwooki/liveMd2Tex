// Block shapes a preset mode asks for (docs/DESIGN.md#presets):
//   - a figure: an image alone in its paragraph, captioned by the NEXT paragraph when it starts with a bold
//     label ("**Figure 3.** ..."); the label is dropped (LaTeX numbers the figure) or kept (the author numbers);
//     layouts by file stem: single column, wide (figure*), or wide with the caption beside the image;
//   - a table: captioned by the PREVIOUS paragraph ("**Table 2.** ..."), with column types chosen by content
//     (numeric right, short text left, long text wrapping as tabularx X), and a following note paragraph
//     ("Units ...", "† ...") folded into the float; a supplement keeps tables in place and scales wide ones.
// Returns the index after the tokens it consumed, or -1 when the block is not one of these shapes.

import type MarkdownIt from 'markdown-it';
import type { LatexWriter } from '../latexWriter';
import { compileSafePattern, type SafePattern } from './safePattern';

type Token = MarkdownIt.Token;

const labelPatterns = new Map<string, SafePattern | null>();

/** A preset's caption label ("Figure|Table") at the start of a text: untrusted, so a safe pattern (safePattern.ts). */
function labelMatches(label: string, text: string): boolean {
  let pattern = labelPatterns.get(label);
  if (pattern === undefined) {
    try {
      pattern = compileSafePattern(`^(?:${label})\\b`);
    } catch {
      pattern = null; // reported when the preset was loaded (load.ts)
    }
    if (labelPatterns.size >= 64) {
      labelPatterns.clear(); // labels come from presets: keep the cache small
    }
    labelPatterns.set(label, pattern);
  }
  return pattern !== null && pattern.test(text);
}

/** The inline children of a paragraph that starts with a bold label ("**Figure 3.** ..."), else undefined. */
function labelled(tokens: Token[], i: number, label: string): Token[] | undefined {
  if (tokens[i]?.type !== 'paragraph_open' || tokens[i + 1]?.type !== 'inline') {
    return undefined;
  }
  // Empty text tokens can come first (an inline rule tried position 0); they carry nothing.
  const kids = (tokens[i + 1].children ?? []).filter((c, k, all) => !(c.type === 'text' && c.content === '' && all.slice(0, k).every((p) => p.type === 'text' && p.content === '')));
  if (kids[0]?.type !== 'strong_open' || kids[1]?.type !== 'text' || !labelMatches(label, kids[1].content)) {
    return undefined;
  }
  return kids;
}

/** Drops the bold label group and the space after it. */
function withoutLabel(kids: Token[]): Token[] {
  let k = 0;
  while (k < kids.length && kids[k].type !== 'strong_close') {
    k++;
  }
  const rest = kids.slice(k + 1);
  if (rest[0]?.type === 'text') {
    const t = Object.assign(Object.create(Object.getPrototypeOf(rest[0])), rest[0]) as Token;
    t.content = t.content.replace(/^\s+/, '');
    rest[0] = t;
  }
  while (rest[0] && (rest[0].type === 'softbreak' || (rest[0].type === 'text' && rest[0].content === ''))) {
    rest.shift();
  }
  return rest;
}

function loneImage(tokens: Token[], i: number): Token | undefined {
  if (tokens[i]?.type !== 'paragraph_open' || tokens[i + 1]?.type !== 'inline') {
    return undefined;
  }
  const visible = (tokens[i + 1].children ?? []).filter((c) => !(c.type === 'softbreak' || (c.type === 'text' && c.content.trim() === '')));
  return visible.length === 1 && visible[0].type === 'image' ? visible[0] : undefined;
}

function stem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
}

function figure(w: LatexWriter, tokens: Token[], i: number, end: number): number {
  const f = w.mode.figures;
  if (f.caption !== 'next-paragraph' || f.style === 'general') {
    return -1;
  }
  const img = loneImage(tokens, i);
  if (!img) {
    return -1;
  }
  const after = w.blockEnd(tokens, i, end);
  const capKids = labelled(tokens, after, f.label);
  const first = w.first(tokens[i]);
  let caption: string | undefined;
  let next = after;
  let capFirst = first;
  let capLast = first;
  if (capKids) {
    capFirst = w.first(tokens[after]);
    capLast = w.last(tokens[after]);
    caption = w.inline(f.keepLabel ? capKids : withoutLabel(capKids), { inCaption: true, line: capFirst });
    next = w.blockEnd(tokens, after, end);
  }
  let path = w.resolvePath(String(img.attrGet('src') ?? ''));
  if (f.pdfForPng === 'always') {
    path = path.replace(/\.png$/i, '.pdf');
  }
  const out = w.out;
  const cap = (text: string | undefined) => out.multiline(`\\caption{${text ?? ''}}`, capFirst, capLast);
  if (f.style === 'report') {
    out.line('\\begin{figure}[htbp]', first);
    out.indent();
    out.line('\\centering', first);
    out.line(`\\includegraphics[${f.graphics.report}]{${path}}`, first);
    if (caption !== undefined) {
      cap(caption);
    }
    out.dedent();
    out.line('\\end{figure}', capLast);
    return next;
  }
  const s = stem(path);
  if (f.sideCaption.includes(s)) {
    out.line('\\begin{figure*}[!tb]\\centering', first);
    const [figureWidth, captionWidth] = f.sideCaptionWidths;
    out.line(`\\begin{minipage}[c]{${figureWidth}\\textwidth}\\centering`, first);
    out.line(`\\includegraphics[${f.graphics.side}]{${path}}`, first);
    out.line('\\end{minipage}\\hfill%', first);
    out.line(`\\begin{minipage}[c]{${captionWidth}\\textwidth}`, capFirst);
    cap(caption);
    out.line('\\end{minipage}', capLast);
    out.line('\\end{figure*}', capLast);
  } else if (f.wide.includes(s)) {
    out.line('\\begin{figure*}[!tb]\\centering', first);
    out.line(`\\includegraphics[${f.graphics.wide}]{${path}}`, first);
    cap(caption);
    out.line('\\end{figure*}', capLast);
  } else {
    out.line('\\begin{figure}[!tb]\\centering', first);
    out.line(`\\includegraphics[${f.graphics.single}]{${path}}`, first);
    cap(caption);
    out.line('\\end{figure}', capLast);
  }
  return next;
}

interface Row {
  cells: Token[];
  line: number;
}

function tableRows(w: LatexWriter, tokens: Token[], i: number, close: number): { header: Row | undefined; body: Row[] } {
  let header: Row | undefined;
  const body: Row[] = [];
  let inHead = false;
  let current: Row | undefined;
  for (let j = i; j < close; j++) {
    const t = tokens[j];
    if (t.type === 'thead_open') {
      inHead = true;
    } else if (t.type === 'thead_close') {
      inHead = false;
    } else if (t.type === 'tr_open') {
      current = { cells: [], line: t.map ? t.map[0] + 1 : w.first(tokens[i]) };
      if (inHead) {
        header = current;
      } else {
        body.push(current);
      }
    } else if ((t.type === 'th_open' || t.type === 'td_open') && current) {
      current.cells.push(tokens[j + 1]);
    }
  }
  return { header, body };
}

/** Column types by content: mostly numbers -> r, short (16 characters or fewer) -> l, longer -> X. */
export function columnTypes(header: string[], rows: string[][]): string[] {
  return header.map((h, c) => {
    const cells = rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    const maxlen = Math.max(h.length, ...cells.map((x) => x.length));
    const nums = cells.filter((x) => /^[([]?[-+±]?[\d.]+/.test(x)).length;
    if (cells.length > 0 && nums / cells.length >= 0.6) {
      return 'r';
    }
    return maxlen <= 16 ? 'l' : 'X';
  });
}

function table(w: LatexWriter, tokens: Token[], i: number, end: number): number {
  const t = w.mode.tables;
  if (t.style === 'general') {
    return -1;
  }
  let at = i;
  let capKids: Token[] | undefined;
  let capFirst = 0;
  let capLast = 0;
  if (t.caption === 'previous-paragraph') {
    capKids = labelled(tokens, i, t.label);
    if (capKids) {
      capFirst = w.first(tokens[i]);
      capLast = w.last(tokens[i]);
      at = w.blockEnd(tokens, i, end);
    }
  }
  if (tokens[at]?.type !== 'table_open') {
    return -1;
  }
  const close = w.blockEnd(tokens, at, end);
  const first = w.first(tokens[at]);
  const last = w.last(tokens[at]);
  const { header, body } = tableRows(w, tokens, at, close);
  const ncol = Math.max(header?.cells.length ?? 0, ...body.map((r) => r.cells.length));
  const raw = (cells: Token[]) => Array.from({ length: ncol }, (_, k) => cells[k]?.content ?? '');
  const render = (r: Row) =>
    Array.from({ length: ncol }, (_, k) => (r.cells[k] ? w.inline(r.cells[k].children ?? [], { inTable: true, line: r.line }) : '')).join(' & ') + ' \\\\';
  const out = w.out;
  let next = close;

  if (t.style === 'report') {
    out.line('\\begin{table}[htbp]', first);
    out.indent();
    out.line('\\centering', first);
    out.line('\\small', first);
    out.line(`\\begin{tabular}{${'l'.repeat(ncol)}}`, first);
    out.indent();
    out.line('\\toprule', first);
    if (header) {
      out.line(render(header), header.line);
    }
    out.line('\\midrule', first + 1);
    body.forEach((r) => out.line(render(r), r.line));
    out.line('\\bottomrule', last);
    out.dedent();
    out.line('\\end{tabular}', last);
    out.dedent();
    out.line('\\end{table}', last);
    return next;
  }

  // Two-column style.
  const caption = capKids ? w.inline(t.keepLabel ? capKids : withoutLabel(capKids), { inCaption: true, line: capFirst }) : '';
  let note = '';
  let noteFirst = last;
  let noteLast = last;
  const noteKids = tokens[close]?.type === 'paragraph_open' ? tokens[close + 1] : undefined;
  if (noteKids && t.notePrefixes.some((p) => noteKids.content.trimStart().startsWith(p))) {
    noteFirst = w.first(tokens[close]);
    noteLast = w.last(tokens[close]);
    note = w.inline(noteKids.children ?? [], { line: noteFirst });
    next = w.blockEnd(tokens, close, end);
  }
  const specs = columnTypes(raw(header?.cells ?? []), body.map((r) => raw(r.cells)));
  const hasX = specs.includes('X');
  const size = ncol >= 5 || hasX ? '\\footnotesize' : '\\small';
  const types = specs.join(' ');
  const begin = hasX ? `\\begin{tabularx}{\\textwidth}{${types}}` : `\\begin{tabular}{${types}}`;
  const endEnv = hasX ? '\\end{tabularx}' : '\\end{tabular}';
  const capLine = capKids ? capFirst : first;
  out.line(t.inPlace ? '\\begin{table}[H]\\centering' : `\\begin{table*}[${t.placement}]\\centering`, Math.min(capLine, first));
  out.line(size, Math.min(capLine, first));
  out.multiline(`\\caption{${caption}}`, capLine, capKids ? capLast : capLine);
  // A preset's wrapper around an in-place tabular (tables.wrap), e.g. one that shrinks a wide table to the line.
  const [wrapBegin, wrapEnd] = t.inPlace && !hasX ? [t.wrap[0] ?? '', t.wrap[1] ?? ''] : ['', ''];
  out.line(`${wrapBegin}${begin}`, first);
  out.line('\\toprule', first);
  if (header) {
    out.line(render(header), header.line);
  }
  out.line('\\midrule', first + 1);
  body.forEach((r) => out.line(render(r), r.line));
  out.line('\\bottomrule', last);
  out.line(`${endEnv}${wrapEnd}`, last);
  if (note) {
    out.line('\\vspace{3pt}', noteFirst);
    out.multiline(`\\noindent\\begin{minipage}{\\textwidth}\\footnotesize ${note}\\end{minipage}`, noteFirst, noteLast);
  }
  out.line(t.inPlace ? '\\end{table}' : '\\end{table*}', Math.max(last, noteLast));
  return next;
}

/** The preset's own block shape starting at tokens[i], if any; returns the index after it or -1. */
export function presetBlock(w: LatexWriter, tokens: Token[], i: number, end: number): number {
  const t = tokens[i];
  if (t.type !== 'paragraph_open' && t.type !== 'table_open') {
    return -1;
  }
  const fig = figure(w, tokens, i, end);
  if (fig > i) {
    return fig;
  }
  return table(w, tokens, i, end);
}
