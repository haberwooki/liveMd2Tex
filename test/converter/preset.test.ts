// The example preset (examples/presets/two-column-paper; docs/DESIGN.md#presets) on public CC0 stand-in
// documents that exercise every rule, with expectations written by hand. Its settings are neutral: plain figure
// sizes, no table resizing; the tests also set the options that change them (figures.graphics, tables.wrap).

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { applyAllowList, latexTokens, normalisedDiff } from '../../src/converter/compare';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { modeForFile, parsePresetFile, resolveMode } from '../../src/converter/preset/load';
import { defaultMode } from '../../src/converter/preset/types';
import { authorYearKey } from '../../src/converter/rules/inline';
import { examplePreset, lineMapProblems, testDir } from './support';

const fixture = (name: string) => readFileSync(path.join(testDir, 'preset', name), 'utf8');
const { preset, files } = examplePreset();
const overrides = {};

function convert(name: string, mode: string, extra: { appendix?: string; overrides?: Record<string, unknown> } = {}) {
  const resolved = resolveMode(preset, mode, files, extra.overrides);
  assert.deepEqual(resolved.problems, []);
  const markdown = fixture(name);
  const result = convertMarkdown(markdown, { preset: resolved.mode, appendix: extra.appendix });
  assert.deepEqual(lineMapProblems(result.latex, result.lineMap, markdown), [], `${name}: line map`);
  return result;
}

function has(latex: string, lines: string[]): void {
  const all = latex.split('\n').map((l) => l.trim());
  for (const line of lines) {
    assert.ok(all.includes(line), `missing line: ${line}`);
  }
}

describe('preset: loading and modes', () => {
  it('loads the example preset with every mode resolving cleanly', () => {
    for (const mode of Object.keys(preset.modes)) {
      assert.deepEqual(resolveMode(preset, mode, files).problems, [], mode);
    }
    assert.deepEqual(Object.keys(preset.modes), ['paper', 'supplement', 'letter', 'response', 'report']);
  });

  it('merges defaults, the mode and overrides key by key, and reports what it does not know', () => {
    const r = resolveMode({ name: 't', defaults: { emphasis: 'textit', colour: 'red' }, modes: { m: { escape: { tilde: 'sim' }, rules: 'drop', headings: { commands: { '7': 'x' } } } } }, 'm', {}, { rules: 'rule', figures: { wide: ['w'] } });
    assert.equal(r.mode.emphasis, 'textit');
    assert.equal(r.mode.escape.tilde, 'sim');
    assert.equal(r.mode.escape.braces, true, 'untouched defaults stay');
    assert.equal(r.mode.rules, 'rule', 'overrides come last');
    assert.deepEqual(r.mode.figures.wide, ['w']);
    assert.equal(r.mode.headings.commands['7'], 'x');
    assert.deepEqual(r.problems, ['"colour" is not a preset option; it was ignored.']);
    assert.match(resolveMode(preset, 'nope').problems[0], /no mode "nope"/);
    assert.match(parsePresetFile('{"name": 1}').problems[0], /needs a "name"/);
  });

  it('picks the mode by file name', () => {
    assert.equal(modeForFile(preset, 'paper.md'), 'paper');
    assert.equal(modeForFile(preset, 'paper-v2.md'), 'paper');
    assert.equal(modeForFile(preset, 'supplement-2.md'), 'supplement');
    assert.equal(modeForFile(preset, 'manuscript.md'), undefined);
    assert.equal(modeForFile(preset, 'cover-letter.md'), 'letter');
    assert.equal(modeForFile(preset, 'response_round2.md'), 'response');
    assert.equal(modeForFile(preset, 'notes.md'), undefined);
  });

  it('turns author-year citations into keys by the surname-and-year rule', () => {
    assert.equal(authorYearKey('Smith 2020'), 'smith2020');
    assert.equal(authorYearKey(' Barroso-Luque\n2024b'), 'barrosoluque2024b');
    assert.equal(authorYearKey('St. John 2019'), 'john2019');
  });

  it('leaves the general dialect exactly as it was when no preset is in force', () => {
    const md = readFileSync(path.join(testDir, 'corpus', 'P10-paper.md'), 'utf8');
    assert.equal(convertMarkdown(md, { preset: defaultMode() }).latex, convertMarkdown(md).latex);
  });
});

describe('preset: the paper mode', () => {
  const result = convert('manuscript.md', 'paper', { appendix: fixture('methods.md'), overrides });
  const latex = result.latex;

  it('uses the preamble template and the two-column banner from the bold-label front matter', () => {
    assert.match(latex, /\\documentclass\[twocolumn,10pt\]\{article\}/);
    has(latex, [
      '\\twocolumn[{%',
      '{\\LARGE\\bfseries Do layered crystals conduct heat?\\\\[2pt] A stand-in study of anisotropy}\\\\[0.7em]',
      '{\\large Ada Example and Ben Sample}\\\\[0.4em]{\\footnotesize Department of Physics, Example University}\\\\[0.3em]{\\footnotesize Correspondence: Ada Example (ada@example.org)}',
      '\\begin{minipage}{\\textwidth}\\small\\noindent\\textbf{Abstract.} We measure the in-plane and cross-plane conductivity of a layered crystal and find a ratio near $\\sim$100 \\cite{slack1973}.\\end{minipage}\\vspace{1.6em}',
      '}]',
    ]);
    assert.doesNotMatch(latex, /Drafting notes before the body|Working title|Manuscript draft/);
  });

  it('writes the body by the preset rules', () => {
    has(latex, [
      '\\section{Introduction}',
      'Layered crystals conduct heat well along their layers \\cite{callaway1959,ziman1960} and poorly across them---%',
      // The citation wraps across a line break in the Markdown, so the break stays in it (the line map).
      'a contrast that the relaxation-time model explains \\cite{minnich2015%',
      '}. The ratio \\textbar{}$\\kappa$\\textbar{} exceeds 10\\textsuperscript{2}, and $\\Delta$T stays below 5 K.',
      'The code lives in \\texttt{scripts/\\allowbreak fit\\_\\allowbreak kappa.\\allowbreak py}, and the tilt is 30$^\\circ$ at most.',
      'We write the model as $\\kappa = C v \\ell / 3$, \\textit{the kinetic formula}, and ``quote\'\' it.\\footnote{%',
      'The heat capacity $C$ is per unit volume.}',
      '\\section{Measurements}',
      '\\section{Conclusion}',
    ]);
    assert.doesNotMatch(latex, /\\label\{/, 'no heading labels in this mode');
    assert.doesNotMatch(latex, /TODO:|2019 data|Note to coauthors|drafting notes and are removed/, 'notes are off');
  });

  it('builds the captioned table, with its note, and the uncaptioned one', () => {
    has(latex, [
      '\\begin{table*}[tbp]\\centering',
      '\\footnotesize',
      '\\caption{Conductivity of three samples. The \\textbf{Ratio} column is in-plane over cross-plane.}',
      '\\begin{tabularx}{\\textwidth}{l r r r X}',
      'Sample & In-plane & Cross-plane & Ratio & Comment \\\\',
      'A & 150 & 1.5 & 100 & grown along the layers, as described in the methods \\\\',
      '\\vspace{3pt}',
      '\\noindent\\begin{minipage}{\\textwidth}\\footnotesize Units: W m\\textsuperscript{--}\\textsuperscript{1} K\\textsuperscript{--}\\textsuperscript{1}; ratios rounded.\\end{minipage}',
      '\\begin{tabular}{r r}',
      '\\caption{}',
    ]);
  });

  it('lays out figures by file stem, captioned by the following "Figure N." paragraph', () => {
    has(latex, [
      '\\begin{figure}[!tb]\\centering',
      '\\includegraphics[width=\\linewidth]{figs/fig_single.png}',
      '\\caption{The ratio against temperature, for both samples.}',
      '\\begin{figure*}[!tb]\\centering',
      '\\includegraphics[width=\\textwidth]{figs/wide_figure.png}',
      '\\begin{minipage}[c]{0.6\\textwidth}\\centering',
      '\\includegraphics[width=\\linewidth]{figs/side_figure.png}',
      '\\begin{minipage}[c]{0.37\\textwidth}',
      '\\caption{A wide figure with its caption beside it.}',
    ]);
    assert.doesNotMatch(latex, /Figure 1\./, 'the label goes; LaTeX numbers the figure');
  });

  it('takes figure sizes and side-caption widths from the preset (figures.graphics, figures.sideCaptionWidths)', () => {
    const sized = convert('manuscript.md', 'paper', {
      appendix: fixture('methods.md'),
      overrides: { figures: { graphics: { single: 'width=\\linewidth,height=0.8\\textheight,keepaspectratio' }, sideCaptionWidths: [0.5, 0.45] } },
    }).latex;
    has(sized, [
      '\\includegraphics[width=\\linewidth,height=0.8\\textheight,keepaspectratio]{figs/fig_single.png}',
      '\\includegraphics[width=\\textwidth]{figs/wide_figure.png}', // the other layouts keep theirs
      '\\begin{minipage}[c]{0.5\\textwidth}\\centering',
      '\\begin{minipage}[c]{0.45\\textwidth}',
    ]);
  });

  it('ends with the bibliography and the Methods appendix from the second file', () => {
    const tail = latex.slice(latex.indexOf('\\bibliographystyle'));
    assert.equal(
      tail,
      [
        '\\bibliographystyle{plainnat}',
        '\\bibliography{references}',
        '',
        '\\clearpage',
        '\\section*{Methods}',
        'The procedure in the order it runs.',
        '',
        '\\subsection*{A. Samples}',
        '',
        'Crystals were grown from the melt \\cite{bridgman1925}.',
        '',
        '\\subsection*{B. Measurement}',
        '',
        'A steady-state method with \\texttt{run\\_\\allowbreak all.\\allowbreak sh}.',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    // In the order converted: the body, then the front matter (the abstract), then the appendix.
    assert.deepEqual(result.citationKeys, ['callaway1959', 'ziman1960', 'minnich2015', 'slack1973', 'bridgman1925']);
  });

  it('shows drafting notes as margin notes when the folder asks', () => {
    const shown = convert('manuscript.md', 'paper', { appendix: fixture('methods.md'), overrides: { ...overrides, notes: { show: true } } }).latex;
    assert.match(shown, /below 5 K\.\\mdnote\{check this number against the 2019 data\}/);
    assert.match(shown, /\\begin\{mdnoteblock\}/);
    assert.match(shown, /These lines are drafting notes and are removed\./);
    assert.match(shown, /\\newcommand\*\\mdnote\[1\]/);
  });

  it('matches only a note marker with its leading space: "Note:" and "MYTODO:" are text', () => {
    const resolved = resolveMode(preset, 'paper', files).mode;
    const r = convertMarkdown('## 1. A\n\nNote: stays. A MYTODO: value stays. Cut TODO: here', { preset: resolved }).latex;
    assert.match(r, /Note: stays\. A MYTODO: value stays\. Cut\n/);
  });

  it('has no built-in note marker: notes are only what a preset names', () => {
    assert.deepEqual(defaultMode().notes, { show: false, inlineMarker: '', blockquotePrefixes: [], sections: [] });
    const r = convertMarkdown('## 1. A\n\nKept TODO: here.\n\n> Drafting note: kept too.\n', {}).latex;
    assert.match(r, /Kept TODO: here\./);
    assert.match(r, /Drafting note: kept too\./);
  });
});

describe('preset: the other modes', () => {
  it('letter: no title, draft headings dropped, line breaks kept in blocks with two-space endings', () => {
    const latex = convert('letter.md', 'letter').latex;
    assert.match(latex, /\\documentclass\[11pt\]\{article\}[\s\S]*\\pagestyle\{empty\}\n\\begin\{document\}/);
    has(latex, [
      'Dear Editor,',
      'We submit our manuscript on heat transport in layered crystals---%',
      'Suggested referees:\\\\',
      'Carla Reviewer, Example Institute\\\\',
      'Dan Critic, Sample University',
      'Sincerely,\\\\',
      'Ada Example',
    ]);
    assert.doesNotMatch(latex, /draft label|\\section|\\bibliography/);
  });

  it('response: starred headings, small quotes, lists, citations as plain text', () => {
    const latex = convert('response.md', 'response').latex;
    has(latex, [
      '\\section*{Response to the referees}',
      '\\subsection*{Referee 1}',
      '\\begin{quote}\\small',
      'The authors should compare with earlier work',
      'We added the comparison (Casimir 1938; Ziman 1960) in Section 3.',
      '\\begin{itemize}',
      '\\item The new figure shows the size effect.',
      'Sincerely,\\\\',
    ]);
    assert.match(latex, /\\pagestyle\{plain\}/);
    assert.doesNotMatch(latex, /\\cite\{/);
  });

  it('supplement: a heading title, tables kept in place', () => {
    const latex = convert('supplement.md', 'supplement').latex;
    has(latex, [
      '\\begin{center}{\\LARGE\\bfseries Supplementary Material}\\end{center}\\vspace{1em}',
      '\\section{Supplementary methods}',
      '\\subsection{Extra data}',
      '\\begin{table}[H]\\centering',
      '\\caption{Raw readings.}',
      '\\begin{tabular}{r r}',
      '\\end{tabular}',
      '\\end{table}',
      '\\subsubsection{Details}',
      'The readings repeat within 5\\%.',
    ]);
    assert.match(latex, /\\renewcommand\{\\thetable\}\{S\\arabic\{table\}\}/);
    assert.doesNotMatch(latex, /Editorial note/);
    assert.doesNotMatch(latex, /resizebox/, 'no table resizing unless the preset asks');
  });

  it('supplement: a preset can wrap in-place tables (tables.wrap), e.g. to fit them to the line', () => {
    const wrap = ['\\resizebox{\\linewidth}{!}{', '}'];
    const latex = convert('supplement.md', 'supplement', { overrides: { tables: { wrap } } }).latex;
    has(latex, ['\\resizebox{\\linewidth}{!}{\\begin{tabular}{r r}', '\\end{tabular}}']);
  });

  it('report: XeTeX, the title block, kept Unicode, author-numbered captions, list options, no math', () => {
    const r = convert('annual-review.md', 'report');
    assert.equal(r.engine, 'xelatex');
    has(r.latex, [
      '\\title{Heat Transport — A Year in Review}',
      '\\author{Ada Example, Example University}',
      '\\date{Draft of 2026-10-15}',
      '\\maketitle',
      '\\section*{Executive summary}',
      "This stand-in document (written for this project's tests, CC0 1.0) costs \\$5 and uses 100\\% of the budget —",
      'with "plain quotes" and a \\href{https://example.org/page\\#top}{project page}.',
      '\\section{Results}',
      '\\begin{enumerate}[leftmargin=*]',
      '\\item The ratio is about \\textasciitilde{}100.',
      '\\item The fit uses \\texttt{fit\\_kappa.py}.',
      '\\begin{figure}[htbp]',
      '\\includegraphics[width=\\linewidth]{figures/ratio.png}',
      "\\caption{\\textbf{Figure 1.} The ratio against temperature; the author's own number stays.}",
      '\\subsection*{What comes next}',
      'A third sample, with $\\alpha$ $\\approx$ 0.3 and x\\textsuperscript{2} terms.',
    ]);
  });
});

describe('normalised diff', () => {
  it('ignores comments, whitespace and line wrapping, and finds each differing stretch', () => {
    assert.deepEqual(latexTokens('\\textbf{a}  b % comment\n50\\% c'), ['\\textbf', '{', 'a', '}', 'b', '50', '\\%', 'c']);
    assert.deepEqual(normalisedDiff('A long\nparagraph here. % note\n\\section{X}', 'A long paragraph here.\n\n\\section{X}'), []);
    const hunks = normalisedDiff('one two three four five six', 'one two 3 four five six seven');
    assert.deepEqual(hunks.map((h) => [h.reference, h.ours]), [['three', '3'], ['', 'seven']]);
  });

  it('applies an allow-list and reports entries that match nothing', () => {
    const hunks = normalisedDiff('a b c', 'a x c');
    const allow = [
      { reference: 'b', ours: 'x', reason: 'intended' },
      { reference: 'q', ours: 'r', reason: 'stale' },
    ];
    const { unexplained, stale } = applyAllowList(hunks, allow);
    assert.deepEqual(unexplained, []);
    assert.deepEqual(stale.map((s) => s.reason), ['stale']);
  });
});
