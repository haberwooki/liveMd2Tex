// M6 at engine level (docs/DESIGN.md#engine-and-data, #testing): the preamble scan on the corpus, a
// corpus document with a missing class reaching a PDF through the Extra Packages route (the stand-in add-on,
// read the way the extension reads an installed data extension) and through "Add a package from a file" (the
// CTAN ZIP), and a real .dtx and .ins package from CTAN (tensor) built by docstrip on the bundled engine and
// loaded. Needs the staged engine and data (dist/), and the pinned CTAN files; skips without them.

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
import { record, writeResults } from './support';

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
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json'))) {
      this.skip();
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
    for (const p of projects.filter((x) => x.main.endsWith('.tex'))) {
      const prepared = await prepareCompile({ fs: nodeFs(p.folder), mainRel: p.main, engineSetting: 'pdflatex', packages: context() });
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

  it('P2 without the REVTeX files: every missing file at once, before compiling, with the add-on offered', async () => {
    const prepared = await prepareCompile({ fs: nodeFs(p2bare), mainRel: 'apssamp.tex', engineSetting: 'pdflatex', packages: context() });
    const missing = prepared.packageScan?.missing ?? [];
    // The .bst comes with the class (its .rtx files name it), so the document itself asks only for the class.
    assert.deepEqual(missing.map((m) => m.file), ['revtex4-2.cls']);
    for (const m of missing) {
      assert.equal(m.offer?.id, EXTRA_DATA_NAME);
    }
    const { result } = await engine.compile(prepared.job);
    const diagnostics = diagnosticsFor(result, prepared);
    const scanned = diagnostics.filter((d) => d.source === DISPLAY_NAME);
    assert.equal(scanned.length, 1);
    assert.match(scanned.find((d) => /revtex4-2\.cls/.test(d.message))?.message ?? '', /"revtex4-2\.cls" \(class revtex\) is not inside the installed packages\. The Extra Packages add-on has it/);
    // The log's own "not found" names the package and the add-on too.
    assert.ok(diagnostics.some((d) => d.source === 'TeX' && /revtex4-2\.cls is in package revtex, in the Extra Packages add-on/.test(d.message)));
    record('M6-P2-missing', { missing: missing.map((m) => m.file), pdf: result.pdf !== null });
  });

  it('the Extra Packages route: with the stand-in add-on installed, P2 reaches a PDF', async () => {
    const { writeStandinFolder } = await importScript<{ writeStandinFolder(root: string, target: string): unknown }>('scripts/lib/extra-standin.mjs');
    const folder = path.join(tmp, 'extensions', `haberwooki.${EXTRA_DATA_NAME}-0.0.1`);
    writeStandinFolder(root, folder);
    const extra = await readDataExtension(folder, EXTRA_DATA_NAME, expected);
    assert.ok('set' in extra, 'problem' in extra ? extra.problem : '');
    const prepared = await prepareCompile({ fs: nodeFs(p2bare), mainRel: 'apssamp.tex', engineSetting: 'pdflatex', packages: context([extra]) });
    assert.deepEqual(prepared.packageScan?.missing, []);
    // The add-on's image is mounted whole; no file of it is copied into the job (build gate 2, G2E-02).
    assert.deepEqual(prepared.job.dataImages?.map((i) => i.id), [EXTRA_DATA_NAME]);
    assert.equal(prepared.job.texmfFiles, undefined);
    const { result } = await engine.compile(prepared.job);
    assert.ok(result.pdf, `no PDF: ${result.log.split('\n').slice(-12).join('\n')}`);
    assert.match(result.log, /\/texmf-extra\/tex\/latex\/revtex\/revtex4-2\.cls/);
    assert.equal(result.bibtexRan, true);
    const errors = diagnosticsFor(result, prepared).filter((d) => d.severity === 'error');
    // The sample's four .eps figures stay errors (no Ghostscript), as with the class beside it in V0.
    assert.ok(errors.every((d) => /eps-converted-to\.pdf/.test(d.message)), errors.map((d) => d.message).join('\n'));
    record('M6-P2-extra', { images: prepared.job.dataImages?.length, pdfBytes: result.pdf.length, errors: errors.length });
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
      ['\\documentclass{article}', '\\usepackage{newtxtext}', '\\usepackage{minted}', '\\usepackage{biblatex}', '\\begin{document}', 'Text.', '\\end{document}', ''].join('\n'),
    );
    const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context() });
    const scan = prepared.packageScan;
    assert.ok(scan);
    const newtx = scan.missing.find((m) => m.file === 'newtxtext.sty');
    assert.ok(newtx?.font, 'newtxtext was not taken for a font package');
    assert.deepEqual(scan.outside.map((o) => o.name).sort(), ['biblatex', 'minted']);
    const { result } = await engine.compile(prepared.job);
    const messages = diagnosticsFor(result, prepared).filter((d) => d.source === DISPLAY_NAME).map((d) => d.message);
    assert.ok(messages.some((m) => /font package/.test(m) && /a copy of the \.sty is not enough/.test(m)));
    assert.ok(messages.some((m) => /minted needs Pygments, a Python program/.test(m)));
    assert.ok(messages.some((m) => /Biber/.test(m) && /backend=bibtex/.test(m)));
  });
});
