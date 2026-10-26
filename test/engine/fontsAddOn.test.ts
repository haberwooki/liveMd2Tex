// Fonts that only an add-on holds (B1: the Extra Packages add-on holds bookman, charter, utopia, more OpenType
// fonts), on the real engine, with a made-up add-on:
// - XeTeX finds an add-on's TrueType font by name (engine/fonts.conf names the add-ons' font folders), also after
//   a compile without the add-on made fontconfig's cache: the add-on's folders carry their own time stamp.
// - A font XeTeX cannot find by name, while the add-on is installed but not mounted: the next compile mounts it.
// - A Type 1 font file pdfTeX cannot open, which the add-on holds: the message has help and names the add-on, and
//   the next compile mounts it.
// The interim core (TeXlyre's image) holds no DejaVu, so DejaVu Sans from the pinned CTAN set stands in for an
// add-on font; cmr10's files under another name stand in for a Type 1 font.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diagnosticsFor, imagesForNotFound, prepareCompile, type PackageContext } from '../../src/extension/compile/pipeline';
import { withErrorHelp } from '../../src/extension/diagnostics/errorHelp';
import { packageContext, readCoreData, readDataExtension, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { buildPackageIndex } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';

const assets = path.resolve(root, '..', 'engine_assets');
const dejavu = path.join(assets, 'ctan-dejavu', 'truetype', 'DejaVuSans.ttf');
const tex = (lines: string[]) => `${lines.join('\n')}\n`;

describe('B1: fonts that only an add-on holds (engine)', function () {
  this.timeout(600000);
  let tmp = '';
  let core: Awaited<ReturnType<typeof readCoreData>>;
  let expected: Expected;
  const context = (installed: PackageContext['installed'] = []) => packageContext(core, installed);
  const fresh = () => {
    const engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    return engine;
  };

  before(async function () {
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json')) || !existsSync(dejavu)) {
      this.skip();
    }
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-fonts-'));
    core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index);
    expected = { texLive: core.manifest.texLive, abi: core.manifest.abi };
  });

  after(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /** A data extension folder holding the given texmf files as one image, in the contract's layout. */
  async function dataExtension(name: string, files: Record<string, Uint8Array>): Promise<string> {
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>): { data: Buffer; index: unknown; sha256: string } }>('scripts/lib/data-image.mjs');
    const image = buildDataImage(new Map(Object.entries(files)));
    const folder = path.join(tmp, 'extensions', name);
    mkdirSync(path.join(folder, 'data'), { recursive: true });
    writeFileSync(path.join(folder, 'data', 'extra.data'), image.data);
    writeFileSync(path.join(folder, 'data', 'extra.index.json'), JSON.stringify(image.index));
    const index = buildPackageIndex(Object.keys(files), () => '');
    const manifest = { format: 1, version: '1', texLive: expected.texLive, abi: expected.abi, image: { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256 }, index };
    writeFileSync(path.join(folder, 'data', 'manifest.json'), JSON.stringify(manifest));
    return folder;
  }

  /** A file of the interim core image, by its path in the image. */
  async function coreFile(name: string): Promise<Buffer> {
    const { openImage } = await importScript<{ openImage(p: string, c: unknown): { read(s: number, e: number): Buffer } }>('scripts/lib/image-files.mjs');
    const index = JSON.parse(readFileSync(path.join(root, 'dist', 'data', 'texlive-extra.index.json'), 'utf8')) as { compressed: unknown; metadata: { files: { filename: string; start: number; end: number }[] } };
    const f = index.metadata.files.find((x) => x.filename.endsWith(name));
    assert.ok(f, name);
    return openImage(path.join(root, 'dist', 'data', 'texlive-extra.data'), index.compressed).read(f.start, f.end);
  }

  it('XeTeX finds an add-on font by name, also after a compile without the add-on made the font cache', async () => {
    const folder = await dataExtension('fonts-byname', { 'fonts/truetype/public/dejavu/DejaVuSans.ttf': readFileSync(dejavu) });
    const extra = await readDataExtension(folder, 'livemd2tex-extra-data', expected);
    assert.ok('image' in extra, 'problem' in extra ? extra.problem : '');
    const doc = path.join(tmp, 'byname');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'main.tex'), tex(['% !TEX program = xelatex', '\\documentclass{article}', '\\usepackage{fontspec}', '\\setmainfont{DejaVu Sans}', '\\begin{document}', 'Text.', '\\end{document}']));
    const engine = fresh();
    try {
      // First a compile without the add-on installed: fontconfig makes its cache, and the font is not there.
      const without = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([]) });
      const r0 = (await engine.compile(without.job)).result;
      assert.match(r0.log, /The font "DejaVu Sans" cannot be\s+found/);
      const help = withErrorHelp(diagnosticsFor(r0, without));
      assert.ok(help.some((d) => d.help?.id === 'font-name-not-found'), JSON.stringify(help.map((d) => d.message)));
      // Installed but not asked for (the scan does not read font names): the font is not found, and the next
      // compile mounts the add-on.
      const first = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([extra]) });
      assert.equal(first.job.dataImages, undefined);
      const r1 = (await engine.compile(first.job)).result;
      assert.match(r1.log, /cannot be\s+found/);
      const more = imagesForNotFound(r1, first);
      assert.deepEqual(more, ['livemd2tex-extra-data']);
      const second = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([extra]), mountSets: new Set(more) });
      const r2 = (await engine.compile(second.job)).result;
      assert.ok(r2.pdf, r2.log.split('\n').slice(-15).join('\n'));
      assert.doesNotMatch(r2.log, /cannot be\s+found/);
      // xdvipdfmx read the font from the add-on's folder (its object streams hide the font's name in the PDF).
      assert.match(r2.transcript, /\/texmf-extra\/fonts\/truetype\/public\/dejavu\/DejaVuSans\.ttf/);
    } finally {
      await engine.stop();
    }
  });

  it('an updated add-on: XeTeX finds its new fonts by name, though the font cache knew the old version\'s folder', async () => {
    const mono = readFileSync(path.join(assets, 'ctan-dejavu', 'truetype', 'DejaVuSansMono.ttf'));
    // The same folder in both versions, with other fonts in it.
    const v1 = await readDataExtension(await dataExtension('fonts-v1', { 'fonts/truetype/public/dejavu/DejaVuSansMono.ttf': mono }), 'livemd2tex-extra-data', expected);
    const v2 = await readDataExtension(await dataExtension('fonts-v2', { 'fonts/truetype/public/dejavu/DejaVuSans.ttf': readFileSync(dejavu) }), 'livemd2tex-extra-data', expected);
    assert.ok('image' in v1 && 'image' in v2);
    const doc = (name: string, font: string) => {
      const folder = path.join(tmp, name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'main.tex'), tex(['\\documentclass{article}', '\\usepackage{fontspec}', `\\setmainfont{${font}}`, '\\begin{document}', 'Text.', '\\end{document}']));
      return folder;
    };
    const engine = fresh();
    try {
      const run = async (folder: string, extra: typeof v1) => {
        const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([extra as never]), mountSets: new Set(['livemd2tex-extra-data']) });
        return (await engine.compile(prepared.job)).result;
      };
      const r1 = await run(doc('v1-doc', 'DejaVu Sans Mono'), v1);
      assert.doesNotMatch(r1.log, /cannot be\s+found/, 'version 1 finds its font');
      const r2 = await run(doc('v2-doc', 'DejaVu Sans'), v2);
      assert.doesNotMatch(r2.log, /cannot be\s+found/, 'version 2 finds its font: the folder was scanned again');
      assert.match(r2.transcript, /\/texmf-extra\/fonts\/truetype\/public\/dejavu\/DejaVuSans\.ttf/);
    } finally {
      await engine.stop();
    }
  });

  it('a Type 1 font file only the add-on holds: help that names the add-on, then the add-on is mounted', async () => {
    const tfm = await coreFile('/fonts/tfm/public/cm/cmr10.tfm');
    const pfb = await coreFile('/fonts/type1/public/amsfonts/cm/cmr10.pfb');
    // The add-on holds the Type 1 file; the document brings its metrics and its map line.
    const folder = await dataExtension('fonts-type1', { 'fonts/type1/public/b1probe/b1probe.pfb': pfb });
    const extra = await readDataExtension(folder, 'livemd2tex-extra-data', expected);
    assert.ok('image' in extra);
    const doc = path.join(tmp, 'type1');
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'b1probe.tfm'), tfm);
    writeFileSync(path.join(doc, 'main.tex'), tex(['\\documentclass{article}', '\\pdfmapline{+b1probe CMR10 <b1probe.pfb}', '\\font\\probe=b1probe', '\\begin{document}', '{\\probe Text.}', '\\end{document}']));
    const engine = fresh();
    try {
      const first = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([extra]) });
      const r1 = (await engine.compile(first.job)).result;
      assert.equal(r1.pdf, null);
      assert.match(r1.log, /\(file b1probe\.pfb\): cannot open Type 1 font file for reading/);
      const shown = withErrorHelp(diagnosticsFor(r1, first)).find((d) => d.help?.id === 'font-file-missing');
      assert.ok(shown, 'the error has help');
      assert.match(shown.message, /pdfTeX error: \(file b1probe\.pfb\): cannot open Type 1 font file for reading \(b1probe\.pfb is in package b1probe, in the Extra Packages add-on\)/);
      const more = imagesForNotFound(r1, first);
      assert.deepEqual(more, ['livemd2tex-extra-data']);
      const second = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: context([extra]), mountSets: new Set(more) });
      const r2 = (await engine.compile(second.job)).result;
      assert.ok(r2.pdf, r2.log.split('\n').slice(-15).join('\n'));
      assert.doesNotMatch(r2.log, /cannot open Type 1 font file/);
    } finally {
      await engine.stop();
    }
  });
});
