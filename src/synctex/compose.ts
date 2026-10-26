// SyncTeX composed with the converter's line map (docs/DESIGN.md#converter): for a converted Markdown file, the PDF
// is made from the generated LaTeX, so a click goes PDF -> generated LaTeX line -> Markdown line, and a forward
// search goes Markdown line -> the generated LaTeX lines it became -> PDF. Pure functions.

import type { ForwardResult, Rect } from './parser';

/** A compile of converted Markdown: the generated main file and the Markdown files it came from. */
export interface MarkdownOrigin {
  /** The generated LaTeX file, relative to the project folder (as SyncTeX names it). */
  main: string;
  /** The Markdown file, relative to the project folder. */
  markdown: string;
  /** lineMap[i]: the Markdown line of generated line i + 1. */
  lineMap: number[];
  bodyStartLine: number;
  /** The generated LaTeX text by line, when at hand: blank generated lines are then passed over. */
  latexLines?: string[];
  /** The Markdown text by line, when at hand: tells a line that continues a construct from a blank one. */
  markdownLines?: string[];
  /** A preset's appendix file and, for each generated line, its line there (0: not from the appendix). */
  appendix?: { file: string; map: number[] };
}

export interface SourceLine {
  file: string;
  line: number;
}

/** The Markdown (or appendix) line of a generated LaTeX line; other files pass through unchanged. */
export function sourceOfGenerated(origin: MarkdownOrigin, file: string, line: number): SourceLine {
  if (file !== origin.main) {
    return { file, line };
  }
  const i = Math.min(Math.max(1, line), origin.lineMap.length) - 1;
  const fromAppendix = origin.appendix?.map[i] ?? 0;
  if (origin.appendix && fromAppendix > 0) {
    return { file: origin.appendix.file, line: fromAppendix };
  }
  return { file: origin.markdown, line: origin.lineMap[i] ?? 1 };
}

/** The generated LaTeX lines of a Markdown (or appendix) line; for other files, the line itself. */
export function generatedOfSource(origin: MarkdownOrigin, file: string, line: number): SourceLine[] {
  if (file === origin.markdown) {
    return generatedLinesFor(origin.lineMap, origin.bodyStartLine, line, origin.latexLines, origin.markdownLines).map((l) => ({ file: origin.main, line: l }));
  }
  const appendix = origin.appendix;
  if (appendix && file === appendix.file) {
    const last = Math.max(0, ...appendix.map);
    for (let a = line; a <= last; a++) {
      const out: SourceLine[] = [];
      appendix.map.forEach((v, i) => v === a && out.push({ file: origin.main, line: i + 1 }));
      if (out.length > 0) {
        return out;
      }
    }
    return [];
  }
  return [{ file, line }];
}

/**
 * The generated LaTeX lines (1-based) that come from a Markdown line, in the body. When none does (a blank line,
 * a comment), those of the next Markdown line that has some, so the jump lands where the reader is going. With
 * the LaTeX text, blank generated lines are passed over; a line that only has blank ones continues the construct
 * above it (the second line of an inline footnote), whose last line is taken.
 */
export function generatedLinesFor(
  lineMap: number[],
  bodyStartLine: number,
  markdownLine: number,
  latexLines?: string[],
  markdownLines?: string[],
): number[] {
  // A front matter line (title, author) maps to preamble or title-block lines, before the body; a line inside a
  // value (a subtitle, a second author) to its key's lines, the nearest line above it that has some.
  const body = lineMap.slice(bodyStartLine - 1);
  const linesOf = (md: number) => lineMap.flatMap((m, i) => (m === md ? [i + 1] : []));
  if (!body.includes(markdownLine) && lineMap.includes(markdownLine)) {
    return linesOf(markdownLine);
  }
  const firstBody = Math.min(...body.filter((m) => m > 1));
  if (markdownLine < firstBody) {
    for (let md = markdownLine - 1; md >= 1; md--) {
      if (lineMap.includes(md)) {
        return linesOf(md);
      }
    }
  }
  // In the body: the line's own generated lines with text (blank ones passed over when the LaTeX is at hand).
  const inBody = (md: number) => lineMap.flatMap((m, i) => (i >= bodyStartLine - 1 && m === md ? [i + 1] : []));
  const textual = (ls: number[]) => (latexLines ? ls.filter((l) => (latexLines[l - 1] ?? '').trim() !== '') : ls);
  const own = textual(inBody(markdownLine));
  if (own.length > 0) {
    return own;
  }
  // A line of text without output of its own continues the construct above it (the second line of an inline
  // footnote): that construct's last line. A blank line: the next line with output.
  const continues = markdownLines ? (markdownLines[markdownLine - 1] ?? '').trim() !== '' : inBody(markdownLine).length > 0;
  if (continues) {
    for (let md = markdownLine - 1; md >= 1; md--) {
      const ls = textual(inBody(md));
      if (ls.length > 0) {
        return [ls[ls.length - 1]];
      }
    }
  }
  const last = Math.max(0, ...body);
  for (let md = markdownLine + 1; md <= last; md++) {
    const ls = textual(inBody(md));
    if (ls.length > 0) {
      return ls;
    }
  }
  return [];
}

/**
 * Several lines' forward results as one (the lines one Markdown line became, in order): the first that shows a
 * line of text decides the pages, and the others add their boxes on those pages. The order matters: a closing
 * line such as "\end{quote}" can carry the records of a page header or footer that TeX set while reading it.
 */
export function mergeForward(results: (ForwardResult | null)[]): ForwardResult | null {
  const found = results.filter((r): r is ForwardResult => r !== null);
  if (found.length === 0) {
    return null;
  }
  const primary = found.find((r) => r.rects.some((rect) => rect.height >= 2)) ?? found[0];
  const pages = new Set(primary.rects.map((r) => r.page));
  const seen = new Set<string>();
  const rects = found
    .flatMap((r) => (r === primary ? r.rects : r.rects.filter((rect) => pages.has(rect.page))))
    .filter((r) => {
      const key = `${r.page}:${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left);
  return { page: primary.page, rects, line: primary.line };
}

/**
 * The page to show for a forward search: the first page with a box that holds the word at the editor's cursor
 * (`holds`: the viewer reads its text layer), else the first page. A paragraph written on one long line runs
 * over several PDF lines, and sometimes over a page or column break: the word says which part the cursor is in.
 */
export function pageForWord(result: ForwardResult, holds: ((rect: Rect) => boolean) | undefined): number {
  return (holds && result.rects.find(holds)?.page) ?? result.page;
}

/** A test for `word` as a whole word (not a part of a longer run of letters or digits). */
function wholeWord(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');
}

/** The words (runs of two or more letters or digits) of the clicked typeset line, each once. */
function contextWords(text: string): string[] {
  return [...new Set([...text.matchAll(/[\p{L}\p{N}]{2,}/gu)].map((m) => m[0]))];
}

/**
 * Refines SyncTeX's line with the word under the click and the typeset line around it (the viewer reads both from
 * pdf.js's text layer). TeX gives text the line where it finished reading it: the end of a verbatim block or of a
 * boxed environment (a callout), the line after \maketitle for the whole title block. In order:
 *
 * - SyncTeX's line stands when it holds the clicked word.
 * - The line that shares most words with the clicked line, when it shares at least two and at least half of them
 *   (a line of a code block, an author's affiliation) and holds the clicked word, if there is one. This also places
 *   a click on a symbol or a one-letter word, which has no word to search for (build gate 1, G1S-06).
 * - The nearest line that holds the word (two letters or more): in `within` first (a range searched whole: the
 *   front matter, for a click on the title block), then the line before, the line after, and so on, up to `back`
 *   lines back and `ahead` lines ahead.
 *
 * Otherwise SyncTeX's line stands.
 */
export function refineByWord(
  lines: string[],
  line: number,
  word: string | undefined,
  options: { back?: number; ahead?: number; within?: { first: number; last: number }; context?: string } = {},
): number {
  const w = word?.trim() || undefined;
  const re = w !== undefined ? wholeWord(w) : undefined;
  const inRange = (l: number) => l >= 1 && l <= lines.length;
  const holds = (l: number) => re !== undefined && inRange(l) && re.test(lines[l - 1]);
  if (holds(line)) {
    return line;
  }
  // The lines searched: `within` by distance, then the window around SyncTeX's line, nearest first.
  const back = options.back ?? 40;
  const ahead = options.ahead ?? 3;
  const order: number[] = [];
  if (options.within) {
    const { first, last } = options.within;
    order.push(...Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => first + k).sort((a, b) => Math.abs(a - line) - Math.abs(b - line)));
  }
  for (let d = 0; d <= Math.max(back, ahead); d++) {
    order.push(...(d === 0 ? [line] : [...(d <= back ? [line - d] : []), ...(d <= ahead ? [line + d] : [])]));
  }
  const candidates = [...new Set(order)].filter(inRange);

  const context = options.context ? contextWords(options.context) : [];
  if (context.length >= 2) {
    const tests = context.map(wholeWord);
    let best: number | undefined;
    let bestScore = 0;
    for (const l of candidates) {
      if (re !== undefined && !re.test(lines[l - 1])) {
        continue;
      }
      const score = tests.filter((t) => t.test(lines[l - 1])).length;
      if (score > bestScore) {
        best = l;
        bestScore = score;
      }
    }
    if (best !== undefined && bestScore >= 2 && bestScore * 2 >= context.length) {
      return best;
    }
  }
  if (w === undefined || w.length < 2) {
    return line;
  }
  return candidates.find(holds) ?? line;
}

/** The Markdown lines of the YAML front matter ("---" to "---" at the top), or undefined. */
export function frontMatterRange(lines: string[]): { first: number; last: number } | undefined {
  if (lines[0]?.trim() !== '---') {
    return undefined;
  }
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return end > 0 ? { first: 1, last: end + 1 } : undefined;
}

/**
 * An inverse-search hit refined by the clicked word and the typeset line around it (`context`), in its file's text
 * (`textOf` gives a file's lines; undefined when it is not at hand). A hit inside a Markdown file's front matter
 * searches the whole front matter.
 */
export function refineHit(hit: SourceLine, word: string | undefined, textOf: (file: string) => string[] | undefined, context?: string): SourceLine {
  const lines = textOf(hit.file);
  if (!lines || (!word && !context)) {
    return hit;
  }
  const front = /\.(md|markdown|mdown|mkd|mkdn)$/i.test(hit.file) ? frontMatterRange(lines) : undefined;
  const inFront = front !== undefined && hit.line >= front.first && hit.line <= front.last;
  return { file: hit.file, line: refineByWord(lines, hit.line, word, { ...(inFront ? { within: front } : {}), context }) };
}
