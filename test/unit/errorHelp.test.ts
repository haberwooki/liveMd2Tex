// Plain-words help for TeX errors (src/extension/diagnostics/errorHelp.ts): the matcher on messages as the log
// parser gives them, including the variants the engine fixtures do not make (an image or an \input file not found,
// a subscript, a character the log prints as itself). The engine test (test/engine/errorHelp.test.ts) makes each
// of the 20 errors happen.

import * as assert from 'node:assert/strict';
import { FONT_HELP_IDS, helpFor, HELP_IDS, problemMessage, withErrorHelp } from '../../src/extension/diagnostics/errorHelp';
import { parseTexLog } from '../../src/extension/diagnostics/logParser';

describe('plain-words help for TeX errors', () => {
  it('has twenty errors, each with its own id', () => {
    assert.equal(HELP_IDS.length, 20);
    assert.equal(new Set(HELP_IDS).size, 20);
  });

  it('names what the message names', () => {
    assert.match(helpFor('Undefined control sequence. (at: Some text \\foo)')?.help ?? '', /the command \\foo\b/);
    assert.match(helpFor('LaTeX Error: File `siunitx.sty\' not found.')?.help ?? '', /package or class siunitx\.sty/);
    assert.match(helpFor("Package pdftex.def Error: File `figs/plot.png' not found: using draft setting.")?.help ?? '', /\\includegraphics/);
    assert.match(helpFor("LaTeX Error: File `chapter1.tex' not found.")?.help ?? '', /\\input/);
    assert.match(helpFor('LaTeX Error: Environment algin undefined.')?.help ?? '', /\\begin\{algin\}/);
    assert.match(helpFor('LaTeX Error: \\begin{itemize} on input line 12 ended by \\end{enumerate}.')?.help ?? '', /line 12 is closed by \\end\{enumerate\}/);
    assert.match(helpFor('Paragraph ended before \\textbf was complete.')?.help ?? '', /argument of \\textbf/);
    assert.match(helpFor('Double subscript. (at: $x_a_')?.help ?? '', /x_\{ab\}/);
    assert.match(helpFor('LaTeX Error: Unicode character ≠ (U+2260) not set up for use with LaTeX.')?.help ?? '', /character ≠ \(U\+2260\)/);
    assert.match(helpFor('LaTeX Error: Unicode character ^^e2^^89^^a0 (U+2260)')?.help ?? '', /character U\+2260 here/);
  });

  it('gives no help for messages it does not know, and no help for warnings', () => {
    assert.equal(helpFor('Something unusual happened.'), undefined);
    assert.equal(helpFor('Citation `x\' on page 1 undefined on input line 3.'), undefined);
  });

  it('adds the help to TeX errors only, and shows it on its own line after the message', () => {
    const message = 'Undefined control sequence. (at: A \\foo)';
    const [error, warning, bibtex, own] = withErrorHelp([
      { file: 'main.tex', line: 3, severity: 'error', message, source: 'TeX' },
      { file: 'main.tex', line: 3, severity: 'warning', message, source: 'TeX' },
      { file: 'main.tex', line: 3, severity: 'error', message, source: 'BibTeX' },
      { file: 'main.tex', line: 3, severity: 'error', message, source: 'liveMd2Tex' },
    ]);
    assert.equal(error.help?.id, 'undefined-command');
    assert.deepEqual([warning.help, bibtex.help, own.help], [undefined, undefined, undefined]);
    assert.equal(problemMessage(error), `${message}\n${error.help?.help ?? ''}`);
    assert.match(problemMessage(error), /\n.*\\foo/);
    assert.equal(problemMessage(warning), message);
  });

  it('names the command TeX did not know when it sits inside a macro or an argument', () => {
    // The log parser keeps the first context line as "(in: ...)" when it is not the l.N line.
    const inMacro = 'Undefined control sequence. (in: \\mymacro ->Some text \\foo) (at: \\mymacro)';
    assert.match(helpFor(inMacro)?.help ?? '', /the command \\foo\./);
    const inArgument = 'Undefined control sequence. (in: <argument> A \\foo) (at: \\section{A \\foo{} and \\ref{x}})';
    assert.match(helpFor(inArgument)?.help ?? '', /the command \\foo\./);
    assert.match(helpFor('File ended while scanning use of \\textbf.')?.help ?? '', /argument of \\textbf: /);
  });

  it('the log parser keeps the first context line of an undefined command when it is not the l.N line', () => {
    const log = [
      './main.tex:4: Undefined control sequence.',
      '\\mymacro ->Some text \\foo ',
      '                          ',
      'l.4 \\mymacro',
      '',
      './main.tex:6: Undefined control sequence.',
      'l.6 Plain \\bar',
      '',
    ].join('\n');
    const [inMacro, plain] = parseTexLog(log, 'main.tex');
    assert.equal(inMacro.message, 'Undefined control sequence. (in: \\mymacro ->Some text \\foo) (at: \\mymacro)');
    assert.equal(plain.message, 'Undefined control sequence. (at: Plain \\bar)');
    assert.match(helpFor(inMacro.message)?.help ?? '', /the command \\foo\./);
    assert.match(helpFor(plain.message)?.help ?? '', /the command \\bar\./);
  });

  it('speaks of Markdown on a Markdown line: no LaTeX-only advice there', () => {
    const unicode = 'LaTeX Error: Unicode character ^^e2^^8c^^98 (U+2318)';
    assert.match(helpFor(unicode)?.help ?? '', /% !TEX program = xelatex/);
    assert.match(helpFor(unicode, 'markdown')?.help ?? '', /engine: xelatex" to the front matter/);
    assert.doesNotMatch(helpFor(unicode, 'markdown')?.help ?? '', /!TEX/);
    assert.doesNotMatch(helpFor('Missing $ inserted.', 'markdown')?.help ?? '', /\\_/);
    assert.match(helpFor('LaTeX Error: Can be used only in preamble. (at: \\usepackage{amsmath})', 'markdown')?.help ?? '', /header-includes/);
    // withErrorHelp picks the wording by the file the error is shown on.
    const message = 'Missing $ inserted.';
    const [onMarkdown, onTex] = withErrorHelp([
      { file: 'notes.md', line: 4, severity: 'error', message, source: 'TeX' },
      { file: 'notes.tex', line: 4, severity: 'error', message, source: 'TeX' },
    ]);
    assert.equal(onMarkdown.help?.help, helpFor(message, 'markdown')?.help);
    assert.equal(onTex.help?.help, helpFor(message)?.help);
    assert.notEqual(onMarkdown.help?.help, onTex.help?.help);
  });

  it("leaves out epstopdf's shell-escape note without an .eps file, and explains it with one", () => {
    const note = { file: 'main.tex', line: 0, severity: 'warning' as const, message: 'epstopdf: Shell escape feature is not enabled.', source: 'TeX' as const };
    assert.deepEqual(withErrorHelp([note], ['main.tex', 'references.bib', 'figs/plot.pdf']), []);
    const [kept] = withErrorHelp([note], ['main.tex', 'figs/plot.EPS']);
    assert.equal(kept.help?.id, 'eps-needs-pdf-copy');
    assert.match(problemMessage(kept), /\nThis extension never runs outside programs/);
    // Without the compile's file list the note is kept, with its help.
    assert.equal(withErrorHelp([note])[0].help?.id, 'eps-needs-pdf-copy');
    // A failed conversion of an .eps figure names the figure and the fix.
    const missed = helpFor("Package pdftex.def Error: File `figs/plot-eps-converted-to.pdf' not found: using draft setting.");
    assert.match(missed?.help ?? '', /The \.eps figure figs\/plot\.eps was not turned into PDF/);
    assert.match(helpFor("Package pdftex.def Error: File `plot-eps-converted-to.pdf' not found: using draft setting.", 'markdown')?.help ?? '', /the converter then uses the PDF/);
  });

  it('explains a font the TeX data does not hold: a Type 1 file pdfTeX cannot open, a font XeTeX cannot find by name', () => {
    assert.deepEqual(FONT_HELP_IDS, ['font-file-missing', 'font-name-not-found']);
    // The messages as the engine prints them (a probe on the extension's engine, 2026-10-22), through the log parser.
    const log = [
      '(./main.tex',
      '!pdfTeX error: /bin/busytex (file pbkl8r.pfb): cannot open Type 1 font file for reading',
      ' ==> Fatal error occurred, no output PDF file produced!',
      './main.tex:3: Package fontspec Error: ',
      '(fontspec)                The font "Fira Sans" cannot be found; this',
      '(fontspec)                may be but usually is not a fontspec bug.',
      '',
    ].join('\n');
    const [type1, byName] = parseTexLog(log, 'main.tex');
    assert.deepEqual([type1.severity, type1.message], ['error', 'pdfTeX error: (file pbkl8r.pfb): cannot open Type 1 font file for reading']);
    assert.equal(byName.line, 3);
    assert.match(byName.message, /^Package fontspec Error: The font "Fira Sans" cannot be found; this may be but usually is not a fontspec bug\.$/);
    const [h1, h2] = withErrorHelp([type1, byName]);
    assert.equal(h1.help?.id, 'font-file-missing');
    assert.match(h1.help?.help ?? '', /could not open the font file pbkl8r\.pfb, so it wrote no PDF\. .*Extra Packages add-on.*\\usepackage\{lmodern\}/);
    assert.equal(h2.help?.id, 'font-name-not-found');
    assert.match(h2.help?.help ?? '', /could not find the font "Fira Sans" by name\. .*not the fonts on your computer.*Extra Packages add-on/);
    assert.doesNotMatch(helpFor(type1.message, 'markdown')?.help ?? '', /\\usepackage/);
  });

  it('stays quick on a long message (it reads text from the document)', () => {
    const long = `Undefined control sequence. (at: ${'x'.repeat(100000)}`;
    const t0 = performance.now();
    for (const m of [long, `Environment ${'a'.repeat(100000)}`, `Unicode character ${'b'.repeat(100000)}`]) {
      helpFor(m);
    }
    assert.ok(performance.now() - t0 < 200);
  });
});
