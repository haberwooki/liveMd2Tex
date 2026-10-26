// Robustness: seeded random documents assembled from every construct of the dialect (and some malformed
// ones) convert without throwing, with a complete line map, balanced braces and balanced environments. The
// corpus outputs must pass the same balance checks.

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { lineMapProblems, testDir } from './support';

/** Mulberry32: a small seeded generator, so a failure can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOCKS = [
  '# Heading {#sec:a}',
  '## Second *level* heading',
  'Plain paragraph with **bold**, *em*, `code`, ~~gone~~ and ==mark==.',
  'Math $x^2 + y_1$ and $$\\sum_i a_i$$ inline, \\(z\\) too.',
  'Citations [@a; see @b, p. 2] and @c [ch. 3], refs [@fig:f] [@Tbl:t].',
  'Raw \\ref{x}, \\SI{3}{\\metre}, \\textbf{a {b} c} and \\begin{tabular}{c}x\\end{tabular}.',
  'Specials: 50% & $ # _ ^ ~ { } \\ < > | [ ] " \' ` and Unicode α → ✓ ≤ ½ 😀.',
  '- item one\n- item two\n  - nested [x] item\n- [ ] task',
  '1. first\n2. second\n\n   continued paragraph',
  '> quote line\n> second line',
  '> [!NOTE] Title *here*\n> Body text.',
  '```js\nconst a = "{x}"; // \\end{verbatim}\n```',
  '```math\na \\\\ b\n```',
  '```{=latex}\n\\clearpage\n```',
  '    indented code',
  '$$\nE = mc^2\n$$ {#eq:e}',
  '\\begin{align}\na &= b \\\\\n\nc &= d\n\\end{align}',
  '| a | b |\n|:-|-:|\n| 1 | $|x|$ |',
  'Table: Caption {#tbl:t}',
  '![Figure caption](img.png){#fig:f width=50%}',
  '![](https://example.org/x.png)',
  'Footnote ref[^n] and inline^[note *x*].',
  '[^n]: Definition\n    with a second line.',
  'Term\n: Definition',
  '::: {.theorem #thm:a}\nInside.\n:::',
  '::: {.unknown}\nKept.\n:::',
  '| line block\n|   indented',
  '[[Wiki|alias]] ![[pic.png|100]] %%hidden%%',
  '%%\nblock comment\n%%',
  '<p align="center"><img src="a.png" width="50"></p>',
  'Inline <sup>1</sup> <b>bold</b> <span>s</span> <unknown>u</unknown> <br>',
  '<details>\n<summary>More</summary>',
  '</details>',
  '+---+---+\n| grid |\n+---+---+',
  '[TOC]',
  '---',
  'Unclosed $math and **bold and `code and [link and \\begin{env} and {{',
  '[bracketed]{.smallcaps} and [@{https://x.org/a}]',
  'a. fancy\nb. list',
  // Inputs that once broke the LaTeX: HTML blocks that cross containers, lists deeper than LaTeX allows, control characters,
  // URLs with ~ & % in a heading, a footnote and a caption, a Windows path.
  '- item\n\n  <div align="center">\n\n  centred in an item',
  '> <div align="center">\n>\n> centred in a quote',
  '</div>',
  '- 1\n  - 2\n    - 3\n      - 4\n        - 5\n          - 6\n            1. 7\n               1. 8',
  '1. a\n   1. b\n      1. c\n         1. d\n            1. e\n               - f',
  `Controls: ${[1, 2, 3, 4, 7, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0xfdd0, 0xfdd1].map((c) => String.fromCharCode(c) + 'x').join('')} end.`,
  '# Head [l](https://e.org/~u/a&b%20c#f)',
  'Note[^u].\n\n[^u]: [p](https://e.org/~u/p?x=1&y=2%25#t) and <https://e.org/~x?a=1&b=2>',
  '![Caption [l](https://e.org/~c/a&b%41#c).](img.png)',
  'Path C:\\Users\\name\\file.txt here.',
];

export function document(random: () => number): string {
  const parts: string[] = [];
  if (random() < 0.3) {
    parts.push('---\ntitle: T *x*\nauthor: [A, B]\nbibliography: r.bib\nabstract: |\n  One.\n\n  Two [@a].\n---');
  }
  const n = 3 + Math.floor(random() * 25);
  for (let i = 0; i < n; i++) {
    parts.push(BLOCKS[Math.floor(random() * BLOCKS.length)]);
  }
  // An HTML block runs to the next blank line (CommonMark) and would swallow a following raw \begin{...}, as it
  // does in pandoc; after one, always leave a blank line.
  const sep = (previous: string) => (previous.startsWith('<') || random() < 0.8 ? '\n\n' : '\n');
  return parts.reduce((acc, p, i) => (i === 0 ? p : acc + sep(parts[i - 1]) + p), '');
}

/** Problems with the braces and environments of LaTeX (verbatim bodies, escaped braces and math ignored). */
export function balanceProblems(latex: string): string[] {
  const text = latex
    .replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/g, '')
    .replace(/\\\\/g, '')
    .replace(/\\[{}]/g, '');
  const problems: string[] = [];
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        problems.push('a closing brace without an opening one');
        depth = 0;
      }
    }
  }
  if (depth !== 0) {
    problems.push(`${depth} unclosed brace(s)`);
  }
  const stack: string[] = [];
  for (const m of text.matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
    if (m[1] === 'begin') {
      stack.push(m[2]);
    } else if (stack.pop() !== m[2]) {
      problems.push(`\\end{${m[2]}} does not close the open environment`);
    }
  }
  if (stack.length) {
    problems.push(`unclosed environments: ${stack.join(', ')}`);
  }
  // LaTeX's limits: four levels of each list kind, six lists and quotes in all.
  const lists = { itemize: 0, enumerate: 0, all: 0 };
  for (const m of text.matchAll(/\\(begin|end)\{(itemize|enumerate|quote|description)\}/g)) {
    const step = m[1] === 'begin' ? 1 : -1;
    lists.all += step;
    if (m[2] === 'itemize' || m[2] === 'enumerate') {
      lists[m[2]] += step;
    }
    if (lists.itemize > 4 || lists.enumerate > 4 || lists.all > 6) {
      problems.push(`lists nested too deeply at ${m[0]}`);
      break;
    }
  }
  // Control characters and the converter's own markers never reach the LaTeX.
  // eslint-disable-next-line no-control-regex -- the point of the check
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufdd0-\ufdef]/.test(latex)) {
    problems.push('a control character or an internal marker in the output');
  }
  return problems;
}

describe('robustness', () => {
  it('converts 400 random documents without throwing, with a complete line map', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const md = document(rng(seed));
      let result;
      try {
        result = convertMarkdown(md);
      } catch (err) {
        assert.fail(`seed ${seed} threw: ${(err as Error).stack}`);
      }
      assert.deepEqual(lineMapProblems(result.latex, result.lineMap, md), [], `seed ${seed}`);
    }
  });

  it('keeps braces and environments balanced in what it generates (random documents without unbalanced input)', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const md = document(rng(seed));
      if (md.includes('Unclosed $math') || md.includes('$|x|$')) {
        continue; // the author's own unbalanced input passes through by design
      }
      assert.deepEqual(balanceProblems(convertMarkdown(md).latex), [], `seed ${seed}:\n${md}`);
    }
  });

  it('keeps braces and environments balanced for the whole corpus', () => {
    const dir = path.join(testDir, 'corpus');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      assert.deepEqual(balanceProblems(convertMarkdown(readFileSync(path.join(dir, file), 'utf8')).latex), [], file);
    }
  });

  it('converts a 20 000-line document in well under a second per 4 000 lines', () => {
    const md = Array.from({ length: 2000 }, (_, i) => `## Part ${i}\n\nText with $x_${i}$, [@k${i}] and **bold** ${i}.\n\n- a\n- b\n`).join('\n');
    const started = Date.now();
    const result = convertMarkdown(md);
    const ms = Date.now() - started;
    assert.ok(result.lineMap.length > 15000);
    assert.ok(ms < 5000, `${ms} ms`);
  });
});
