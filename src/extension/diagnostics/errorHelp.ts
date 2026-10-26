// Plain-words help for the 20 most common TeX errors, and two font errors (docs/DESIGN.md#help-for-new-users). A TeX error message is
// short and written for TeX experts ("Missing $ inserted."); the help says what usually causes it and what to try,
// in a sentence or two, and names the command, file or environment the message names. The Problems panel shows it
// on its own line after the message, with the error's id as the problem's code (compile/runner.ts adds it,
// compile/outputs.ts shows it).
//
// Each entry matches the message as the log parser gives it (logParser.ts: the text after "file:line: ", with the
// "(at: ...)" context TeX printed, and for an undefined command inside a macro or an argument its first context
// line as "(in: ...)"). An error shown on a Markdown line, through the converter's line map, gets the entry's
// Markdown wording where it has one: the front matter instead of the preamble or a "% !TEX" line. The fixtures in
// test/fixtures/tex-errors/ make each error happen on the engine. Pure: no VS Code here.

import type { TexDiagnostic } from './logParser';

export interface ErrorHelp {
  /** A stable name, e.g. "undefined-command". */
  id: string;
  /** The help, in plain words. */
  help: string;
}

/** The kind of source the error is shown on: a LaTeX file, or a Markdown file through the converter's line map. */
export type SourceKind = 'latex' | 'markdown';

interface Entry {
  id: string;
  /** Tested against the message; the groups feed `help`. */
  pattern: RegExp;
  help: (m: RegExpExecArray) => string;
  /** The wording for a Markdown line, where it differs (no LaTeX-only advice there). */
  markdown?: (m: RegExpExecArray) => string;
}

/** The command, environment or file a message names, cleaned for a sentence. */
const named = (s: string | undefined, fallback: string) => (s && s.trim() ? s.trim() : fallback);

/**
 * The command TeX stopped at: the last command of its first context line. The log parser keeps that line as
 * "(in: \mymacro ->\foo)" when it is not the "l.N" line (an undefined command inside a macro or an argument);
 * otherwise it is the "l.N" line, kept as "(at: Some text \foo)".
 */
function lastCommand(message: string): string | undefined {
  const inner = message.indexOf('(in: ');
  let context: string;
  if (inner >= 0) {
    const end = message.indexOf(') (at: ', inner);
    context = message.slice(inner + 5, end < 0 ? message.lastIndexOf(')') : end);
  } else {
    const start = message.lastIndexOf('(at: ');
    context = start < 0 ? '' : message.slice(start + 5);
  }
  const commands = context.match(/\\[A-Za-z@]+\*?/g);
  return commands?.[commands.length - 1];
}

/** The .eps figure behind epstopdf's output name ("fig-eps-converted-to.pdf" gives "fig.eps"), or undefined. */
function epsFigure(file: string): string | undefined {
  return /-eps-converted-to\.pdf$/i.test(file) ? file.replace(/-eps-converted-to\.pdf$/i, '.eps') : undefined;
}

const ENTRIES: Entry[] = [
  {
    id: 'undefined-command',
    pattern: /^Undefined control sequence/,
    help: (m) => {
      const cmd = lastCommand(m.input);
      return `TeX does not know the command ${cmd ?? 'on this line'}. Check its spelling; if it comes from a package, add \\usepackage{...} for that package to the preamble.`;
    },
    markdown: (m) => {
      const cmd = lastCommand(m.input);
      return `TeX does not know the command ${cmd ?? 'on this line'}. Check its spelling; if it comes from a package, load the package in the front matter (header-includes: \\usepackage{...}).`;
    },
  },
  {
    id: 'file-not-found',
    pattern: /File [`']([^`']+)' not found/,
    help: (m) => {
      const file = m[1];
      const eps = epsFigure(file);
      if (eps) {
        return `The .eps figure ${eps} was not turned into PDF: that needs a program outside TeX, and this extension never runs one. Put a PDF copy beside it, with the same name, and include the figure without its extension.`;
      }
      if (/\.(sty|cls)$/i.test(file)) {
        return `The package or class ${file} is not in the TeX data this extension carries. Check the name; if it is right, add it with "Add a package from a file", or install the extra packages.`;
      }
      if (/\.(png|jpe?g|pdf|eps)$/i.test(file) || !/\./.test(file)) {
        return `The file ${file} was not found. Check the name and the folder in \\includegraphics (paths are relative to the main document), and that the file is inside the project folder.`;
      }
      return `The file ${file} was not found. Check the name in \\input, \\include or \\bibliography, and that the file is inside the project folder.`;
    },
    markdown: (m) => {
      const file = m[1];
      const eps = epsFigure(file);
      if (eps) {
        return `The .eps figure ${eps} was not turned into PDF: that needs a program outside TeX, and this extension never runs one. Put a PDF copy beside it, with the same name; the converter then uses the PDF.`;
      }
      if (/\.(sty|cls)$/i.test(file)) {
        return `The package or class ${file} is not in the TeX data this extension carries. Check the name; if it is right, add it with "Add a package from a file", or install the extra packages.`;
      }
      if (/\.(png|jpe?g|pdf|eps)$/i.test(file) || !/\./.test(file)) {
        return `The image ${file} was not found. Check its path in ![...](...): it is relative to the Markdown file, and the file must be inside the project folder.`;
      }
      return `The file ${file} was not found. Check its name in the front matter (bibliography:) or in the LaTeX you wrote, and that it is inside the project folder.`;
    },
  },
  {
    id: 'missing-dollar',
    pattern: /^Missing \$ inserted/,
    help: () =>
      'Something that only works in maths (such as _ or ^, or a symbol like \\alpha) is in ordinary text, or a $ is missing. Put the maths between $...$, or write \\_ for an underscore in text.',
    markdown: () =>
      'Something that only works in maths (such as ^, or a symbol like \\alpha) is outside maths, or a $ is missing. Check the maths between $...$ on this line.',
  },
  {
    id: 'extra-brace-or-dollar',
    pattern: /^Extra \}, or forgotten (\$|\\endgroup)/,
    help: () => 'A } closes a group that was never opened here, or a $ that ends maths is missing. Check the braces and dollars on this line.',
  },
  {
    id: 'missing-brace',
    pattern: /^Missing \} inserted/,
    help: () => 'A { is not closed, often inside maths or a command argument. Count the braces on this line and the lines before it.',
  },
  {
    id: 'too-many-braces',
    pattern: /^Too many \}'s/,
    help: () => 'There is a } with no { to match it. Remove the extra } or add the missing {.',
  },
  {
    id: 'runaway-argument',
    pattern: /^(Paragraph ended before (\\\S+) was complete|Runaway argument)/,
    help: (m) =>
      `The argument of ${named(m[2], 'a command')} was not closed before a blank line. A } is probably missing; a command's argument cannot hold a new paragraph.`,
  },
  {
    id: 'file-ended',
    pattern: /^File ended while scanning (?:use|definition|text) of (\\[A-Za-z@]+|\\.)/,
    help: (m) => `The file ended while TeX was still reading the argument of ${m[1]}: a } is missing somewhere after it.`,
  },
  {
    id: 'environment-undefined',
    pattern: /Environment ([^\s]{1,80}) undefined/,
    help: (m) =>
      `There is no environment called ${m[1]}. Check the spelling in \\begin{${m[1]}}; if it comes from a package (such as align from amsmath), load that package.`,
    markdown: (m) =>
      `There is no environment called ${m[1]}. Check the spelling in \\begin{${m[1]}}; if it comes from a package (such as align from amsmath), load that package in the front matter (header-includes).`,
  },
  {
    id: 'begin-end-mismatch',
    pattern: /\\begin\{([^}]*)\} on input line (\d+) ended by \\end\{([^}]*)\}/,
    help: (m) =>
      `The environment ${m[1]} that starts on line ${m[2]} is closed by \\end{${m[3]}}. Every \\begin{...} needs its own \\end{...}, in the right order: one is missing or misspelt.`,
  },
  {
    id: 'misplaced-ampersand',
    pattern: /^Misplaced alignment tab character &/,
    help: () => 'An & is outside a table or an aligned equation. Write \\& for an ampersand in text.',
    markdown: () => 'An & is outside a table or an aligned equation, in maths or in LaTeX you wrote. In ordinary Markdown text the converter writes the & for you.',
  },
  {
    id: 'extra-alignment-tab',
    pattern: /^Extra alignment tab has been changed to \\cr/,
    help: () => 'A table row has more cells (more &) than the table has columns. Add a column in \\begin{tabular}{...} or remove an &.',
    markdown: () => 'A table row has more cells than the table has columns. Give each row of a Markdown table the same number of | cells; in LaTeX you wrote, remove an & or add a column.',
  },
  {
    id: 'missing-number',
    pattern: /^Missing number, treated as zero/,
    help: () =>
      'TeX expected a number or a length here and found something else, for example an empty width, or a word after a command such as \\vspace. Check the arguments on this line.',
  },
  {
    id: 'illegal-unit',
    pattern: /^Illegal unit of measure \(pt inserted\)/,
    help: () => 'A length has no unit. Write a unit after the number, such as 5cm, 2em or 0.5\\linewidth.',
  },
  {
    id: 'missing-begin-document',
    pattern: /Missing \\begin\{document\}/,
    help: () =>
      'Text or a command that prints something comes before \\begin{document}, or \\begin{document} is missing. Only settings belong in the preamble; move the text after \\begin{document}.',
    markdown: () =>
      'Something in the preamble prints text: check header-includes in the front matter, or the preset\'s preamble file. Only settings belong there.',
  },
  {
    id: 'preamble-only',
    pattern: /Can be used only in preamble/,
    help: (m) => {
      const cmd = lastCommand(m.input);
      return `${cmd ?? 'This command'} works only in the preamble (before \\begin{document}). Move it there; \\usepackage is the usual case.`;
    },
    markdown: (m) => {
      const cmd = lastCommand(m.input);
      return `${cmd ?? 'This command'} works only in the preamble. In Markdown, put it in the front matter under header-includes; \\usepackage is the usual case.`;
    },
  },
  {
    id: 'no-line-to-end',
    pattern: /There's no line here to end/,
    help: () => 'A \\\\ (new line) comes where no line has started, for example on an empty line or right after a heading. Remove it, or use a blank line or \\vspace for space.',
    markdown: () => 'A line break comes where no line has started, for example a \\\\ on an empty line or right after a heading. Remove it, and leave a blank line between paragraphs instead.',
  },
  {
    id: 'lonely-item',
    pattern: /Lonely \\item/,
    help: () => 'An \\item is outside a list. Put the items inside \\begin{itemize} ... \\end{itemize} (or enumerate, or description).',
    markdown: () => 'An \\item is outside a list. In Markdown, start each list item with "- " or "1. "; in LaTeX you wrote, put \\item inside \\begin{itemize} ... \\end{itemize}.',
  },
  {
    id: 'double-script',
    pattern: /^Double (superscript|subscript)/,
    help: (m) => {
      const mark = m[1] === 'superscript' ? '^' : '_';
      return `Two ${m[1]}s follow one another (x${mark}a${mark}b). Group them with braces: x${mark}{ab}, or {x${mark}a}${mark}b.`;
    },
  },
  {
    id: 'unicode-not-set-up',
    // TeX prints the character as bytes (^^e2^^8c^^98) and puts "not set up for use with LaTeX" on the next line.
    pattern: /Unicode character ([^\s(]{1,24}) \((U\+[0-9A-Fa-f]{4,6})\)/,
    help: (m) => {
      const shown = m[1].includes('^^') ? m[2] : `${m[1]} (${m[2]})`;
      return `pdfLaTeX cannot print the character ${shown} here. Use its LaTeX command instead, or compile with XeTeX (put "% !TEX program = xelatex" on the first line).`;
    },
    markdown: (m) => {
      const shown = m[1].includes('^^') ? m[2] : `${m[1]} (${m[2]})`;
      return `pdfLaTeX cannot print the character ${shown} here. Add "engine: xelatex" to the front matter (or "engine": "xelatex" to the folder's .latexpreview.json), or write the character's LaTeX command.`;
    },
  },
];

/**
 * Fonts the TeX data does not hold. They are not among the 20 common errors, but they come with fonts that only the
 * Extra Packages add-on holds (bookman, charter, utopia and others) and with fonts XeTeX looks up by name. The
 * compile pipeline adds which package and data set hold a missing font file, when one does.
 */
const FONT_ENTRIES: Entry[] = [
  {
    id: 'font-file-missing',
    // pdfTeX: "pdfTeX error: (file pbkl8r.pfb): cannot open Type 1 font file for reading" (logParser.ts).
    pattern: /\(file ([^)\s]+)\): cannot open Type 1 font file/,
    help: (m) =>
      `pdfTeX could not open the font file ${m[1]}, so it wrote no PDF. The core TeX data does not hold this font. If the Extra Packages add-on has it, install the add-on and compile again; or choose a font the core holds, such as \\usepackage{lmodern} or \\usepackage{mathptmx}.`,
    markdown: (m) =>
      `pdfTeX could not open the font file ${m[1]}, so it wrote no PDF. The core TeX data does not hold this font. If the Extra Packages add-on has it, install the add-on and compile again; or choose another font in the front matter.`,
  },
  {
    id: 'font-name-not-found',
    // fontspec: "The font "X" cannot be found" (its message goes on over "(fontspec)" lines; logParser.ts joins them).
    pattern: /The font "([^"]+)" cannot be\s+found/,
    help: (m) =>
      `XeTeX could not find the font "${m[1]}" by name. This extension uses the fonts in its TeX data, not the fonts on your computer. Check the name; the Extra Packages add-on holds more fonts. Or put the font file in the project folder and load it by its file name, for example \\setmainfont{MyFont.otf}.`,
  },
];

/** The help for a TeX error message on a LaTeX or a Markdown line, or undefined when it is not one of the 20 or a font error. */
export function helpFor(message: string, kind: SourceKind = 'latex'): ErrorHelp | undefined {
  for (const entry of [...ENTRIES, ...FONT_ENTRIES]) {
    const m = entry.pattern.exec(message);
    if (m) {
      return { id: entry.id, help: kind === 'markdown' && entry.markdown ? entry.markdown(m) : entry.help(m) };
    }
  }
  return undefined;
}

/** A Markdown file's name (the converter's sources; their TeX errors arrive through the line map). */
const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn)$/i;

/** The ids of the errors that have help, in order. */
export const HELP_IDS: readonly string[] = ENTRIES.map((e) => e.id);

/** The ids of the font errors that have help. */
export const FONT_HELP_IDS: readonly string[] = FONT_ENTRIES.map((e) => e.id);

/** A diagnostic with the plain-words help for its TeX error, when it has one. */
export type HelpedDiagnostic = TexDiagnostic & { help?: ErrorHelp };

/**
 * epstopdf's note "Shell escape feature is not enabled", which every pdfLaTeX document that loads graphicx gets.
 * Shell escape is off because the extension never runs outside programs; the note matters only to an .eps figure,
 * which epstopdf would turn into PDF with Ghostscript.
 */
const SHELL_ESCAPE = /^epstopdf: Shell escape feature is not enabled/;

/** The help for that note, on a compile that has an .eps file. */
export const EPS_HELP: ErrorHelp = {
  id: 'eps-needs-pdf-copy',
  help: 'This extension never runs outside programs, so .eps figures are not turned into PDF. Put a PDF copy beside each .eps figure, with the same name, and include the figure without its extension.',
};

/**
 * Adds the help to each TeX error that has one (warnings, BibTeX and the extension's own messages get none), in
 * the wording for the file the error is shown on: a Markdown file gets Markdown advice. `projectFiles` are the
 * compile's files: without an .eps file among them, epstopdf's shell-escape note says nothing about the document
 * and is left out; with one, it gets its own help (EPS_HELP). Without `projectFiles` the note is kept, with help.
 */
export function withErrorHelp(diagnostics: readonly TexDiagnostic[], projectFiles?: readonly string[]): HelpedDiagnostic[] {
  const eps = projectFiles === undefined || projectFiles.some((f) => /\.eps$/i.test(f));
  const out: HelpedDiagnostic[] = [];
  for (const d of diagnostics) {
    if (d.source === 'TeX' && SHELL_ESCAPE.test(d.message)) {
      if (eps) {
        out.push({ ...d, help: EPS_HELP });
      }
      continue;
    }
    const help = d.source === 'TeX' && d.severity === 'error' ? helpFor(d.message, MARKDOWN.test(d.file) ? 'markdown' : 'latex') : undefined;
    out.push(help ? { ...d, help } : d);
  }
  return out;
}

/** The text the Problems panel shows: TeX's message, then the help on its own line. */
export function problemMessage(d: HelpedDiagnostic): string {
  return d.help ? `${d.message}\n${d.help.help}` : d.message;
}
