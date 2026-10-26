// Build gate 2 at engine level:
// - G2E-02: a data extension is an image the engine host mounts whole. A package in it that loads another file
//   of the image indirectly (a name built by a macro, which no index lists) finds it; a document that reaches a
//   file of an installed image without asking for any of its packages gets "not found" once, and the next compile
//   mounts the image. The user's own package files cross in the change sets.
// - G2E-01: a package build (docstrip, a tool job of the scheduler) and a live compile, on the real engine, never
//   cancel each other.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { imagesForNotFound, prepareCompile, type PackageContext } from '../../src/extension/compile/pipeline';
import { CompileScheduler, type CompileOutcome } from '../../src/extension/compile/scheduler';
import { packageContext, readCoreData, readDataExtension, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { preparePackages, UserPackages, type RunIns } from '../../src/extension/packages/userPackages';
import { ENGINE_FORMATS, type ProjectFile } from '../../src/shared/engineJobs';
import { buildPackageIndex } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';

const assets = path.resolve(root, '..', 'engine_assets');
const tex = (lines: string[]) => `${lines.join('\n')}\n`;

describe('gate 2 (engine level): data images, and package builds beside compiles', function () {
  this.timeout(600000);
  let engine: EngineService;
  let tmp = '';
  let core: Awaited<ReturnType<typeof readCoreData>>;
  let expected: Expected;
  const context = (installed: PackageContext['installed'] = []) => packageContext(core, installed);

  before(async function () {
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json'))) {
      this.skip();
    }
    engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-gate2-'));
    core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index);
    expected = { texLive: core.manifest.texLive, abi: core.manifest.abi };
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /** A data extension folder holding the given texmf files as one image, in the contract's layout. */
  async function dataExtension(name: string, files: Record<string, string>, version = '1'): Promise<string> {
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>): { data: Buffer; index: unknown; sha256: string } }>('scripts/lib/data-image.mjs');
    const bytes = new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));
    const image = buildDataImage(bytes);
    const folder = path.join(tmp, 'extensions', name);
    mkdirSync(path.join(folder, 'data'), { recursive: true });
    writeFileSync(path.join(folder, 'data', 'extra.data'), image.data);
    writeFileSync(path.join(folder, 'data', 'extra.index.json'), JSON.stringify(image.index));
    const index = buildPackageIndex(Object.keys(files), (rel) => files[rel]);
    const manifest = { format: 1, version, texLive: expected.texLive, abi: expected.abi, image: { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256 }, index };
    writeFileSync(path.join(folder, 'data', 'manifest.json'), JSON.stringify(manifest));
    return folder;
  }

  const g2files = {
    // The .def's name is built by a macro: no regex, and no package index, sees that g2pkg loads it.
    'tex/latex/g2pkg/g2pkg.sty': tex(['\\ProvidesPackage{g2pkg}[2026/10/16 gate 2 test]', '\\def\\gtwo@name{g2pkg-data}', '\\input{\\gtwo@name.def}']),
    'tex/latex/g2pkg/g2pkg-data.def': tex(['\\typeout{G2-INDIRECT-LOADED}', '\\newcommand\\gtwo{indirect file found}']),
  };

  it('G2E-02: a package in a data image finds a file it loads indirectly; nothing is copied into the job', async () => {
    const folder = await dataExtension('g2-indirect', g2files);
    const extra = await readDataExtension(folder, 'g2-extra', expected);
    assert.ok('image' in extra, 'problem' in extra ? extra.problem : '');
    assert.deepEqual(extra.set.index.packages.g2pkg?.requires ?? [], [], 'the index saw the indirect load after all');
    const doc = path.join(tmp, 'indirect-doc');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{g2pkg}', '\\begin{document}', '\\gtwo.', '\\end{document}']));
    const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([extra]) });
    assert.deepEqual(prepared.packageScan?.missing, []);
    assert.deepEqual(prepared.job.dataImages?.map((i) => i.id), ['g2-extra']);
    assert.equal(prepared.job.texmfFiles, undefined);
    const { result } = await engine.compile(prepared.job);
    assert.ok(result.pdf, result.log.split('\n').slice(-10).join('\n'));
    assert.match(result.log, /G2-INDIRECT-LOADED/);
    assert.match(result.log, /\/texmf-extra\/tex\/latex\/g2pkg\/g2pkg-data\.def/);
    assert.doesNotMatch(result.log, /not found/);
  });

  it('G2E-02: a file of an installed image reached without its package: "not found" once, then the image is mounted', async () => {
    const folder = await dataExtension('g2-ondemand', g2files);
    const extra = await readDataExtension(folder, 'g2-extra2', expected);
    assert.ok('image' in extra);
    const doc = path.join(tmp, 'ondemand-doc');
    mkdirSync(doc, { recursive: true });
    // \csname input\endcsname hides the request from the preamble scan.
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\makeatletter', '\\csname input\\endcsname{g2pkg-data.def}', '\\makeatother', '\\begin{document}', '\\gtwo.', '\\end{document}']));
    // A fresh engine host: one that has read an image mounts it in every later worker, as a TeX installation
    // with the add-on would find its files.
    const fresh = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    fresh.execArgv = engine.execArgv;
    const first = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([extra]) });
    assert.equal(first.job.dataImages, undefined);
    const r1 = (await fresh.compile(first.job)).result;
    assert.match(r1.log, /File `g2pkg-data\.def' not found/);
    const more = imagesForNotFound(r1, first);
    assert.deepEqual(more, ['g2-extra2']);
    const second = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([extra]), mountSets: new Set(more) });
    const r2 = (await fresh.compile(second.job)).result;
    assert.match(r2.log, /G2-INDIRECT-LOADED/);
    assert.doesNotMatch(r2.log, /not found/);
    await fresh.stop();
  });

  it('G2E-R1: install, update with a changed file, uninstall: each compile sees exactly the installed version', async () => {
    const files = (v: string) => ({
      'tex/latex/g2upd/g2upd.sty': tex(['\\ProvidesPackage{g2upd}', '\\input{g2upd-data.def}']),
      'tex/latex/g2upd/g2upd-data.def': tex([`\\typeout{G2-VERSION-${v}}`]),
    });
    const doc = path.join(tmp, 'update-doc');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{g2upd}', '\\begin{document}', 'Text.', '\\end{document}']));
    const probe = path.join(tmp, 'probe-doc');
    mkdirSync(probe, { recursive: true });
    // A document that asks for none of the add-on's packages, and looks for its file anyway.
    writeFileSync(path.join(probe, 'main.tex'), tex(['\\documentclass{article}', '\\IfFileExists{g2upd-data.def}{\\typeout{G2-LEAK}}{\\typeout{G2-NO-LEAK}}', '\\begin{document}', 'Text.', '\\end{document}']));
    const compile = async (folder: string, installed: PackageContext['installed']) => {
      const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context(installed) });
      return { prepared, result: (await engine.compile(prepared.job)).result };
    };
    // Installed, version 1.
    const v1 = await readDataExtension(await dataExtension('g2upd-1.0.0', files('1'), '1.0.0'), 'g2-upd', expected);
    assert.ok('image' in v1);
    assert.match((await compile(doc, [v1])).result.log, /G2-VERSION-1/);
    assert.match((await compile(probe, [v1])).result.log, /G2-NO-LEAK/, 'an image the job does not list was mounted');
    // Updated to version 2, with a changed file, in a new folder (as VS Code installs an update).
    const v2 = await readDataExtension(await dataExtension('g2upd-2.0.0', files('2'), '2.0.0'), 'g2-upd', expected);
    assert.ok('image' in v2);
    const after = await compile(doc, [v2]);
    assert.match(after.result.log, /G2-VERSION-2/);
    assert.doesNotMatch(after.result.log, /G2-VERSION-1/);
    // Uninstalled: the scan says so, and no compile sees either version.
    const gone = await compile(doc, []);
    assert.deepEqual(gone.prepared.packageScan?.missing.map((m) => m.file), ['g2upd.sty']);
    assert.doesNotMatch(gone.result.log, /G2-VERSION-/);
    assert.match((await compile(probe, [])).result.log, /G2-NO-LEAK/);
  });

  /** docstrip on the engine, as the extension's tool job runs it. */
  const runIns = (scheduler: CompileScheduler): RunIns => async (files: ProjectFile[], ins: string) => {
    const { result } = await scheduler.runTool(`docstrip ${ins}`, () =>
      engine.compile({ id: 900000 + Math.floor(Math.random() * 1000), main: ins, files, engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false, steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', ENGINE_FORMATS.pdflatex, ins]], returnNewFiles: true }),
    );
    assert.equal(result.error, undefined, `the build failed: ${result.error}`);
    return result.newFiles ?? [];
  };

  it('G2E-01: tensor builds while a live compile runs and while typing goes on; nothing is cancelled', async function () {
    const dir = path.join(assets, 'ctan-tensor');
    if (!existsSync(path.join(dir, 'tensor.dtx'))) {
      this.skip();
    }
    const doc = path.join(tmp, 'live-doc');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{lipsum}', '\\begin{document}', '\\lipsum[1-60]', '\\end{document}']));
    const outcomes: CompileOutcome[] = [];
    let cancels = 0;
    const scheduler = new CompileScheduler({
      pauseMs: () => 50,
      mode: () => 'pause',
      hasState: () => true,
      run: async () => {
        const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', pass: 'full' });
        const { result } = await engine.compile(prepared.job);
        const outcome = { cancelled: result.error === 'cancelled', pdf: result.pdf !== null, wantsFullPass: false };
        outcomes.push(outcome);
        return outcome;
      },
      cancelRunning: () => {
        cancels++;
        void engine.cancel();
      },
    });
    try {
      scheduler.request('doc');
      await new Promise((resolve) => setTimeout(resolve, 300)); // the compile is running now
      const picked = ['tensor.dtx', 'tensor.ins'].map((name) => ({ name, data: new Uint8Array(readFileSync(path.join(dir, name))) }));
      const building = preparePackages(picked, runIns(scheduler));
      setTimeout(() => scheduler.edit('doc'), 100); // typing while the build waits or runs
      const prepared = await building;
      assert.deepEqual(prepared.built, ['tensor.sty']);
      while (outcomes.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(outcomes.map((o) => o.cancelled), [false, false], 'a compile was cancelled');
      assert.equal(cancels, 0);
    } finally {
      scheduler.dispose();
    }
  });

  it('G2E-02: the user\'s package files cross in the change sets: the second compile sends none of them', async function () {
    const dir = path.join(assets, 'ctan-tensor');
    if (!existsSync(path.join(dir, 'tensor.dtx'))) {
      this.skip();
    }
    const scheduler = new CompileScheduler({ pauseMs: () => 50, mode: () => 'pause', hasState: () => true, run: async () => ({ cancelled: false, pdf: false, wantsFullPass: false }), cancelRunning: () => undefined });
    const picked = ['tensor.dtx', 'tensor.ins'].map((name) => ({ name, data: new Uint8Array(readFileSync(path.join(dir, name))) }));
    const user = new UserPackages(path.join(tmp, 'globalStorage-g2', 'packages'));
    await user.add(await preparePackages(picked, runIns(scheduler)));
    scheduler.dispose();
    const set = await user.set();
    assert.ok(set);
    const doc = path.join(tmp, 'tensor-sets');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{tensor}', '\\begin{document}', '$\\tensor{T}{^a_b}$', '\\end{document}']));
    const compile = async () => {
      const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([set]) });
      assert.ok(prepared.job.texmfFiles?.some((f) => f.path === 'tex/latex/tensor/tensor.sty'));
      return (await engine.compile(prepared.job, 'g2-user-sets')).result;
    };
    const r1 = await compile();
    assert.ok(r1.pdf);
    const firstSent = engine.lastTransfer?.changed ?? 0;
    const r2 = await compile();
    assert.ok(r2.pdf, r2.log.split('\n').slice(-8).join('\n'));
    assert.match(r2.log, /\/texmf-home\/tex\/latex\/tensor\/tensor\.sty/);
    assert.deepEqual([engine.lastTransfer?.full, engine.lastTransfer?.changed], [false, 0]);
    assert.ok(firstSent >= 2, `the first compile sent ${firstSent} files`);
  });
});
