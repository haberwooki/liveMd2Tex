// SyncTeX (docs/DESIGN.md#architecture, #live-behaviour): the extension's own reader of the .synctex file the engine writes, and
// the two queries, PDF point to source line (inverse search) and source line to PDF boxes (forward search).
// Written for this project from the format as pdfTeX and XeTeX write it (no code from other projects). Pure:
// text in, plain data out; it runs in a worker thread (worker.ts), never on the extension host's main thread.
//
// The format: a preamble ("Input:<tag>:<path>", "Unit:", "X Offset:", "Y Offset:", "Magnification:"), then
// pages "{n" ... "}n" holding boxes and points: "(" an hbox, ")" its end, "[" a vbox, "]" its end, "h" and "v"
// void boxes, and the points "x" (a character position), "g" glue, "k" kern, "$" math. Each record is
// "<tag>,<line>(,<column>)?:<h>,<v>(:<W>(,<H>,<D>)?)?", with h and v in scaled points from the page's top-left.
// The preamble's offsets differ by engine: pdfTeX writes 0 and positions that include TeX's 1 inch origin;
// XeTeX writes 1 inch (4736287 sp) and positions without it. A position in PDF points from the top-left of the
// page is (h * Unit * Magnification/1000 + X Offset) / 65781.76 (65781.76 sp to a big point), and so for v.

export interface SyncPoint {
  tag: number;
  line: number;
  /** PDF points from the page's left edge. */
  x: number;
  /** PDF points from the page's top edge (the baseline). */
  y: number;
  /** Index of the innermost enclosing hbox on the page; -1 when there is none. */
  box: number;
  /** x (a position record, which may carry its box's line), g glue, k kern, $ math. */
  kind: string;
}

export interface SyncBox {
  tag: number;
  line: number;
  /** PDF points, top-left origin. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Points directly inside this box, in the page's point list. */
  points: number[];
  /** Index of the enclosing hbox, -1 when none. */
  parent: number;
  /** A void box ("h" record) is a leaf of its own. */
  void: boolean;
}

export interface SyncPage {
  boxes: SyncBox[];
  points: SyncPoint[];
}

export interface SyncIndex {
  /** Input files by tag, as the engine named them. */
  inputs: Map<number, string>;
  /** Pages, 1-based: pages[0] is unused. */
  pages: SyncPage[];
  unit: number;
  xOffset: number;
  yOffset: number;
  magnification: number;
  /** For forward search: by tag, the lines that have records, sorted. */
  lines: Map<number, number[]>;
}

export interface InverseResult {
  tag: number;
  file: string;
  line: number;
}

export interface Rect {
  /** The page (1-based). */
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ForwardResult {
  /** The first page that shows the line. */
  page: number;
  /**
   * The PDF lines that hold the source line, on every page (top-left origin, PDF points): a long source line
   * (a Markdown paragraph written on one line) can run over a page or column break.
   */
  rects: Rect[];
  /** The source line the boxes come from (the nearest line with output when the asked line has none). */
  line: number;
}

const SP_PER_BP = 65781.76;
const RECORD = /^([([hvxgk$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

function preambleNumber(text: string, name: string, fallback: number): number {
  const m = new RegExp(`^${name}:(-?[\\d.]+)\\s*$`, 'm').exec(text.slice(0, 20000));
  return m ? Number(m[1]) : fallback;
}

/** Reads a .synctex file's text into an index of boxes and points per page. */
export function parseSyncTex(text: string): SyncIndex {
  const unit = preambleNumber(text, 'Unit', 1);
  const magnification = preambleNumber(text, 'Magnification', 1000);
  const xOffset = preambleNumber(text, 'X Offset', 0);
  const yOffset = preambleNumber(text, 'Y Offset', 0);
  const scale = (unit * magnification) / 1000 / SP_PER_BP;
  const toX = (h: number) => h * scale + (xOffset * unit) / SP_PER_BP;
  const toY = (v: number) => v * scale + (yOffset * unit) / SP_PER_BP;
  const dim = (d: number) => d * scale;

  const inputs = new Map<number, string>();
  const pages: SyncPage[] = [{ boxes: [], points: [] }];
  const lineSets = new Map<number, Set<number>>();
  const noteLine = (tag: number, line: number) => {
    let s = lineSets.get(tag);
    if (!s) {
      s = new Set();
      lineSets.set(tag, s);
    }
    s.add(line);
  };

  let page: SyncPage | null = null;
  const stack: number[] = []; // open hboxes (indexes); -2 marks an open vbox
  const innermost = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] >= 0) {
        return stack[i];
      }
    }
    return -1;
  };

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    if (line.length === 0) {
      continue;
    }
    const c = line[0];
    if (c === 'I' && line.startsWith('Input:')) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) {
        inputs.set(Number(m[1]), m[2]);
      }
      continue;
    }
    if (c === '{') {
      const n = Number(line.slice(1));
      while (pages.length <= n) {
        pages.push({ boxes: [], points: [] });
      }
      page = pages[n];
      stack.length = 0;
      continue;
    }
    if (c === '}') {
      page = null;
      stack.length = 0;
      continue;
    }
    if (!page) {
      continue;
    }
    if (c === ')') {
      // The innermost open hbox ends.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] >= 0) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }
    if (c === ']') {
      const i = stack.lastIndexOf(-2);
      if (i >= 0) {
        stack.splice(i);
      }
      continue;
    }
    const m = RECORD.exec(line);
    if (!m) {
      continue;
    }
    const kind = m[1];
    const tag = Number(m[2]);
    const srcLine = Number(m[3]);
    const h = Number(m[4]);
    const v = Number(m[5]);
    if (kind === '[') {
      stack.push(-2);
      continue;
    }
    if (kind === 'v') {
      continue; // a void vbox: nothing to click on
    }
    noteLine(tag, srcLine);
    if (kind === '(' || kind === 'h') {
      const w = Number(m[6] ?? 0);
      const height = Number(m[7] ?? 0);
      const depth = Number(m[8] ?? 0);
      const left = toX(h);
      const baseline = toY(v);
      const parent = innermost();
      const box: SyncBox = {
        tag,
        line: srcLine,
        left: Math.min(left, left + dim(w)),
        right: Math.max(left, left + dim(w)),
        top: baseline - dim(height),
        bottom: baseline + dim(depth),
        points: [],
        parent,
        void: kind === 'h',
      };
      page.boxes.push(box);
      if (kind === '(') {
        stack.push(page.boxes.length - 1);
      }
      continue;
    }
    // A point: x, g, k or $.
    const box = innermost();
    page.points.push({ tag, line: srcLine, x: toX(h), y: toY(v), box, kind });
    if (box >= 0) {
      page.boxes[box].points.push(page.points.length - 1);
    }
  }

  const lines = new Map<number, number[]>();
  for (const [tag, set] of lineSets) {
    lines.set(tag, [...set].sort((a, b) => a - b));
  }
  return { inputs, pages, unit, xOffset, yOffset, magnification, lines };
}

const area = (b: SyncBox) => (b.right - b.left) * (b.bottom - b.top);

function distance(b: SyncBox, x: number, y: number): number {
  const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
  const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
  return Math.hypot(dx, dy);
}

/**
 * The source line under a point of a page (PDF points, top-left origin): the smallest hbox holding the point
 * (or the nearest one), and inside it the first point at or right of the click: the glue or kern after the
 * clicked word, which TeX made while reading that word's line.
 */
export function inverseSearch(index: SyncIndex, pageNumber: number, x: number, y: number): InverseResult | null {
  const page = index.pages[pageNumber];
  if (!page || page.boxes.length === 0) {
    return null;
  }
  let best = -1;
  for (let i = 0; i < page.boxes.length; i++) {
    const b = page.boxes[i];
    if (b.right - b.left <= 0 || x < b.left || x > b.right || y < b.top || y > b.bottom) {
      continue;
    }
    if (best < 0 || area(b) < area(page.boxes[best])) {
      best = i;
    }
  }
  if (best < 0) {
    let bestDistance = Infinity;
    for (let i = 0; i < page.boxes.length; i++) {
      const b = page.boxes[i];
      if (b.right - b.left <= 0) {
        continue;
      }
      const d = distance(b, x, y);
      if (d < bestDistance || (d === bestDistance && best >= 0 && area(b) < area(page.boxes[best]))) {
        best = i;
        bestDistance = d;
      }
    }
  }
  if (best < 0) {
    return null;
  }
  const box = page.boxes[best];
  let tag = box.tag;
  let line = box.line;
  // The points directly in the box, else in its void children (a line may hold only void boxes).
  // Glue, kern and math records carry the line TeX was reading when it made them; prefer them to x records.
  const all = box.points.map((p) => page.points[p]);
  const made = all.filter((p) => p.kind !== 'x');
  const candidates = made.length > 0 ? made : all;
  if (candidates.length > 0) {
    const sorted = candidates.slice().sort((a, b) => a.x - b.x);
    const after = sorted.find((p) => p.x >= x - 0.5) ?? sorted[sorted.length - 1];
    tag = after.tag;
    line = after.line;
  }
  return { tag, file: index.inputs.get(tag) ?? '', line };
}

/**
 * The PDF lines that hold a source line: every hbox with a point or a box from that line, on every page. When
 * the line itself produced nothing (a blank line, a comment), the next line with output is used, else the
 * previous one.
 */
export function forwardSearch(index: SyncIndex, tag: number, line: number): ForwardResult | null {
  const known = index.lines.get(tag);
  if (!known || known.length === 0) {
    return null;
  }
  // The line itself, then the next lines with records, then the earlier ones (a line's records may give no box:
  // a \author line's, say), a few dozen at most.
  const order = [...known.filter((l) => l >= line), ...known.filter((l) => l < line).reverse()].slice(0, 40);
  for (const target of order) {
    const found = forwardLine(index, tag, target);
    if (found) {
      return found;
    }
  }
  return null;
}

function forwardLine(index: SyncIndex, tag: number, target: number): ForwardResult | null {
  const all: Rect[] = [];
  for (let n = 1; n < index.pages.length; n++) {
    const page = index.pages[n];
    const hits = new Set<number>();
    page.points.forEach((p) => {
      if (p.tag === tag && p.line === target && p.box >= 0) {
        hits.add(p.box);
      }
    });
    page.boxes.forEach((b, i) => {
      if (b.tag === tag && b.line === target && !b.void && b.points.length === 0 && b.right > b.left) {
        hits.add(i);
      }
    });
    if (hits.size === 0) {
      continue;
    }
    // A void box or a nested box stands for the line box that holds it.
    const lineBoxes = new Set<number>();
    for (const i of hits) {
      let j = i;
      while (page.boxes[j].parent >= 0 && page.boxes[j].right - page.boxes[j].left < 0.5) {
        j = page.boxes[j].parent;
      }
      lineBoxes.add(j);
    }
    const rects = [...lineBoxes]
      .map((i) => page.boxes[i])
      .filter((b) => b.right > b.left)
      .map((b) => ({ page: n, left: b.left, top: b.top, width: b.right - b.left, height: Math.max(b.bottom - b.top, 1) }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    all.push(...rects);
  }
  return all.length > 0 ? { page: all[0].page, rects: all, line: target } : null;
}

/** The tag of an input file, by its path relative to the engine's project folder ("main.tex", "sub/a.tex"). */
export function tagOf(index: SyncIndex, projectPath: string): number | undefined {
  for (const [tag, file] of index.inputs) {
    if (projectRelative(file) === projectPath) {
      return tag;
    }
  }
  return undefined;
}

/** An input path as the engine wrote it ("/project/./sub/a.tex") relative to the project; undefined outside. */
export function projectRelative(file: string): string | undefined {
  const m = /^\/project\/(.*)$/.exec(file.replace(/\\/g, '/'));
  if (!m) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of m[1].split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}
