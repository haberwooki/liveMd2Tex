// M2-A unit tests: the SyncTeX reader (src/synctex/parser.ts) on synthetic files in the two engines' forms, and
// the composition with the converter's line map (src/synctex/compose.ts). The engine-level checks are
// test/engine/synctex.test.ts.

import * as assert from 'node:assert/strict';
import { frontMatterRange, generatedLinesFor, generatedOfSource, mergeForward, pageForWord, refineByWord, sourceOfGenerated } from '../../src/synctex/compose';
import { forwardSearch, inverseSearch, parseSyncTex, projectRelative, tagOf } from '../../src/synctex/parser';

const IN = 4736287; // one inch in scaled points (72.27 pt)
const PT = 65536;
const BP = 65781.76;

/**
 * One page: two text lines from main.tex (lines 3 and 4 of a paragraph) and one from an included file. pdfTeX's
 * form has offsets 0 and positions that include the inch; XeTeX's has the inch in the offsets.
 */
function synctex(engine: 'pdftex' | 'xetex'): string {
  const off = engine === 'xetex' ? IN : 0;
  const h = (pt: number) => Math.round(pt * PT) - (engine === 'xetex' ? IN : 0) + (engine === 'xetex' ? 0 : 0);
  const v = h;
  return [
    'SyncTeX Version:1',
    'Input:1:/project/./main.tex',
    'Input:2:/texlive/texmf-dist/tex/latex/base/article.cls',
    'Input:3:/project/./sub/part.tex',
    `Output:${engine === 'xetex' ? 'xdv' : 'pdf'}`,
    'Magnification:1000',
    'Unit:1',
    `X Offset:${off}`,
    `Y Offset:${off}`,
    'Content:',
    '{1',
    `[1,5:${h(72.27)},${v(72.27)}:${345 * PT},${600 * PT},0`,
    // Line 1 of the paragraph: words from source lines 3 and 4.
    `(1,4:${h(100)},${v(200)}:${300 * PT},${7 * PT},${2 * PT}`,
    `g1,3:${h(130)},${v(200)}`,
    `g1,3:${h(170)},${v(200)}`,
    `g1,4:${h(230)},${v(200)}`,
    `x1,4:${h(260)},${v(200)}`,
    ')',
    // An included file's line.
    `(3,1:${h(100)},${v(230)}:${300 * PT},${7 * PT},${2 * PT}`,
    `g3,1:${h(150)},${v(230)}`,
    ')',
    ']',
    '}1',
    'Postamble:',
    '',
  ].join('\n');
}

/** PDF points from the page's top-left for a TeX position in points (TeX's origin is one inch in). */
const toBp = (pt: number) => (pt * PT) / BP;

describe('M2-A SyncTeX reader', () => {
  for (const engine of ['pdftex', 'xetex'] as const) {
    it(`reads ${engine}'s preamble offsets: the same page positions either way`, () => {
      const index = parseSyncTex(synctex(engine));
      assert.equal(index.pages.length - 1, 1);
      const box = index.pages[1].boxes.find((b) => b.tag === 1 && b.line === 4);
      assert.ok(box);
      assert.ok(Math.abs(box.left - toBp(100)) < 0.01, `${box.left}`);
      assert.ok(Math.abs(box.top - toBp(193)) < 0.01, `${box.top}`);
      assert.ok(Math.abs(box.bottom - toBp(202)) < 0.01, `${box.bottom}`);
    });
  }

  it('inverse search: the glue after the clicked word gives the line; another file by its tag', () => {
    const index = parseSyncTex(synctex('xetex'));
    const y = toBp(198);
    assert.deepEqual(inverseSearch(index, 1, toBp(120), y), { tag: 1, file: '/project/./main.tex', line: 3 });
    assert.equal(inverseSearch(index, 1, toBp(200), y)?.line, 4);
    assert.equal(inverseSearch(index, 1, toBp(120), toBp(228))?.file, '/project/./sub/part.tex');
    // Between the lines: the nearest box.
    assert.equal(inverseSearch(index, 1, toBp(120), toBp(205))?.line, 3);
    assert.equal(inverseSearch(index, 2, 10, 10), null);
  });

  it('forward search: the line boxes of a source line, and the next line with output for one without', () => {
    const index = parseSyncTex(synctex('pdftex'));
    const r = forwardSearch(index, 1, 3);
    assert.ok(r);
    assert.equal(r.page, 1);
    assert.equal(r.rects.length, 1);
    assert.equal(r.rects[0].page, 1);
    assert.ok(Math.abs(r.rects[0].top - toBp(193)) < 0.01);
    assert.equal(forwardSearch(index, 1, 2)?.line, 3); // nothing on line 2: the next line with output
    assert.equal(forwardSearch(index, 3, 1)?.rects.length, 1);
    assert.equal(forwardSearch(index, 9, 1), null);
  });

  it('names project files relative to the project folder', () => {
    const index = parseSyncTex(synctex('pdftex'));
    assert.equal(projectRelative('/project/./sub/part.tex'), 'sub/part.tex');
    assert.equal(projectRelative('/project/docs/../main.tex'), 'main.tex');
    assert.equal(projectRelative('/texlive/texmf-dist/tex/latex/base/article.cls'), undefined);
    assert.equal(tagOf(index, 'sub/part.tex'), 3);
  });
});

describe('M2-A SyncTeX composed with the line map', () => {
  // Generated lines: 1-3 preamble (Markdown line 1, the title key 2), 4 \begin{document}, 5 \maketitle (2),
  // 6 blank, 7-8 a paragraph (Markdown 6-7), 9 "" (8), 10 a heading (9), 11 \end{document}.
  const lineMap = [1, 2, 1, 1, 2, 1, 6, 7, 8, 9, 9];
  const latexLines = ['\\documentclass{article}', '\\title{T}', '', '\\begin{document}', '\\maketitle\\relax', '', 'First line', 'second line', '', '\\section{H}', '\\end{document}'];
  const markdownLines = ['---', 'title: T', 'author:', '  - Ann', '---', 'First line', 'second line', 'continued', '# H'];
  const origin = { main: 'notes.tex', markdown: 'notes.md', lineMap, bodyStartLine: 7, latexLines, markdownLines };

  it('maps generated lines to Markdown lines, and an appendix to its own file', () => {
    assert.deepEqual(sourceOfGenerated(origin, 'notes.tex', 8), { file: 'notes.md', line: 7 });
    assert.deepEqual(sourceOfGenerated(origin, 'other.tex', 3), { file: 'other.tex', line: 3 });
    const withAppendix = { ...origin, appendix: { file: 'methods.md', map: [0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0] } };
    assert.deepEqual(sourceOfGenerated(withAppendix, 'notes.tex', 10), { file: 'methods.md', line: 4 });
    assert.deepEqual(generatedOfSource(withAppendix, 'methods.md', 4), [{ file: 'notes.tex', line: 10 }]);
  });

  it('finds the generated lines of a Markdown line: own, front matter key, continued construct, next', () => {
    assert.deepEqual(generatedLinesFor(lineMap, 7, 6, latexLines, markdownLines), [7]);
    assert.deepEqual(generatedLinesFor(lineMap, 7, 2, latexLines, markdownLines), [2, 5]); // the title key
    assert.deepEqual(generatedLinesFor(lineMap, 7, 4, latexLines, markdownLines), [2, 5]); // inside the front matter
    assert.deepEqual(generatedLinesFor(lineMap, 7, 8, latexLines, markdownLines), [8]); // continues line 7's construct
    assert.deepEqual(generatedLinesFor(lineMap, 7, 8, latexLines, ['', '', '', '', '', '', '', '', '']), [10, 11]); // blank: the next line's
  });

  it('refines a line by the clicked word: earlier lines first, the whole front matter for the title block', () => {
    const lines = ['alpha', 'beta gamma', 'delta', 'epsilon', 'zeta'];
    assert.equal(refineByWord(lines, 4, 'gamma'), 2);
    assert.equal(refineByWord(lines, 4, 'epsilon'), 4);
    assert.equal(refineByWord(lines, 4, 'absent'), 4);
    assert.equal(refineByWord(lines, 2, 'gam'), 2); // a part of a word does not count
    assert.equal(refineByWord(markdownLines, 2, 'Ann', { within: frontMatterRange(markdownLines) }), 4);
    assert.deepEqual(frontMatterRange(markdownLines), { first: 1, last: 5 });
  });

  it('refines by the clicked typeset line: a code line, an affiliation, a symbol (build gate 1, G1S-06)', () => {
    // A code block: TeX gives every line of it the closing fence.
    const code = ['Text before.', '```python', 'def conductivity(P, L, A, dT):', '    """k = P L / (A dT), all in SI units."""', '    return P * L / (A * dT)', 'print([conductivity(P, 0.012, dT) for P, dT in runs])', '```'];
    const docLine = '"""k = P L / (A dT), all in SI units."""';
    assert.equal(refineByWord(code, 7, 'in', { context: docLine }), 4); // not line 6, the nearest that holds "in"
    assert.equal(refineByWord(code, 7, undefined, { context: docLine }), 4); // a click on "/"
    assert.equal(refineByWord(code, 7, 'k', { context: docLine }), 4);
    // Too little in common: SyncTeX's line, or the nearest line with the word.
    assert.equal(refineByWord(code, 7, undefined, { context: 'alpha beta dT' }), 7);
    assert.equal(refineByWord(code, 7, 'runs', { context: 'unrelated words here runs' }), 6);
    // SyncTeX's line holds the word: it stands.
    assert.equal(refineByWord(code, 6, 'dT', { context: docLine }), 6);
    // The title block: the affiliation's own line, not the nearest line with "Example".
    const front = ['---', 'title: A paper', 'author:', '  - name: A. Author', '    affiliation: Example University', '  - name: B. Author', '    affiliation: Institute for Materials, Example City', '---'];
    const within = frontMatterRange(front);
    assert.equal(refineByWord(front, 2, 'Example', { within, context: 'Institute for Materials, Example City' }), 7);
    assert.equal(refineByWord(front, 2, 'Example', { within }), 5);
  });

  it('merges several lines\' results by the first with text, and picks the page that holds the cursor\'s word', () => {
    const rect = (page: number, top: number, height = 8) => ({ page, left: 72, top, width: 300, height });
    const merged = mergeForward([
      { page: 2, rects: [rect(2, 100)], line: 10 },
      { page: 1, rects: [rect(1, 40, 0.5), rect(2, 112)], line: 11 },
    ]);
    assert.ok(merged);
    assert.equal(merged.page, 2);
    assert.deepEqual(merged.rects.map((r) => [r.page, r.top]), [[2, 100], [2, 112]]);
    const spanning = { page: 3, rects: [rect(3, 700), rect(4, 72)], line: 5 };
    assert.equal(pageForWord(spanning, (r) => r.page === 4), 4);
    assert.equal(pageForWord(spanning, undefined), 3);
  });
});
