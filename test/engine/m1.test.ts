// M1 exit criteria at Node level (docs/DESIGN.md#testing), on public documents: Markdown typeset through the
// extension's own route (test/engine/markdownRoute.ts) with zero "Missing character" lines: the Markdown corpus
// P9, P10, P16 and P17, and the CC0 stand-ins of test/converter/m1 (the XeTeX notes template with its font
// fallback, accented names in Latin Modern, the example preset's letter mode, the biblatex mapping, one warning
// per unsupported construct). The PDF's text is read as the viewer reads it (pdf.js). Private documents are
// typeset the same way by the private test overlay, when there is one. Results (numbers only) go to ../s1_runs/.

import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveMode } from '../../src/converter/preset/load';
import type { EngineService } from '../../src/extension/engine/engineService';
import { examplePreset } from '../converter/support';
import { materializeMarkdownCorpus, type CorpusProject } from '../support/corpusProjects';
import { root } from '../support/helpers';
import { pdfText, squeeze } from '../support/pdfText';
import { record, writeResults } from './support';
import { folderFs, markdownEngineService, memoryFs, typesetMarkdown, type TypesetMarkdown } from './markdownRoute';

const m1 = path.join(root, 'test', 'converter', 'm1');
const read = (name: string) => readFileSync(path.join(m1, name), 'utf8');

/** The project of a stand-in: the file alone (its text is passed separately) and refs.bib, in memory. */
function standIn(_name: string): ReturnType<typeof memoryFs> {
  return memoryFs(new Map([['refs.bib', new Uint8Array(readFileSync(path.join(m1, 'refs.bib')))]]));
}

function summary(name: string, t: TypesetMarkdown) {
  const entry = {
    engine: t.conversion.engine,
    fontSet: t.conversion.fontSet ?? null,
    fontFiles: t.conversion.fontFiles.length,
    passes: t.result.passes,
    bibtexRan: t.result.bibtexRan,
    ms: t.result.timings.totalMs,
    missingCharacterLines: t.missing.length,
    texErrors: t.diagnostics.filter((d) => d.severity === 'error').length,
    converterWarnings: t.conversion.diagnostics.filter((d) => d.kind === 'unsupported').reduce((n, d) => n + d.lines.length, 0),
  };
  record(`M1-${name}`, entry);
  console.log(`      ${name}: ${entry.engine}${entry.fontSet ? ` (${entry.fontSet})` : ''}, ${entry.passes} pass(es), ${entry.ms} ms; Missing character lines ${entry.missingCharacterLines}; TeX errors ${entry.texErrors}`);
}

function assertClean(name: string, t: TypesetMarkdown) {
  assert.ok(t.result.pdf, `${name}: no PDF (${t.result.error ?? ''})\n${t.result.log.split('\n').slice(-20).join('\n')}`);
  assert.deepEqual(t.missing, [], `${name}: Missing character lines`);
  assert.deepEqual(
    t.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}: ${d.message}`),
    [],
    `${name}: TeX errors`,
  );
  assert.deepEqual(t.result.stubs?.blocked, [], `${name}: the compile worker tried to spawn or connect`);
}

describe('M1: Markdown typeset through the engine, public documents (Node)', function () {
  this.timeout(1800000);
  let service: EngineService;
  let tmp = '';
  let corpus: CorpusProject[] = [];

  before(async function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip(); // needs node scripts/stage-engine.mjs --data after the build
    }
    service = s as EngineService;
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-m1-'));
    corpus = await materializeMarkdownCorpus(tmp);
  });

  after(async () => {
    await service?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  for (const id of ['P9', 'P10', 'P16', 'P17']) {
    it(`${id}: typeset with zero "Missing character" lines`, async () => {
      const p = corpus.find((x) => x.id === id) as CorpusProject;
      const t = await typesetMarkdown(service, folderFs(p.folder), p.main, readFileSync(path.join(p.folder, p.main), 'utf8'));
      summary(id, t);
      assertClean(id, t);
    });
  }

  it('the notes stand-in: XeTeX notes template, the fallback covers every character, all of them in the PDF text', async () => {
    const t = await typesetMarkdown(service, standIn('notes-unicode.md'), 'notes-unicode.md', read('notes-unicode.md'));
    summary('notes-unicode', t);
    assert.equal(t.conversion.engine, 'xelatex');
    assert.equal(t.conversion.fontSet, 'dejavu');
    assertClean('notes-unicode', t);
    assert.deepEqual(t.result.stubs?.blocked, []);
    const text = squeeze(await pdfText(t.result.pdf as Uint8Array));
    for (const s of [
      'Labnotes:phonontransport✓', 'Status✓', 'done✓,open✗,blocked⚠', 'ℓ→0', 'κ∝T⁻¹', 'H₂O', 'Wm⁻¹K⁻¹', '½Å', '😀',
      '[U+1F680]', '𝒩=len(branches)', '𝓜⊂𝒰', '├──input.toml#𝒩=6branches✓', '│└──bands.dat', '└──result.json→κ(T)',
      'Ωₘ≥3', 'Γ–X', '⟶done✓',
    ]) {
      assert.ok(text.includes(s), `notes-unicode: "${s}" is not in the PDF's text`);
    }
  });

  it('the check is real: the same LaTeX without the fallback lines gives "Missing character" lines', async () => {
    const t = await typesetMarkdown(service, standIn('notes-unicode.md'), 'notes-unicode.md', read('notes-unicode.md'));
    const lines = t.conversion.latex.split('\n');
    const from = lines.findIndex((l) => l.startsWith('% Fallback fonts'));
    const to = lines.indexOf('\\makeatother', from);
    assert.ok(from > 0 && to > from, 'no fallback block');
    const job = { ...t.prepared.job, id: t.prepared.job.id + 100000, files: t.prepared.job.files.map((f) => (f.path === t.prepared.job.main ? { ...f, data: new TextEncoder().encode([...lines.slice(0, from), ...lines.slice(to + 1)].join('\n')) } : f)) };
    const { result } = await service.compile(job);
    const missing = result.log.split('\n').filter((l) => /Missing character: There is no/.test(l));
    record('M1-notes-unicode-without-fallback', { missingCharacterLines: missing.length });
    assert.ok(missing.length > 0, 'no Missing character lines without the fallback: the check would prove nothing');
  });

  it('accented names: XeTeX in Latin Modern, each name whole in the PDF text', async () => {
    const t = await typesetMarkdown(service, standIn('accented-names.md'), 'accented-names.md', read('accented-names.md'));
    summary('accented-names', t);
    assert.equal(t.conversion.fontSet, 'latin-modern');
    assert.deepEqual(t.conversion.fontFiles, []);
    assertClean('accented-names', t);
    const text = squeeze((await pdfText(t.result.pdf as Uint8Array)).replace(/-\n/g, ''));
    for (const name of ['ÁronSzép', 'ÉmileDurand', 'AnaRădulescu', 'ŽydrūnėVaitkutė', 'DovilėKazlauskienė', 'ElīzaBērziņa']) {
      assert.ok(text.includes(name), `"${name}" is not whole in the PDF's text`);
    }
  });

  it("the example preset's letter mode: engine auto takes XeTeX for the names, which are whole in the PDF text", async () => {
    const { preset, files } = examplePreset();
    const mode = resolveMode(preset, 'letter', files).mode;
    const t = await typesetMarkdown(service, standIn('cover-letter.md'), 'cover-letter.md', read('cover-letter.md'), { preset: mode });
    summary('cover-letter', t);
    assert.equal(t.conversion.engine, 'xelatex');
    assert.match(t.conversion.latex, /\\usepackage\{fontspec\}/);
    assertClean('cover-letter', t);
    const text = squeeze(await pdfText(t.result.pdf as Uint8Array));
    for (const name of ['DávidPéterSzabó', 'IoanaMăgureanu', 'ŽilvinasPetrauskas', 'RūtaJankauskienė']) {
      assert.ok(text.includes(name), `"${name}" is not whole in the PDF's text`);
    }
  });

  it('the biblatex mapping: bibtex8 runs, every citation resolves', async () => {
    const t = await typesetMarkdown(service, standIn('biblatex.md'), 'biblatex.md', read('biblatex.md'));
    summary('biblatex', t);
    assert.match(t.conversion.latex, /\\usepackage\[backend=bibtex8,style=authoryear\]\{biblatex\}/);
    assertClean('biblatex', t);
    assert.equal(t.result.bibtexRan, true);
    assert.doesNotMatch(t.result.log, /There were undefined (citations|references)|Citation .* undefined/);
    const text = squeeze(await pdfText(t.result.pdf as Uint8Array));
    assert.ok(text.includes('Callaway1959') || text.includes('Callaway(1959)'), 'the citation did not resolve');
  });

  it('one plain warning per unsupported construct, on its line, and no TeX error', async () => {
    const t = await typesetMarkdown(service, standIn('unsupported.md'), 'unsupported.md', read('unsupported.md'));
    summary('unsupported', t);
    assertClean('unsupported', t);
    const warnings = t.conversion.diagnostics.filter((d) => d.kind === 'unsupported').flatMap((d) => d.lines.map((l) => `${d.code}@${l}`));
    assert.deepEqual(warnings.sort(), ['div-class:sidebar@22', 'example-list@12', 'fancy-list@15', 'grid-table@28', 'grid-table@6', 'html:video@26', 'simple-table@19']);
  });
});
