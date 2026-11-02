// Fonts for the XeTeX route of the converter (docs/DESIGN.md#converter).
//
// Two font sets. 'latin-modern' is fontspec's default (Latin Modern text, Latin Modern Math), so a document
// that needs XeTeX only for a few accented letters looks like the pdfTeX template. 'dejavu' is the notes
// template: DejaVu Serif, Sans and Sans Mono for text and code (they carry Greek, box drawing and many
// symbols), Latin Modern Math for math. The set is chosen from the characters the document uses and the
// coverage table (coverage.ts, measured from the font files).
//
// No one face covers every character, so the notes template has a fallback rule: each character its own face
// lacks is printed from the first shipped font that has it, upright. The rule runs inside XeTeX: the character
// gets an interchar class whose tokens open a group with the fallback font (chosen for the serif or the
// monospaced context) and close it after the run, so it works in headings, \texttt, tables and verbatim alike.
// Math characters Latin Modern Math lacks are taken from DejaVu Math TeX Gyre through unicode-math's range
// option. A character no shipped font has is shown as [U+XXXX] by the writer, with a notice.
//
// The fonts are in the core data set (DejaVu among them), so XeTeX finds each by its file name.

import { COVERAGE, type CoverageId } from './coverage';

const parsed = new Map<CoverageId, Uint32Array>();

function ranges(id: CoverageId): Uint32Array {
  let r = parsed.get(id);
  if (!r) {
    const parts = COVERAGE[id].split(' ').filter((p) => p !== '');
    r = new Uint32Array(parts.length * 2);
    parts.forEach((p, k) => {
      const [a, b] = p.split('-');
      r![2 * k] = parseInt(a, 16);
      r![2 * k + 1] = parseInt(b ?? a, 16);
    });
    parsed.set(id, r);
  }
  return r;
}

/** True when the font family `id` has the code point (every face of it, for the families). */
export function covers(id: CoverageId, cp: number): boolean {
  const r = ranges(id);
  let lo = 0;
  let hi = r.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < r[2 * mid]) {
      hi = mid - 1;
    } else if (cp > r[2 * mid + 1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

const ALL: CoverageId[] = Object.keys(COVERAGE) as CoverageId[];

/** True when some font the extension ships has the character. */
export function anyFontHas(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 || ALL.some((id) => covers(id, cp));
}

/** Text written for a character no shipped font has. */
export function missingCharText(ch: string): string {
  return `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`;
}

export type FontSetName = 'latin-modern' | 'dejavu';

/** The non-ASCII characters a document uses, by where they stand. */
export interface CharacterUse {
  text: Set<string>;
  code: Set<string>;
  math: Set<string>;
}

export function emptyCharacterUse(): CharacterUse {
  return { text: new Set(), code: new Set(), math: new Set() };
}

const cp = (ch: string) => ch.codePointAt(0) ?? 0;

/** Latin Modern when it has every character of the text and the code; the DejaVu notes set otherwise. */
export function chooseFontSet(use: CharacterUse): FontSetName {
  const text = [...use.text].every((ch) => covers('lmroman', cp(ch)) || !anyFontHas(ch));
  const code = [...use.code].every((ch) => covers('lmmono', cp(ch)) || !anyFontHas(ch));
  return text && code ? 'latin-modern' : 'dejavu';
}

interface Fallback {
  id: CoverageId;
  /** The fontspec command name for the fallback family. */
  command: string;
  /** Font file (one file for every face: fallback characters print upright). */
  file: string;
}

const FALLBACKS: Record<string, Fallback> = {
  serif: { id: 'DejaVuSerif-upright', command: 'mdfbDejaVuSerif', file: 'DejaVuSerif.ttf' },
  sans: { id: 'DejaVuSans-upright', command: 'mdfbDejaVuSans', file: 'DejaVuSans.ttf' },
  mono: { id: 'DejaVuSansMono-upright', command: 'mdfbDejaVuSansMono', file: 'DejaVuSansMono.ttf' },
  dejavuMath: { id: 'texgyredejavu-math', command: 'mdfbDejaVuMath', file: 'texgyredejavu-math.otf' },
  lmMath: { id: 'latinmodern-math', command: 'mdfbLatinModernMath', file: 'latinmodern-math.otf' },
};

/** Fallback order for characters in the serif text, and in monospaced code. */
const TEXT_ORDER = [FALLBACKS.serif, FALLBACKS.sans, FALLBACKS.mono, FALLBACKS.dejavuMath, FALLBACKS.lmMath];
const CODE_ORDER = [FALLBACKS.mono, FALLBACKS.sans, FALLBACKS.serif, FALLBACKS.dejavuMath, FALLBACKS.lmMath];

export interface FontPlan {
  set: FontSetName;
  /** Preamble lines after \usepackage{fontspec} and \usepackage{unicode-math}. */
  preamble: string[];
  /** Characters with a fallback font, as [character, serif fallback file, code fallback file]. */
  fallbacks: [string, string | undefined, string | undefined][];
  /** Math characters that no math font has. */
  missingMath: string[];
}

const hex = (ch: string) => cp(ch).toString(16).toUpperCase();

/** The font lines for a document's characters in the given set. */
export function fontPlan(use: CharacterUse, set: FontSetName): FontPlan {
  const preamble: string[] = [];
  if (set === 'dejavu') {
    preamble.push(
      '\\setmainfont{DejaVuSerif}[Extension=.ttf,BoldFont=*-Bold,ItalicFont=*-Italic,BoldItalicFont=*-BoldItalic]',
      '\\setsansfont{DejaVuSans}[Extension=.ttf,BoldFont=*-Bold,ItalicFont=*-Oblique,BoldItalicFont=*-BoldOblique]',
      '\\setmonofont{DejaVuSansMono}[Extension=.ttf,BoldFont=*-Bold,ItalicFont=*-Oblique,BoldItalicFont=*-BoldOblique,Scale=MatchLowercase]',
    );
  }
  preamble.push('\\setmathfont{latinmodern-math.otf}');

  // Math characters Latin Modern Math lacks: from DejaVu Math TeX Gyre when it has them.
  const mathFromDejaVu = [...use.math].filter((ch) => !covers('latinmodern-math', cp(ch)) && covers('texgyredejavu-math', cp(ch))).sort();
  const missingMath = [...use.math].filter((ch) => !covers('latinmodern-math', cp(ch)) && !covers('texgyredejavu-math', cp(ch))).sort();
  if (mathFromDejaVu.length > 0) {
    preamble.push(`\\setmathfont{texgyredejavu-math.otf}[range={${mathFromDejaVu.map((ch) => `"${hex(ch)}`).join(',')}}]`);
  }

  // Text and code characters the set's own faces lack (the Latin Modern set is only chosen when there are none).
  const fallbacks: FontPlan['fallbacks'] = [];
  if (set === 'dejavu') {
    for (const ch of [...new Set([...use.text, ...use.code])].sort()) {
      const c = cp(ch);
      if (c < 0x80 || !anyFontHas(ch)) {
        continue;
      }
      const rm = covers('DejaVuSerif', c) ? undefined : TEXT_ORDER.find((f) => covers(f.id, c));
      const tt = covers('DejaVuSansMono', c) ? undefined : CODE_ORDER.find((f) => covers(f.id, c));
      if (rm || tt) {
        fallbacks.push([ch, rm?.file, tt?.file]);
      }
    }
  }
  if (fallbacks.length > 0) {
    preamble.push(...fallbackLines(fallbacks));
  }
  return { set, preamble, fallbacks, missingMath };
}

/** The XeTeX interchar setup for the fallback characters (one class per pair of serif and code fallbacks). */
function fallbackLines(fallbacks: FontPlan['fallbacks']): string[] {
  const byFile = new Map(Object.values(FALLBACKS).map((f) => [f.file, f]));
  const used = new Set<string>();
  const classes = new Map<string, string[]>(); // "rmFile|ttFile" -> characters
  for (const [ch, rm, tt] of fallbacks) {
    const key = `${rm ?? ''}|${tt ?? ''}`;
    classes.set(key, [...(classes.get(key) ?? []), ch]);
    [rm, tt].forEach((f) => f && used.add(f));
  }
  const out = ['% Fallback fonts for the characters the main fonts lack (the converter\'s font rule).', '\\makeatletter'];
  for (const file of used) {
    const f = byFile.get(file) as Fallback;
    out.push(`\\newfontfamily\\${f.command}{${f.file}}[BoldFont=${f.file},ItalicFont=${f.file},BoldItalicFont=${f.file}]`);
  }
  out.push(
    '\\XeTeXinterchartokenstate=1',
    '\\AtBeginDocument{\\edef\\mdfb@tt{\\ttdefault}}',
    '\\def\\mdfb@begin#1#2{\\begingroup\\edef\\mdfb@cur{\\f@family}\\ifx\\mdfb@cur\\mdfb@tt#2\\else#1\\fi}',
  );
  const names: string[] = [];
  const begin: string[] = [];
  let k = 0;
  for (const [key, chars] of classes) {
    const name = `\\mdfb@class${String.fromCharCode(65 + k++)}`;
    names.push(name);
    const [rm, tt] = key.split('|');
    const cmd = (file: string) => (file ? `\\${(byFile.get(file) as Fallback).command}` : '\\relax');
    begin.push(`\\mdfb@begin{${cmd(rm)}}{${cmd(tt)}}`);
    out.push(`\\newXeTeXintercharclass${name}`);
    // Several characters per line keeps the preamble short.
    for (let i = 0; i < chars.length; i += 8) {
      out.push(chars.slice(i, i + 8).map((ch) => `\\XeTeXcharclass"${hex(ch)}=${name}`).join(' '));
    }
  }
  names.forEach((name, i) => {
    out.push(`\\XeTeXinterchartoks 0 ${name}={${begin[i]}} \\XeTeXinterchartoks 4095 ${name}={${begin[i]}}`);
    out.push(`\\XeTeXinterchartoks ${name} 0={\\endgroup} \\XeTeXinterchartoks ${name} 4095={\\endgroup}`);
    names.forEach((other, j) => {
      if (i !== j) {
        out.push(`\\XeTeXinterchartoks ${name} ${other}={\\endgroup${begin[j]}}`);
      }
    });
  });
  out.push('\\makeatother');
  return out;
}
