// Click-to-source on the lists TeX makes itself (build gate 1 follow-up, G1S-06): the contents list, the lists of
// figures and tables, and the bibliography. SyncTeX names the file TeX read them from (name.toc, name.bbl), which is
// not a source: it lives only in the compile. The compile's own auxiliary files say where each line came from:
//
//   - a contents line ("\contentsline {section}{\numberline {2}Model}{3}{section.2}") gives a title, found again
//     on a heading line of the sources (a caption line for .lof and .lot);
//   - a bibliography entry ("\bibitem[Callaway(1959)]{callaway1959}") gives a key, found again as "@article{key,"
//     in the .bib files that the .aux names ("\bibdata{refs}");
//   - the bibliography's own heading, above the first entry, goes to the line that places the bibliography.
//
// Pure code: the caller passes the auxiliary files' text and a reader for the sources. Every scan is one pass over
// text the compile wrote, with plain string search.

import { posix } from 'node:path';
import type { SourceLine } from './compose';

/** The files TeX writes and reads back that SyncTeX can name. */
export const GENERATED_FILE = /\.(toc|lof|lot|bbl)$/i;

/** An auxiliary file of a compile: its path relative to the project folder, and its text. */
export interface AuxFile {
  path: string;
  text: string;
}

/** The text of the brace group that starts at `text[i]` ("{"), and the index after it; undefined if unbalanced. */
function group(text: string, i: number, open = '{', close = '}'): { inside: string; end: number } | undefined {
  if (text[i] !== open) {
    return undefined;
  }
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\\') {
      j++; // an escaped brace does not count
    } else if (text[j] === open) {
      depth++;
    } else if (text[j] === close && --depth === 0) {
      return { inside: text.slice(i + 1, j), end: j + 1 };
    }
  }
  return undefined;
}

const skipSpaces = (text: string, i: number) => {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  return i;
};

/** The title of the contents line at `line` (1-based), or of the nearest one above it. */
export function contentsTitle(lines: string[], line: number): string | undefined {
  for (let l = Math.min(line, lines.length); l >= 1; l--) {
    const text = lines[l - 1];
    const at = text.indexOf('\\contentsline');
    if (at < 0) {
      continue;
    }
    const level = group(text, skipSpaces(text, at + '\\contentsline'.length));
    const title = level && group(text, skipSpaces(text, level.end));
    if (!title) {
      return undefined;
    }
    // "\numberline {2.1}Model": the number is not part of the title.
    let inside = title.inside;
    const number = inside.indexOf('\\numberline');
    if (number >= 0) {
      const n = group(inside, skipSpaces(inside, number + '\\numberline'.length));
      inside = inside.slice(0, number) + (n ? inside.slice(n.end) : '');
    }
    return inside;
  }
  return undefined;
}

/** The citation key of the bibliography entry at `line`, or of the nearest one above it. */
export function bibitemKey(lines: string[], line: number): string | undefined {
  for (let l = Math.min(line, lines.length); l >= 1; l--) {
    const text = lines[l - 1];
    const at = text.indexOf('\\bibitem');
    if (at < 0) {
      continue;
    }
    let i = skipSpaces(text, at + '\\bibitem'.length);
    if (text[i] === '[') {
      const label = group(text, i, '[', ']');
      if (!label) {
        return undefined;
      }
      i = skipSpaces(text, label.end);
    }
    const key = group(text, i);
    return key?.inside.trim() || undefined;
  }
  return undefined;
}

/** The .bib files an .aux file names (\bibdata{a,b}), without biblatex's own "-blx" file. */
export function bibdataFiles(aux: string): string[] {
  const out: string[] = [];
  for (let at = aux.indexOf('\\bibdata'); at >= 0; at = aux.indexOf('\\bibdata', at + 1)) {
    const names = group(aux, skipSpaces(aux, at + '\\bibdata'.length));
    for (const name of names?.inside.split(',') ?? []) {
      const n = name.trim();
      if (n && !n.endsWith('-blx')) {
        out.push(/\.bib$/i.test(n) ? n : `${n}.bib`);
      }
    }
  }
  return out;
}

/** The line (1-based) where the .bib entry with `key` starts ("@article{key,"); keys compare without case. */
export function bibEntryLine(lines: string[], key: string): number | undefined {
  const want = key.toLowerCase();
  for (let l = 0; l < lines.length; l++) {
    const text = lines[l];
    const at = text.indexOf('@');
    if (at < 0 || text.slice(0, at).trim() !== '') {
      continue;
    }
    const open = Math.min(...['{', '('].map((c) => text.indexOf(c, at)).filter((i) => i >= 0));
    if (!Number.isFinite(open)) {
      continue;
    }
    const comma = text.indexOf(',', open);
    const found = (comma < 0 ? text.slice(open + 1) : text.slice(open + 1, comma)).trim().toLowerCase();
    if (found === want) {
      return l + 1;
    }
  }
  return undefined;
}

/** The words of a text (runs of letters or digits, lower case), with TeX command names left out. */
function words(text: string): string[] {
  return [...text.replace(/\\[A-Za-z@]+\*?/g, ' ').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
}

const HEADING = /^\s{0,3}#{1,6}\s|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/;
const CAPTION = /\\caption\b|^\s*!\[|^\s*(Table|:)\s*:?\s/;

/**
 * The first line of `lines` that is a heading (`caption`: a caption) and holds every word of `title`; undefined when
 * none does.
 */
export function entryLine(lines: string[], title: string, caption: boolean): number | undefined {
  const want = words(title);
  if (want.length === 0) {
    return undefined;
  }
  const kind = caption ? CAPTION : HEADING;
  for (let l = 0; l < lines.length; l++) {
    if (!kind.test(lines[l])) {
      continue;
    }
    const have = new Set(words(lines[l]));
    if (want.every((w) => have.has(w))) {
      return l + 1;
    }
  }
  return undefined;
}

/**
 * The line that places the bibliography: \bibliography{...} or \printbibliography in LaTeX, a "::: {#refs}" block
 * or the front matter's "bibliography:" in Markdown. For a click on the bibliography's heading, above any entry.
 */
export function bibliographyLine(lines: string[]): number | undefined {
  for (const test of [/\\bibliography\s*\{|\\printbibliography\b/, /^:::+\s*\{#refs\}/, /^bibliography\s*:/]) {
    const at = lines.findIndex((l) => test.test(l));
    if (at >= 0) {
      return at + 1;
    }
  }
  return undefined;
}

/** A project-relative path that stays inside the project (no "..", not absolute). */
function inside(rel: string): boolean {
  const n = posix.normalize(rel);
  return n !== '..' && !n.startsWith('../') && !posix.isAbsolute(n) && !/^[A-Za-z]:/.test(n);
}

/**
 * The source of a SyncTeX hit in a list TeX made: a heading or caption line in `sources` (project-relative, the
 * main document first), or the .bib entry of a bibliography item. `aux`: the compile's auxiliary files; `read`
 * gives a project file's lines. Undefined when the auxiliary files are not at hand or nothing matches.
 */
export async function sourceOfList(
  hit: SourceLine,
  aux: AuxFile[],
  sources: string[],
  read: (file: string) => Promise<string[] | undefined>,
): Promise<SourceLine | undefined> {
  const base = posix.basename(hit.file);
  const own = aux.find((a) => a.path === hit.file) ?? aux.find((a) => posix.basename(a.path) === base);
  if (!own) {
    return undefined;
  }
  const lines = own.text.split(/\r?\n/);
  const dir = posix.dirname(own.path) === '.' ? '' : `${posix.dirname(own.path)}/`;
  if (/\.bbl$/i.test(hit.file)) {
    const key = bibitemKey(lines, hit.line);
    if (!key) {
      // The bibliography's heading, above the first entry: the line that places the bibliography.
      for (const file of sources.filter(inside)) {
        const sourceLines = await read(file);
        const at = sourceLines && bibliographyLine(sourceLines);
        if (at) {
          return { file, line: at };
        }
      }
      return undefined;
    }
    const stem = base.replace(/\.bbl$/i, '');
    const mainAux = aux.find((a) => a.path === `${dir}${stem}.aux`);
    if (!mainAux) {
      return undefined;
    }
    for (const bib of bibdataFiles(mainAux.text).map((b) => posix.normalize(`${dir}${b}`))) {
      const bibLines = inside(bib) ? await read(bib) : undefined;
      const at = bibLines && bibEntryLine(bibLines, key);
      if (at) {
        return { file: bib, line: at };
      }
    }
    return undefined;
  }
  const title = contentsTitle(lines, hit.line);
  if (!title) {
    return undefined;
  }
  for (const file of sources.filter(inside)) {
    const sourceLines = await read(file);
    const at = sourceLines && entryLine(sourceLines, title, !/\.toc$/i.test(hit.file));
    if (at) {
      return { file, line: at };
    }
  }
  return undefined;
}
