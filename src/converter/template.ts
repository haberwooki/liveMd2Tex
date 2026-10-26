// The default article template (docs/DESIGN.md#converter): article with amsmath, amssymb, graphicx, booktabs,
// hyperref, natbib and geometry, Latin Modern fonts, numbered sections, pandoc-style citations with plainnat.
// Packages beyond that are added only when the document uses what needs them (tabularx, ulem, soul, tcolorbox,
// amsthm, cleveref, babel). Every line carries the Markdown line it comes from: the front matter key that set
// it, or line 1.
//
// On XeTeX (input.fonts set) the same template loads fontspec and unicode-math instead of fontenc, lmodern and
// amssymb, with the font set and fallback lines of fonts/fonts.ts: Latin Modern, or the notes template's DejaVu
// fonts. biblatex runs on bibtex8 (backend=bibtex8): Biber is not in the engine.

import { articleTemplate, classTemplate, type TitleAuthor } from './classes';
import { stripLineMarks } from './emitter';
import type { FontPlan } from './fonts/fonts';
import type { Feature } from './latexWriter';
import { babelLanguage, type DocumentMeta } from './metadata';

export interface TemplateInput {
  meta: DocumentMeta;
  features: Set<Feature>;
  theorems: Set<string>;
  /** Converted title pieces (already LaTeX). */
  title?: string;
  subtitle?: string;
  authors: TitleAuthor[];
  date?: string;
  abstract: string[];
  keywords: string[];
  body: { lines: string[]; map: number[] };
  bibliography: string[];
  sourceName?: string;
  sourceLines: number;
  /** XeTeX: the font lines (fonts/fonts.ts); absent: pdfLaTeX. */
  fonts?: FontPlan;
  notices: (code: string, message: string, line: number) => void;
}

export interface TemplateOutput {
  lines: string[];
  map: number[];
  /** 1-based LaTeX line where the body starts. */
  bodyStart: number;
  /** A preset's appendix: for each LaTeX line, the line of the appendix file it comes from, or 0. */
  appendixMap?: number[];
}

const THEOREM_NAMES: Record<string, string> = {
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
};
const DEFINITION_STYLE = new Set(['definition', 'example', 'exercise', 'solution']);
const REMARK_STYLE = new Set(['remark']);

/** Classes the default template fits; others work but get a notice that their own template comes later. */
const PLAIN_CLASSES = new Set(['article', 'report', 'book', 'scrartcl', 'scrreprt', 'scrbook', 'memoir', 'extarticle', 'amsart']);

export function buildDocument(input: TemplateInput): TemplateOutput {
  const { meta } = input;
  const lines: string[] = [];
  const map: number[] = [];
  const at = (key: string) => meta.lines[key] ?? 1;
  const push = (text: string, line: number) => {
    lines.push(stripLineMarks(text)); // front matter values keep a footnote inline
    map.push(Math.max(1, Math.min(line, input.sourceLines)));
  };

  push(`% Generated from ${input.sourceName ?? 'Markdown'} by the extension's Markdown converter. Edit the Markdown; this file is rewritten.`, 1);

  // Class: a class template (classes.ts) when there is one, else the article template with the class named.
  let documentclass = meta.documentclass;
  if (documentclass === 'beamer') {
    documentclass = 'article';
  }
  const cls = classTemplate(documentclass) ?? articleTemplate();
  if (!classTemplate(documentclass) && !PLAIN_CLASSES.has(documentclass)) {
    input.notices(
      'class-template',
      `The class "${documentclass}" has no template of its own; it is used with the default article template's title block.`,
      at('documentclass'),
    );
  }
  const options = [...(meta.fontsize ? [meta.fontsize] : []), ...(meta.classoptions.length > 0 ? meta.classoptions : cls.defaultOptions)];
  push(`\\documentclass${options.length ? `[${options.join(',')}]` : ''}{${documentclass}}`, at('documentclass'));

  // Order: our packages, then the user's header-includes, then hyperref and cleveref (which load last), then our
  // definitions, which need the packages above whoever loaded them. A package the user loads in header-includes
  // is not loaded by us too, so their options never clash with ours ("Option clash for package xcolor").
  const userPackages = new Set<string>();
  for (const m of meta.headerIncludes.join('\n').matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach((p) => userPackages.add(p.trim()));
  }
  const usePackage = (names: string, options: string, line: number) => {
    const keep = names.split(',').filter((p) => !userPackages.has(p) && !cls.skip.includes(p));
    if (keep.length > 0) {
      push(`\\usepackage${options ? `[${options}]` : ''}{${keep.join(',')}}`, line);
    }
  };

  // Fonts and the always-loaded packages. On XeTeX: fontspec and unicode-math (after amsmath, which it needs
  // first), unless the class sets its own fonts (acmart) or the header-includes load unicode-math themselves.
  if (input.fonts) {
    usePackage('amsmath', '', 1);
    if (!cls.skip.includes('fontenc')) {
      usePackage('fontspec', '', 1);
      usePackage('unicode-math', '', 1);
      if (!userPackages.has('unicode-math')) {
        input.fonts.preamble.forEach((l) => push(l, 1));
      }
    }
  } else {
    usePackage('fontenc', 'T1', 1);
    usePackage('lmodern', '', 1);
    usePackage('amsmath,amssymb', '', 1);
  }
  usePackage('graphicx', '', 1);
  usePackage('booktabs', '', 1);
  if (meta.geometry.length > 0) {
    usePackage('geometry', meta.geometry.join(','), at('geometry'));
  }
  if (meta.lang) {
    const babel = babelLanguage(meta.lang);
    if (babel) {
      usePackage('babel', babel, at('lang'));
    } else {
      input.notices('lang', `The language "${meta.lang}" has no babel name in the converter's table; the document is set in English.`, at('lang'));
    }
  }

  // Packages the document needs.
  const f = input.features;
  if (f.has('tabularx')) {
    usePackage('tabularx', '', 1);
  }
  if (f.has('ulem')) {
    usePackage('ulem', 'normalem', 1);
  }
  if (f.has('soul') || f.has('callout') || f.has('notes')) {
    usePackage('xcolor', '', 1);
  }
  if (f.has('soul')) {
    usePackage('soul', '', 1);
  }
  if (f.has('callout')) {
    usePackage('tcolorbox', '', 1);
  }
  if (f.has('amsthm')) {
    usePackage('amsthm', '', 1);
  }
  if (meta.citationPackage === 'biblatex') {
    // Biber is not in the engine; biblatex's bibtex8 backend gives the same citations and list.
    usePackage('biblatex', ['backend=bibtex8', ...(meta.biblioStyle ? [`style=${meta.biblioStyle}`] : [])].join(','), at('biblatex'));
  } else {
    usePackage('natbib', cls.natbibOptions, at('natbib'));
  }
  if (meta.csl) {
    input.notices(
      'csl',
      `CSL styles (csl: ${meta.csl}) are not supported; ${meta.citationPackage === 'biblatex' ? `biblatex${meta.biblioStyle ? ` with style ${meta.biblioStyle}` : ''}` : `natbib with ${meta.biblioStyle ?? 'plainnat'}`} is used instead.`,
      at('csl'),
    );
  }
  for (const include of meta.headerIncludes) {
    include
      .replace(/\n+$/, '')
      .split('\n')
      .forEach((l) => push(l, at('header-includes')));
  }
  if (!cls.skip.includes('hyperref')) {
    push('\\usepackage{hyperref}', 1);
  }
  if (meta.cref) {
    push('\\usepackage{cleveref}', at('cref'));
  }

  // Definitions that need the packages above.
  if (meta.citationPackage === 'biblatex') {
    for (const file of meta.bibliography) {
      push(`\\addbibresource{${file}}`, at('bibliography'));
    }
  }
  featureDefinitions(f, input.theorems, input.meta.headerIncludes.join('\n'), false).forEach((l) => push(l, 1));
  const pdfInfo: string[] = ['hidelinks'];
  if (input.title) {
    pdfInfo.push(`pdftitle={${plainPdfString(meta.title ?? '')}}`);
  }
  if (meta.authors.length > 0) {
    pdfInfo.push(`pdfauthor={${plainPdfString(meta.authors.map((a) => a.name).join(', '))}}`);
  }
  if (meta.keywords.length > 0) {
    pdfInfo.push(`pdfkeywords={${plainPdfString(meta.keywords.join(', '))}}`);
  }
  if (pdfInfo.length > 0) {
    push(`\\hypersetup{${pdfInfo.join(',')}}`, at('title'));
  }
  if (!meta.numbersections) {
    push('\\setcounter{secnumdepth}{-1}', at('numbersections'));
  }

  // Helper macros, only those the body uses.
  featureDefinitions(f, input.theorems, '', true).forEach((l) => push(l, 1));

  // Title block, in the class's own idiom (classes.ts).
  const titleData = { title: input.title, subtitle: input.subtitle, authors: input.authors, date: input.date, abstract: input.abstract, keywords: input.keywords };
  const titleLine = (l: string) => (/^\\(begin|end)\{abstract\}/.test(l) || input.abstract.includes(l) ? at('abstract') : /keyword/i.test(l) ? at('keywords') : /^\\(author|affiliation|email|ead|institute|thanks)/.test(l) ? at('author') : at('title'));
  cls.preambleTitle(titleData).forEach((l) => push(l, titleLine(l)));

  push('', 1);
  push('\\begin{document}', 1);
  if (input.title !== undefined || input.abstract.length > 0 || input.keywords.length > 0) {
    cls.frontMatter(titleData).forEach((l) => push(l, titleLine(l)));
  }
  if (meta.toc) {
    push('\\tableofcontents', at('toc'));
  }
  push('', 1);
  const bodyStart = lines.length + 1;
  input.body.lines.forEach((l, k) => push(l, input.body.map[k]));
  if (input.bibliography.length > 0) {
    push('', input.sourceLines);
    input.bibliography.forEach((l) => push(l, at('bibliography')));
  }
  push('', input.sourceLines);
  push('\\end{document}', input.sourceLines);
  return { lines, map, bodyStart };
}

/**
 * The packages the body's features need, as [name, options] (for a preset's own preamble, which may load some
 * of them already).
 */
export function featurePackages(f: Set<Feature>): [string, string][] {
  const out: [string, string][] = [];
  if (f.has('tabularx')) {
    out.push(['tabularx', '']);
  }
  if (f.has('ulem')) {
    out.push(['ulem', 'normalem']);
  }
  if (f.has('soul') || f.has('callout') || f.has('notes')) {
    out.push(['xcolor', '']);
  }
  if (f.has('soul')) {
    out.push(['soul', '']);
  }
  if (f.has('callout')) {
    out.push(['tcolorbox', '']);
  }
  if (f.has('amsthm')) {
    out.push(['amsthm', '']);
  }
  return out;
}

/**
 * Definitions the body's features need. `macros` false: the package-dependent definitions (column type,
 * colours, boxes, theorems, notes); true: the image helper macros.
 */
export function featureDefinitions(f: Set<Feature>, theorems: Set<string>, declared: string, macros: boolean): string[] {
  const out: string[] = [];
  if (macros) {
    if (f.has('fit-image')) {
      out.push('\\newsavebox\\mdimagebox');
      out.push('\\newcommand*\\mdincludegraphics[1]{\\sbox\\mdimagebox{\\includegraphics{#1}}%');
      out.push('  \\ifdim\\wd\\mdimagebox>\\linewidth\\resizebox{\\linewidth}{!}{\\usebox\\mdimagebox}\\else\\usebox\\mdimagebox\\fi}');
    }
    if (f.has('remote-image')) {
      out.push('\\newcommand*\\mdremoteimage[1]{\\fbox{\\parbox{0.8\\linewidth}{\\centering\\small Image from the web, not embedded:\\\\\\url{#1}}}}');
    }
    if (f.has('web-image')) {
      out.push('\\newcommand*\\mdwebimage[1]{\\fbox{\\scriptsize #1}}');
    }
    if (f.has('missing-image')) {
      out.push('\\newcommand*\\mdmissingimage[1]{\\fbox{\\parbox{0.8\\linewidth}{\\centering\\small Image #1 needs a PDF or PNG copy.}}}');
    }
    if (f.has('missing-char')) {
      // A character no shipped font has, by its code point.
      out.push('\\newcommand*\\mdmissingchar[1]{{\\footnotesize[U+#1]}}');
    }
    return out;
  }
  if (f.has('tabularx')) {
    out.push('\\newcolumntype{L}{>{\\raggedright\\arraybackslash}X}');
  }
  if (f.has('callout')) {
    out.push('\\definecolor{mdcallout-note}{RGB}{9,105,218}\\definecolor{mdcallout-tip}{RGB}{26,127,55}');
    out.push('\\definecolor{mdcallout-important}{RGB}{130,80,223}\\definecolor{mdcallout-warning}{RGB}{154,103,0}');
    out.push('\\definecolor{mdcallout-caution}{RGB}{207,34,46}');
    out.push('\\newtcolorbox{mdcallout}[2]{colback=mdcallout-#1!4,colframe=mdcallout-#1,fonttitle=\\bfseries,title={#2}}');
  }
  if (f.has('notes')) {
    out.push('\\definecolor{mdnotecolor}{RGB}{154,103,0}');
    out.push('\\newcommand*\\mdnote[1]{\\marginpar{\\raggedright\\footnotesize\\color{mdnotecolor}#1}}');
    out.push('\\newenvironment{mdnoteblock}{\\begin{quote}\\footnotesize\\color{mdnotecolor}}{\\end{quote}}');
  }
  if (f.has('amsthm')) {
    let style = '';
    for (const name of [...theorems].sort((a, b) => Number(DEFINITION_STYLE.has(a)) - Number(DEFINITION_STYLE.has(b)) || Number(REMARK_STYLE.has(a)) - Number(REMARK_STYLE.has(b)))) {
      if (declared.includes(`\\newtheorem{${name}}`)) {
        continue;
      }
      const wanted = DEFINITION_STYLE.has(name) ? 'definition' : REMARK_STYLE.has(name) ? 'remark' : 'plain';
      const set = wanted !== style ? `\\theoremstyle{${wanted}}` : '';
      style = wanted;
      out.push(`${set}\\newtheorem{${name}}{${THEOREM_NAMES[name] ?? name}}`);
    }
  }
  return out;
}

/** Text for a PDF information field: TeX specials removed. */
function plainPdfString(text: string): string {
  return text.replace(/[\\{}$&%#_^~*]/g, '').replace(/\s+/g, ' ').trim();
}
