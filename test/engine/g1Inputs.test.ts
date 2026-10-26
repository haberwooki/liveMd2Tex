// Build gate 1, G1E-14, through the engine: the converter inputs that used to give broken LaTeX (an HTML block that
// crosses a container, control characters, lists deeper than LaTeX allows, URLs with ~ & % # in a heading, a
// footnote, a caption and a table) now typeset with no TeX error. The converter-level checks are in
// test/converter/g1Inputs.test.ts.

import * as assert from 'node:assert/strict';
import type { EngineService } from '../../src/extension/engine/engineService';
import { tinyPng } from '../support/corpusProjects';
import { markdownEngineService, memoryFs, typesetMarkdown } from './markdownRoute';

const controls = [1, 2, 3, 4, 7, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0xfdd0, 0xfdd1].map((c) => String.fromCharCode(c)).join('');

const MARKDOWN = [
  '# Inputs [that broke](https://example.org/~u/a&b%20c#frag) the LaTeX',
  '',
  `Control characters${controls} in a line, and a note.[^n]`,
  '',
  '[^n]: See [the page](https://example.org/~u/p?x=1&y=2%25z#top) and <https://example.org/~x?a=1&b=2>.',
  '',
  '- item',
  '',
  '  <div align="center">',
  '',
  '  centred in an item',
  '',
  '- next item',
  '',
  '</div>',
  '',
  '> <div align="center">',
  '>',
  '> centred in a quote',
  '',
  '- 1',
  '  - 2',
  '    - 3',
  '      - 4',
  '        - 5',
  '          - 6',
  '            1. 7',
  '',
  '![A caption with [a link](https://example.org/~c/a&b%41#c).](fig.png)',
  '',
  'Table: A table caption with [a link](https://example.org/~t/a&b%41).',
  '',
  '| a | b |',
  '|---|---|',
  '| [x](https://example.org/~c/a&b%41#d) | 2 |',
  '',
].join('\n');

describe('build gate 1 (G1E-14): the inputs that broke the LaTeX typeset cleanly (Node)', function () {
  this.timeout(600000);
  let service: EngineService;

  before(function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip(); // needs node scripts/stage-engine.mjs --data after the build
    }
    service = s as EngineService;
  });

  after(async () => {
    await service?.stop();
  });

  it('gives a PDF with no TeX error', async () => {
    const fs = memoryFs(new Map([['fig.png', new Uint8Array(tinyPng())]]));
    const t = await typesetMarkdown(service, fs, 'inputs.md', MARKDOWN);
    assert.ok(t.result.pdf, `no PDF (${t.result.error ?? ''})`);
    assert.deepEqual(
      t.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}: ${d.message}`),
      [],
    );
    const codes = t.conversion.diagnostics.map((d) => d.code);
    for (const code of ['control-characters', 'html-block-container', 'deep-list']) {
      assert.ok(codes.includes(code), `no ${code} notice`);
    }
  });
});
