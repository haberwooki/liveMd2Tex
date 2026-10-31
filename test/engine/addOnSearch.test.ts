// Lookups in the data images' tree (/texmf-extra) on the real engine. kpathsea finds an add-on's files from the
// tree's ls-R, which the engine host writes from the files it mounted there (src/engine-host/engine/lsR.ts): our
// texmf.cnf lists the tree in TEXMFDBS and TEXMFHOME marks it "!!". So neither a file the add-on has nor a file
// nobody has starts a search of the tree's folders on disk, which with the real add-on's thousands of folders made
// a compile up to a hundred times slower. The user's own package folder has no ls-R and keeps its disk search.
// kpathsea's "stat" debugging (-kpathsea-debug=1) prints a dir_links line for each folder a disk search visits.
// The "not found once, then the image is mounted" route is gate2.test.ts's.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData, readDataExtension, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { ENGINE_FORMATS, type CompileJob } from '../../src/shared/engineJobs';
import { buildPackageIndex } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';

const tex = (lines: string[]) => `${lines.join('\n')}\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
/** A folder kpathsea visited on disk, in its stat debugging. */
const diskSearch = (transcript: string, top: string) => transcript.split('\n').filter((l) => l.includes(`dir_links(${top}`));

describe('lookups in the data images\' tree: from its ls-R, never a search on disk', function () {
  this.timeout(600000);
  let engine: EngineService;
  let tmp = '';
  let core: Awaited<ReturnType<typeof readCoreData>>;
  let expected: Expected;

  before(async function () {
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json'))) {
      this.skip();
    }
    engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-addonsearch-'));
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
  async function dataExtension(name: string, files: Record<string, string>): Promise<string> {
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>): { data: Buffer; index: unknown; sha256: string } }>('scripts/lib/data-image.mjs');
    const image = buildDataImage(new Map(Object.entries(files).map(([k, v]) => [k, bytes(v)])));
    const folder = path.join(tmp, 'extensions', name);
    mkdirSync(path.join(folder, 'data'), { recursive: true });
    writeFileSync(path.join(folder, 'data', 'extra.data'), image.data);
    writeFileSync(path.join(folder, 'data', 'extra.index.json'), JSON.stringify(image.index));
    const index = buildPackageIndex(Object.keys(files).filter((f) => f !== 'ls-R'), (rel) => files[rel]);
    const manifest = { format: 1, version: '1', texLive: expected.texLive, abi: expected.abi, image: { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256 }, index };
    writeFileSync(path.join(folder, 'data', 'manifest.json'), JSON.stringify(manifest));
    return folder;
  }

  /** The image's files, and folders around them, as a real add-on spreads its files over many folders. */
  const filesA: Record<string, string> = {
    'tex/latex/aopkg/aopkg.sty': tex(['\\ProvidesPackage{aopkg}[2026/10/31 add-on lookup test]', '\\input{aopkg-data.def}']),
    'tex/latex/aopkg/aopkg-data.def': tex(['\\typeout{AO-DATA-LOADED}']),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tex/latex/aofill${i}/sub/aofill${i}.tex`, tex([`% ${i}`])])),
  };
  const filesB: Record<string, string> = {
    'tex/latex/bopkg/bopkg.sty': tex(['\\ProvidesPackage{bopkg}[2026/10/31 add-on lookup test]', '\\typeout{BO-PKG-LOADED}']),
  };

  /** The job the extension prepares for main.tex, run as one pdfLaTeX pass with kpathsea's stat debugging. */
  async function debugJob(doc: string, installed: Parameters<typeof packageContext>[1]): Promise<CompileJob> {
    const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: packageContext(core, installed) });
    return {
      ...prepared.job,
      // A package of the user's own (TEXMFHOME's other folder, searched on disk).
      texmfFiles: [{ path: 'tex/latex/userpkg/userpkg.sty', data: bytes(tex(['\\ProvidesPackage{userpkg}', '\\typeout{USER-PKG-LOADED}'])) }],
      steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-kpathsea-debug=1', '-fmt', ENGINE_FORMATS.pdflatex, 'main.tex']],
      readBack: ['/texmf-extra/ls-R'],
    };
  }

  it('an add-on\'s file and a missing file are each found or refused without a disk search; the user\'s folder is searched on disk', async () => {
    const extra = await readDataExtension(await dataExtension('ao-a', filesA), 'ao-a', expected);
    assert.ok('image' in extra, 'problem' in extra ? extra.problem : '');
    const doc = path.join(tmp, 'doc-a');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex([
      '\\documentclass{article}',
      '\\usepackage{aopkg}',
      '\\usepackage{userpkg}',
      '\\IfFileExists{ao-nobody-has-this.sty}{\\typeout{AO-MISSING-FOUND}}{\\typeout{AO-MISSING-REFUSED}}',
      '\\begin{document}',
      'Text.',
      '\\end{document}',
    ]));
    const job = await debugJob(doc, [extra]);
    assert.deepEqual(job.dataImages?.map((i) => i.id), ['ao-a']);
    const { result } = await engine.compile(job);
    assert.ok(result.pdf, result.log.split('\n').slice(-10).join('\n'));
    assert.match(result.log, /AO-DATA-LOADED/);
    assert.match(result.log, /\/texmf-extra\/tex\/latex\/aopkg\/aopkg-data\.def/);
    assert.match(result.log, /AO-MISSING-REFUSED/);
    assert.match(result.log, /USER-PKG-LOADED/);
    // The debugging works, and the user's folder is still searched on disk.
    assert.ok(diskSearch(result.transcript, '/texmf-home').length > 0, 'no disk search of /texmf-home: is -kpathsea-debug=1 printed?');
    assert.deepEqual(diskSearch(result.transcript, '/texmf-extra'), [], 'the add-on tree was searched on disk');
    assert.match(result.readBack?.['/texmf-extra/ls-R'] ?? '', /^aopkg-data\.def$/m);
  });

  it('a second image mounted beside the first: its files are in the tree\'s ls-R too, though the first image has its own', async () => {
    // An image with its own ls-R, which lists only its files (the add-on's builder writes one).
    const { lsR } = await importScript<{ lsR(p: Iterable<string>): string }>('scripts/lib/texmf-config.mjs');
    const a = await readDataExtension(await dataExtension('ao-a2', { ...filesA, 'ls-R': lsR(Object.keys(filesA)) }), 'ao-a2', expected);
    const b = await readDataExtension(await dataExtension('ao-b', filesB), 'ao-b', expected);
    assert.ok('image' in a && 'image' in b);
    const doc = path.join(tmp, 'doc-ab');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{aopkg}', '\\usepackage{bopkg}', '\\begin{document}', 'Text.', '\\end{document}']));
    const { result } = await engine.compile(await debugJob(doc, [a, b]));
    assert.ok(result.pdf, result.log.split('\n').slice(-10).join('\n'));
    assert.match(result.log, /AO-DATA-LOADED/);
    assert.match(result.log, /BO-PKG-LOADED/);
    assert.deepEqual(diskSearch(result.transcript, '/texmf-extra'), []);
    const list = result.readBack?.['/texmf-extra/ls-R'] ?? '';
    assert.match(list, /^aopkg\.sty$/m);
    assert.match(list, /^bopkg\.sty$/m);
  });
});
