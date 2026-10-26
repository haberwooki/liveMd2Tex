// The raw_tex rule (docs/DESIGN.md#converter): a backslash and letters with balanced [..] and
// {..} arguments passes through unescaped wherever it stands in a line; \begin...\end too; only lone special
// characters are escaped. The fixture pair is hand-written: raw-tex-inline.md and its expected LaTeX body.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { scanRawTexCommand } from '../../src/converter/rules/inline';
import { lineMapProblems, testDir } from './support';

function body(latex: string, bodyStartLine: number): string {
  const lines = latex.split('\n').slice(bodyStartLine - 1);
  const end = lines.lastIndexOf('\\end{document}');
  return `${lines.slice(0, end).join('\n').replace(/\s+$/, '')}\n`;
}

describe('raw TeX passthrough (pandoc raw_tex)', () => {
  it('passes inline \\ref, \\cite, \\SI and \\textbf through, and escapes only lone specials (fixture)', () => {
    const markdown = readFileSync(path.join(testDir, 'fixtures', 'raw-tex-inline.md'), 'utf8');
    const want = readFileSync(path.join(testDir, 'fixtures', 'raw-tex-inline.expected.tex'), 'utf8').replace(/\r\n/g, '\n');
    const result = convertMarkdown(markdown);
    assert.equal(body(result.latex, result.bodyStartLine), want);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(lineMapProblems(result.latex, result.lineMap, markdown), []);
  });

  it('maps each fixture line to the same Markdown line', () => {
    const markdown = readFileSync(path.join(testDir, 'fixtures', 'raw-tex-inline.md'), 'utf8');
    const result = convertMarkdown(markdown);
    const source = markdown.split('\n');
    const latex = result.latex.split('\n');
    for (let i = result.bodyStartLine - 1; i < latex.length; i++) {
      const line = latex[i];
      if (line.startsWith('As shown') || line.startsWith('The sample') || line.startsWith('braces too')) {
        const mdLine = source[result.lineMap[i] - 1];
        assert.equal(mdLine.slice(0, 8), line.slice(0, 8), `LaTeX line ${i + 1}`);
      }
    }
  });

  it('scans a command with its arguments, and nothing more', () => {
    const cases: [string, string][] = [
      ['\\ref{a} b', '\\ref{a}'],
      ['\\SI{3}{\\metre}.', '\\SI{3}{\\metre}'],
      ['\\SI[x=y]{3}{m} z', '\\SI[x=y]{3}{m}'],
      ['\\section*{T} x', '\\section*{T}'],
      ['\\textbf{a {b} c}!', '\\textbf{a {b} c}'],
      ['\\LaTeX\\ is', '\\LaTeX'],
      ['\\foo {x}', '\\foo'],
      ['\\begin{env}a \\begin{env}b\\end{env} c\\end{env} tail', '\\begin{env}a \\begin{env}b\\end{env} c\\end{env}'],
    ];
    for (const [src, want] of cases) {
      const end = scanRawTexCommand(src, 0);
      assert.equal(src.slice(0, end), want, src);
    }
    assert.equal(scanRawTexCommand('\\begin{env} never closed', 0), -1);
    assert.equal(scanRawTexCommand('\\end{env} alone', 0), -1);
    assert.equal(scanRawTexCommand('\\1', 0), -1);
    assert.equal(scanRawTexCommand('\\$', 0), -1);
  });

  it('keeps raw LaTeX environments as blocks, blank lines inside included', () => {
    const md = 'Text.\n\n\\begin{align}\n  a &= b \\\\\n\n  c &= d\n\\end{align}\n\nMore.';
    const { latex, lineMap } = convertMarkdown(md);
    assert.match(latex, /\\begin\{align\}\n {2}a &= b \\\\\n\n {2}c &= d\n\\end\{align\}/);
    const at = latex.split('\n').indexOf('\\begin{align}');
    assert.deepEqual(lineMap.slice(at, at + 5), [3, 4, 5, 6, 7]);
  });

  it('shows a \\begin or \\end without its partner as text, with a notice, so the document still compiles', () => {
    const r = convertMarkdown('Text \\begin{center} alone.\n\nAnd \\end{align} alone.');
    assert.match(r.latex, /Text \\textbackslash\{\}begin\\\{center\\\} alone\./);
    assert.match(r.latex, /And \\textbackslash\{\}end\\\{align\\\} alone\./);
    assert.deepEqual(r.diagnostics.map((d) => [d.kind, d.code, d.lines]), [['notice', 'unmatched-environment', [1, 3]]]);
  });

  it('passes ```{=latex} blocks and `x`{=latex} spans verbatim, and drops other raw formats', () => {
    const md = '```{=latex}\n\\newpage\n```\n\n```{=html}\n<hr>\n```\n\nInline `\\hfill`{=latex} and `<b>`{=html} end.';
    const { latex } = convertMarkdown(md);
    assert.match(latex, /\n\\newpage\n/);
    assert.doesNotMatch(latex, /<hr>/);
    assert.match(latex, /Inline \\hfill and {2}end\./);
  });

  it('treats a tilde right before a command as a tie, and escapes it elsewhere', () => {
    const { latex } = convertMarkdown('Fig.~\\ref{a}, about ~5 and ~~gone~~.');
    assert.match(latex, /Fig\.~\\ref\{a\}, about \\textasciitilde\{\}5 and \\sout\{gone\}\./);
  });
});
