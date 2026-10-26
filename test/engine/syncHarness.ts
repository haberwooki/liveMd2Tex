// The Node-level SyncTeX harness of M2-A (docs/DESIGN.md#testing): words are picked from a PDF's text as pdf.js reads
// it, mapped through SyncTeX (the extension's SyncTeX worker, composed with the converter's line map for
// Markdown) and checked against the source text.
//
// - Inverse search: a click at the centre of a picked word must land within one line of the source line that
//   holds that word.
// - Forward search: a picked source line must land on the page that shows its word, with a highlight box over it.
//
// A word is picked only when it is unambiguous: letters only, five or more, once in the PDF's text and once in
// the sources. A click carries the word under it and its typeset line, as the viewer sends them from pdf.js's text
// layer, and the extension refines SyncTeX's line with them (compose.ts, refineHit): TeX gives text the line where it finished
// reading it, which for a title block, a verbatim block or a boxed environment is not the line that holds it.
// The report also counts the same clicks with SyncTeX alone. Picks come from a seeded generator, so a run can
// be repeated.
//
// The 10/10 above holds for unambiguous words. Build gate 1 (G1S-06) asked for harder targets too, so the
// harness also clicks random characters of the text (runRandomPoints): common words, maths, numbers, table cells,
// captions, footnotes and title blocks, as often as they appear. Those clicks are reported beside SyncTeX alone,
// with a floor of 90% of the points that can be judged, not a perfect score.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SyncClient } from '../../src/extension/sync/syncClient';
import { generatedOfSource, mergeForward, pageForWord, refineHit, sourceOfGenerated, type MarkdownOrigin, type SourceLine } from '../../src/synctex/compose';
import type { CompileResult } from '../../src/shared/engineJobs';
import { bibliographyLine, GENERATED_FILE, sourceOfList, type AuxFile } from '../../src/synctex/generated';
import type { ForwardResult, Rect } from '../../src/synctex/parser';
import { root } from '../support/helpers';

export interface PdfWord {
  page: number;
  word: string;
  /** Centre of the word, PDF points, top-left origin. */
  x: number;
  y: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface PdfJs {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{ numPages: number; getPage(n: number): Promise<{ view: number[]; getTextContent(): Promise<{ items: unknown[] }> }> }>;
    destroy(): Promise<void>;
  };
}

/** A horizontal text run of a PDF as pdf.js reads it (PDF points, top-left origin; `baseline` is a y). */
export interface PdfRun {
  page: number;
  str: string;
  left: number;
  width: number;
  baseline: number;
  size: number;
}

/** Every horizontal text run of a PDF. */
export async function pdfRuns(pdf: Uint8Array): Promise<PdfRun[]> {
  const pdfjs = (await import(pathToFileURL(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href)) as PdfJs;
  const task = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const out: PdfRun[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [x0, , , y1] = page.view;
    for (const raw of (await page.getTextContent()).items) {
      const item = raw as TextItem;
      if (typeof item.str !== 'string' || item.str.length === 0 || !item.transform || Math.abs(item.transform[1]) > 1e-3 || Math.abs(item.transform[2]) > 1e-3) {
        continue;
      }
      const [, , , d, e, f] = item.transform;
      out.push({ page: n, str: item.str, left: e - x0, width: item.width, baseline: y1 - f, size: Math.abs(d) || item.height });
    }
  }
  await task.destroy();
  return out;
}

/** The centre of characters `start` to `end` of a run (estimated: the run's width shared evenly). */
function centreOf(run: PdfRun, start: number, end: number): { x: number; y: number } {
  const left = run.left + (run.width * start) / run.str.length;
  const right = run.left + (run.width * end) / run.str.length;
  return { x: (left + right) / 2, y: run.baseline - run.size * 0.3 };
}

/** Every word of five or more letters in a PDF's runs, with its centre. */
export function wordsOfRuns(runs: PdfRun[]): (PdfWord & { run: PdfRun })[] {
  const out: (PdfWord & { run: PdfRun })[] = [];
  for (const run of runs) {
    for (const m of run.str.matchAll(/[A-Za-z]+/g)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Not a part of a hyphenated or composed word.
      if (m[0].length < 5 || /[-\u00ad]/.test(run.str[end] ?? '') || /[^\s(["'`]/.test(run.str[start - 1] ?? ' ') || /[A-Za-z0-9\u0080-\uffff]/.test(run.str[end] ?? '')) {
        continue;
      }
      out.push({ page: run.page, word: m[0], ...centreOf(run, start, end), run });
    }
  }
  return out;
}

/** The text of a typeset line, as the viewer reads it from its text layer: the runs left to right, joined. */
const lineText = (line: PdfRun[]): string => line.map((r) => r.str).join(' ');

/** Every word of five or more letters in a PDF, with its centre (estimated within its text run). */
export async function pdfWords(pdf: Uint8Array): Promise<PdfWord[]> {
  return wordsOfRuns(await pdfRuns(pdf)).map(({ page, word, x, y }) => ({ page, word, x, y }));
}

/**
 * The typeset lines of a page: runs on one baseline, split where a gap is wider than 0.8 of the font size (the gutter
 * of a two-column page, a table's column gap). Each run belongs to one line.
 */
function typesetLines(runs: PdfRun[]): Map<PdfRun, PdfRun[]> {
  const byPage = new Map<number, PdfRun[]>();
  runs.forEach((r) => byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]));
  const lineOf = new Map<PdfRun, PdfRun[]>();
  for (const pageRuns of byPage.values()) {
    const sorted = pageRuns.slice().sort((a, b) => a.baseline - b.baseline || a.left - b.left);
    let group: PdfRun[] = [];
    const flush = () => {
      group.sort((a, b) => a.left - b.left);
      let line: PdfRun[] = [];
      for (const r of group) {
        const last = line[line.length - 1];
        if (last && r.left - (last.left + last.width) > 0.8 * Math.max(r.size, last.size)) {
          line.forEach((x) => lineOf.set(x, line));
          line = [];
        }
        line.push(r);
      }
      line.forEach((x) => lineOf.set(x, line));
      group = [];
    };
    for (const r of sorted) {
      if (group.length > 0 && Math.abs(r.baseline - group[0].baseline) > 1.5) {
        flush();
      }
      group.push(r);
    }
    flush();
  }
  return lineOf;
}

/** Where each word of five or more letters stands in the sources. */
export function wordOccurrences(sources: { file: string; text: string }[]): Map<string, SourceLine[]> {
  const out = new Map<string, SourceLine[]>();
  for (const { file, text } of sources) {
    text.split(/\r?\n/).forEach((line, k) => {
      for (const m of line.matchAll(/(?<![A-Za-z\\])[A-Za-z]{5,}(?![A-Za-z])/g)) {
        const list = out.get(m[0]) ?? [];
        list.push({ file, line: k + 1 });
        out.set(m[0], list);
      }
    });
  }
  return out;
}

/** A small seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(list: T[], count: number, random: () => number): T[] {
  const pool = list.slice();
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return out;
}

/** The two queries in source terms (Markdown lines for converted Markdown); inverse refined by the word and run, if given. */
export interface SyncSubject {
  inverse(page: number, x: number, y: number, word?: string, context?: string): Promise<SourceLine | null>;
  forward(file: string, line: number): Promise<ForwardResult | null>;
  /** A project file's lines (the sources, and the .bib files for the bibliography). */
  lines(file: string): Promise<string[] | undefined>;
}

/** What the list lookup needs (generated.ts): the compile's auxiliary files, and the files beyond the sources. */
export interface Lists {
  aux: AuxFile[];
  /** Project files by relative path (the .bib files), read on demand. */
  read: (file: string) => Promise<string[] | undefined>;
}

/** The auxiliary files of a compile result, as the sync service keeps them. */
export function auxOf(result: CompileResult): AuxFile[] {
  return result.state.filter((f) => /\.(toc|lof|lot|bbl|aux)$/i.test(f.path)).map((f) => ({ path: f.path, text: new TextDecoder().decode(f.data) }));
}

type Sources = { file: string; text: string }[];
const textOf = (sources: Sources) => (file: string) => sources.find((s) => s.file === file)?.text.split(/\r?\n/);

/** A reader for the sources first, then the lists' other files. */
const linesOf = (sources: Sources, lists?: Lists) => async (file: string) => textOf(sources)(file) ?? (await lists?.read(file));

export function texSubject(client: SyncClient, key: string, sources: Sources, lists?: Lists): SyncSubject {
  const lines = linesOf(sources, lists);
  return {
    async inverse(page, x, y, word, context) {
      const hit = await client.inverse(key, page, x, y);
      if (hit?.file && GENERATED_FILE.test(hit.file) && (word !== undefined || context !== undefined)) {
        // As the sync service does: a click on the contents list or the bibliography (the refined answer only).
        return (await sourceOfList({ file: hit.file, line: hit.line }, lists?.aux ?? [], sources.map((s) => s.file), lines)) ?? null;
      }
      return hit?.file ? refineHit({ file: hit.file, line: hit.line }, word, textOf(sources), context) : null;
    },
    forward: (file, line) => client.forward(key, file, line),
    lines,
  };
}

export function markdownSubject(client: SyncClient, key: string, origin: MarkdownOrigin, sources: Sources, lists?: Lists): SyncSubject {
  const lines = linesOf(sources, lists);
  return {
    async inverse(page, x, y, word, context) {
      const hit = await client.inverse(key, page, x, y);
      if (hit?.file && GENERATED_FILE.test(hit.file) && (word !== undefined || context !== undefined)) {
        const files = [origin.markdown, ...(origin.appendix ? [origin.appendix.file] : [])];
        return (await sourceOfList({ file: hit.file, line: hit.line }, lists?.aux ?? [], files, lines)) ?? null;
      }
      return hit?.file ? refineHit(sourceOfGenerated(origin, hit.file, hit.line), word, textOf(sources), context) : null;
    },
    lines,
    async forward(file, line) {
      const targets = generatedOfSource(origin, file, line);
      return mergeForward(await Promise.all(targets.map((t) => client.forward(key, t.file, t.line))));
    },
  };
}

export interface HarnessReport {
  candidates: number;
  /** With the word and the typeset line under the click, as the viewer sends them. */
  inverse: { tried: number; withinOne: number; exact: number; misses: string[] };
  /** The same clicks with SyncTeX alone (no word, no run), for the record. */
  syncTexOnly: { withinOne: number; exact: number };
  forward: { tried: number; landed: number; misses: string[] };
  /** Clicks at random characters of the text: common words, maths, numbers, tables, captions, notes, titles. */
  randomPoints: RandomPointReport;
}

export interface PointTally {
  /** Points whose source lines are known (see runRandomPoints). */
  judged: number;
  /** Answered within those lines, with the word and the typeset line under the point as the viewer sends them. */
  refined: number;
  /** Answered within those lines by SyncTeX alone. */
  syncTexOnly: number;
}

export interface RandomPointReport {
  tried: number;
  /** Points on a typeset line that holds unambiguous words: the truth is tight. */
  onWordLines: PointTally;
  /** Points on a line without one (a display formula, a heading, a table rule): the truth is the lines between. */
  betweenLines: PointTally;
  /** Of all judged points, those on a token of one to four characters or on a symbol (maths, numbers, "the"). */
  shortTokens: PointTally;
  /** Points with nothing to judge them by (a page number, a float or a footnote with no unambiguous word near). */
  unjudged: number;
  /** Points SyncTeX places in a file the compile wrote (the contents list, the bibliography), not in a source. */
  inGenerated: number;
  /** Of those, the ones the list lookup takes to a heading or caption with the clicked word, or to a .bib entry. */
  listsResolved: number;
  misses: string[];
}

const tally = (): PointTally => ({ judged: 0, refined: 0, syncTexOnly: 0 });

/** Files a compile writes and TeX reads back: a click on the contents list or the bibliography lands in them. */
const GENERATED = /\.(toc|lof|lot|bbl|ind|gls|nav)$/i;

/**
 * Clicks at random characters of the PDF's text (build gate 1, G1S-06): any run, any character, so common words,
 * maths, numbers, table cells, captions, footnotes and title blocks are clicked as often as they appear. The
 * truth comes from the unambiguous words (`anchors`), whose source lines are known:
 *
 * - on a typeset line that holds some, the span of their source lines, widened by one line each way;
 * - on a line that holds none, the source lines from the nearest line above that holds some to the nearest line
 *   below (in the same column), widened by one line each way: what is typeset between two lines was written
 *   between them, floats and footnotes aside;
 * - otherwise the point is not judged.
 *
 * A point SyncTeX places in a file the compile wrote (the contents list, the bibliography) is judged apart: the
 * lookup of generated.ts must reach a heading or caption that holds the clicked word, or a .bib entry.
 *
 * The click carries what the viewer's text layer gives: the run of letters and digits under it (none on a symbol)
 * and the typeset line around it.
 */
async function runRandomPoints(
  subject: SyncSubject,
  runs: PdfRun[],
  lineOf: Map<PdfRun, PdfRun[]>,
  anchors: { source: SourceLine; run: PdfRun }[],
  count: number,
  random: () => number,
): Promise<RandomPointReport> {
  const report: RandomPointReport = { tried: 0, onWordLines: tally(), betweenLines: tally(), shortTokens: tally(), unjudged: 0, inGenerated: 0, listsResolved: 0, misses: [] };
  const anchorsOf = new Map<PdfRun[], SourceLine[]>();
  for (const a of anchors) {
    const line = lineOf.get(a.run) as PdfRun[];
    anchorsOf.set(line, [...(anchorsOf.get(line) ?? []), a.source]);
  }
  const anchored = [...anchorsOf.keys()];
  const span = (l: PdfRun[]) => ({ page: l[0].page, baseline: l[0].baseline, left: Math.min(...l.map((r) => r.left)), right: Math.max(...l.map((r) => r.left + r.width)) });
  /** The source lines between the nearest anchored lines above and below `line` (same page and column), per file. */
  const between = (line: PdfRun[]): { file: string; first: number; last: number } | undefined => {
    const s = span(line);
    const column = anchored.map((l) => ({ l, s: span(l) })).filter((o) => o.s.page === s.page && o.s.left < s.right && o.s.right > s.left);
    const above = column.filter((o) => o.s.baseline < s.baseline).sort((a, b) => b.s.baseline - a.s.baseline)[0];
    const below = column.filter((o) => o.s.baseline > s.baseline).sort((a, b) => a.s.baseline - b.s.baseline)[0];
    if (!above || !below) {
      return undefined;
    }
    const a = anchorsOf.get(above.l) as SourceLine[];
    const b = anchorsOf.get(below.l) as SourceLine[];
    const file = a[0].file;
    if (a.some((x) => x.file !== file) || b.some((x) => x.file !== file)) {
      return undefined;
    }
    const first = Math.min(...a.map((x) => x.line));
    const last = Math.max(...b.map((x) => x.line));
    return first <= last ? { file, first, last } : undefined;
  };
  const clickable = runs.filter((r) => /\S/.test(r.str));
  for (let k = 0; k < count && clickable.length > 0; k++) {
    const run = clickable[Math.floor(random() * clickable.length)];
    const chars = [...run.str.matchAll(/\S/g)].map((m) => m.index ?? 0);
    const at = chars[Math.floor(random() * chars.length)];
    const token = [...run.str.matchAll(/[\p{L}\p{N}]+/gu)].find((m) => (m.index ?? 0) <= at && at < (m.index ?? 0) + m[0].length)?.[0];
    const { x, y } = centreOf(run, at, at + 1);
    report.tried++;
    const line = lineOf.get(run) as PdfRun[];
    const raw = await subject.inverse(run.page, x, y);
    if (raw && GENERATED.test(raw.file)) {
      // The contents list or the bibliography: the lookup must reach a heading (or caption) that holds the clicked
      // word, or a .bib entry (for the bibliography's heading, the line that places it; generated.ts).
      report.inGenerated++;
      const hit = await subject.inverse(run.page, x, y, token, lineText(line));
      const text = hit && !GENERATED.test(hit.file) ? ((await subject.lines(hit.file))?.[hit.line - 1] ?? '') : '';
      const isBib = /\.bbl$/i.test(raw.file);
      const kindOk = isBib ? /^\s*@/.test(text) || bibliographyLine([text]) === 1 : /^\s{0,3}#|\\(part|chapter|section|subsection|subsubsection|paragraph|caption)\b|^\s*!\[|^\s*Table:/.test(text);
      const wordOk = isBib || token === undefined || !/^\p{L}{2,}$/u.test(token) || text.toLowerCase().includes(token.toLowerCase());
      if (kindOk && wordOk) {
        report.listsResolved++;
      } else {
        report.misses.push(`${token === undefined ? 'a symbol' : `"${token}"`} p${run.page} in ${raw.file}: ${hit ? `${hit.file}:${hit.line}` : 'nothing'}`);
      }
      continue;
    }
    const own = anchorsOf.get(line);
    const ranges = own
      ? [...new Set(own.map((o) => o.file))].map((file) => {
          const at = own.filter((o) => o.file === file).map((o) => o.line);
          return { file, first: Math.min(...at), last: Math.max(...at) };
        })
      : [between(line)].filter((r): r is { file: string; first: number; last: number } => r !== undefined);
    if (ranges.length === 0) {
      report.unjudged++;
      continue;
    }
    const inTruth = (hit: SourceLine | null) => hit !== null && ranges.some((r) => r.file === hit.file && hit.line >= r.first - 1 && hit.line <= r.last + 1);
    const hit = await subject.inverse(run.page, x, y, token, lineText(line));
    const tallies = [own ? report.onWordLines : report.betweenLines];
    if (token === undefined || token.length <= 4) {
      tallies.push(report.shortTokens);
    }
    for (const t of tallies) {
      t.judged++;
      t.syncTexOnly += inTruth(raw) ? 1 : 0;
      t.refined += inTruth(hit) ? 1 : 0;
    }
    if (!inTruth(hit)) {
      const truth = ranges.map((r) => `${r.file}:${r.first}-${r.last}`).join(',');
      report.misses.push(`${token === undefined ? 'a symbol' : `"${token}"`} p${run.page}: ${hit ? `${hit.file}:${hit.line}` : 'nothing'} for ${truth}`);
    }
  }
  return report;
}

/** Ten (or `count`) inverse and forward checks on unambiguous words. Misses name word, page and lines only. */
export async function runHarness(
  subject: SyncSubject,
  pdf: Uint8Array,
  sources: { file: string; text: string }[],
  options: { count?: number; seed?: number; others?: string[]; randomPoints?: number } = {},
): Promise<HarnessReport> {
  const count = options.count ?? 10;
  const random = seeded(options.seed ?? 20261015);
  const runs = await pdfRuns(pdf);
  const words = wordsOfRuns(runs);
  const lineOf = typesetLines(runs);
  const inPdf = new Map<string, typeof words>();
  words.forEach((w) => inPdf.set(w.word, [...(inPdf.get(w.word) ?? []), w]));
  const occurrences = wordOccurrences(sources);
  // Text the compile made (the .bbl) counts too: a word there is not unambiguous.
  const elsewhere = wordOccurrences((options.others ?? []).map((text, k) => ({ file: '(generated) ' + k, text })));
  const candidates = [...occurrences]
    .filter(([word, at]) => at.length === 1 && inPdf.get(word)?.length === 1 && !elsewhere.has(word))
    .map(([word, at]) => ({ word, source: at[0], pdf: (inPdf.get(word) as typeof words)[0] }));

  const report: HarnessReport = {
    candidates: candidates.length,
    inverse: { tried: 0, withinOne: 0, exact: 0, misses: [] },
    syncTexOnly: { withinOne: 0, exact: 0 },
    forward: { tried: 0, landed: 0, misses: [] },
    randomPoints: { tried: 0, onWordLines: tally(), betweenLines: tally(), shortTokens: tally(), unjudged: 0, inGenerated: 0, listsResolved: 0, misses: [] },
  };

  for (const c of pick(candidates, count, random)) {
    report.inverse.tried++;
    const raw = await subject.inverse(c.pdf.page, c.pdf.x, c.pdf.y);
    if (raw && raw.file === c.source.file && Math.abs(raw.line - c.source.line) <= 1) {
      report.syncTexOnly.withinOne++;
      report.syncTexOnly.exact += raw.line === c.source.line ? 1 : 0;
    }
    const hit = await subject.inverse(c.pdf.page, c.pdf.x, c.pdf.y, c.word, lineText(lineOf.get(c.pdf.run) as PdfRun[]));
    const ok = hit !== null && hit.file === c.source.file && Math.abs(hit.line - c.source.line) <= 1;
    if (ok) {
      report.inverse.withinOne++;
      if (hit.line === c.source.line) {
        report.inverse.exact++;
      }
    } else {
      report.inverse.misses.push(`"${c.word}" p${c.pdf.page}: ${hit ? `${hit.file}:${hit.line}` : 'nothing'} for ${c.source.file}:${c.source.line}`);
    }
  }

  // Forward: distinct source lines that hold a candidate word.
  const byLine = new Map<string, (typeof candidates)[number]>();
  candidates.forEach((c) => byLine.set(`${c.source.file}:${c.source.line}`, byLine.get(`${c.source.file}:${c.source.line}`) ?? c));
  for (const c of pick([...byLine.values()], count, random)) {
    report.forward.tried++;
    const result = await subject.forward(c.source.file, c.source.line);
    // The viewer's choice, with the cursor on the word: the page whose box holds it in the text layer.
    const inRect = (w: PdfWord, r: Rect) => w.page === r.page && w.x >= r.left - 1 && w.x <= r.left + r.width + 1 && w.y >= r.top - 2 && w.y <= r.top + r.height + 2;
    const page = result ? pageForWord(result, (r) => words.some((w) => w.word === c.word && inRect(w, r))) : 0;
    const covered = result !== null && page === c.pdf.page && result.rects.some((r) => r.page === page && inRect(c.pdf, r));
    if (covered) {
      report.forward.landed++;
    } else {
      report.forward.misses.push(`${c.source.file}:${c.source.line} ("${c.word}" on p${c.pdf.page}): ${result ? `p${page} (first p${result.page}), ${result.rects.length} box(es)` : 'nothing'}`);
    }
  }

  // Random points: the unambiguous words (every one, not only the picked ones) tell where each typeset line came from.
  report.randomPoints = await runRandomPoints(
    subject,
    runs,
    lineOf,
    candidates.map((c) => ({ source: c.source, run: c.pdf.run })),
    options.randomPoints ?? 100,
    random,
  );
  return report;
}

export function reportLine(name: string, r: HarnessReport): string {
  const p = r.randomPoints;
  const t = (x: PointTally) => `${x.refined}/${x.judged} (SyncTeX alone ${x.syncTexOnly})`;
  return (
    `${name}: inverse ${r.inverse.withinOne}/${r.inverse.tried} within one line (${r.inverse.exact} exact), ` +
    `forward ${r.forward.landed}/${r.forward.tried} on the right page and line; SyncTeX alone ${r.syncTexOnly.withinOne}/${r.inverse.tried} ` +
    `(${r.syncTexOnly.exact} exact); ${r.candidates} candidate words. ${p.tried} random points: on lines with such words ` +
    `${t(p.onWordLines)}, between them ${t(p.betweenLines)}, short tokens and symbols ${t(p.shortTokens)}; ${p.unjudged} not judged, ${p.inGenerated} in the contents list or bibliography (${p.listsResolved} reach their heading or .bib entry)`
  );
}

export function assertHarness(name: string, r: HarnessReport, minimum = 10): void {
  assert.ok(r.inverse.tried >= minimum, `${name}: only ${r.inverse.tried} unambiguous words to click`);
  assert.equal(r.inverse.withinOne, r.inverse.tried, `${name}: inverse misses: ${r.inverse.misses.join('; ')}`);
  assert.equal(r.forward.landed, r.forward.tried, `${name}: forward misses: ${r.forward.misses.join('; ')}`);
  // Random points (G1S-06): a floor, not a perfect score. Measured on 2026-10-16: every judged point of P1, P9, P10
  // and T1, and 54 of 58 for T6.
  const p = r.randomPoints;
  const judged = p.onWordLines.judged + p.betweenLines.judged;
  const refined = p.onWordLines.refined + p.betweenLines.refined;
  assert.ok(judged >= 40, `${name}: only ${judged} of ${p.tried} random points could be judged`);
  assert.ok(refined >= 0.9 * judged, `${name}: random points ${refined}/${judged} within their source lines (${p.misses.length} misses)`);
  // Clicks on the contents list and the bibliography reach their heading or .bib entry (generated.ts).
  assert.ok(p.listsResolved >= 0.9 * p.inGenerated, `${name}: ${p.listsResolved}/${p.inGenerated} clicks in the lists reached their source`);
}

/** Text the compile made that also reaches the PDF (the .bbl): counted when a word must be unique, never a target. */
export function generatedTexts(result: CompileResult): string[] {
  return result.state.filter((f) => /\.bbl$/i.test(f.path)).map((f) => new TextDecoder().decode(f.data));
}
