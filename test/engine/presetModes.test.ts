// The example preset's modes (examples/presets/two-column-paper; docs/DESIGN.md#presets) produce LaTeX that
// typesets on the bundled engine: the CC0 stand-in documents of test/converter/preset, converted in each mode,
// compiled with pdfLaTeX (XeTeX for the report mode) and bibtex8. Figures are drawn in code (CC0). Results (numbers only) go to ../s1_runs/.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { resolveMode } from '../../src/converter/preset/load';
import type { EngineName, ProjectFile } from '../../src/shared/engineJobs';
import { examplePreset } from '../converter/support';
import { root } from '../support/helpers';
import { compileAndRecord, engineAssetPaths, job, writeResults } from './support';

const fixtures = path.join(root, 'test', 'converter', 'preset');
const enc = new TextEncoder();

async function figure(file: string): Promise<ProjectFile> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([240, 140]);
  page.drawRectangle({ x: 20, y: 20, width: 200, height: 100, borderColor: rgb(0.1, 0.2, 0.7), borderWidth: 2 });
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 220, y: 120 }, thickness: 1.5, color: rgb(0.1, 0.2, 0.7) });
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  return { path: file, data: await doc.save() };
}

/** A 1x1 PNG (for the report mode, which keeps .png files that have no .pdf twin). */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

function convert(file: string, mode: string, extra: { appendix?: string; overrides?: Record<string, unknown>; pdfTwins?: boolean } = {}) {
  const { preset, files } = examplePreset();
  const resolved = resolveMode(preset, mode, files, extra.overrides);
  const resolveImage = extra.pdfTwins ? (image: string) => image.replace(/\.png$/i, '.pdf') : undefined;
  return convertMarkdown(readFileSync(path.join(fixtures, file), 'utf8'), { preset: resolved.mode, appendix: extra.appendix, resolveImage });
}

describe('the example preset modes typeset on the bundled engine', function () {
  this.timeout(900000);

  before(function () {
    if (!engineAssetPaths()) {
      this.skip();
    }
  });
  after(() => {
    console.log(`      results: ${writeResults()}`);
  });

  async function typeset(name: string, latex: string, engine: EngineName, extra: ProjectFile[]) {
    const r = await compileAndRecord(`preset-${name}`, job({ main: `${name}.tex`, files: [{ path: `${name}.tex`, data: enc.encode(latex) }, ...extra], engine, bibtex: 'auto', maxPasses: 4, synctex: true }));
    console.log(`      ${name}: ${r.result.steps.map((s) => `${s.argv[0]} ${s.ms} ms`).join(', ')}; pages ${r.analysis.pages}; errors ${r.analysis.errors.length}`);
    assert.ok(r.result.pdf, `${name}: no PDF (${r.result.error ?? r.analysis.errors.slice(0, 5).join(' | ')})`);
    assert.deepEqual(r.analysis.errors, [], `${name}: errors`);
    assert.deepEqual(r.analysis.fallbacks, [], `${name}: font fallback`);
    assert.ok(r.result.stubs && r.result.stubs.blocked.length === 0, `${name}: the compile worker tried to spawn or connect`);
    return r;
  }

  it('paper: two columns, banner, figures in three layouts, a table with notes, the Methods appendix, BibTeX', async () => {
    // pdfForPng is "if-exists": the .pdf beside each .png is used, as the extension finds it on disk.
    const result = convert('manuscript.md', 'paper', { appendix: readFileSync(path.join(fixtures, 'methods.md'), 'utf8'), pdfTwins: true });
    const files = [
      await figure('figs/fig_single.pdf'),
      await figure('figs/wide_figure.pdf'),
      await figure('figs/side_figure.pdf'),
      { path: 'references.bib', data: new Uint8Array(readFileSync(path.join(fixtures, 'references.bib'))) },
    ];
    const r = await typeset('paper', result.latex, 'pdflatex', files);
    assert.equal(r.analysis.undefinedRefs, 0);
  });

  it('supplement: single column, tables in place', async () => {
    await typeset('supplement', convert('supplement.md', 'supplement').latex, 'pdflatex', [{ path: 'references.bib', data: new Uint8Array(readFileSync(path.join(fixtures, 'references.bib'))) }]);
  });

  it('letter and response', async () => {
    await typeset('letter', convert('letter.md', 'letter').latex, 'pdflatex', []);
    await typeset('response', convert('response.md', 'response').latex, 'pdflatex', []);
  });

  it('report: XeTeX with fontspec and its default font', async () => {
    const result = convert('annual-review.md', 'report');
    assert.equal(result.engine, 'xelatex');
    await typeset('report', result.latex, 'xelatex', [{ path: 'figures/ratio.png', data: PNG }]);
  });
});
