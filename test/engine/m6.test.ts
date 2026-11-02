// M6 at engine level (docs/DESIGN.md#engine-and-data, #testing): the preamble scan on the corpus (with the Extra
// Packages add-on installed when the tests have it, support.ts extraAddOn), a corpus document whose class and
// packages are in the add-on (P7: memoir, biblatex) named before the compile with the add-on offered and then
// reaching a PDF through the Extra Packages route (the real add-on, read the way the extension reads an installed
// data extension), P2 without its REVTeX files through "Add a package from a file" (the CTAN ZIP), and a real .dtx
// and .ins package from CTAN (tensor) built by docstrip on the bundled engine and loaded. Needs the staged engine
// and data (dist/), and the pinned CTAN files; skips without them.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diagnosticsFor, prepareCompile, type PackageContext } from '../../src/extension/compile/pipeline';
import { readCoreData, readDataExtension, packageContext, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { preparePackages, UserPackages, type RunIns } from '../../src/extension/packages/userPackages';
import { ENGINE_FORMATS } from '../../src/shared/engineJobs';
import { DISPLAY_NAME, EXTRA_DATA_NAME } from '../../src/shared/identity';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';
import { extraAddOn, needAddOn, record, stagedEngine, writeResults } from './support';

const assets = path.resolve(root, '..', 'engine_assets');

describe('M6 (engine level): package help', function () {
  this.timeout(900000);
  let engine: EngineService;
  let tmp = '';
  let projects: CorpusProject[] = [];
  let core: Awaited<ReturnType<typeof readCoreData>>;
  let expected: Expected;
  let p2bare = '';

  const runIns: RunIns = async (files, ins) => {
    const { result } = await engine.compile({
      id: 0,
      main: ins,
      files,
      engine: 'pdflatex',
      bibtex: 'never',
      maxPasses: 1,
      synctex: false,
      steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', ENGINE_FORMATS.pdflatex, ins]],
      returnNewFiles: true,
    });
    return result.newFiles ?? [];
  };

  before(async function () {
    if (!stagedEngine(this)) {
      return;
    }
    engine = new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => bundledEngineAssets(root),
      idleMinutes: () => 0,
      log: () => undefined,
    });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-m6-'));
    projects = await materializeCorpus(path.join(tmp, 'corpus'), docstripWith(engine));
    core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index, 'the staged data has no package index');
    expected = { texLive: core.manifest.texLive, abi: core.manifest.abi };
    // P2, the REVTeX sample, without the REVTeX files the corpus puts beside it.
    const p2 = projects.find((p) => p.id === 'P2') as CorpusProject;
    p2bare = path.join(tmp, 'P2-bare');
    mkdirSync(p2bare, { recursive: true });
    for (const name of readdirSync(p2.folder)) {
      if (!/\.(cls|rtx|sty|bst)$/i.test(name)) {
        cpSync(path.join(p2.folder, name), path.join(p2bare, name));
      }
    }
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  const context = (installed: PackageContext['installed'] = []) => packageContext(core, installed);

  it('the scan finds nothing missing in the corpus documents that compile (no false alarms)', async () => {
    const report: Record<string, number> = {};
    // P7 needs the add-on (memoir, biblatex): installed when the tests have it, as for a user who installed it.
    const extra = await extraAddOn();
    for (const p of projects.filter((x) => x.main.endsWith('.tex') && (extra || x.id !== 'P7'))) {
      const prepared = await prepareCompile({ fs: nodeFs(p.folder), mainRel: p.main, engineSetting: 'pdflatex', packages: context(extra ? [extra] : []) });
      const scan = prepared.packageScan;
      assert.ok(scan, `${p.id}: no scan`);
      report[p.id] = scan.requests;
      assert.deepEqual(
        scan.missing.map((m) => m.file),
        [],
        `${p.id}: reported missing although it compiles`,
      );
    }
    record('M6-scan-corpus', report);
    console.log(`      requests scanned: ${Object.entries(report).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  });

  it('P7 without the add-on: the scan names its package before compiling, TeX\'s "not found" its class, each with the add-on', async () => {
    const p7 = projects.find((p) => p.id === 'P7') as CorpusProject;
    const prepared = await prepareCompile({ fs: nodeFs(p7.folder), mainRel: p7.main, engineSetting: 'pdflatex', packages: context() });
    const missing = prepared.packageScan?.missing ?? [];
    // The document asks for biblatex; memoir is the project's own class's base class, which the scan does not read.
    assert.deepEqual(missing.map((m) => m.file), ['biblatex.sty']);
    // The core's manifest lists the add-on's files, so each is offered from it.
    for (const m of missing) {
      assert.equal(m.offer?.id, EXTRA_DATA_NAME, `${m.file}: no offer`);
    }
    const { result } = await engine.compile(prepared.job);
    assert.equal(result.pdf, null);
    const diagnostics = diagnosticsFor(result, prepared);
    const scanned = diagnostics.filter((d) => d.source === DISPLAY_NAME);
    assert.match(scanned.find((d) => /biblatex\.sty/.test(d.message))?.message ?? '', /"biblatex\.sty" \(package biblatex\) is not inside the installed packages\. The Extra Packages add-on has it/);
    // The log's own "not found" names the package and the add-on too.
    assert.ok(diagnostics.some((d) => d.source === 'TeX' && /memoir\.cls is in package memoir, in the Extra Packages add-on/.test(d.message)), diagnostics.map((d) => d.message).join('\n'));
    record('M6-P7-missing', { missing: missing.map((m) => m.file), pdf: result.pdf !== null });
  });

  it('the Extra Packages route: with the add-on installed, P7 reaches a PDF', async function () {
    // The add-on comes from LIVEMD2TEX_EXTRA_DATA; without it the case skips, and on CI it fails once a core-data
    // package is pinned (support.ts, needAddOn).
    const extra = await needAddOn(this);
    const p7 = projects.find((p) => p.id === 'P7') as CorpusProject;
    const prepared = await prepareCompile({ fs: nodeFs(p7.folder), mainRel: p7.main, engineSetting: 'pdflatex', packages: context([extra]) });
    assert.deepEqual(prepared.packageScan?.missing, []);
    // The add-on's image is mounted whole; no file of it is copied into the job (build gate 2, G2E-02).
    assert.deepEqual(prepared.job.dataImages?.map((i) => i.id), [EXTRA_DATA_NAME]);
    assert.equal(prepared.job.texmfFiles, undefined);
    const { result } = await engine.compile(prepared.job);
    assert.ok(result.pdf, `no PDF: ${result.log.split('\n').slice(-12).join('\n')}`);
    assert.match(result.log, /\/texmf-extra\/tex\/latex\/memoir\/memoir\.cls/);
    assert.equal(result.bibtexRan, true);
    const errors = diagnosticsFor(result, prepared).filter((d) => d.severity === 'error');
    assert.deepEqual(errors.map((d) => d.message), []);
    record('M6-P7-extra', { images: prepared.job.dataImages?.length, pdfBytes: result.pdf.length });
  });

  it('a data set built for another engine or TeX Live year is refused with one plain message', async () => {
    const { writeStandinFolder } = await importScript<{ writeStandinFolder(root: string, target: string): unknown }>('scripts/lib/extra-standin.mjs');
    const folder = path.join(tmp, 'extensions', 'wrong-abi');
    writeStandinFolder(root, folder);
    const manifestFile = path.join(folder, 'data', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { abi: string; texLive: number };
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, texLive: 2025 }));
    const extra = await readDataExtension(folder, EXTRA_DATA_NAME, expected);
    assert.ok('problem' in extra);
    assert.match(extra.problem, /built from TeX Live 2025, but this version of the extension uses TeX Live 2026/);
  });

  it('"Add a package from a file" with the CTAN ZIP: P2 reaches a PDF from the user\'s package folder', async () => {
    const zip = readFileSync(path.join(assets, 'ctan-revtex', 'revtex.tds.zip'));
    const prepared = await preparePackages([{ name: 'revtex.tds.zip', data: new Uint8Array(zip) }], runIns);
    assert.deepEqual(prepared.packages, ['revtex']);
    const user = new UserPackages(path.join(tmp, 'globalStorage', 'packages'));
    await user.add(prepared);
    const set = await user.set();
    assert.ok(set);
    const compile = await prepareCompile({ fs: nodeFs(p2bare), mainRel: 'apssamp.tex', engineSetting: 'pdflatex', packages: context([set]) });
    assert.deepEqual(compile.packageScan?.missing, []);
    const { result } = await engine.compile(compile.job);
    assert.ok(result.pdf, 'no PDF');
    record('M6-P2-file', { files: prepared.files.size, pdfBytes: result.pdf.length });
  });

  it('a .dtx and .ins package from CTAN (tensor 2.2): built by docstrip on the bundled engine, then loaded', async function () {
    const dir = path.join(assets, 'ctan-tensor');
    if (!existsSync(path.join(dir, 'tensor.dtx'))) {
      this.skip();
    }
    const picked = ['tensor.dtx', 'tensor.ins'].map((name) => ({ name, data: new Uint8Array(readFileSync(path.join(dir, name))) }));
    const prepared = await preparePackages(picked, runIns);
    assert.deepEqual(prepared.built, ['tensor.sty']);
    assert.ok(prepared.files.has('tex/latex/tensor/tensor.sty'));
    const user = new UserPackages(path.join(tmp, 'globalStorage-tensor', 'packages'));
    await user.add(prepared);
    const set = await user.set();
    assert.ok(set);
    const doc = path.join(tmp, 'tensor-doc');
    mkdirSync(doc, { recursive: true });
    writeFileSync(
      path.join(doc, 'main.tex'),
      ['\\documentclass{article}', '\\usepackage{tensor}', '\\begin{document}', 'A tensor: $\\tensor{T}{^a_b^c}$ and $\\indices{_\\mu^\\nu}$.', '\\end{document}', ''].join('\n'),
    );
    const without = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context() });
    assert.deepEqual(without.packageScan?.missing.map((m) => m.file), ['tensor.sty'], 'tensor is in the image after all');
    const compile = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([set]) });
    assert.deepEqual(compile.packageScan?.missing, []);
    const { result } = await engine.compile(compile.job);
    assert.ok(result.pdf, 'no PDF');
    assert.match(result.log, /\/texmf-home\/tex\/latex\/tensor\/tensor\.sty/);
    assert.deepEqual(diagnosticsFor(result, compile).filter((d) => d.severity === 'error'), []);
    record('M6-tensor', { built: prepared.built, pdfBytes: result.pdf.length });
  });

  it('font packages and packages that need an outside program get their own plain messages', async () => {
    const doc = path.join(tmp, 'messages');
    mkdirSync(doc, { recursive: true });
    writeFileSync(
      path.join(doc, 'main.tex'),
      ['\\documentclass{article}', '\\usepackage{kpfonts}', '\\usepackage{minted}', '\\usepackage{biblatex}', '\\begin{document}', 'Text.', '\\end{document}', ''].join('\n'),
    );
    const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context() });
    const scan = prepared.packageScan;
    assert.ok(scan);
    // kpfonts is in neither data set (newtx, which this case named before, is in the core now).
    const kp = scan.missing.find((m) => m.file === 'kpfonts.sty');
    assert.ok(kp?.font, 'kpfonts was not taken for a font package');
    assert.deepEqual(scan.outside.map((o) => o.name).sort(), ['biblatex', 'minted']);
    const { result } = await engine.compile(prepared.job);
    const messages = diagnosticsFor(result, prepared).filter((d) => d.source === DISPLAY_NAME).map((d) => d.message);
    assert.ok(messages.some((m) => /font package/.test(m) && /a copy of the \.sty is not enough/.test(m)));
    assert.ok(messages.some((m) => /minted needs Pygments, a Python program/.test(m)));
    assert.ok(messages.some((m) => /Biber/.test(m) && /backend=bibtex/.test(m)));
  });
});
