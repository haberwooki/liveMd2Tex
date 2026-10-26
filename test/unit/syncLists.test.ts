// Click-to-source on the lists TeX makes (src/synctex/generated.ts; build gate 1 follow-up, G1S-06): a contents
// line goes to its heading, a list-of-figures line to its caption, a bibliography entry to its .bib entry.

import * as assert from 'node:assert/strict';
import { bibdataFiles, bibEntryLine, bibitemKey, bibliographyLine, contentsTitle, entryLine, sourceOfList } from '../../src/synctex/generated';

const BS = '\\';

const toc = [
  `${BS}babel@toc {english}{}`,
  `${BS}contentsline {section}{${BS}numberline {1}Setup}{1}{section.1}%`,
  `${BS}contentsline {subsection}{${BS}numberline {1.1}The ${BS}emph {minimal} model}{2}{subsection.1.1}%`,
  `${BS}contentsline {section}{Open questions}{3}{section*.2}%`,
];
const bbl = [
  `${BS}begin{thebibliography}{2}`,
  `${BS}bibitem[Callaway(1959)]{callaway1959}`,
  'J.~Callaway.',
  `${BS}newblock Model for lattice thermal conductivity.`,
  '',
  `${BS}bibitem{slack1973}`,
  'G.~A. Slack.',
  `${BS}end{thebibliography}`,
];
const bib = ['% references', '@article{callaway1959,', '  author = {Callaway, J.},', '}', '', '@Article{ Slack1973 ,', '  title = {x}', '}'];
const markdown = ['---', 'title: Notes', '---', '', '# Setup {#sec:setup}', '', 'Text.', '', '## The *minimal* model', '', '![The ratio plot.](r.png)', '', '# Open questions'];
const tex = [`${BS}documentclass{article}`, `${BS}begin{document}`, `${BS}section{Setup}`, 'Text about the setup.', `${BS}subsection*{The ${BS}emph{minimal} model}`, `${BS}section{Open questions}`];

describe('build gate 1 follow-up (G1S-06): clicks on the contents list and the bibliography', () => {
  it('reads a contents line: the title without its number, from the line or the one above', () => {
    assert.equal(contentsTitle(toc, 2), 'Setup');
    assert.equal(contentsTitle(toc, 3), `The ${BS}emph {minimal} model`);
    assert.equal(contentsTitle(toc, 4), 'Open questions');
    assert.equal(contentsTitle(toc, 1), undefined);
  });

  it('reads a bibliography entry: its key, with or without a label', () => {
    assert.equal(bibitemKey(bbl, 2), 'callaway1959');
    assert.equal(bibitemKey(bbl, 4), 'callaway1959'); // a line inside the entry
    assert.equal(bibitemKey(bbl, 7), 'slack1973');
    assert.equal(bibitemKey(bbl, 1), undefined);
  });

  it('finds the .bib files and the entry line, keys without case', () => {
    assert.deepEqual(bibdataFiles(`${BS}relax\n${BS}bibdata{refs,more.bib,paper-blx}\n`), ['refs.bib', 'more.bib']);
    assert.equal(bibEntryLine(bib, 'callaway1959'), 2);
    assert.equal(bibEntryLine(bib, 'slack1973'), 6);
    assert.equal(bibEntryLine(bib, 'absent'), undefined);
  });

  it('finds the heading or caption line that holds every word of a title', () => {
    assert.equal(entryLine(markdown, 'Setup', false), 5);
    assert.equal(entryLine(markdown, `The ${BS}emph {minimal} model`, false), 9);
    assert.equal(entryLine(markdown, 'The ratio plot.', true), 11);
    assert.equal(entryLine(markdown, 'Text', false), undefined); // not a heading
    assert.equal(entryLine(tex, 'Setup', false), 3);
    assert.equal(entryLine(tex, `The ${BS}emph {minimal} model`, false), 5);
    assert.equal(entryLine(tex, 'Open questions', false), 6);
  });

  it('maps a hit in name.toc or name.bbl to its source through the compile\'s auxiliary files', async () => {
    const aux = [
      { path: 'notes.toc', text: toc.join('\n') },
      { path: 'notes.bbl', text: bbl.join('\n') },
      { path: 'notes.aux', text: `${BS}bibdata{refs}` },
    ];
    const files: Record<string, string[]> = { 'notes.md': markdown, 'refs.bib': bib };
    const read = async (f: string) => files[f];
    assert.deepEqual(await sourceOfList({ file: 'notes.toc', line: 3 }, aux, ['notes.md'], read), { file: 'notes.md', line: 9 });
    assert.deepEqual(await sourceOfList({ file: 'notes.bbl', line: 7 }, aux, ['notes.md'], read), { file: 'refs.bib', line: 6 });
    // The bibliography's heading (above the first entry): the line that places the bibliography.
    const front = async (f: string) => (f === 'notes.md' ? ['---', 'bibliography: refs.bib', '---'] : undefined);
    assert.deepEqual(await sourceOfList({ file: 'notes.bbl', line: 1 }, aux, ['notes.md'], front), { file: 'notes.md', line: 2 });
    assert.equal(bibliographyLine(['x', `${BS}bibliography{refs}`]), 2);
    assert.equal(bibliographyLine(['::: {#refs}']), 1);
    // Without the auxiliary files (a document's first compile), or with a .bib outside the project: nothing.
    assert.equal(await sourceOfList({ file: 'notes.toc', line: 3 }, [], ['notes.md'], read), undefined);
    const outside = [aux[1], { path: 'notes.aux', text: `${BS}bibdata{../../secret}` }];
    assert.equal(await sourceOfList({ file: 'notes.bbl', line: 2 }, outside, [], async () => bib), undefined);
  });
});
