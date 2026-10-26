// Converter inputs that used to give broken LaTeX. Each case is also in the random generator
// (robustness.test.ts), and test/engine/g1Inputs.test.ts typesets them all with no TeX error.

import * as assert from 'node:assert/strict';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { balanceProblems } from './robustness.test';
import { lineMapProblems } from './support';

const codes = (md: string) => convertMarkdown(md).diagnostics.map((d) => d.code);

describe('inputs that once broke the LaTeX', () => {
  it('ends an HTML block opened in a list item, quote or callout with that container', () => {
    for (const md of [
      '- item\n\n  <div align="center">\n\n  centred\n\n- next\n\n</div>\n\nAfter.\n',
      '> <div align="center">\n>\n> centred in a quote\n\nAfter.\n',
      '> [!NOTE]\n> <div align="center">\n>\n> centred in a callout\n',
    ]) {
      const result = convertMarkdown(md);
      assert.deepEqual(balanceProblems(result.latex), [], md);
      assert.ok(result.diagnostics.some((d) => d.code === 'html-block-container'), md);
      assert.deepEqual(lineMapProblems(result.latex, result.lineMap, md), []);
    }
    // A closing tag inside a quote does not close a block opened outside it.
    const outer = '<div align="center">\n\nCentred.\n\n> quoted\n>\n> </div>\n\nStill centred.\n\n</div>\n';
    const latex = convertMarkdown(outer).latex;
    assert.deepEqual(balanceProblems(latex), []);
    assert.ok(latex.indexOf('\\end{quote}') < latex.indexOf('\\end{center}'));
    // Opened and closed in the same container: no notice.
    assert.ok(!codes('- <div align="center">\n\n  a\n\n  </div>\n').includes('html-block-container'));
  });

  it('removes control characters with a notice, and keeps its own markers apart from the input', () => {
    const controls = [1, 2, 3, 4, 7, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0xfdd0, 0xfdd1, 0xfdd3].map((c) => String.fromCharCode(c)).join('');
    const md = `First line.\n\nText${controls} with a note.[^a] And a closed---dash.\n\n[^a]: The note${controls}.\n`;
    const result = convertMarkdown(md);
    assert.deepEqual(balanceProblems(result.latex), []);
    const notice = result.diagnostics.find((d) => d.code === 'control-characters');
    assert.ok(notice, 'no notice');
    assert.match(notice.message, /^26 control character/);
    assert.deepEqual(notice.lines, [3, 5]);
    // The footnote still comes out on its own line, mapped to its definition (the emitter's markers work).
    const at = result.latex.split('\n').findIndex((l) => l.includes('The note'));
    assert.ok(at >= 0);
    assert.equal(result.lineMap[at], 5);
    assert.match(result.latex, /closed---dash/);
    assert.deepEqual(lineMapProblems(result.latex, result.lineMap, md), []);
  });

  it('flattens lists nested deeper than LaTeX allows, with a notice', () => {
    const md = '- 1\n  - 2\n    - 3\n      - 4\n        - 5\n          - 6\n';
    const result = convertMarkdown(md);
    assert.deepEqual(balanceProblems(result.latex), []);
    assert.equal(result.latex.match(/\\begin\{itemize\}/g)?.length, 4);
    assert.equal(result.latex.match(/\\item /g)?.length, 6);
    assert.ok(result.diagnostics.some((d) => d.code === 'deep-list'));
    // Four of each kind, mixed, is fine; quotes count towards LaTeX's six.
    const mixed = '- a\n  1. b\n     - c\n       1. d\n          - e\n            1. f\n';
    assert.ok(!codes(mixed).includes('deep-list'));
    assert.ok(codes('> > > - a\n> > >   - b\n> > >     - c\n> > >       - d\n').includes('deep-list'));
  });

  it('writes URLs with ~ & % # in a heading, a footnote and a caption so that hyperref reads them', () => {
    const md = [
      '# Heading [l](https://example.org/~u/a&b%20c#frag)',
      '',
      'Text.[^n]',
      '',
      '[^n]: See [p](https://example.org/~u/p?x=1&y=2%25z#top).',
      '',
      '![Caption [l](https://example.org/~c/a&b%41#c).](fig.png)',
      '',
    ].join('\n');
    const latex = convertMarkdown(md).latex;
    assert.match(latex, /\\section\{Heading \\href\{https:\/\/example\.org\/~u\/a&b\\%20c\\#frag\}\{l\}\}/);
    assert.match(latex, /\\href\{https:\/\/example\.org\/~u\/p\?x=1&y=2\\%25z\\#top\}\{p\}/);
    assert.match(latex, /\\caption\{Caption \\href\{https:\/\/example\.org\/~c\/a&b\\%41\\#c\}\{l\}\.\}/);
  });

  it('counts its passes: one for pdfLaTeX, two when XeTeX is needed', () => {
    assert.equal(convertMarkdown('Plain text, café.\n').passes, 1);
    assert.equal(convertMarkdown('Box drawing: ┌──┐\n').passes, 2);
    assert.equal(convertMarkdown('---\nengine: xelatex\n---\n\nText.\n').passes, 1);
  });

  it('notes a Windows path outside a code span', () => {
    assert.ok(codes('The file is in C:\\Users\\name\\paper.tex today.\n').includes('windows-path'));
    assert.ok(!codes('The file is in `C:\\Users\\name\\paper.tex` today.\n').includes('windows-path'));
  });
});
