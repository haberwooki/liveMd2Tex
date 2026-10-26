// The LaTeX writer: walks markdown-it's token stream and emits LaTeX through the line emitter, one LaTeX line per
// Markdown source line wherever the construct allows (docs/DESIGN.md#converter). The writer, not the parser, holds
// every convention, so the parser could be swapped. Pure: no I/O; files are reached only
// through the resolveImage callback the caller passes.

import type MarkdownIt from 'markdown-it';
import { latexLength, type Attributes } from './attributes';
import { Diagnostics } from './diagnostics';
import { Emitter, markFromLine } from './emitter';
import {
  CLOSED_EM_DASH,
  DEFAULT_TEXT_OPTIONS,
  escapeCode,
  escapeText,
  escapeUrl,
  labelKey,
  noteUnprintable,
  UnicodeReport,
  type TextOptions,
  type UnicodeMode,
} from './escape';
import { DROP_CONTENT_TAGS, INLINE_CLOSERS, INLINE_TAGS, tokenizeHtml, TRANSPARENT_TAGS, type HtmlTag } from './html';
import type { DocumentMeta } from './metadata';
import { presetBlock } from './preset/blocks';
import { defaultMode, type PresetMode } from './preset/types';
import type { CalloutMeta, TableCaption } from './rules/core';
import type { CitationItem, CitationMeta, WikiMeta } from './rules/inline';

type Token = MarkdownIt.Token;

/** One-argument commands that may follow _ or ^ without braces in pdfTeX's math, but not in unicode-math's. */
const SCRIPT_COMMAND =
  /([_^])\s*(\\(?:math[a-z]+|sym[a-z]+|text[a-z]*|operatorname|boldsymbol|bm|hat|bar|tilde|vec|dot|ddot|check|breve|acute|grave|widehat|widetilde|overline|underline))\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})/g;

/**
 * "x_\mathcal{M}" and "u_\text{eff}" work with pdfTeX's math fonts but not with unicode-math (XeTeX), whose
 * alphabet commands cannot stand as a bare sub- or superscript; such a command and its argument get braces of
 * their own (accents too, which neither engine takes bare). Other math is passed through as written.
 */
export function braceScriptCommands(math: string): string {
  return math.replace(SCRIPT_COMMAND, '$1{$2$3}');
}

/** The escaping options of a preset mode; the shared default object when the mode escapes as the dialect does. */
export function textOptionsFor(mode: PresetMode): TextOptions {
  const d = defaultMode();
  const e = mode.escape;
  const same =
    e.braces === d.escape.braces &&
    e.brackets === d.escape.brackets &&
    e.angles === d.escape.angles &&
    e.tilde === d.escape.tilde &&
    e.caret === d.escape.caret &&
    e.emDash === d.escape.emDash &&
    e.doubleQuotes === d.escape.doubleQuotes &&
    mode.unicode.length === 0;
  if (same) {
    return DEFAULT_TEXT_OPTIONS;
  }
  return {
    braces: e.braces,
    brackets: e.brackets,
    angles: e.angles,
    tilde: e.tilde,
    caret: e.caret,
    emDash: e.emDash,
    straightQuotes: e.doubleQuotes === 'straight',
    sequences: mode.unicode,
  };
}

/** Finishes closed-up em dashes: "word —\nnext" becomes "word---%" and "next" (the % keeps the line break silent). */
export function closeEmDashes(text: string): string {
  if (!text.includes(CLOSED_EM_DASH)) {
    return text;
  }
  return text
    .replace(new RegExp(`[ \\t]*${CLOSED_EM_DASH}[ \\t]*\\n[ \\t]*`, 'g'), '---%\n')
    .replace(new RegExp(`[ \\t]*\\n[ \\t]*${CLOSED_EM_DASH}[ \\t]*`, 'g'), '%\n---')
    .replace(new RegExp(`[ \\t]*${CLOSED_EM_DASH}[ \\t]*`, 'g'), '---');
}

export type Feature =
  | 'notes'
  | 'tabularx'
  | 'ulem'
  | 'soul'
  | 'callout'
  | 'amsthm'
  | 'fit-image'
  | 'remote-image'
  | 'web-image'
  | 'missing-image'
  | 'float'
  | 'line-block'
  | 'missing-char';

export interface WriterOptions {
  meta: DocumentMeta;
  unicode: UnicodeMode;
  md: MarkdownIt.MarkdownIt;
  env: Record<string, unknown>;
  /** The Markdown source split into lines (for the last non-blank line of a block). */
  sourceLines?: string[];
  /**
   * Called for every local image path (as written, URL-decoded). Returns the path to use instead (a .pdf twin of
   * a .png, say) or undefined to keep it. The converter itself never touches the file system.
   */
  resolveImage?: (path: string) => string | undefined;
  /** The preset mode in force (the general dialect when absent). */
  mode?: PresetMode;
}

export interface InlineContext {
  inHeading?: boolean;
  inCaption?: boolean;
  inTable?: boolean;
  /** The column breaks lines (an X column), so <br> may become \newline. */
  cellBreaks?: boolean;
  /** Source line used for diagnostics from this inline run. */
  line: number;
}

const SECTIONS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];
const THEOREMS: Record<string, string> = {
  theorem: 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  corollary: 'Corollary',
  definition: 'Definition',
  conjecture: 'Conjecture',
  claim: 'Claim',
  remark: 'Remark',
  example: 'Example',
  exercise: 'Exercise',
  solution: 'Solution',
  proof: 'Proof',
};
const LAYOUT_DIVS: Record<string, string> = { center: 'center', flushleft: 'flushleft', flushright: 'flushright', quote: 'quote', quotation: 'quotation', verse: 'verse' };
/** Callout kinds (GitHub alerts, Obsidian callouts, admonition divs) and the colour each gets. */
const CALLOUT_COLOURS: Record<string, string> = {
  note: 'note', info: 'note', todo: 'note', abstract: 'note', summary: 'note', tldr: 'note', quote: 'note', cite: 'note', example: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
  important: 'important', question: 'important', help: 'important', faq: 'important',
  warning: 'warning', caution: 'caution', attention: 'warning',
  failure: 'caution', fail: 'caution', missing: 'caution', danger: 'caution', error: 'caution', bug: 'caution',
};
const ADMONITION_DIVS = new Set(['note', 'tip', 'important', 'warning', 'caution', 'info', 'danger', 'hint', 'attention', 'error']);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|pdf|eps|svg|gif|webp|bmp|tiff?)$/i;
const LATEX_IMAGE = /\.(png|jpe?g|pdf)$/i;
const DISPLAY_ENVIRONMENTS = /^\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray)(\*?)\}(\{[^}]*\})?/;
const CROSSREF = /^([Ff]ig|[Tt]bl|[Ee]q|[Ss]ec|[Ll]st):/;

function isRemote(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(src) || /^data:/i.test(src) || src.startsWith('//');
}

function decodePath(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The plain text of an inline token list, for identifiers and alt text. */
export function plainText(children: Token[] | null | undefined): string {
  let out = '';
  for (const t of children ?? []) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'math_inline' || t.type === 'text_special') {
      out += t.content;
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') {
      out += ' ';
    } else if (t.type === 'image') {
      out += plainText(t.children);
    } else if (t.type === 'wikilink') {
      const w = t.meta as unknown as WikiMeta;
      out += w.alias ?? w.target;
    }
  }
  return out;
}

/** pandoc's auto_identifiers algorithm (MANUAL, "Extension: auto_identifiers"). */
export function autoIdentifier(text: string): string {
  const id = text
    .replace(/[^\p{L}\p{N}_\-.\s]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/^[^\p{L}]+/u, '');
  return id || 'section';
}

/** True if math content has a line break (\\) outside any \begin...\end group. */
function hasTopLevelBreak(content: string): boolean {
  if (/\\begin\{/.test(content)) {
    return false;
  }
  return /(^|[^\\])\\\\/.test(content);
}

export class LatexWriter {
  out = new Emitter();
  readonly diagnostics = new Diagnostics();
  readonly unicode = new UnicodeReport();
  readonly features = new Set<Feature>();
  readonly theorems = new Set<string>();
  /** Citation keys, in order of first use (bibliography entries only, not cross-references). */
  readonly citationKeys: string[] = [];
  bibliographyPlaced = false;
  private readonly footnotes = new Map<number, Token[]>();
  private readonly ids = new Set<string>();
  private enumDepth = 0;
  private itemDepth = 0;
  /** Lists and quotes open around the current block (LaTeX allows six, and four of each list kind). */
  private listDepth = 0;
  private inFootnote = 0;
  private fallbackLine = 1;
  private readonly blockHtml: { name: string; closer: string }[] = [];
  /** blockHtml entries below this index belong to an enclosing container (see renderBlocks). */
  private htmlFloor = 0;
  private blockDepth = 0;

  /** The preset mode in force (defaultMode() is the general dialect). */
  readonly mode: PresetMode;
  private readonly textOptions: TextOptions;
  /** Drafting notes: the heading level of a notes section being skipped, or 0. */
  private notesSectionLevel = 0;

  constructor(private readonly options: WriterOptions) {
    this.mode = options.mode ?? defaultMode();
    this.textOptions = textOptionsFor(this.mode);
  }

  private get meta(): DocumentMeta {
    return this.options.meta;
  }

  text(s: string): string {
    // Break the T1 ligatures ?` !` ,, that would print as inverted marks or a low quote.
    return escapeText(s, this.options.unicode, this.unicode, this.textOptions).replace(/([?!])`/g, '$1{}`').replace(/,,/g, ',{},');
  }

  // -------------------------------------------------------------------------------------------------------
  // Entry

  /** Writes the body for a token stream; returns nothing (the lines are in this.out). */
  writeBody(tokens: Token[]): void {
    this.collectFootnotes(tokens);
    this.renderBlocks(tokens, 0, tokens.length);
    this.closeBlockHtml(this.fallbackLine);
  }

  private collectFootnotes(tokens: Token[]): void {
    let current: number | undefined;
    let collected: Token[] = [];
    for (const t of tokens) {
      if (t.type === 'footnote_open') {
        current = (t.meta as { id: number }).id;
        collected = [];
      } else if (t.type === 'footnote_close') {
        // A later parse (a title, the abstract) repeats body footnotes it cannot see as empty: keep the body's.
        if (current !== undefined && (collected.length > 0 || !this.footnotes.has(current))) {
          this.footnotes.set(current, collected);
        }
        current = undefined;
      } else if (current !== undefined && t.type !== 'footnote_anchor') {
        collected.push(t);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Blocks

  blockEnd(tokens: Token[], i: number, end: number): number {
    const t = tokens[i];
    if (t.nesting !== 1) {
      return i + 1;
    }
    for (let j = i + 1; j < end; j++) {
      if (tokens[j].level === t.level && tokens[j].nesting === -1) {
        return j + 1;
      }
    }
    return end;
  }

  /**
   * Writes a run of blocks: the document, or the inside of a container (a list item, a quote, a callout). An HTML
   * block (<div align="center">) opened inside a container ends where the container ends, and a closing tag
   * inside a container does not close one opened outside it, so the LaTeX environments stay nested.
   */
  renderBlocks(tokens: Token[], start: number, end: number): void {
    const nested = this.blockDepth > 0;
    const floor = this.htmlFloor;
    if (nested) {
      this.htmlFloor = this.blockHtml.length;
    }
    this.blockDepth++;
    this.renderBlockRun(tokens, start, end);
    this.blockDepth--;
    if (nested) {
      if (this.blockHtml.length > this.htmlFloor) {
        this.diagnostics.notice(
          'html-block-container',
          'An HTML block (such as <div align="center">) opened inside a list item, a quote or a callout ends where that container ends.',
          this.fallbackLine,
        );
        while (this.blockHtml.length > this.htmlFloor) {
          this.out.line(this.blockHtml.pop()?.closer ?? '', this.fallbackLine);
        }
      }
      this.htmlFloor = floor;
    }
  }

  private renderBlockRun(tokens: Token[], start: number, end: number): void {
    let previousEnd: number | undefined;
    let i = start;
    while (i < end) {
      const t = tokens[i];
      const next = this.blockEnd(tokens, i, end);
      if (t.type === 'footnote_block_open') {
        // The footnote plugin builds its tail without nesting levels: skip to its close by type.
        let close = i + 1;
        while (close < end && tokens[close].type !== 'footnote_block_close') {
          close++;
        }
        i = close + 1;
        continue;
      }
      // Drafting-note sections (a preset's notes.sections): skipped up to the next heading of the same level or
      // above, unless notes are shown.
      if (t.type === 'heading_open') {
        const level = Number(t.tag.slice(1));
        if (this.notesSectionLevel && level <= this.notesSectionLevel) {
          this.notesSectionLevel = 0;
        }
        const title = tokens[i + 1]?.content.trim() ?? '';
        if (!this.notesSectionLevel && this.mode.notes.sections.some((s) => s.toLowerCase() === title.toLowerCase())) {
          this.notesSectionLevel = level;
          if (!this.mode.notes.show) {
            i = next;
            continue;
          }
        }
      }
      if (this.notesSectionLevel && !this.mode.notes.show) {
        i = next;
        continue;
      }
      const map = t.map;
      // A blank line between two blocks in the Markdown is a blank line in the LaTeX (and nowhere else, so
      // display math written inside a paragraph stays inside it).
      if (map && previousEnd !== undefined && map[0] > previousEnd) {
        this.out.blank(previousEnd + 1);
      }
      if (map) {
        this.fallbackLine = map[0] + 1;
      }
      // A preset's own block shapes (a figure with its caption paragraph, a captioned table with its notes).
      const consumed = presetBlock(this, tokens, i, end);
      const after = consumed > i ? consumed : next;
      if (consumed <= i) {
        this.renderBlock(tokens, i, next);
      }
      if (map) {
        const lastToken = tokens[after - 1]?.map ? tokens[after - 1] : t;
        previousEnd = Math.max(previousEnd ?? 0, this.last(t), lastToken.map ? this.last(lastToken) : 0);
      }
      i = after;
    }
  }

  first(t: Token): number {
    return t.map ? t.map[0] + 1 : this.fallbackLine;
  }

  /** The last source line of a block that is not blank (markdown-it's maps of lists run over trailing blanks). */
  last(t: Token): number {
    if (!t.map) {
      return this.fallbackLine;
    }
    let line = Math.max(t.map[0] + 1, t.map[1]);
    const source = this.options.sourceLines;
    while (source && line > t.map[0] + 1 && (source[line - 1] ?? '').trim() === '') {
      line--;
    }
    return line;
  }

  private renderBlock(tokens: Token[], i: number, next: number): void {
    const t = tokens[i];
    switch (t.type) {
      case 'paragraph_open':
        this.paragraph(t, tokens[i + 1]);
        return;
      case 'heading_open':
        this.heading(t, tokens[i + 1]);
        return;
      case 'bullet_list_open':
      case 'ordered_list_open':
        this.list(tokens, i, next);
        return;
      case 'blockquote_open':
        this.blockquote(tokens, i, next);
        return;
      case 'code_block':
      case 'fence':
        this.code(t);
        return;
      case 'hr': {
        // A row of dash groups next to text is the rule line of a pandoc simple or multiline table, which
        // markdown-it reads as a horizontal rule.
        const source = this.options.sourceLines;
        const at = t.map?.[0] ?? -1;
        const nonBlank = (k: number) => !!source && k >= 0 && k < source.length && source[k].trim() !== '';
        if (source && /^\s*-{2,}(\s+-{2,})+\s*$/.test(source[at] ?? '') && (nonBlank(at - 1) || nonBlank(at + 1))) {
          this.diagnostics.unsupported(
            'simple-table',
            'Simple and multiline tables (pandoc simple_tables, multiline_tables) are not supported; use a pipe table. The text is kept as it is.',
            this.first(t),
          );
          this.out.line(this.text(source[at].trim()), this.first(t));
          return;
        }
        if (this.mode.rules === 'drop') {
          return;
        }
        this.out.line('\\begin{center}\\rule{0.5\\linewidth}{0.5pt}\\end{center}', this.first(t));
        return;
      }
      case 'html_block':
        this.htmlBlock(t);
        return;
      case 'table_open':
        this.table(tokens, i, next);
        return;
      case 'dl_open':
        this.definitionList(tokens, i, next);
        return;
      case 'math_block':
        this.out.multiline(this.displayMath(t.content, (t.meta as { attrs?: Attributes } | null)?.attrs), this.first(t), this.last(t));
        return;
      case 'latex_block':
        t.content.split('\n').forEach((line, k) => this.out.rawLine(line, this.first(t) + k));
        return;
      case 'comment_block':
        return;
      case 'div_open':
        this.fencedDiv(tokens, i, next);
        return;
      case 'line_block_open':
        this.lineBlock(tokens, i, next);
        return;
      default:
        if (t.nesting === 1) {
          this.renderBlocks(tokens, i + 1, next - 1);
        }
    }
  }

  /** One warning per unsupported construct in a block of text: each kind once, on its first line. */
  private checkUnsupportedText(content: string, line: number): void {
    const lines = content.split('\n');
    const at = (k: number) => line + k;
    const seen = new Set<string>();
    const once = (code: string, message: string, k: number) => {
      if (!seen.has(code)) {
        seen.add(code);
        this.diagnostics.unsupported(code, message, at(k));
      }
    };
    lines.forEach((l, k) => {
      if (/^\s*\+[-=:]+(\+[-=:]+)*\+\s*$/.test(l)) {
        once('grid-table', 'Grid tables (pandoc grid_tables) are not supported; the text is kept as it is.', k);
      } else if (/^\s*-{3,}(\s+-{3,})+\s*$/.test(l)) {
        once('simple-table', 'Simple and multiline tables (pandoc simple_tables, multiline_tables) are not supported; use a pipe table. The text is kept as it is.', k);
      } else if (/^\s*\(@[\w-]*\)\s/.test(l)) {
        once('example-list', 'Example lists (pandoc example_lists, "(@)" markers) are not supported; the text is kept as it is.', k);
      }
    });
    const fancy = lines.filter((l) => /^\s*(?:\(?(?:[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)])\s+\S/.test(l) && !/^\s*\d/.test(l));
    if (fancy.length >= 2) {
      const k = lines.findIndex((l) => fancy.includes(l));
      this.diagnostics.unsupported(
        'fancy-list',
        'Letter and Roman-numeral list markers (pandoc fancy_lists: "a.", "i.", "(a)") are not supported; use numbers or bullets. The text is kept as it is.',
        at(k),
      );
    }
  }

  private paragraph(open: Token, inline: Token): void {
    const first = this.first(open);
    const last = this.last(open);
    const children = inline.children ?? [];
    this.checkUnsupportedText(inline.content, first);

    const trimmed = inline.content.trim();
    const visible = children.filter((c) => !(c.type === 'softbreak' || (c.type === 'text' && c.content.trim() === '')));
    if (/^\[(TOC|toc)\]$/.test(trimmed) || (visible.length === 1 && visible[0].type === 'wikilink' && (visible[0].meta as unknown as WikiMeta).target === '_TOC_')) {
      this.out.line('\\tableofcontents', first);
      return;
    }
    if (visible.length === 1 && visible[0].type === 'image' && this.figure(visible[0], first, last)) {
      return;
    }
    if (visible.length === 1 && visible[0].type === 'wikiembed' && this.blockEmbed(visible[0], first)) {
      return;
    }
    if (visible.every((c) => c.type === 'comment' || (c.type === 'html_inline' && /^<!--/.test(c.content)))) {
      return;
    }
    // Letters: in a block where any line ends with two spaces, every line keeps its break.
    const kids =
      this.mode.blockLineBreaks && children.some((c) => c.type === 'hardbreak')
        ? children.map((c) => (c.type === 'softbreak' ? Object.assign(Object.create(Object.getPrototypeOf(c)), c, { type: 'hardbreak' }) : c))
        : children;
    const text = this.inline(kids, { line: first });
    this.out.multiline(text, first, last);
  }

  private claimId(id: string): string {
    let candidate = id;
    for (let n = 1; this.ids.has(candidate); n++) {
      candidate = `${id}-${n}`;
    }
    this.ids.add(candidate);
    return candidate;
  }

  private heading(open: Token, inline: Token): void {
    const level = Number(open.tag.slice(1));
    const attrs = (open.meta as { attrs?: Attributes } | null)?.attrs;
    const h = this.mode.headings;
    let children = inline.children ?? [];
    // "## 3. Results": the author's number goes; LaTeX numbers the section.
    let numbered = false;
    if (h.stripNumbers && children[0]?.type === 'text') {
      const m = /^\d+(\.\d+)*\.?\s+/.exec(children[0].content);
      if (m) {
        numbered = true;
        children = [Object.assign(Object.create(Object.getPrototypeOf(children[0])), children[0], { content: children[0].content.slice(m[0].length) }), ...children.slice(1)];
      }
    }
    let command = h.commands[String(Math.min(level, 6))] ?? SECTIONS[Math.min(level, 6) - 1];
    const starred = attrs?.classes.includes('unnumbered') || (h.starUnnumbered && !numbered);
    if (starred && !command.endsWith('*')) {
      command += '*';
    }
    const title = this.inline(children, { inHeading: true, line: this.first(open) });
    let label = '';
    if (h.labels) {
      const id = this.claimId(attrs?.id ?? autoIdentifier(plainText(children)));
      label = `\\label{${labelKey(id)}}`;
    } else if (attrs?.id) {
      label = `\\label{${labelKey(this.claimId(attrs.id))}}`;
    }
    this.out.multiline(`\\${command}{${title}}${label}`, this.first(open), this.last(open));
  }

  private list(tokens: Token[], i: number, next: number): void {
    const open = tokens[i];
    const ordered = open.type === 'ordered_list_open';
    const env = ordered ? 'enumerate' : 'itemize';
    const items = () => {
      for (let j = i + 1; j < next - 1; ) {
        const item = tokens[j];
        const itemEnd = this.blockEnd(tokens, j, next - 1);
        if (item.type === 'list_item_open') {
          this.listItem(tokens, j, itemEnd);
        }
        j = itemEnd;
      }
    };
    // LaTeX stops with "Too deeply nested" past four lists of a kind or six lists and quotes in all: deeper items
    // join the list around them.
    if ((ordered ? this.enumDepth : this.itemDepth) >= 4 || this.listDepth >= 6) {
      this.diagnostics.notice('deep-list', 'Lists nested more than four deep are flattened: LaTeX allows four levels of each kind.', this.first(open));
      items();
      return;
    }
    let begin = `\\begin{${env}}${this.mode.listOptions}`;
    if (ordered) {
      const start = Number(open.attrGet('start') ?? 1);
      if (start !== 1 && Number.isFinite(start)) {
        const counter = ['enumi', 'enumii', 'enumiii', 'enumiv'][Math.min(this.enumDepth, 3)];
        begin += `\\setcounter{${counter}}{${start - 1}}`;
      }
      this.enumDepth++;
    } else {
      this.itemDepth++;
    }
    this.listDepth++;
    this.out.line(begin, this.first(open));
    this.out.indent();
    items();
    this.out.flushPrefix();
    this.out.dedent();
    this.listDepth--;
    if (ordered) {
      this.enumDepth--;
    } else {
      this.itemDepth--;
    }
    this.out.line(`\\end{${env}}`, this.last(open));
  }

  private listItem(tokens: Token[], i: number, next: number): void {
    const item = tokens[i];
    let prefix = '\\item ';
    if (tokens[i + 1]?.type === 'paragraph_open') {
      const firstChild = tokens[i + 2]?.children?.[0];
      const m = firstChild?.type === 'text' ? /^\[([ xX])\][ \t]+/.exec(firstChild.content) : null;
      if (firstChild && m) {
        // amssymb's \square is \mdlgwhtsquare in unicode-math (XeTeX); \boxtimes is the same in both.
        const box = this.options.unicode === 'keep' ? '\\mdlgwhtsquare' : '\\square';
        prefix = m[1] === ' ' ? `\\item[$${box}$] ` : '\\item[$\\boxtimes$] ';
        firstChild.content = firstChild.content.slice(m[0].length);
      }
    }
    this.out.setPrefix(prefix, this.first(item));
    this.renderBlocks(tokens, i + 1, next - 1);
    this.out.flushPrefix();
  }

  private blockquote(tokens: Token[], i: number, next: number): void {
    // A quote is a list to LaTeX (it counts towards the six levels).
    this.listDepth++;
    this.blockquoteIn(tokens, i, next);
    this.listDepth--;
  }

  private blockquoteIn(tokens: Token[], i: number, next: number): void {
    const open = tokens[i];
    const callout = (open.meta as { callout?: CalloutMeta } | null)?.callout;
    // A drafting note (notes.blockquotePrefixes): removed, or set as a framed note when notes are shown.
    const firstText = tokens[i + 2]?.type === 'inline' ? tokens[i + 2].content.trimStart() : '';
    const isNote = this.mode.notes.blockquotePrefixes.some((p) => firstText.startsWith(p));
    if (isNote || (!callout && this.mode.blockquotes === 'drop')) {
      if (isNote && this.mode.notes.show) {
        this.features.add('notes');
        this.out.line('\\begin{mdnoteblock}', this.first(open));
        this.out.indent();
        this.renderBlocks(tokens, i + 1, next - 1);
        this.out.dedent();
        this.out.line('\\end{mdnoteblock}', this.last(open));
      }
      return;
    }
    let end = '\\end{quote}';
    if (!callout && this.mode.blockquotes === 'small-quote') {
      this.out.line('\\begin{quote}\\small', this.first(open));
      this.out.indent();
      this.renderBlocks(tokens, i + 1, next - 1);
      this.out.dedent();
      this.out.line(end, this.last(open));
      return;
    }
    if (callout) {
      this.features.add('callout');
      const title = callout.title ? this.inlineString(callout.title, this.first(open)) : this.text(capitalize(callout.type));
      this.out.line(`\\begin{mdcallout}{${CALLOUT_COLOURS[callout.type] ?? 'note'}}{${title}}`, this.first(open));
      end = '\\end{mdcallout}';
    } else {
      this.out.line('\\begin{quote}', this.first(open));
    }
    this.out.indent();
    this.renderBlocks(tokens, i + 1, next - 1);
    this.out.dedent();
    this.out.line(end, this.last(open));
  }

  private code(t: Token): void {
    const first = this.first(t);
    const info = t.type === 'fence' ? t.info.trim() : '';
    const content = t.content.replace(/\n$/, '');
    const lines = content === '' ? [] : content.split('\n');
    const contentFirst = t.type === 'fence' ? first + 1 : first;
    const fenceClosed = t.type === 'fence' && t.map ? t.map[1] - t.map[0] >= lines.length + 2 : false;
    const closeLine = t.type === 'fence' ? (fenceClosed ? this.last(t) : Math.max(first, contentFirst + lines.length - 1)) : Math.max(first, this.last(t));

    const raw = /^\{?=([A-Za-z]+)\}?$/.exec(info);
    if (raw) {
      const format = raw[1].toLowerCase();
      if (format === 'latex' || format === 'tex') {
        lines.forEach((line, k) => this.out.rawLine(line, contentFirst + k));
      }
      return; // other raw formats are dropped, as pandoc does for LaTeX output
    }
    if (/^math\b/.test(info)) {
      const body = ['', ...lines, ''].join('\n');
      this.out.multiline(this.displayMath(body, undefined), first, closeLine);
      return;
    }
    if (this.inFootnote) {
      this.diagnostics.unsupported('footnote-code', 'Code blocks inside footnotes are set as monospaced lines (LaTeX cannot put verbatim text in a footnote).', first);
      lines.forEach((line, k) => this.out.line(`\\texttt{${escapeCode(line, this.options.unicode, this.unicode)}}\\\\`, contentFirst + k));
      return;
    }
    this.out.rawLine('\\begin{verbatim}', first);
    lines.forEach((line, k) => {
      const expanded = line.replace(/^([^\t]*)\t/, (_m, before: string) => before + ' '.repeat(4 - (before.length % 4)));
      const safe = expanded.replace(/\\end\{verbatim\}/g, '\\end {verbatim}');
      this.out.rawLine(noteUnprintable(safe, this.unicode, 'code').replace(/\t/g, '    '), contentFirst + k);
    });
    this.out.rawLine('\\end{verbatim}', closeLine);
  }

  private table(tokens: Token[], i: number, next: number): void {
    const open = tokens[i];
    const caption = (open.meta as { caption?: TableCaption } | null)?.caption;
    interface Cell {
      inline: Token;
      align: string;
    }
    const rows: { cells: Cell[]; header: boolean; line: number }[] = [];
    let inHead = false;
    for (let j = i; j < next; j++) {
      const t = tokens[j];
      if (t.type === 'thead_open') {
        inHead = true;
      } else if (t.type === 'thead_close') {
        inHead = false;
      } else if (t.type === 'tr_open') {
        rows.push({ cells: [], header: inHead, line: t.map ? t.map[0] + 1 : this.first(open) });
      } else if ((t.type === 'th_open' || t.type === 'td_open') && rows.length > 0) {
        const style = String(t.attrGet('style') ?? '');
        rows[rows.length - 1].cells.push({ inline: tokens[j + 1], align: /text-align:\s*(left|center|right)/.exec(style)?.[1] ?? '' });
      }
    }
    const columns = Math.max(1, ...rows.map((r) => r.cells.length));
    const headerRow = rows.find((r) => r.header);
    const aligns = Array.from({ length: columns }, (_, k) => headerRow?.cells[k]?.align ?? '');
    const width = Array.from({ length: columns }, (_, k) => Math.max(0, ...rows.map((r) => r.cells[k]?.inline.content.length ?? 0)));
    const numeric = Array.from({ length: columns }, (_, k) =>
      rows.filter((r) => !r.header).every((r) => /^\s*[-+−]?[\d.,]+\s*%?\s*$/.test(r.cells[k]?.inline.content ?? '')),
    );
    const wide = columns > 1 && width.reduce((a, b) => a + b, 0) > 90;
    const specs = aligns.map((a, k) => (wide && width[k] > 24 && !numeric[k] ? 'L' : a === 'center' ? 'c' : a === 'right' ? 'r' : 'l'));
    const usesX = specs.includes('L');
    if (usesX) {
      this.features.add('tabularx');
    }
    const first = this.first(open);
    const last = this.last(open);
    const captionLine = caption ? caption.line + 1 : first;
    const env = usesX ? 'tabularx' : 'tabular';
    if (caption) {
      this.out.line('\\begin{table}[htbp]', Math.min(captionLine, first));
      this.out.indent();
      this.out.line('\\centering', Math.min(captionLine, first));
      const label = caption.attrs?.id ? `\\label{${labelKey(caption.attrs.id)}}` : '';
      this.out.multiline(`\\caption{${this.inlineString(caption.text, captionLine, { inCaption: true })}}${label}`, captionLine);
    } else {
      this.out.line('\\begin{center}', first);
      this.out.indent();
    }
    this.out.line(usesX ? `\\begin{tabularx}{\\linewidth}{@{}${specs.join('')}@{}}` : `\\begin{tabular}{@{}${specs.join('')}@{}}`, first);
    this.out.line('\\toprule', first);
    const renderRow = (r: (typeof rows)[number]) =>
      Array.from({ length: columns }, (_, k) => {
        const cell = r.cells[k];
        return cell ? this.inline(cell.inline.children ?? [], { inTable: true, cellBreaks: specs[k] === 'L', line: r.line }) : '';
      }).join(' & ') + ' \\\\';
    const headerEmpty = !headerRow || headerRow.cells.every((c) => c.inline.content.trim() === '');
    for (const r of rows) {
      if (r.header) {
        if (!headerEmpty) {
          this.out.line(renderRow(r), r.line);
          this.out.line('\\midrule', r.line + 1);
        }
      } else {
        this.out.line(renderRow(r), r.line);
      }
    }
    this.out.line('\\bottomrule', last);
    this.out.line(`\\end{${env}}`, last);
    this.out.dedent();
    this.out.line(caption ? '\\end{table}' : '\\end{center}', Math.max(last, caption && captionLine > last ? captionLine : last));
  }

  private definitionList(tokens: Token[], i: number, next: number): void {
    const open = tokens[i];
    this.out.line('\\begin{description}', this.first(open));
    this.out.indent();
    for (let j = i + 1; j < next - 1; ) {
      const t = tokens[j];
      const end = this.blockEnd(tokens, j, next - 1);
      if (t.type === 'dt_open') {
        const inline = tokens[j + 1];
        const line = inline.map ? inline.map[0] + 1 : this.first(t);
        this.out.line(`\\item[{${this.inline(inline.children ?? [], { line })}}]`, line);
      } else if (t.type === 'dd_open') {
        this.renderBlocks(tokens, j + 1, end - 1);
      }
      j = end;
    }
    this.out.dedent();
    this.out.line('\\end{description}', this.last(open));
  }

  private fencedDiv(tokens: Token[], i: number, next: number): void {
    const open = tokens[i];
    const attrs = (open.meta as { attrs: Attributes }).attrs;
    const first = this.first(open);
    const last = this.last(open);
    const label = attrs.id ? `\\label{${labelKey(attrs.id)}}` : '';
    const inner = () => this.renderBlocks(tokens, i + 1, next - 1);
    const wrap = (begin: string, end: string) => {
      this.out.line(begin, first);
      this.out.indent();
      inner();
      this.out.dedent();
      this.out.line(end, last);
    };
    if (attrs.id === 'refs') {
      this.out.line(this.bibliographyCommands().join(' '), first);
      this.bibliographyPlaced = true;
      inner();
      return;
    }
    const classes = attrs.classes.map((c) => c.toLowerCase());
    const theorem = classes.find((c) => THEOREMS[c]);
    if (theorem) {
      if (theorem !== 'proof') {
        this.theorems.add(theorem);
      }
      this.features.add('amsthm');
      const title = attrs.values.title ?? attrs.values.name;
      const option = title ? `[${this.inlineString(title, first)}]` : '';
      wrap(`\\begin{${theorem}}${option}${label}`, `\\end{${theorem}}`);
      return;
    }
    const callout = classes.map((c) => c.replace(/^callout-/, '')).find((c) => ADMONITION_DIVS.has(c) || (classes.some((k) => k.startsWith('callout-')) && CALLOUT_COLOURS[c]));
    if (callout) {
      this.features.add('callout');
      const title = attrs.values.title ? this.inlineString(attrs.values.title, first) : this.text(capitalize(callout));
      wrap(`\\begin{mdcallout}{${CALLOUT_COLOURS[callout] ?? 'note'}}{${title}}${label}`, '\\end{mdcallout}');
      return;
    }
    const layout = classes.find((c) => LAYOUT_DIVS[c]);
    if (layout) {
      wrap(`\\begin{${LAYOUT_DIVS[layout]}}${label}`, `\\end{${LAYOUT_DIVS[layout]}}`);
      return;
    }
    if (classes.length > 0) {
      this.diagnostics.unsupported(
        `div-class:${classes[0]}`,
        `The fenced div class ".${classes[0]}" has no environment in the template; its content is kept as plain text.`,
        first,
      );
    }
    if (label) {
      this.out.line(`\\phantomsection${label}`, first);
    }
    inner();
  }

  private lineBlock(tokens: Token[], i: number, next: number): void {
    this.features.add('line-block');
    const entries = tokens.slice(i + 1, next - 1).filter((t) => t.type === 'inline');
    entries.forEach((t, k) => {
      const indent = Number((t.meta as { indent?: number } | null)?.indent ?? 0);
      const pad = indent > 0 ? `\\hspace*{${indent * 0.5}em}` : '';
      const body = this.inline(t.children ?? [], { line: this.first(t) });
      const lead = k === 0 ? '\\noindent ' : '';
      const end = k < entries.length - 1 ? '\\\\' : '';
      this.out.multiline(`${lead}${pad}${body === '' ? '~' : body}${end}`, this.first(t), this.last(t));
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // HTML

  private htmlBlock(t: Token): void {
    const first = this.first(t);
    const lines: string[] = t.content.replace(/\n$/, '').split('\n').map(() => '');
    const lineOf = (offset: number) => t.content.slice(0, offset).split('\n').length - 1;
    const inlineStack: { name: string; closer: string }[] = [];
    let dropping = '';
    for (const piece of tokenizeHtml(t.content)) {
      const k = Math.min(lineOf(piece.offset), lines.length - 1);
      if (piece.type === 'comment') {
        continue;
      }
      if (piece.type === 'text') {
        if (dropping) {
          continue;
        }
        const decoded = this.options.md.utils.unescapeAll(piece.text);
        piece.text.split('\n').forEach((_, n) => {
          const part = decoded.split('\n')[n] ?? '';
          const target = Math.min(k + n, lines.length - 1);
          lines[target] += part.trim() === '' ? '' : this.text(part.replace(/\s+/g, ' '));
        });
        continue;
      }
      const tag = piece.tag;
      if (dropping) {
        if (tag.kind === 'close' && tag.name === dropping) {
          dropping = '';
        }
        continue;
      }
      lines[k] += this.htmlTag(tag, inlineStack, true, first + k, (name) => (dropping = name));
    }
    let tail = '';
    while (inlineStack.length) {
      tail += inlineStack.pop()?.closer ?? '';
    }
    lines[lines.length - 1] += tail;
    lines.forEach((text, k) => {
      if (text.trim() !== '') {
        this.out.multiline(text.trim(), first + k);
      }
    });
  }

  private closeBlockHtml(line: number): void {
    while (this.blockHtml.length) {
      this.out.line(this.blockHtml.pop()?.closer ?? '', line);
    }
  }

  /** LaTeX for one HTML tag; inline tags push their closer on `stack`. */
  private htmlTag(tag: HtmlTag, stack: { name: string; closer: string }[], block: boolean, line: number, drop: (name: string) => void, ctx?: InlineContext): string {
    const { name, kind, attrs } = tag;
    if (kind === 'close') {
      const blockIndex = block ? this.blockHtml.map((b) => b.name).lastIndexOf(name) : -1;
      if (block && blockIndex >= this.htmlFloor && !stack.some((s) => s.name === name)) {
        let out = '';
        while (this.blockHtml.length > blockIndex) {
          out += this.blockHtml.pop()?.closer ?? '';
        }
        return out;
      }
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at < 0) {
        return '';
      }
      let out = '';
      while (stack.length > at) {
        out += stack.pop()?.closer ?? '';
      }
      return out;
    }
    const isIcon = /\bfa[srlbd]?\b|\bfa-|\bicon\b|\bmaterial-icons\b|\bbi-/.test(attrs.class ?? '');
    if (isIcon && (name === 'i' || name === 'span')) {
      this.diagnostics.unsupported('html:icon', 'Icon-font HTML (<i class="fa ...">) is not supported and was dropped.', line);
      if (kind === 'open') {
        stack.push({ name, closer: '' });
      }
      return '';
    }
    switch (name) {
      case 'br':
        if (ctx?.inTable) {
          return ctx.cellBreaks ? '\\newline ' : ' ';
        }
        return '\\leavevmode\\\\';
      case 'hr':
        return '\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par ';
      case 'img': {
        const src = attrs.src ?? '';
        if (src === '') {
          return '';
        }
        const values: Record<string, string> = {};
        if (attrs.width) {
          values.width = /^\d+$/.test(attrs.width) ? `${attrs.width}px` : attrs.width;
        }
        if (attrs.height) {
          values.height = /^\d+$/.test(attrs.height) ? `${attrs.height}px` : attrs.height;
        }
        const graphic = this.graphic(src, { classes: [], values }, attrs.alt ?? '', 'inline', line);
        const centred = this.blockHtml.some((b) => b.closer.includes('{center}')) || stack.some((b) => b.closer.includes('{center}'));
        return block && !centred ? `\\begin{center}${graphic}\\end{center}` : graphic;
      }
      case 'a':
        if (kind === 'open' && attrs.href) {
          stack.push({ name, closer: '}' });
          return attrs.href.startsWith('#') ? `\\hyperref[${labelKey(attrs.href.slice(1))}]{` : `\\href{${escapeUrl(attrs.href)}}{`;
        }
        if (kind === 'open') {
          stack.push({ name, closer: '' });
          const id = attrs.id ?? attrs.name;
          return id ? `\\phantomsection\\label{${labelKey(id)}}` : '';
        }
        return '';
      case 'p':
      case 'div':
      case 'center':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        if (kind !== 'open') {
          return '';
        }
        const centred = name === 'center' || (attrs.align ?? '').toLowerCase() === 'center';
        const heading = /^h\d$/.test(name);
        const closer = (heading ? '}' : '') + (centred ? '\\end{center}' : '');
        const opener = (centred ? '\\begin{center}' : '') + (heading ? '{\\large\\bfseries ' : '');
        if (block && !heading) {
          this.blockHtml.push({ name, closer: closer || '' });
          return opener;
        }
        stack.push({ name, closer });
        return opener;
      }
      case 'summary':
        if (kind === 'open') {
          stack.push({ name, closer: '}\\par ' });
          return '\\noindent\\textbf{';
        }
        return '';
      default:
        break;
    }
    if (TRANSPARENT_TAGS.has(name)) {
      if (kind === 'open') {
        stack.push({ name, closer: '' });
      }
      return '';
    }
    const opener = INLINE_TAGS[name];
    if (opener !== undefined) {
      if (name === 'u' || name === 'ins' || name === 's' || name === 'del' || name === 'strike') {
        this.features.add('ulem');
      } else if (name === 'mark') {
        this.features.add('soul');
      }
      if (kind === 'open') {
        stack.push({ name, closer: INLINE_CLOSERS[name] ?? '}' });
        return opener;
      }
      return '';
    }
    this.diagnostics.unsupported(`html:${name}`, `The HTML element <${name}> is not supported and was dropped${DROP_CONTENT_TAGS.has(name) ? ' with its content' : ''}.`, line);
    if (kind === 'open') {
      if (DROP_CONTENT_TAGS.has(name)) {
        drop(name);
      } else {
        stack.push({ name, closer: '' });
      }
    }
    return '';
  }

  // -------------------------------------------------------------------------------------------------------
  // Images and figures

  /** A local image path as the document should name it: URL-decoded, "/" separators, the caller's twin. */
  resolvePath(src: string): string {
    const path = decodePath(src).replace(/\\/g, '/').replace(/^\.\//, '');
    return isRemote(src) ? src : (this.options.resolveImage?.(path) ?? path);
  }

  /** The \includegraphics (or placeholder) for an image source. */
  private graphic(src: string, attrs: Attributes | undefined, alt: string, mode: 'figure' | 'inline', line: number): string {
    const width = latexLength(attrs?.values.width, 'width');
    const height = latexLength(attrs?.values.height, 'height');
    if (isRemote(src)) {
      if (mode === 'figure') {
        this.features.add('remote-image');
        return `\\mdremoteimage{${escapeUrl(src)}}`;
      }
      this.features.add('web-image');
      return `\\mdwebimage{${this.text(alt.trim() || 'image')}}`;
    }
    let path = decodePath(src).replace(/\\/g, '/').replace(/^\.\//, '');
    const resolved = this.options.resolveImage?.(path);
    if (resolved) {
      path = resolved;
    }
    if (IMAGE_EXTENSIONS.test(path) && !LATEX_IMAGE.test(path)) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      this.diagnostics.notice(
        `image-format:${ext}`,
        `pdfLaTeX cannot include .${ext} images; put a PDF or PNG copy beside the file (the converter uses a .pdf or .png of the same name when one exists). A placeholder box is shown.`,
        line,
      );
      this.features.add('missing-image');
      return `\\mdmissingimage{${this.text(path)}}`;
    }
    const options = [width ? `width=${width}` : '', height ? `height=${height}` : '', width && height ? '' : width || height ? 'keepaspectratio' : '']
      .filter(Boolean)
      .join(',');
    if (options) {
      return `\\includegraphics[${options}]{${path}}`;
    }
    this.features.add('fit-image');
    return `\\mdincludegraphics{${path}}`;
  }

  /** An image alone in its paragraph: a figure when it has a caption or an identifier (pandoc's rule). */
  private figure(img: Token, first: number, last: number): boolean {
    const attrs = (img.meta as { attrs?: Attributes } | null)?.attrs;
    const alt = img.children ?? [];
    const hasCaption = alt.some((c) => c.type !== 'softbreak' && !(c.type === 'text' && c.content.trim() === ''));
    if (!hasCaption && !attrs?.id) {
      return false;
    }
    const src = String(img.attrGet('src') ?? '');
    const graphic = this.graphic(src, attrs, plainText(alt), 'figure', first);
    const label = attrs?.id ? `\\label{${labelKey(attrs.id)}}` : '';
    this.out.line('\\begin{figure}[htbp]', first);
    this.out.indent();
    this.out.line('\\centering', first);
    this.out.line(graphic, first);
    if (hasCaption) {
      this.out.multiline(`\\caption{${this.inline(alt, { inCaption: true, line: first })}}${label}`, first, last);
    } else {
      this.out.line(label, last);
    }
    this.out.dedent();
    this.out.line('\\end{figure}', last);
    return true;
  }

  private embedSize(meta: WikiMeta): Attributes {
    const m = /^(\d+)(?:x(\d+))?$/.exec(meta.alias ?? '');
    return { classes: [], values: m ? { width: `${m[1]}px`, ...(m[2] ? { height: `${m[2]}px` } : {}) } : {} };
  }

  private blockEmbed(t: Token, line: number): boolean {
    const meta = t.meta as unknown as WikiMeta;
    if (!IMAGE_EXTENSIONS.test(meta.target)) {
      return false;
    }
    this.out.line(`\\begin{center}${this.graphic(meta.target, this.embedSize(meta), '', 'inline', line)}\\end{center}`, line);
    return true;
  }

  // -------------------------------------------------------------------------------------------------------
  // Math

  /** Display math: \[...\], or an equation with \label when it has an identifier; newlines are kept. */
  /** Math as written, with its characters recorded; on XeTeX, bare script commands braced (braceScriptCommands). */
  private mathText(source: string): string {
    const content = noteUnprintable(source, this.unicode);
    return this.options.unicode === 'keep' ? braceScriptCommands(content) : content;
  }

  displayMath(source: string, attrs: Attributes | undefined): string {
    const content = this.mathText(source);
    const parts = content.split('\n');
    const body = parts.map((p, k) => (k > 0 && k < parts.length - 1 && p.trim() === '' ? '%' : p)).join('\n');
    const label = attrs?.id ? `\\label{${labelKey(attrs.id)}}` : '';
    const trimmed = body.trim();
    const env = DISPLAY_ENVIRONMENTS.exec(trimmed);
    if (env && trimmed.endsWith(`\\end{${env[1]}${env[2]}}`)) {
      return label ? body.replace(env[0], `${env[0]}${label}`) : body;
    }
    let inner = body;
    if (hasTopLevelBreak(trimmed)) {
      const wrapper = trimmed.includes('&') ? 'aligned' : 'gathered';
      const lead = body.match(/^\s*/)?.[0] ?? '';
      const trail = body.match(/\s*$/)?.[0] ?? '';
      inner = `${lead}\\begin{${wrapper}}${body.trim()}\\end{${wrapper}}${trail}`;
    }
    return label ? `\\begin{equation}${inner}${label}\\end{equation}` : `\\[${inner}\\]`;
  }

  // -------------------------------------------------------------------------------------------------------
  // Citations and cross-references

  private crossref(items: CitationItem[]): string {
    const out: string[] = [];
    // Group consecutive items of the same kind ("figs. 1, 2").
    let k = 0;
    while (k < items.length) {
      const kind = (CROSSREF.exec(items[k].key)?.[1] ?? 'fig').toLowerCase() as keyof DocumentMeta['prefixes'];
      const group: CitationItem[] = [];
      while (k < items.length && (CROSSREF.exec(items[k].key)?.[1] ?? '').toLowerCase() === kind) {
        group.push(items[k]);
        k++;
      }
      const capital = /^[A-Z]/.test(group[0].key);
      const labels = group.map((it) => labelKey(it.key.charAt(0).toLowerCase() + it.key.slice(1)));
      let text: string;
      if (this.meta.cref) {
        text = group[0].suppressAuthor ? labels.map((l) => `\\ref{${l}}`).join(', ') : `\\${capital ? 'C' : 'c'}ref{${labels.join(',')}}`;
      } else {
        const refs = labels.map((l) => `\\ref{${l}}`).join(', ');
        if (group[0].suppressAuthor) {
          text = refs;
        } else {
          const [one, many] = this.meta.prefixes[kind];
          const word = group.length > 1 ? many : one;
          text = `${this.text(capital ? capitalize(word) : word)}~${refs}`;
        }
      }
      const prefix = group[0].prefix ? `${this.inlineString(group[0].prefix, this.fallbackLine)} ` : '';
      const suffix = group[group.length - 1].suffix ? ` ${this.inlineString(group[group.length - 1].suffix, this.fallbackLine)}` : '';
      out.push(prefix + text + suffix);
    }
    return out.join('; ');
  }

  private note(text: string): string {
    return this.inlineString(text, this.fallbackLine).replace(/\b(pp?|chaps?|secs?|vols?|nos?|figs?|eqs?)\. /g, '$1.~');
  }

  private bibCitation(meta: CitationMeta, items: CitationItem[]): string {
    for (const it of items) {
      if (!this.citationKeys.includes(it.key)) {
        this.citationKeys.push(it.key);
      }
    }
    const biblatex = this.meta.citationPackage === 'biblatex';
    const opt = (it: CitationItem) => {
      const pre = it.prefix ? this.note(it.prefix) : '';
      const post = it.suffix ? this.note(it.suffix) : '';
      if (pre) {
        return `[${pre}][${post}]`;
      }
      return post ? `[${post}]` : '';
    };
    if (meta.mode === 'intext') {
      const it = items[0];
      return `\\${biblatex ? 'textcite' : 'citet'}${opt(it)}{${it.key}}`;
    }
    const plain = items.every((it) => !it.prefix && !it.suffix && !it.suppressAuthor);
    if (items.length === 1 || plain) {
      if (plain) {
        return `\\${biblatex ? 'autocite' : 'citep'}{${items.map((it) => it.key).join(',')}}`;
      }
      const it = items[0];
      const command = biblatex ? (it.suppressAuthor ? 'autocite*' : 'autocite') : it.suppressAuthor ? 'citeyearpar' : 'citep';
      return `\\${command}${opt(it)}{${it.key}}`;
    }
    if (biblatex) {
      return `\\autocites${items.map((it) => `${opt(it) || ''}{${it.key}}`).join('')}`;
    }
    const parts = items.map((it) => {
      const pre = it.prefix ? `${this.note(it.prefix)} ` : '';
      const post = it.suffix ? `[${this.note(it.suffix)}]` : '';
      return `${pre}\\${it.suppressAuthor ? 'citeyear' : 'citealp'}${post}{${it.key}}`;
    });
    return `\\citetext{${parts.join('; ')}}`;
  }

  /**
   * A citation that spans a line break in the Markdown keeps it in the LaTeX, so the lines after it stay on their
   * own Markdown lines (the line map, and click-to-source): "\cite{key%" and "}" on the next line, the "%"
   * swallowing the break. In text mode the break is written as it stands (a space to TeX).
   */
  private citationKeepingLines(meta: CitationMeta): string {
    const latex = this.citation(meta);
    const breaks = meta.source.split('\n').length - 1 - (latex.split('\n').length - 1);
    const close = latex.lastIndexOf('}');
    return breaks > 0 && close >= 0 ? `${latex.slice(0, close)}${'%\n'.repeat(breaks)}${latex.slice(close)}` : latex;
  }

  private citation(meta: CitationMeta): string {
    if (meta.mode === 'authoryear') {
      if (this.mode.authorYear === 'text') {
        return `(${this.text(meta.source)})`;
      }
      for (const it of meta.items) {
        if (!this.citationKeys.includes(it.key)) {
          this.citationKeys.push(it.key);
        }
      }
      return `\\cite{${meta.items.map((it) => it.key).join(',')}}`;
    }
    const refs = meta.items.filter((it) => CROSSREF.test(it.key));
    const bib = meta.items.filter((it) => !CROSSREF.test(it.key));
    const out: string[] = [];
    if (refs.length > 0) {
      out.push(this.crossref(refs));
    }
    if (bib.length > 0) {
      out.push(this.bibCitation(meta, bib));
    }
    return out.join('; ');
  }

  bibliographyCommands(): string[] {
    if (this.meta.bibliography.length === 0) {
      return [];
    }
    if (this.meta.citationPackage === 'biblatex') {
      return ['\\printbibliography'];
    }
    const files = this.meta.bibliography.map((b) => b.replace(/\.bib$/i, '')).join(',');
    const style = this.meta.biblioStyle ?? 'plainnat';
    // An empty style: the class chooses (REVTeX's aps option picks apsrev4-2).
    return style === '' ? [`\\bibliography{${files}}`] : [`\\bibliographystyle{${style}}`, `\\bibliography{${files}}`];
  }

  // -------------------------------------------------------------------------------------------------------
  // Inline

  /** Parses and converts a Markdown string that is inline content (a title, a caption, a citation note). */
  inlineString(markdown: string, line: number, ctx: Partial<InlineContext> = {}): string {
    const tokens = this.options.md.parseInline(markdown, this.options.env);
    this.collectFootnotes(tokens);
    return this.inline(tokens[0]?.children ?? [], { ...ctx, line });
  }

  /** Converts Markdown block content (an abstract) and returns its lines. */
  blockString(markdown: string, line: number): string[] {
    const tokens = this.options.md.parse(markdown, this.options.env);
    this.collectFootnotes(tokens);
    const saved = this.out;
    const savedFallback = this.fallbackLine;
    this.out = new Emitter();
    const savedSource = this.options.sourceLines;
    this.options.sourceLines = markdown.split('\n');
    this.fallbackLine = line;
    this.renderBlocks(tokens, 0, tokens.length);
    const lines = this.out.lines;
    this.out = saved;
    this.fallbackLine = savedFallback;
    this.options.sourceLines = savedSource;
    return lines;
  }

  private footnoteText(id: number): string {
    const tokens = this.footnotes.get(id);
    if (!tokens) {
      return '';
    }
    const saved = this.out;
    this.out = new Emitter();
    this.inFootnote++;
    this.renderBlocks(tokens, 0, tokens.length);
    this.inFootnote--;
    const lines = this.out.lines;
    // The definition's line; an inline note (^[...]) has none: it is its own reference.
    const placed = tokens.find((t) => t.map);
    const definitionLine = placed ? this.first(placed) : undefined;
    this.out = saved;
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const l of lines) {
      if (l.trim() === '') {
        if (current.length) {
          paragraphs.push(current.join(' '));
        }
        current = [];
      } else {
        current.push(l.trim());
      }
    }
    if (current.length) {
      paragraphs.push(current.join(' '));
    }
    const text = paragraphs.join(' \\par ');
    // On a LaTeX line of its own, mapped to the definition (emitter.ts), when the body has a source line.
    return definitionLine ? markFromLine(definitionLine, text) : text;
  }

  inline(children: Token[], ctx: InlineContext): string {
    let out = '';
    const html: { name: string; closer: string }[] = [];
    const links: string[] = [];
    let skipLinkText = false;
    let dropping = '';
    for (let k = 0; k < children.length; k++) {
      const t = children[k];
      if (skipLinkText && t.type !== 'link_close') {
        continue;
      }
      if (dropping) {
        if (t.type === 'html_inline') {
          const parsed = tokenizeHtml(t.content).find((p) => p.type === 'tag');
          if (parsed?.type === 'tag' && parsed.tag.kind === 'close' && parsed.tag.name === dropping) {
            dropping = '';
          }
        }
        continue;
      }
      switch (t.type) {
        case 'text':
        case 'text_special':
          if (/\\(begin|end)\{[^{}]*\}/.test(t.content)) {
            this.diagnostics.notice(
              'unmatched-environment',
              'A \\begin{...} or \\end{...} without its partner in the same block is shown as text (raw LaTeX environments must be complete).',
              ctx.line,
            );
          }
          // "Figure~\ref{a}": a tilde right before a raw TeX command can only be meant as a tie.
          if (t.content.endsWith('~') && !t.content.endsWith('~~') && children[k + 1]?.type === 'latex_inline') {
            out += `${this.text(t.content.slice(0, -1))}~`;
          } else {
            out += this.text(t.content);
          }
          break;
        case 'softbreak':
          out += '\n';
          break;
        case 'hardbreak':
          out += ctx.inTable ? ' ' : '\\\\\n';
          break;
        case 'code_inline': {
          const lines = String((t.meta as { lines?: string } | null)?.lines ?? t.content);
          const style = this.mode.code;
          // 'text': escaped like prose; 'text-breaks': also break points after / _ . for long paths.
          const one = (l: string) =>
            style === 'general'
              ? escapeCode(l, this.options.unicode, this.unicode)
              : style === 'text-breaks'
                ? this.text(l).replace(/\/|\\_|\./g, (m) => `${m}\\allowbreak `)
                : this.text(l);
          out += `\\texttt{${lines.split('\n').map(one).join('\n')}}`;
          break;
        }
        case 'raw_inline':
          if (t.info === 'latex' || t.info === 'tex') {
            out += t.content;
          }
          break;
        case 'latex_inline':
          // "C:\Users\name" outside a code span: pandoc reads "\Users" as a command too, and TeX stops on it.
          if (children[k - 1]?.type === 'text' && /(^|[^A-Za-z0-9])[A-Za-z]:$/.test(children[k - 1].content)) {
            this.diagnostics.notice(
              'windows-path',
              'A Windows path (C:\\Users\\...) outside a code span is read as LaTeX commands, as pandoc reads it; put the path in backticks.',
              ctx.line,
            );
          }
          out += t.content;
          break;
        case 'math_inline': {
          const math = this.mathText(t.content);
          out += t.markup === '$' ? `$${math}$` : `\\(${math}\\)`;
          break;
        }
        case 'math_display':
          out += this.displayMath(t.content, (t.meta as { attrs?: Attributes } | null)?.attrs);
          break;
        case 'em_open':
          out += this.mode.emphasis === 'textit' ? '\\textit{' : '\\emph{';
          break;
        case 'strong_open':
          out += '\\textbf{';
          break;
        case 's_open':
          this.features.add('ulem');
          out += '\\sout{';
          break;
        case 'mark_open':
          this.features.add('soul');
          out += '\\hl{';
          break;
        case 'em_close':
        case 'strong_close':
        case 's_close':
        case 'mark_close':
        case 'span_close':
          out += '}';
          break;
        case 'span_open': {
          const classes = ((t.meta as { attrs?: Attributes } | null)?.attrs?.classes ?? []).map((c) => c.toLowerCase());
          if (classes.includes('smallcaps')) {
            out += '\\textsc{';
          } else if (classes.includes('underline') || classes.includes('ul')) {
            this.features.add('ulem');
            out += '\\uline{';
          } else if (classes.includes('mark')) {
            this.features.add('soul');
            out += '\\hl{';
          } else {
            out += '{';
          }
          break;
        }
        case 'sup':
          out += `\\textsuperscript{${this.text(t.content)}}`;
          break;
        case 'sub':
          out += `\\textsubscript{${this.text(t.content)}}`;
          break;
        case 'link_open': {
          const href = String(t.attrGet('href') ?? '');
          const isAuto = t.markup === 'autolink' || t.markup === 'linkify';
          if (isAuto) {
            const label = children[k + 1]?.type === 'text' ? children[k + 1].content : href;
            if (label === href) {
              out += `\\url{${escapeUrl(href)}}`;
            } else {
              // mailto: links and linkified "www." addresses show the text as written.
              out += `\\href{${escapeUrl(href)}}{\\nolinkurl{${escapeUrl(label)}}}`;
            }
            skipLinkText = true;
            links.push('');
          } else if (href.startsWith('#')) {
            out += `\\hyperref[${labelKey(decodePath(href.slice(1)))}]{`;
            links.push('}');
          } else {
            out += `\\href{${escapeUrl(href)}}{`;
            links.push('}');
          }
          break;
        }
        case 'link_close':
          skipLinkText = false;
          out += links.pop() ?? '';
          break;
        case 'image': {
          const attrs = (t.meta as { attrs?: Attributes } | null)?.attrs;
          out += this.graphic(String(t.attrGet('src') ?? ''), attrs, plainText(t.children), 'inline', ctx.line);
          break;
        }
        case 'footnote_ref': {
          const id = (t.meta as { id: number }).id;
          out += `${ctx.inHeading || ctx.inCaption ? '\\protect' : ''}\\footnote{${this.footnoteText(id)}}`;
          break;
        }
        case 'citation':
          out += this.citationKeepingLines(t.meta as unknown as CitationMeta);
          break;
        case 'wikilink': {
          const w = t.meta as unknown as WikiMeta;
          const shown = w.alias ?? (w.target && w.anchor ? `${w.target} > ${w.anchor}` : w.target || w.anchor || '');
          out += this.text(shown);
          break;
        }
        case 'wikiembed': {
          const w = t.meta as unknown as WikiMeta;
          if (IMAGE_EXTENSIONS.test(w.target)) {
            out += this.graphic(w.target, this.embedSize(w), '', 'inline', ctx.line);
          } else {
            this.diagnostics.unsupported('note-embed', 'Obsidian note embeds (![[Note]]) are shown as the note\'s name; the note is not included.', ctx.line);
            out += this.text(w.alias ?? w.target);
          }
          break;
        }
        case 'comment':
          break;
        case 'html_inline': {
          for (const piece of tokenizeHtml(t.content)) {
            if (piece.type === 'tag') {
              out += this.htmlTag(piece.tag, html, false, ctx.line, (name) => (dropping = name), ctx);
            } else if (piece.type === 'text') {
              out += this.text(piece.text);
            }
          }
          break;
        }
        default:
          if (t.content) {
            out += this.text(t.content);
          }
      }
    }
    while (html.length) {
      out += html.pop()?.closer ?? '';
    }
    while (links.length) {
      out += links.pop();
    }
    return closeEmDashes(this.inlineNotes(out));
  }

  /**
   * Inline drafting notes (notes.inlineMarker, e.g. " TODO:"): from the marker to the end of its line. Removed, or
   * set as a margin note when notes are shown. The marker includes its leading space, so "MYTODO:" never matches.
   * Works on the converted line, so the note keeps its formatting.
   */
  private inlineNotes(text: string): string {
    const marker = this.mode.notes.inlineMarker;
    if (!marker || !text.includes(marker)) {
      return text;
    }
    return text
      .split('\n')
      .map((line) => {
        const at = line.indexOf(marker);
        if (at < 0) {
          return line;
        }
        let note = line.slice(at + marker.length).trim();
        // A note that starts inside a group ("**bold TODO: x**") closes that group: keep its closing braces.
        const opens = (note.match(/(?<!\\)\{/g) ?? []).length;
        const closes = (note.match(/(?<!\\)\}/g) ?? []).length;
        const tail = closes > opens ? '}'.repeat(closes - opens) : '';
        if (tail) {
          note = note.slice(0, note.length - tail.length).trimEnd();
        }
        if (!this.mode.notes.show) {
          return line.slice(0, at) + tail;
        }
        this.features.add('notes');
        return `${line.slice(0, at)}\\mdnote{${note}}${tail}`;
      })
      .join('\n');
  }
}
