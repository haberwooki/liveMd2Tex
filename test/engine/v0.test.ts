// V0 exit criteria at Node level (docs/DESIGN.md#testing): every document goes through the same pipeline the save
// handler uses (src/extension/compile/pipeline.ts) and the same engine service, with the engine and the interim
// data staged where the extension looks (dist/engine, dist/data), the stubs in every process, and the PDF
// written next to the source. A second compile with the first one's state stands for a second save. The VS Code
// test (test/integration/v0.test.ts) repeats this through real saves in a window.

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { diagnosticsFor, generatedMainFor, nextState, prepareCompile, prepareMarkdownCompile } from '../../src/extension/compile/pipeline';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { interimFontsFolder, readInterimFonts } from '../../src/extension/engine/interimFonts';
import type { ProjectFs } from '../../src/extension/project/collect';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { docstripWith } from '../support/prepareV0Workspace';
import { root, stubState } from '../support/helpers';
import { record, writeResults } from './support';

function nodeFs(folder: string): ProjectFs {
  return {
    async readDirectory(rel) {
      const entries = await readdir(path.join(folder, rel), { withFileTypes: true });
      return entries.map((e) => [e.name, e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other']);
    },
    readFile: async (rel) => new Uint8Array(await readFile(path.join(folder, rel))),
  };
}

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P8-manual', 'T1', 'T2', 'T3', 'T4', 'T5'];

describe('V0 compile route (Node): a PDF next to the source for every document', function () {
  this.timeout(1800000);
  let service: EngineService;
  let projects: CorpusProject[] = [];
  let tmp = '';

  before(async function () {
    if (!bundledEngineAssets(root)) {
      // Needs node scripts/stage-engine.mjs --data after the build.
      this.skip();
    }
    service = new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => bundledEngineAssets(root),
      idleMinutes: () => 0,
      log: () => undefined,
    });
    service.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-v0-'));
    projects = await materializeCorpus(tmp, docstripWith(service));
  });

  after(async () => {
    await service?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  for (const id of IDS) {
    it(`${id}: compiles through the pipeline, PDF written next to the source`, async function () {
      const p = projects.find((x) => x.id === id);
      if (!p) {
        this.skip();
      }
      const project = p as CorpusProject;
      const prepared = await prepareCompile({ fs: nodeFs(project.folder), mainRel: project.main, engineSetting: 'pdflatex' });
      const { result, engineStartMs } = await service.compile(prepared.job);
      const diagnostics = diagnosticsFor(result, prepared);
      assert.ok(result.pdf, `${id}: no PDF (${result.error ?? ''})\n${result.log.split('\n').slice(-25).join('\n')}`);
      const pdfPath = path.join(project.folder, project.main.replace(/\.tex$/i, '.pdf'));
      writeFileSync(pdfPath, result.pdf);
      assert.ok(statSync(pdfPath).size > 1000);
      assert.deepEqual(result.stubs?.blocked, [], `${id}: the compile worker tried to spawn or connect`);
      assert.deepEqual(stubState().blocked, []);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const entry: Record<string, unknown> = {
        engine: prepared.engine.engine,
        reason: prepared.engine.reason,
        files: prepared.job.files.length,
        collectMs: prepared.collectMs,
        engineStartMs,
        passes: result.passes,
        bibtexRan: result.bibtexRan,
        engineTotalMs: result.timings.totalMs,
        pdfBytes: result.pdf.length,
        errors: errors.length,
        warnings: diagnostics.filter((d) => d.severity === 'warning').length,
        errorSamples: errors.slice(0, 3).map((d) => `${d.file}:${d.line}: ${d.message.slice(0, 80)}`),
      };

      // A second save with nothing changed: the first compile's state (aux, bbl) makes it one pass.
      const again = await prepareCompile({
        fs: nodeFs(project.folder),
        mainRel: project.main,
        engineSetting: 'pdflatex',
        previous: nextState(result, prepared),
      });
      const second = await service.compile(again.job);
      assert.ok(second.result.pdf, `${id}: no PDF on the second compile`);
      assert.equal(second.result.bibtexRan, false, `${id}: bibtex8 ran again although nothing changed`);
      entry.secondCompile = { passes: second.result.passes, engineTotalMs: second.result.timings.totalMs };
      // With the state carried over, a second save never needs more passes than the first.
      assert.ok(second.result.passes <= result.passes, `${id}: the second save took more passes than the first`);
      record(`V0-${id}`, entry);
      console.log(
        `      ${id}: ${prepared.engine.engine}, ${result.passes} pass(es)${result.bibtexRan ? ' + bibtex8' : ''}, ` +
          `${result.timings.totalMs} ms (collect ${prepared.collectMs} ms${engineStartMs ? `, engine start ${engineStartMs} ms` : ''}); ` +
          `second save: ${second.result.passes} pass(es), ${second.result.timings.totalMs} ms; ${errors.length} error(s)`,
      );
    });
  }

  it('P1: a changed .bib, or a new citation, runs bibtex8 again', async function () {
    const p = projects.find((x) => x.id === 'P1') as CorpusProject;
    const fs1 = nodeFs(p.folder);
    const first = await prepareCompile({ fs: fs1, mainRel: p.main, engineSetting: 'pdflatex' });
    const r1 = (await service.compile(first.job)).result;
    assert.equal(r1.bibtexRan, true);
    const bib = path.join(p.folder, 'paper.bib');
    writeFileSync(bib, `${readFileSync(bib, 'utf8')}\n@misc{added2026, title = {Added}, author = {A. Person}, year = {2026}}\n`);
    const second = await prepareCompile({ fs: fs1, mainRel: p.main, engineSetting: 'pdflatex', previous: nextState(r1, first) });
    assert.equal(second.job.bibChanged, true);
    const r2 = (await service.compile(second.job)).result;
    assert.equal(r2.bibtexRan, true, 'bibtex8 did not run after the .bib changed');
    // A new citation in an unsaved editor buffer (the overrides), with the .bib unchanged.
    const tex = readFileSync(path.join(p.folder, p.main), 'utf8').replace('\\citep{knuth1984}', '\\citep{knuth1984,added2026}');
    const third = await prepareCompile({
      fs: fs1,
      mainRel: p.main,
      engineSetting: 'pdflatex',
      previous: nextState(r2, second),
      overrides: new Map([[p.main, new TextEncoder().encode(tex)]]),
    });
    assert.equal(third.job.bibChanged, false);
    const r3 = (await service.compile(third.job)).result;
    assert.equal(r3.bibtexRan, true, 'bibtex8 did not run after a citation was added');
    assert.ok(r3.pdf);
    assert.doesNotMatch(r3.log, /Citation .added2026. .*undefined/);
  });

  it('a document with errors still gives a PDF, and the errors carry their file and line', async function () {
    const folder = path.join(tmp, 'broken');
    mkdirSync(path.join(folder, 'sections'), { recursive: true });
    writeFileSync(
      path.join(folder, 'main.tex'),
      ['\\documentclass{article}', '\\begin{document}', 'Before.', '\\input{sections/part}', 'After \\ref{nowhere}.', '\\end{document}', ''].join('\n'),
    );
    writeFileSync(path.join(folder, 'sections', 'part.tex'), ['First line.', '', 'An \\undefinedmacro here.', ''].join('\n'));
    const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'pdflatex' });
    const { result } = await service.compile(prepared.job);
    assert.ok(result.pdf, 'no PDF from a document with an error');
    const diagnostics = diagnosticsFor(result, prepared);
    const error = diagnostics.find((d) => d.severity === 'error');
    assert.ok(error, 'no error diagnostic');
    assert.equal(error.file, 'sections/part.tex');
    assert.equal(error.line, 3);
    assert.match(error.message, /Undefined control sequence/);
    const warning = diagnostics.find((d) => /nowhere/.test(d.message));
    assert.ok(warning, 'no warning for the undefined reference');
    assert.equal(warning.file, 'main.tex');
    assert.equal(warning.line, 5);
  });

  // The converted-Markdown route: the converter's LaTeX as an in-memory root document named after the file.
  async function compileMarkdown(folder: string, markdownRel: string, previous?: ReturnType<typeof nextState>) {
    const conversion = convertMarkdown(readFileSync(path.join(folder, markdownRel), 'utf8'), { sourceName: markdownRel });
    const prepared = await prepareMarkdownCompile({
      fs: nodeFs(folder),
      markdownRel,
      latex: conversion.latex,
      lineMap: conversion.lineMap,
      engine: conversion.engine,
      previous,
      // The notes template's DejaVu fonts (interim, until B1), as the controller adds them.
      extraFiles: await readInterimFonts(interimFontsFolder(root), conversion.fontFiles),
    });
    const { result } = await service.compile(prepared.job);
    return { conversion, prepared, result, diagnostics: diagnosticsFor(result, prepared) };
  }

  for (const id of ['P9', 'P10', 'P16', 'P17']) {
    it(`${id} (Markdown): converted and typeset, PDF written next to the source`, async function () {
      const project = projects.find((x) => x.id === id) as CorpusProject;
      const { conversion, prepared, result, diagnostics } = await compileMarkdown(project.folder, project.main);
      assert.ok(result.pdf, `${id}: no PDF (${result.error ?? ''})\n${result.log.split('\n').slice(-25).join('\n')}`);
      assert.equal(prepared.job.main, generatedMainFor(project.main));
      const pdfPath = path.join(project.folder, prepared.job.main.replace(/\.tex$/i, '.pdf'));
      writeFileSync(pdfPath, result.pdf);
      assert.deepEqual(result.stubs?.blocked, [], `${id}: the compile worker tried to spawn or connect`);
      // Every problem on the generated file is shown on a real Markdown line.
      const lines = readFileSync(path.join(project.folder, project.main), 'utf8').split('\n').length;
      for (const d of diagnostics) {
        assert.notEqual(d.file, prepared.job.main, `${id}: a problem stayed on the generated file: ${d.message}`);
        if (d.file === project.main) {
          assert.ok(d.line >= 0 && d.line <= lines, `${id}: line ${d.line} is outside the Markdown file`);
        }
      }
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const second = await compileMarkdown(project.folder, project.main, nextState(result, prepared));
      assert.ok(second.result.pdf);
      assert.equal(second.result.bibtexRan, false, `${id}: bibtex8 ran again although nothing changed`);
      record(`V0-${id}`, {
        engine: prepared.engine.engine,
        files: prepared.job.files.length,
        passes: result.passes,
        bibtexRan: result.bibtexRan,
        engineTotalMs: result.timings.totalMs,
        pdfBytes: result.pdf.length,
        errors: errors.length,
        unprintable: conversion.unprintable.length,
        errorSamples: errors.slice(0, 3).map((d) => `${d.file}:${d.line}: ${d.message.slice(0, 80)}`),
        secondCompile: { passes: second.result.passes, engineTotalMs: second.result.timings.totalMs },
      });
      console.log(
        `      ${id}: ${result.passes} pass(es)${result.bibtexRan ? ' + bibtex8' : ''}, ${result.timings.totalMs} ms; ` +
          `second save: ${second.result.passes} pass(es), ${second.result.timings.totalMs} ms; ${errors.length} error(s); ` +
          `${conversion.engine}${conversion.fontSet ? ` (${conversion.fontSet} fonts)` : ''}`,
      );
      // Since M1, characters pdfLaTeX cannot print take the XeTeX route, so every document typesets cleanly.
      assert.deepEqual(errors.map((d) => `${d.file}:${d.line}: ${d.message}`), [], `${id}: TeX errors`);
    });
  }

  it('Markdown: a TeX error is shown on its Markdown line, and a .tex file of the same name is not compiled instead', async function () {
    const folder = path.join(tmp, 'md-broken');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'notes.md'), ['---', 'title: Notes', '---', '', '# Start', '', 'Fine text.', '', 'A raw \\undefinedmacro here.', ''].join('\n'));
    writeFileSync(path.join(folder, 'notes.tex'), '\\errmessage{the real notes.tex was compiled}\n');
    const { result, diagnostics } = await compileMarkdown(folder, 'notes.md');
    assert.ok(result.pdf, 'no PDF');
    assert.doesNotMatch(result.log, /the real notes\.tex was compiled/);
    const error = diagnostics.find((d) => d.severity === 'error');
    assert.ok(error, 'no error diagnostic');
    assert.deepEqual([error.file, error.line], ['notes.md', 9]);
    assert.match(error.message, /Undefined control sequence/);
  });
});
