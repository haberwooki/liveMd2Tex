// The extension's own Markdown-to-LaTeX converter (docs/DESIGN.md#converter; no pandoc, no Python, no outside
// program). Pure: a string in, a LaTeX document, a line map and diagnostics out. Runs in the extension host, in
// the browser bundle and under plain Node in the tests.
//
//   convertMarkdown(source, options)  the full conversion
//   markdownToLatex(source)           the same with default options, { latex, lineMap } (M0's interface)
//   latexToMarkdownLine / markdownToLatexLine   the line map in both directions
//
// The engine: pdfLaTeX with the default template, unless the document has characters
// pdfLaTeX cannot print as single characters (Greek in math, box drawing, script letters, an accented name such
// as ė); then XeTeX, in Latin Modern when it has every character, else with the notes template's DejaVu fonts
// and the fallback rule (fonts/fonts.ts). "engine:" and "template: notes" in the front matter or the folder
// config choose directly; a preset mode names its engine, or 'auto' with a XeTeX preamble.

import type { Diagnostic } from './diagnostics';
import { splitFrontMatter, type FrontMatter } from './frontMatter';
import { chooseFontSet, fontPlan, type FontPlan, type FontSetName } from './fonts/fonts';
import { LatexWriter } from './latexWriter';
import { readMetadata, type DocumentMeta, type EngineName, type MetaDefaults } from './metadata';
import { converterParser, type ParserOptions } from './parser';
import { buildPresetDocument, type PresetTitle } from './preset/document';
import { compileSafePattern, MAX_TEXT_LENGTH, PATTERN_BUDGET, withPatternBudget } from './preset/safePattern';
import { splitPresetFront, type PresetFront } from './preset/frontMatter';
import { defaultMode, type PresetMode } from './preset/types';
import { buildDocument } from './template';
import { classTemplate } from './classes';

export interface ConvertOptions {
  /** File name shown in the generated file's first line. */
  sourceName?: string;
  /** Defaults from the folder config (.latexpreview.json); the front matter wins over them. */
  defaults?: MetaDefaults;
  /** Maps a local image path to the file to use (e.g. a .pdf beside a .png); undefined keeps the path. */
  resolveImage?: (path: string) => string | undefined;
  /** A preset mode (preset/load.ts resolveMode); absent: the general dialect. */
  preset?: PresetMode;
  /** Markdown text of the mode's appendix file (a Methods section appended after the bibliography). */
  appendix?: string;
}

export interface ConversionResult {
  /** The complete LaTeX document, "\n" line ends, ending with a newline. */
  latex: string;
  /** lineMap[i] is the 1-based Markdown line that LaTeX line i + 1 comes from. Every entry is a real line. */
  lineMap: number[];
  /** 1-based LaTeX line where the converted body starts (after the preamble and title block). */
  bodyStartLine: number;
  diagnostics: Diagnostic[];
  meta: DocumentMeta;
  /** The engine the generated document is meant for. */
  engine: EngineName;
  /** The XeTeX font set of the general templates; undefined on pdfLaTeX and with a preset's own preamble. */
  fontSet?: FontSetName;
  /** Font files the engine's TeX data lacks, to be given to the compile as project files (DejaVu, until the data package carries it). */
  fontFiles: string[];
  /** Characters pdfTeX cannot print as single characters that the Unicode table does not map. */
  unprintable: string[];
  /** Bibliography keys cited, in the order converted (the body, then the front matter, then an appendix). */
  citationKeys: string[];
  /** A preset's appendix: for each LaTeX line, the line of the appendix file it comes from, or 0. */
  appendixMap?: number[];
  /** Local image paths as written in the Markdown (for the .pdf-twin lookup). */
  images: string[];
  /** Converter passes this result took: 2 when pdfLaTeX could not print a character and XeTeX's pass followed. */
  passes: number;
  /** The work spent on preset patterns (automaton steps and milliseconds), for the log and the tests. */
  patternWork?: { steps: number; ms: number };
}

/** Line count of a text, counting a final line without a newline. */
function countLines(text: string): number {
  return text.split('\n').length;
}

/** 1-based lines of the text that hold any of the characters (at most `limit`). */
function linesWith(text: string, chars: string[], limit = 20): number[] {
  const out: number[] = [];
  text.split('\n').forEach((line, k) => {
    if (out.length < limit && chars.some((ch) => line.includes(ch))) {
      out.push(k + 1);
    }
  });
  return out.length > 0 ? out : [1];
}

const listed = (chars: string[]) => `${chars.slice(0, 12).join(' ')}${chars.length > 12 ? ' ...' : ''}`;

/** The parse-level options of a preset mode. */
function parserOptionsFor(mode: PresetMode): ParserOptions {
  return {
    math: mode.escape.dollar === 'math',
    rawTex: mode.escape.backslash === 'raw-tex',
    authorYear: mode.authorYear !== 'off',
    singleQuotes: mode.escape.singleQuotes,
    doubleQuotes: mode.escape.doubleQuotes,
    linkify: mode.autolinks,
  };
}

/**
 * Control characters (other than tab and newline) and Unicode noncharacters: TeX cannot print them, and the
 * converter's own markers are noncharacters (escape.ts, emitter.ts), so none may come from the input.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufdd0-\ufdef]/g;

/** The input without control characters, and a notice naming their lines. */
function withoutControls(text: string): { text: string; notice?: Diagnostic } {
  if (!CONTROL.test(text)) {
    return { text };
  }
  const lines: number[] = [];
  let count = 0;
  text.split('\n').forEach((line, k) => {
    const found = line.match(CONTROL)?.length ?? 0;
    if (found > 0) {
      count += found;
      if (lines.length < 20) {
        lines.push(k + 1);
      }
    }
  });
  return {
    text: text.replace(CONTROL, ''),
    notice: { kind: 'notice', code: 'control-characters', message: `${count} control character(s) were removed: TeX cannot print them.`, lines },
  };
}

export function convertMarkdown(source: string, options: ConvertOptions = {}): ConversionResult {
  const cleaned = withoutControls(source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'));
  const appendix = options.appendix === undefined ? undefined : withoutControls(options.appendix.replace(/\r\n?/g, '\n')).text;
  // One budget for every preset-pattern test of this conversion, both engine passes included (docs/DESIGN.md#presets).
  const { value: result, budget } = withPatternBudget(() => convertCleaned(cleaned.text, appendix === options.appendix ? options : { ...options, appendix }));
  if (cleaned.notice) {
    result.diagnostics.unshift(cleaned.notice);
  }
  if (budget.exhausted) {
    result.diagnostics.push({
      kind: 'warning',
      code: 'preset-patterns',
      message: `The preset's patterns needed more work than one conversion may spend (${PATTERN_BUDGET.toLocaleString('en')} steps), so the rest were not applied. Simplify the appendix.dropLines and label patterns.`,
      lines: [1],
    });
  }
  if (budget.tooLong > 0) {
    result.diagnostics.push({
      kind: 'warning',
      code: 'preset-pattern-length',
      message: `${budget.tooLong} line(s) or caption(s) longer than ${MAX_TEXT_LENGTH.toLocaleString('en')} characters were not tested against the preset's patterns.`,
      lines: [1],
    });
  }
  result.patternWork = { steps: PATTERN_BUDGET - Math.max(budget.left, 0), ms: Math.round(budget.ms * 10) / 10 };
  return result;
}

function convertCleaned(text: string, options: ConvertOptions): ConversionResult {
  const preset = options.preset;
  if (preset) {
    if (preset.engine !== 'auto') {
      return convertOnce(text, options, preset, preset.engine);
    }
    const first = convertOnce(text, options, preset, 'pdflatex');
    if (first.unprintable.length === 0 || !preset.xetexPreamble) {
      return first;
    }
    const second = convertOnce(text, options, { ...preset, preamble: preset.xetexPreamble }, 'xelatex');
    second.diagnostics.unshift(engineNotice(text, first.unprintable, undefined));
    second.passes = 2;
    return second;
  }
  // The general dialect: the front matter or the folder config may name the engine or the template.
  const early = readMetadata(splitFrontMatter(text).frontMatter, options.defaults);
  if (early.template === 'notes' || early.engine === 'xelatex') {
    return convertOnce(text, options, undefined, 'xelatex', early.template === 'notes' ? 'dejavu' : undefined);
  }
  const first = convertOnce(text, options, undefined, 'pdflatex');
  if (first.unprintable.length === 0 || early.engine === 'pdflatex') {
    return first;
  }
  const second = convertOnce(text, options, undefined, 'xelatex');
  second.diagnostics.unshift(engineNotice(text, first.unprintable, second.fontSet));
  second.passes = 2;
  return second;
}

function engineNotice(text: string, unprintable: string[], fontSet: FontSetName | undefined): Diagnostic {
  const fonts = fontSet === 'dejavu' ? ' and the DejaVu fonts of the notes template' : fontSet === 'latin-modern' ? ' (in Latin Modern, as with pdfLaTeX)' : '';
  return {
    kind: 'notice',
    code: 'engine',
    message: `pdfLaTeX cannot print ${unprintable.length} character(s) of this document as single characters (${listed(unprintable)}), so it is typeset with XeTeX${fonts}.`,
    lines: linesWith(text, unprintable, 1),
  };
}

/** One conversion for one engine: the writer, the front matter, and the general template or the preset's own. */
function convertOnce(text: string, options: ConvertOptions, preset: PresetMode | undefined, engine: EngineName, forcedFontSet?: FontSetName): ConversionResult {
  const sourceLines = countLines(text);
  let mode = preset ?? defaultMode();
  const unicodeMode = engine === 'xelatex' ? 'keep' : 'pdftex';
  let frontMatter: FrontMatter | undefined;
  let body: string;
  let presetFront: PresetFront | undefined;
  if (mode.frontMatter === 'yaml') {
    ({ frontMatter, body } = splitFrontMatter(text));
  } else {
    ({ front: presetFront, body } = splitPresetFront(text, mode));
  }
  const meta = readMetadata(frontMatter, options.defaults);
  // A class template (classes.ts) brings its bibliography style and, for report and book, chapters.
  const cls = classTemplate(meta.documentclass);
  if (meta.biblioStyle === undefined && cls && cls.name !== 'article' && meta.citationPackage === 'natbib') {
    meta.biblioStyle = cls.bibliographyStyle;
  }
  if (!preset && cls?.chapters) {
    mode = { ...mode, headings: { ...mode.headings, commands: { '1': 'chapter', '2': 'section', '3': 'subsection', '4': 'subsubsection', '5': 'paragraph', '6': 'subparagraph' } } };
  }
  const md = converterParser(parserOptionsFor(mode));
  const env: Record<string, unknown> = {};
  const tokens = md.parse(body, env);

  const images: string[] = [];
  const writerOptions = {
    meta,
    unicode: unicodeMode,
    md,
    env,
    sourceLines: body.split('\n'),
    mode,
    resolveImage: (path: string) => {
      if (!images.includes(path)) {
        images.push(path);
      }
      return options.resolveImage?.(path);
    },
  } as const;
  const writer = new LatexWriter(writerOptions);
  writer.writeBody(tokens);

  if (mode.preamble) {
    return presetResult(options, text, mode, engine, writer, presetFront ?? { extra: [], lines: {} }, meta, sourceLines, images, writerOptions);
  }

  if (frontMatter?.error) {
    writer.diagnostics.notice('front-matter', `The YAML front matter could not be read (${frontMatter.error}); it was ignored.`, 1);
  }
  if (meta.documentclass === 'beamer') {
    writer.diagnostics.unsupported(
      'beamer',
      'documentclass: beamer needs the Markdown-to-Beamer writer (planned for v1.1); the article template is used.',
      meta.lines.documentclass ?? 1,
    );
  }

  // Front matter values are Markdown: convert them with the same writer (after the body, so footnote and
  // reference definitions are known).
  const at = (key: string) => meta.lines[key] ?? 1;
  const title = meta.title !== undefined ? writer.inlineString(meta.title, at('title')) : undefined;
  const subtitle = meta.subtitle !== undefined ? writer.inlineString(meta.subtitle, at('subtitle')) : undefined;
  const authors = meta.authors.map((a) => ({
    name: writer.inlineString(a.name, at('author')),
    affiliations: a.affiliations.map((aff) => writer.inlineString(aff, at('author'))),
    // Plain text: class commands such as \email take the address itself.
    email: a.email ? writer.text(a.email) : undefined,
  }));
  const date = meta.date !== undefined ? writer.inlineString(meta.date, at('date')) : undefined;
  const abstract = meta.abstract !== undefined ? writer.blockString(meta.abstract, at('abstract')).filter((l, k, all) => l !== '' || (k > 0 && k < all.length - 1)) : [];
  const keywords = meta.keywords.map((k) => writer.inlineString(k, at('keywords')));

  const bibliography = writer.bibliographyPlaced ? [] : writer.bibliographyCommands();
  if (writer.citationKeys.length > 0 && meta.bibliography.length === 0) {
    writer.diagnostics.notice(
      'no-bibliography',
      'The document cites sources but names no bibliography file (bibliography: refs.bib in the front matter), so the citations print as "?".',
      1,
    );
  }
  const unprintable = writer.unicode.characters();
  if (unprintable.length > 0 && engine === 'pdflatex') {
    writer.diagnostics.notice(
      'unicode',
      `pdfLaTeX cannot print ${unprintable.length} character(s) in this document as single characters (${listed(unprintable)}); without "engine: pdflatex" the document is typeset with XeTeX, which can.`,
      linesWith(text, unprintable, 1)[0],
    );
  }
  noteMissing(writer, text);

  let fonts: FontPlan | undefined;
  if (engine === 'xelatex') {
    fonts = fontPlan(writer.unicode.use, forcedFontSet ?? chooseFontSet(writer.unicode.use));
    for (const ch of fonts.missingMath) {
      const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      writer.diagnostics.notice(`math-font:${hex}`, `The math fonts have no ${ch} (U+${hex}), so it does not print in math.`, linesWith(text, [ch], 1)[0]);
    }
  }

  const doc = buildDocument({
    meta,
    features: writer.features,
    theorems: writer.theorems,
    title,
    subtitle,
    authors,
    date,
    abstract,
    keywords,
    body: { lines: writer.out.lines, map: writer.out.map },
    bibliography,
    sourceName: options.sourceName,
    sourceLines,
    fonts,
    notices: (code, message, line) => writer.diagnostics.notice(code, message, line),
  });

  return {
    latex: `${doc.lines.join('\n')}\n`,
    lineMap: doc.map,
    bodyStartLine: doc.bodyStart,
    diagnostics: writer.diagnostics.list(),
    meta,
    engine,
    fontSet: fonts?.set,
    fontFiles: fonts?.files ?? [],
    unprintable,
    citationKeys: [...writer.citationKeys],
    images,
    passes: 1,
  };
}

/** Characters no shipped font has: one notice each, on every line where it stands; the macro that shows them. */
function noteMissing(writer: LatexWriter, text: string): void {
  for (const ch of writer.unicode.missing.keys()) {
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    for (const line of linesWith(text, [ch])) {
      writer.diagnostics.notice(`missing-font:${hex}`, `No font the extension ships has ${ch} (U+${hex}); it is shown as [U+${hex}].`, line);
    }
  }
  if (writer.unicode.missing.size > 0) {
    writer.features.add('missing-char');
  }
}

/** The document for a preset mode with its own preamble (preset/document.ts). */
function presetResult(
  options: ConvertOptions,
  text: string,
  mode: PresetMode,
  engine: EngineName,
  writer: LatexWriter,
  front: PresetFront,
  meta: DocumentMeta,
  sourceLines: number,
  images: string[],
  writerOptions: ConstructorParameters<typeof LatexWriter>[0],
): ConversionResult {
  const conv = (s: string | undefined, key: string) => (s === undefined ? undefined : writer.inlineString(s, front.lines[key] ?? 1));
  let title = front.title;
  let titleSecond: string | undefined;
  if (title !== undefined && mode.titleBreakAfterQuestion && title.includes('? ')) {
    const at = title.indexOf('? ');
    titleSecond = title.slice(at + 2);
    title = title.slice(0, at + 1);
  }
  const converted: PresetTitle = {
    title: conv(title, 'title'),
    titleSecond: conv(titleSecond, 'title'),
    authors: conv(front.authors, 'authors'),
    affiliations: conv(front.affiliations, 'affiliations'),
    corresponding: conv(front.corresponding, 'corresponding'),
    abstract: conv(front.abstract, 'abstract'),
    date: conv(front.date, 'date'),
    lines: front.lines,
  };

  let appendix: { lines: string[]; map: number[] } | undefined;
  if (mode.appendix && options.appendix !== undefined) {
    // Untrusted patterns (a repository's preset): matched by safePattern.ts, never by RegExp; bad ones were
    // reported and dropped when the preset was loaded (load.ts).
    const drops = mode.appendix.dropLines.flatMap((p) => {
      try {
        return [compileSafePattern(p)];
      } catch {
        return [];
      }
    });
    const appendixText = options.appendix
      .replace(/^\ufeff/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => (drops.some((re) => re.test(l)) ? '' : l))
      .join('\n');
    const commands: Record<string, string> = {};
    for (const [level, command] of Object.entries(mode.headings.commands)) {
      commands[level] = mode.appendix.starred && !command.endsWith('*') ? `${command}*` : command;
    }
    const appendixMode: PresetMode = { ...mode, headings: { ...mode.headings, commands, starUnnumbered: false } };
    const env: Record<string, unknown> = {};
    const tokens = writerOptions.md.parse(appendixText, env);
    const sub = new LatexWriter({ ...writerOptions, env, mode: appendixMode, sourceLines: appendixText.split('\n') });
    sub.writeBody(tokens);
    appendix = { lines: sub.out.lines, map: sub.out.map };
    for (const key of sub.citationKeys) {
      if (!writer.citationKeys.includes(key)) {
        writer.citationKeys.push(key);
      }
    }
    sub.features.forEach((f) => writer.features.add(f));
    for (const d of sub.diagnostics.list()) {
      writer.diagnostics.add(d.kind, `appendix:${d.code}`, `In the appendix: ${d.message}`, sourceLines);
    }
  }

  noteMissing(writer, text);
  const doc = buildPresetDocument({
    mode,
    front: converted,
    features: writer.features,
    theorems: writer.theorems,
    body: { lines: writer.out.lines, map: writer.out.map },
    appendix,
    sourceName: options.sourceName,
    sourceLines,
  });
  const unprintable = writer.unicode.characters();
  if (unprintable.length > 0 && engine === 'pdflatex') {
    writer.diagnostics.notice(
      'unicode',
      `pdfLaTeX cannot print ${unprintable.length} character(s) in this document as single characters (${listed(unprintable)}); the preset mode "${mode.name}" uses pdfLaTeX.`,
      linesWith(text, unprintable, 1)[0],
    );
  }
  return {
    latex: `${doc.lines.join('\n')}\n`,
    lineMap: doc.map,
    bodyStartLine: doc.bodyStart,
    diagnostics: writer.diagnostics.list(),
    meta: {
      ...meta,
      title: front.title,
      authors: front.authors ? [{ name: front.authors, affiliations: front.affiliations ? [front.affiliations] : [] }] : [],
      date: front.date,
      abstract: front.abstract,
    },
    engine,
    fontFiles: [],
    unprintable,
    citationKeys: [...writer.citationKeys],
    images,
    passes: 1,
    appendixMap: doc.appendixMap,
  };
}

/** M0's interface, kept for its callers: the full document and its line map. */
export function markdownToLatex(markdown: string): { latex: string; lineMap: number[] } {
  const result = convertMarkdown(markdown);
  // The document ends with "\n"; the map has one entry per line before it.
  return { latex: result.latex.replace(/\n$/, ''), lineMap: result.lineMap };
}

/** The Markdown line (1-based) for a LaTeX line (1-based). */
export function latexToMarkdownLine(result: Pick<ConversionResult, 'lineMap'>, latexLine: number): number {
  const i = Math.min(Math.max(1, latexLine), result.lineMap.length) - 1;
  return result.lineMap[i] ?? 1;
}

/**
 * The first LaTeX line (1-based) that comes from a Markdown line, searching the body first; when no LaTeX line
 * comes from that Markdown line (a blank line, a footnote definition), the nearest earlier one.
 */
export function markdownToLatexLine(result: Pick<ConversionResult, 'lineMap' | 'bodyStartLine'>, markdownLine: number): number {
  let best = -1;
  let bestSource = -1;
  for (let i = result.bodyStartLine - 1; i < result.lineMap.length; i++) {
    const source = result.lineMap[i];
    if (source === markdownLine) {
      return i + 1;
    }
    if (source < markdownLine && source > bestSource) {
      best = i;
      bestSource = source;
    }
  }
  if (best >= 0) {
    return best + 1;
  }
  const anywhere = result.lineMap.indexOf(markdownLine);
  return anywhere >= 0 ? anywhere + 1 : 1;
}
