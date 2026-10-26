// A document in a preset mode that brings its own preamble (docs/DESIGN.md#presets): the preamble
// template (with {{title}}, {{author}} and {{date}} filled in), packages and definitions the body's features
// need that the preamble lacks, the title (a two-column banner, a centred heading, \maketitle or none), the
// body, the bibliography, an appendix converted from a second Markdown file, and \end{document}. Every line
// carries the Markdown line it comes from (preamble lines: line 1; the appendix: the last line, and its own line
// in appendixMap, for click-to-source into the appendix file).

import type { Feature } from '../latexWriter';
import { stripLineMarks } from '../emitter';
import { featureDefinitions, featurePackages, type TemplateOutput } from '../template';
import type { PresetMode } from './types';

export interface PresetTitle {
  /** Converted (LaTeX) pieces of the front matter. */
  title?: string;
  /** The title split after its question mark, when the mode asks for that. */
  titleSecond?: string;
  authors?: string;
  affiliations?: string;
  corresponding?: string;
  abstract?: string;
  date?: string;
  lines: Record<string, number>;
}

export interface PresetDocumentInput {
  mode: PresetMode;
  front: PresetTitle;
  features: Set<Feature>;
  theorems: Set<string>;
  body: { lines: string[]; map: number[] };
  /** The appendix, converted from its own Markdown file, with that file's line for each LaTeX line. */
  appendix?: { lines: string[]; map: number[] };
  sourceName?: string;
  sourceLines: number;
}

/**
 * Whether the preset's preamble loads the package `name` (\usepackage[...]{a,name,b} or \RequirePackage). The
 * preamble comes from a repository, so this is a plain scan in one pass, not a regular expression with nested
 * repeats that could take quadratic time on a long run of spaces (docs/DESIGN.md#presets).
 */
function loadsPackage(preamble: string, name: string): boolean {
  for (const command of ['\\usepackage', '\\RequirePackage']) {
    // Each character is looked at a bounded number of times: the search goes on after what was read.
    let from = 0;
    for (let at = preamble.indexOf(command, from); at >= 0; at = preamble.indexOf(command, from)) {
      let i = at + command.length;
      from = i;
      while (i < preamble.length && /\s/.test(preamble[i])) {
        i++;
      }
      if (preamble[i] === '[') {
        const close = preamble.indexOf(']', i);
        if (close < 0) {
          break;
        }
        i = close + 1;
        from = i;
        while (i < preamble.length && /\s/.test(preamble[i])) {
          i++;
        }
      }
      if (preamble[i] !== '{') {
        continue;
      }
      const close = preamble.indexOf('}', i);
      if (close < 0) {
        break;
      }
      from = close + 1;
      const names = preamble.slice(i + 1, close).split(',');
      if (names.some((p) => p.replace(/%[^\n]*/g, '').trim() === name)) {
        return true;
      }
    }
  }
  return false;
}

export function buildPresetDocument(input: PresetDocumentInput): TemplateOutput {
  const { mode, front } = input;
  const lines: string[] = [];
  const map: number[] = [];
  const push = (text: string, line: number) => {
    lines.push(stripLineMarks(text)); // front matter values keep a footnote inline
    map.push(Math.max(1, Math.min(line, input.sourceLines)));
  };
  const at = (key: string) => front.lines[key] ?? 1;

  const filled = mode.preamble
    .replace(/\r\n?/g, '\n')
    .replace(/\{\{title\}\}/g, front.title ?? '')
    .replace(/\{\{author\}\}/g, front.authors ?? '')
    .replace(/\{\{date\}\}/g, front.date ?? '');
  const begin = filled.lastIndexOf('\\begin{document}');
  const pre = (begin >= 0 ? filled.slice(0, begin) : filled).replace(/\n+$/, '');
  const post = begin >= 0 ? filled.slice(begin + '\\begin{document}'.length).replace(/^\n/, '').replace(/\n+$/, '') : '';

  push(`% Generated from ${input.sourceName ?? 'Markdown'} by the extension's Markdown converter (preset mode "${mode.name}"). Edit the Markdown; this file is rewritten.`, 1);
  pre.split('\n').forEach((l) => push(l, 1));
  // What the body uses beyond the preset's own preamble.
  for (const [name, options] of featurePackages(input.features)) {
    if (!loadsPackage(pre, name)) {
      push(`\\usepackage${options ? `[${options}]` : ''}{${name}}`, 1);
    }
  }
  [...featureDefinitions(input.features, input.theorems, pre, false), ...featureDefinitions(input.features, input.theorems, pre, true)].forEach((l) =>
    push(l, 1),
  );
  push('\\begin{document}', 1);
  if (post) {
    post.split('\n').forEach((l) => push(l, at('title')));
  }

  if (mode.title === 'banner') {
    const titleTex = front.titleSecond !== undefined ? `${front.title ?? ''}\\\\[2pt] ${front.titleSecond}` : (front.title ?? '');
    let authors = `{\\large ${front.authors ?? ''}}`;
    if (front.affiliations) {
      authors += `\\\\[0.4em]{\\footnotesize ${front.affiliations}}`;
    }
    if (front.corresponding) {
      authors += `\\\\[0.3em]{\\footnotesize ${mode.titleLabels.correspondence}${front.corresponding}}`;
    }
    push('\\twocolumn[{%', at('title'));
    push('\\begin{center}', at('title'));
    push(`{\\LARGE\\bfseries ${titleTex}}\\\\[0.7em]`, at('title'));
    push(authors, at('authors'));
    push('\\end{center}\\vspace{0.7em}', at('authors'));
    push(`\\begin{minipage}{\\textwidth}\\small\\noindent\\textbf{${mode.titleLabels.abstract}} ${front.abstract ?? ''}\\end{minipage}\\vspace{1.6em}`, at('abstract'));
    push('}]', at('abstract'));
  } else if (mode.title === 'heading') {
    push(`\\begin{center}{\\LARGE\\bfseries ${mode.titleText}}\\end{center}\\vspace{1em}`, 1);
  } else if (mode.title === 'maketitle' && front.title !== undefined) {
    push('\\maketitle', at('title'));
  }

  const bodyStart = lines.length + 1;
  input.body.lines.forEach((l, k) => push(l, input.body.map[k]));
  if (mode.bibliographyStyle) {
    push('', input.sourceLines);
    push(`\\bibliographystyle{${mode.bibliographyStyle}}`, input.sourceLines);
    push(`\\bibliography{${mode.bibliographyFiles.join(',')}}`, input.sourceLines);
  }
  if (mode.appendix && input.appendix) {
    push('', input.sourceLines);
    if (mode.appendix.clearpage) {
      push('\\clearpage', input.sourceLines);
    }
    push(`\\section*{${mode.appendix.heading}}`, input.sourceLines);
    // Lines before the appendix: 0; its heading: the appendix file's first line.
    const appendixMap = new Array<number>(lines.length).fill(0);
    appendixMap[lines.length - 1] = 1;
    const appendix = input.appendix;
    appendix.lines.forEach((l, k) => {
      push(l, input.sourceLines);
      appendixMap.push(appendix.map[k] ?? 1);
    });
    push('', input.sourceLines);
    push('\\end{document}', input.sourceLines);
    appendixMap.push(0, 0);
    return { lines, map, bodyStart, appendixMap };
  }
  push('', input.sourceLines);
  push('\\end{document}', input.sourceLines);
  return { lines, map, bodyStart };
}
