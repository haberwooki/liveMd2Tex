// Escaping of text for LaTeX, and the Unicode table used with the default pdfTeX template.
//
// pdfTeX reads UTF-8 and, with the T1 and TS1 font encodings LaTeX loads, prints Latin-1, the letters of Latin
// Extended-A that T1 has as single glyphs, and the common punctuation and text symbols by itself. Greek
// letters, mathematical symbols, arrows beyond TS1, check marks, sub- and superscript digits and the like are
// not set up for it, so the table below maps them to commands from the LaTeX kernel, amsmath and amssymb (all
// in the default template). Letters T1 builds from a letter and an accent (ė, ā, ș: LaTeX composes them) print,
// but the PDF's text then holds the two parts, so a search or a copy of the name fails; they count as
// unprintable here. Characters the table does not cover are kept as they are and reported, and the converter
// then takes the XeTeX route (docs/DESIGN.md#converter, fonts/fonts.ts). A character no shipped font has is written
// as [U+XXXX] on both routes, and reported too.

import { anyFontHas, emptyCharacterUse, missingCharText, type CharacterUse } from './fonts/fonts';

export type UnicodeMode = 'pdftex' | 'keep';

export type CharContext = 'text' | 'code' | 'math';

/** Collects the characters that pdfTeX cannot print and that the table does not map. */
export class UnicodeReport {
  readonly unmapped = new Map<string, number>();
  /** Characters no shipped font has (written as [U+XXXX]). */
  readonly missing = new Map<string, number>();
  /** Every non-ASCII character, by where it stands (for the XeTeX font rule). */
  readonly use: CharacterUse = emptyCharacterUse();

  note(ch: string): void {
    this.unmapped.set(ch, (this.unmapped.get(ch) ?? 0) + 1);
  }

  see(ch: string, context: CharContext): void {
    this.use[context].add(ch);
  }

  noteMissing(ch: string): void {
    this.missing.set(ch, (this.missing.get(ch) ?? 0) + 1);
  }

  /** The unmapped characters, in order of first appearance. */
  characters(): string[] {
    return [...this.unmapped.keys()];
  }
}

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  '^': '\\^{}',
  '~': '\\textasciitilde{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
  '[': '{[}',
  ']': '{]}',
  '"': '\\textquotedbl{}',
  '`': '\\textasciigrave{}',
  '\u00a0': '~',
  '‘': '`',
  '’': "'",
  '“': '``',
  '”': "''",
  '–': '--',
  '—': '---',
  '…': '\\ldots{}',
};

const math = (cmd: string) => `\\(${cmd}\\)`;

const GREEK: [string, string][] = [
  ['α', 'alpha'], ['β', 'beta'], ['γ', 'gamma'], ['δ', 'delta'], ['ε', 'epsilon'], ['ζ', 'zeta'], ['η', 'eta'],
  ['θ', 'theta'], ['ι', 'iota'], ['κ', 'kappa'], ['λ', 'lambda'], ['μ', 'mu'], ['ν', 'nu'], ['ξ', 'xi'],
  ['π', 'pi'], ['ρ', 'rho'], ['σ', 'sigma'], ['ς', 'varsigma'], ['τ', 'tau'], ['υ', 'upsilon'], ['φ', 'phi'],
  ['χ', 'chi'], ['ψ', 'psi'], ['ω', 'omega'], ['ϕ', 'varphi'], ['ϵ', 'varepsilon'], ['ϑ', 'vartheta'],
  ['Γ', 'Gamma'], ['Δ', 'Delta'], ['Θ', 'Theta'], ['Λ', 'Lambda'], ['Ξ', 'Xi'], ['Π', 'Pi'], ['Σ', 'Sigma'],
  ['Υ', 'Upsilon'], ['Φ', 'Phi'], ['Ψ', 'Psi'], ['Ω', 'Omega'],
];

const SYMBOLS: Record<string, string> = {
  // Relations and operators (amsmath, amssymb).
  '≤': math('\\leq'), '≥': math('\\geq'), '≠': math('\\neq'), '≈': math('\\approx'), '≡': math('\\equiv'),
  '∼': math('\\sim'), '≃': math('\\simeq'), '≅': math('\\cong'), '∝': math('\\propto'), '≪': math('\\ll'),
  '≫': math('\\gg'), '∞': math('\\infty'), '∂': math('\\partial'), '∇': math('\\nabla'), '∑': math('\\sum'),
  '∏': math('\\prod'), '∫': math('\\int'), '√': math('\\surd'), '∈': math('\\in'), '∉': math('\\notin'),
  '∋': math('\\ni'), '⊂': math('\\subset'), '⊃': math('\\supset'), '⊆': math('\\subseteq'),
  '⊇': math('\\supseteq'), '∪': math('\\cup'), '∩': math('\\cap'), '∅': math('\\emptyset'),
  '∀': math('\\forall'), '∃': math('\\exists'), '∧': math('\\wedge'), '∨': math('\\vee'), '⊕': math('\\oplus'),
  '⊗': math('\\otimes'), '∘': math('\\circ'), '⋅': math('\\cdot'), '∗': math('\\ast'), '∖': math('\\setminus'),
  '−': '\\textminus{}', '∓': math('\\mp'), '′': math("{}'"), '″': math("{}''"), 'ℏ': math('\\hbar'),
  'ℓ': math('\\ell'), 'ℝ': math('\\mathbb{R}'), 'ℕ': math('\\mathbb{N}'), 'ℤ': math('\\mathbb{Z}'),
  'ℚ': math('\\mathbb{Q}'), 'ℂ': math('\\mathbb{C}'), '⟨': math('\\langle'), '⟩': math('\\rangle'),
  '⊥': math('\\perp'), '∥': math('\\parallel'), '∠': math('\\angle'), '△': math('\\triangle'),
  '⋯': math('\\cdots'), '⋮': math('\\vdots'), '⋱': math('\\ddots'), '∶': ':',
  // Arrows. The four TS1 arrows print in text; the rest are math.
  '→': '\\textrightarrow{}', '←': '\\textleftarrow{}', '↑': '\\textuparrow{}', '↓': '\\textdownarrow{}',
  '↔': math('\\leftrightarrow'), '⇒': math('\\Rightarrow'), '⇐': math('\\Leftarrow'),
  '⇔': math('\\Leftrightarrow'), '↦': math('\\mapsto'), '⟶': math('\\longrightarrow'),
  '⟹': math('\\Longrightarrow'), '↗': math('\\nearrow'), '↘': math('\\searrow'), '⇌': math('\\rightleftharpoons'),
  // Marks and shapes.
  '✓': '\\checkmark{}', '✔': '\\checkmark{}', '✗': math('\\times'), '✘': math('\\times'),
  '★': math('\\bigstar'), '☆': math('\\star'), '■': math('\\blacksquare'), '□': math('\\square'),
  '☐': math('\\square'), '☑': math('\\boxtimes'), '☒': math('\\boxtimes'), '◦': '\\textopenbullet{}',
  '▪': math('\\blacksquare'), '▸': math('\\blacktriangleright'), '►': math('\\blacktriangleright'),
  '♦': math('\\diamondsuit'), '†': '\\dag{}', '‡': '\\ddag{}', '•': '\\textbullet{}', '‣': '\\textbullet{}',
  '℃': '\\textcelsius{}', 'Å': '\\AA{}', 'ℹ': 'i',
  // Typographic spaces and joiners: print as an ordinary or thin space, or nothing.
  '\u2002': ' ', '\u2003': ' ', '\u2009': '\\,', '\u200a': '\\,', '\u202f': '\\,', '\u2007': '~',
  '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '', '\u2060': '',
  // Variation selectors (text or emoji presentation of the character before): nothing to print.
  '\ufe0e': '', '\ufe0f': '',
  // Other punctuation pdfTeX lacks.
  '‐': '-', '‑': '-', '‒': '--', '―': '---', '‹': '\\guilsinglleft{}', '›': '\\guilsinglright{}',
};

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ';
const SUPERSCRIPT_VALUES = '0123456789+-=()ni';
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ';
const SUBSCRIPT_VALUES = '0123456789+-=()aeoxhklmnpst';

const UNICODE_TABLE = new Map<string, string>();
for (const [ch, name] of GREEK) {
  UNICODE_TABLE.set(ch, math(`\\${name}`));
}
for (const [ch, latex] of Object.entries(SYMBOLS)) {
  UNICODE_TABLE.set(ch, latex);
}
[...SUPERSCRIPTS].forEach((ch, i) => {
  // ¹ ² ³ are Latin-1 and print by themselves.
  if (!'¹²³'.includes(ch)) {
    UNICODE_TABLE.set(ch, `\\textsuperscript{${SUPERSCRIPT_VALUES[i]}}`);
  }
});
[...SUBSCRIPTS].forEach((ch, i) => UNICODE_TABLE.set(ch, `\\textsubscript{${SUBSCRIPT_VALUES[i]}}`));

/** Variation selectors (text or emoji presentation of the character before): nothing to print. */
const VARIATION_SELECTORS = ['\ufe0e', '\ufe0f'];

/** The letters of Latin Extended-A that the T1 encoding has as single glyphs (the others LaTeX composes). */
const T1_LATIN_EXTENDED_A = 'ĂăĄąĆćČčĎďĐđĚěĘęĞğİıĲĳĹĺĽľŁłŃńŇňŊŋŐőŒœŔŕŘřŚśŠšŞşŤťŢţŮůŰűŸŹźŻżŽž';

/**
 * True for a character pdfTeX's UTF-8 input with T1 and TS1 prints by itself as one glyph (so that the PDF's
 * text holds the character itself).
 */
export function pdftexPrints(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) {
    return true;
  }
  if (cp >= 0xa0 && cp <= 0xff) {
    return true; // Latin-1 Supplement
  }
  if (cp >= 0x100 && cp <= 0x17f) {
    return T1_LATIN_EXTENDED_A.includes(ch);
  }
  // Common punctuation and symbols of the TS1 and T1 encodings.
  return '–—‘’‚“”„†‡•…‰‹›€™←↑→↓№℃ˆ˜ƒ′″Ω℧℮₡₤₦₩₫₱₲−⁒♪◦ʻʼ'.includes(ch);
}

/**
 * Maps one non-ASCII character for the given mode; records where it stands, and records it when pdfTeX cannot
 * print it or no shipped font has it (then it is written as \mdmissingchar{hex}).
 */
export function mapUnicode(ch: string, mode: UnicodeMode, report?: UnicodeReport, context: CharContext = 'text'): string {
  const mapped = mode === 'pdftex' ? UNICODE_TABLE.get(ch) : VARIATION_SELECTORS.includes(ch) ? '' : undefined;
  if (mapped !== undefined) {
    return mapped;
  }
  if (!anyFontHas(ch)) {
    report?.noteMissing(ch);
    return `\\mdmissingchar{${missingCharText(ch).slice(3, -1)}}`;
  }
  report?.see(ch, context);
  if (mode === 'pdftex' && !pdftexPrints(ch)) {
    report?.note(ch);
  }
  return ch;
}

/**
 * A run of Unicode superscript or subscript characters starting at chars[i] ("⁻¹", "₁₂"), as one
 * \textsuperscript or \textsubscript, or undefined when there is none worth grouping (a lone ¹ ² ³ prints).
 */
function scriptRun(chars: string[], i: number): { latex: string; length: number } | undefined {
  for (const [set, values, command] of [
    [SUPERSCRIPTS, SUPERSCRIPT_VALUES, 'textsuperscript'],
    [SUBSCRIPTS, SUBSCRIPT_VALUES, 'textsubscript'],
  ] as const) {
    let j = i;
    let body = '';
    while (j < chars.length && set.includes(chars[j])) {
      body += values[set.indexOf(chars[j])];
      j++;
    }
    const run = chars.slice(i, j).join('');
    if (j > i && (j - i > 1 || !'¹²³'.includes(run))) {
      return { latex: `\\${command}{${body}}`, length: j - i };
    }
  }
  return undefined;
}

/** Text escaping choices a preset can make (docs/DESIGN.md#presets); the defaults are the general dialect's. */
export interface TextOptions {
  braces: boolean;
  brackets: boolean;
  angles: boolean;
  tilde: 'escape' | 'sim' | 'nbsp';
  caret: 'hat' | 'textasciicircum';
  /** 'closed': an em dash takes no spaces (written as the sentinel CLOSED_EM_DASH for the caller to finish). */
  emDash: 'spaced' | 'closed';
  /** Straight double quotes stay as they are (no TeX quotes). */
  straightQuotes: boolean;
  /** A preset's own replacements, tried in order at each position before anything else: [from, LaTeX]. */
  sequences: [string, string][];
}

export const DEFAULT_TEXT_OPTIONS: TextOptions = {
  braces: true,
  brackets: true,
  angles: true,
  tilde: 'escape',
  caret: 'hat',
  emDash: 'spaced',
  straightQuotes: false,
  sequences: [],
};

/**
 * Marks a closed-up em dash in escaped text; the inline writer turns it into "---" with no spaces around it. A
 * Unicode noncharacter, which the converter removes from its input (markdownToLatex.ts, withoutControls).
 */
export const CLOSED_EM_DASH = '\ufdd0';

const TILDE: Record<TextOptions['tilde'], string> = { escape: '\\textasciitilde{}', sim: '$\\sim$', nbsp: '~' };

/** Escapes ordinary text: LaTeX's special characters, typographic quotes and the Unicode table. */
export function escapeText(text: string, mode: UnicodeMode = 'pdftex', report?: UnicodeReport, options: TextOptions = DEFAULT_TEXT_OPTIONS): string {
  let out = '';
  const chars = [...text];
  const custom = options !== DEFAULT_TEXT_OPTIONS;
  const offsets: number[] = [];
  if (custom && options.sequences.length > 0) {
    let o = 0;
    for (const c of chars) {
      offsets.push(o);
      o += c.length;
    }
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (custom) {
      // The closed-up em dash comes first: the spaces go before any table maps the dash itself.
      if (ch === '—' && options.emDash === 'closed') {
        out = out.replace(/[ \t]+$/, '') + CLOSED_EM_DASH;
        while (chars[i + 1] === ' ' || chars[i + 1] === '\t') {
          i++;
        }
        continue;
      }
      const seq = offsets.length > 0 ? options.sequences.find(([from]) => text.startsWith(from, offsets[i])) : undefined;
      if (seq) {
        out += seq[1];
        i += [...seq[0]].length - 1;
        continue;
      }
      const plain =
        (ch === '{' || ch === '}') && !options.braces
          ? ch
          : (ch === '[' || ch === ']') && !options.brackets
            ? ch
            : (ch === '<' || ch === '>') && !options.angles
              ? ch
              : ch === '"' && options.straightQuotes
                ? ch
                : undefined;
      if (plain !== undefined) {
        out += plain;
        continue;
      }
      if (ch === '~') {
        out += TILDE[options.tilde];
        continue;
      }
      if (ch === '^' && options.caret === 'textasciicircum') {
        out += '\\textasciicircum{}';
        continue;
      }
    }
    if (mode === 'pdftex' && ch.charCodeAt(0) >= 0x80) {
      const run = scriptRun(chars, i);
      if (run) {
        out += run.latex;
        i += run.length - 1;
        continue;
      }
    }
    const special = SPECIAL[ch];
    // The typographic characters in SPECIAL (dashes, curly quotes, ...) are kept as they are for XeTeX ('keep').
    if (special !== undefined && (mode === 'pdftex' || ch.charCodeAt(0) < 0x80)) {
      out += special;
    } else if (ch.charCodeAt(0) < 0x80) {
      out += ch;
    } else {
      out += mapUnicode(ch, mode, report);
    }
  }
  // "\ldots{}." and similar are fine; but a command followed by a letter needs its braces, which it has.
  return out;
}

/** Escapes code for \texttt{...}: like text, but quotes and dashes stay literal. */
export function escapeCode(text: string, mode: UnicodeMode = 'pdftex', report?: UnicodeReport): string {
  let out = '';
  let previous = '';
  for (const ch of text) {
    const afterSpace = previous === ' ';
    previous = ch;
    switch (ch) {
      case '-':
        out += '-{}'; // no -- or --- ligature in code
        break;
      case "'":
        out += '\\textquotesingle{}';
        break;
      case '`':
        out += '\\textasciigrave{}';
        break;
      case '"':
        out += '\\textquotedbl{}';
        break;
      case ' ':
        out += afterSpace ? '\\ ' : ' '; // keep runs of spaces, which TeX would collapse
        break;
      default: {
        const special = SPECIAL[ch];
        if (special !== undefined && ch.charCodeAt(0) < 0x80) {
          out += special;
        } else if (ch.charCodeAt(0) < 0x80) {
          out += ch;
        } else {
          out += mapUnicode(ch, mode, report, 'code');
        }
      }
    }
  }
  return out;
}

/** Escapes a URL for \href and \url: only the characters hyperref needs escaped inside an argument. */
export function escapeUrl(url: string): string {
  return url.replace(/[\\#%{}]/g, (c) => (c === '\\' ? '/' : `\\${c}`));
}

/** Makes a string safe as a \label or \ref key: keeps it readable, drops characters TeX cannot take there. */
export function labelKey(id: string): string {
  return id.replace(/[\\{}%#~^&$\s]/g, '-');
}

/**
 * Records the characters of a verbatim ('code') or math string, which cannot be mapped: where they stand, and
 * those pdfTeX cannot print. Returns the string with variation selectors dropped and each character no shipped
 * font has written as [U+XXXX] (in math inside \mbox).
 */
export function noteUnprintable(text: string, report: UnicodeReport, context: 'code' | 'math' = 'math'): string {
  let out = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      out += ch;
    } else if (VARIATION_SELECTORS.includes(ch)) {
      // nothing to print
    } else if (!anyFontHas(ch)) {
      report.noteMissing(ch);
      out += context === 'math' ? `\\mbox{${missingCharText(ch)}}` : missingCharText(ch);
    } else {
      report.see(ch, context);
      if (!pdftexPrints(ch)) {
        report.note(ch);
      }
      out += ch;
    }
  }
  return out;
}
