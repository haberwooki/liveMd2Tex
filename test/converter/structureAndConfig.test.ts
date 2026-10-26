// The structure extractor (it reads LaTeX, ours now and pandoc's later) and the folder config file.

import * as assert from 'node:assert/strict';
import { configFromMeta, exportFileName, metaDefaults, parseFolderConfig } from '../../src/converter/config';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { extractStructure, plainLatex } from '../../src/converter/structure';

describe('structure extractor', () => {
  it("reads pandoc-style LaTeX the way pandoc writes it", () => {
    const latex = [
      '\\section{Introduction}\\label{introduction}',
      '\\hypertarget{methods}{%',
      '\\subsection[Short]{Methods with \\emph{style}}\\label{methods}}',
      'As shown \\citep[p.~3]{a,b} and \\citet{c}; also \\citetext{see \\citealp{d}; \\citealp[ch.~2]{e}}.',
      '\\autocites[pre][post]{f}{g} and \\textcite{h}.',
      'Text.\\footnote{A note with \\cite{i}.}',
      '% \\section{Commented out} \\cite{zz}',
      '\\begin{verbatim}',
      '\\section{In verbatim}',
      '\\end{verbatim}',
      '\\[ x \\] and \\begin{equation}\\begin{aligned} y \\end{aligned}\\label{eq:y}\\end{equation}',
      'and $$ z $$ and a line break \\\\[2pt] not math.',
      '\\begin{figure}\\caption{F}\\end{figure}',
      '\\begin{table}\\caption{T}\\begin{tabular}{l}x\\end{tabular}\\end{table}',
      '\\begin{longtable}[]{@{}l@{}}x\\end{longtable}',
      'See \\ref{eq:y} and \\cref{fig:a,tbl:b}.',
    ].join('\n');
    const s = extractStructure(latex);
    assert.deepEqual(s.sections, [
      [1, 'Introduction'],
      [2, 'Methods with style'],
    ]);
    assert.deepEqual(s.citations, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    assert.equal(s.footnotes, 1);
    assert.equal(s.equations, 3);
    assert.equal(s.figures, 1);
    assert.equal(s.tables, 2);
    assert.equal(s.tableCaptions, 1);
    assert.deepEqual(s.labels, ['eq:y', 'introduction', 'methods']);
    assert.deepEqual(s.refs, ['eq:y', 'fig:a', 'tbl:b']);
  });

  it('reduces LaTeX to plain text', () => {
    assert.equal(plainLatex('A \\emph{b} \\& c\\_d ``q\'\' \\texttt{-{}-x}'), 'A b & c_d "q" --x');
  });
});

describe('folder config (.latexpreview.json)', () => {
  it('reads the converter defaults and the view switches', () => {
    const { config, problems } = parseFolderConfig(
      JSON.stringify({ markdown: { citations: 'biblatex', cref: true, classoption: '11pt', geometry: ['margin=2cm'], engine: 'XeLaTeX', template: 'notes', htmlView: true, exportName: 'build-{name}.tex' } }),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(metaDefaults(config), {
      citationPackage: 'biblatex',
      biblioStyle: undefined,
      cref: true,
      numbersections: undefined,
      documentclass: undefined,
      classoptions: ['11pt'],
      geometry: ['margin=2cm'],
      engine: 'xelatex',
      template: 'notes',
    });
    assert.equal(config.markdown.htmlView, true);
    assert.equal(exportFileName(config, 'notes.md'), 'build-notes.tex');
    assert.equal(exportFileName({ markdown: {} }, 'README.markdown'), 'README.tex');
  });

  it('writes a starting config from a document that reads back to the same settings', () => {
    const meta = convertMarkdown('---\nbiblatex: true\ncref: true\nclassoption: [11pt, twocolumn]\n---\nx').meta;
    const config = configFromMeta(meta);
    const { config: back, problems } = parseFolderConfig(JSON.stringify(config));
    assert.deepEqual(problems, []);
    assert.deepEqual(back, config);
    assert.deepEqual(metaDefaults(back), {
      citationPackage: 'biblatex',
      biblioStyle: undefined,
      cref: true,
      numbersections: true,
      documentclass: 'article',
      classoptions: ['11pt', 'twocolumn'],
      geometry: ['margin=1in'],
      engine: undefined,
      template: undefined,
    });
  });

  it('reports bad values, unknown keys and preset keys, and never fails', () => {
    const { config, problems } = parseFolderConfig(JSON.stringify({ markdown: { citations: 'csl', cref: 'yes', template: 'x', colour: 1, presetOverrides: 3, exportName: '../out.tex' } }));
    assert.deepEqual(config, { markdown: {} });
    assert.equal(problems.length, 6);
    const withPreset = parseFolderConfig(JSON.stringify({ markdown: { preset: 'p/preset.json', mode: 'paper', presetOverrides: { rules: 'rule' } } }));
    assert.deepEqual(withPreset, { config: { markdown: { preset: 'p/preset.json', mode: 'paper', presetOverrides: { rules: 'rule' } } }, problems: [] });
    assert.match(parseFolderConfig('{ not json').problems[0], /not valid JSON/);
    assert.deepEqual(parseFolderConfig('{}'), { config: { markdown: {} }, problems: [] });
  });
});
