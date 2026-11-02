// Fonts by name on the real engine, through the font lists XeTeX's fontconfig stand-in reads (each image's
// fonts/xetex-fonts.tsv, joined by the engine host; docs/DESIGN.md, "Engine and data"), and fonts that only an add-on
// holds (B1: the Extra Packages add-on holds bookman, charter, utopia, more OpenType fonts):
// - XeLaTeX finds the core's fonts by name (DejaVu Serif with its bold and italic faces, from the files the rules
//   choose; Latin Modern Roman). With LIVEMD2TEX_FONT_LIST_CHECK set the stand-in reports every name two faces of the
//   shipped lists share: on the core alone and with the real add-on mounted, the reported names are exactly the
//   names of the data builder's fontOrder rules for the mounted sets, and the face first in the list is each rule's;
// - an add-on's TrueType font by name: not found while the add-on is not mounted (with help), then the next compile
//   mounts it and XeTeX finds the font through the add-on's own list;
// - an updated add-on: its new list is the one read;
// - a Type 1 font file pdfTeX cannot open, which the add-on holds: the message has help and names the add-on, and
//   the next compile mounts it.
// The add-on's fonts are DejaVu files of the pinned CTAN set with their names changed (same length, so no table
// moves): DejaVu is in the core, and an add-on font must have names of its own. cmr10's files under another name
// stand in for a Type 1 font.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { diagnosticsFor, imagesForNotFound, prepareCompile, type PackageContext } from '../../src/extension/compile/pipeline';
import { withErrorHelp } from '../../src/extension/diagnostics/errorHelp';
import { packageContext, readCoreData, readDataExtension, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { buildPackageIndex } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { needAddOn, stagedEngine } from './support';

const assets = path.resolve(root, '..', 'engine_assets');
const dejavu = path.join(assets, 'ctan-dejavu', 'truetype', 'DejaVuSans.ttf');
const tex = (lines: string[]) => `${lines.join('\n')}\n`;

/**
 * A copy of a font whose name table says `to` wherever it said `from` (both spellings: one byte per character and
 * UTF-16BE), the two of the same length, so no offset in the file moves. FreeType and the list writer read the
 * names from that table; neither checks the table's checksum.
 */
function renamed(font: Buffer, pairs: [string, string][]): Buffer {
  const out = Buffer.from(font);
  const tables = out.readUInt16BE(4);
  let start = -1;
  let length = 0;
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (out.toString('latin1', at, at + 4) === 'name') {
      start = out.readUInt32BE(at + 8);
      length = out.readUInt32BE(at + 12);
    }
  }
  assert.ok(start >= 0, 'the font has no name table');
  for (const [from, to] of pairs) {
    assert.equal(from.length, to.length);
    for (const [a, b] of [
      [Buffer.from(from, 'latin1'), Buffer.from(to, 'latin1')],
      [Buffer.from(from, 'utf16le').swap16(), Buffer.from(to, 'utf16le').swap16()],
    ]) {
      for (let i = out.indexOf(a, start); i >= 0 && i < start + length; i = out.indexOf(a, i + 1)) {
        b.copy(out, i);
      }
    }
  }
  return out;
}

describe('fonts by name, and fonts that only an add-on holds (engine)', function () {
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
    if (!stagedEngine(this)) {
      return;
    }
    // The renamed fonts come from the pinned CTAN set (npm run engine:assets).
    if (!existsSync(dejavu)) {
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

  /**
   * A data extension folder holding the given texmf files as one image, in the contract's layout, with the font list
   * the data builder writes for its OpenType and TrueType files (fonts/xetex-fonts.tsv, by the image's own paths).
   */
  async function dataExtension(name: string, files: Record<string, Uint8Array>): Promise<string> {
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>): { data: Buffer; index: unknown; sha256: string } }>('scripts/lib/data-image.mjs');
    const fl = await importScript<{ describeFile(b: Uint8Array, file: string): { faces: unknown[] }; listLine(f: unknown): string; isListedFontPath(p: string): boolean }>('scripts/lib/font-list.mjs');
    const lines = Object.entries(files)
      .filter(([p]) => fl.isListedFontPath(p))
      .flatMap(([p, b]) => fl.describeFile(b, `/${p}`).faces.map((f) => fl.listLine(f)));
    const image = buildDataImage(new Map([...Object.entries(files), ['fonts/xetex-fonts.tsv', new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')]]));
    const folder = path.join(tmp, 'extensions', name);
    mkdirSync(path.join(folder, 'data'), { recursive: true });
    writeFileSync(path.join(folder, 'data', 'extra.data'), image.data);
    writeFileSync(path.join(folder, 'data', 'extra.index.json'), JSON.stringify(image.index));
    const index = buildPackageIndex(Object.keys(files), () => '');
    const manifest = { format: 1, version: '1', texLive: expected.texLive, abi: expected.abi, image: { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256 }, index };
    writeFileSync(path.join(folder, 'data', 'manifest.json'), JSON.stringify(manifest));
    return folder;
  }

  /** A file of the core image, by its path in the image. */
  async function coreFile(name: string): Promise<Buffer> {
    const { openImage } = await importScript<{ openImage(p: string, c: unknown): { read(s: number, e: number): Buffer } }>('scripts/lib/image-files.mjs');
    const assets = bundledEngineAssets(root);
    assert.ok(assets, 'the core data is not staged');
    const index = JSON.parse(readFileSync(assets.index, 'utf8')) as { compressed: unknown; metadata: { files: { filename: string; start: number; end: number }[] } };
    const f = index.metadata.files.find((x) => x.filename.endsWith(name));
    assert.ok(f, name);
    return openImage(assets.data, index.compressed).read(f.start, f.end);
  }

  const fontDoc = (name: string, lines: string[]) => {
    const folder = path.join(tmp, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'main.tex'), tex(['% !TEX program = xelatex', '\\documentclass{article}', '\\usepackage{fontspec}', ...lines, '\\begin{document}', 'Text, \\textbf{bold} and \\textit{italic}.', '\\end{document}']));
    return folder;
  };

  /** The BaseFont names of a PDF's fonts, its object streams read too. */
  async function pdfFonts(pdf: Uint8Array | null): Promise<string[]> {
    assert.ok(pdf, 'no PDF');
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const names: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) {
        const base = obj.get(PDFName.of('BaseFont'));
        if (base) names.push(base.toString().replace(/^\//, ''));
      }
    }
    return names;
  }

  type Rule = { name: string; first: string };
  const rules = (): Record<'core-data' | 'extra-data', Rule[]> => {
    const sets = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-sets.json'), 'utf8')) as Record<string, { fontOrder?: Rule[] }>;
    return { 'core-data': sets['core-data'].fontOrder ?? [], 'extra-data': sets['extra-data'].fontOrder ?? [] };
  };

  /**
   * The stand-in's collision report against the rules: the names it reports are exactly the rules' names, and for
   * each reported pair of lines of /engine/fonts.list the first is the rule's file. Returns the number of lines.
   */
  function checkReport(transcript: string, list: string, ruleList: Rule[], what: string): number {
    const lines = list.split('\n');
    const byName = new Map(ruleList.map((r) => [r.name, r.first]));
    const reported = transcript.split('\n').filter((l) => l.startsWith('fonts.list:'));
    assert.ok(reported.length > 0, `${what}: the stand-in reported nothing (does LIVEMD2TEX_FONT_LIST_CHECK reach it?)`);
    // The stand-in reports the pairs of neighbouring lines that share a name, so a name three faces share comes in
    // two pairs; the first of all its lines is the face XeTeX uses.
    const firstLine = new Map<string, number>();
    for (const line of reported) {
      const m = /^fonts\.list: .*? "([^"]+)" on lines (\d+) and (\d+); the first is used/.exec(line);
      assert.ok(m, `${what}: an unexpected report line: ${line}`);
      const [, name, a, b] = m;
      assert.ok(byName.has(name), `${what}: "${name}" is reported, and no rule decides it`);
      firstLine.set(name, Math.min(firstLine.get(name) ?? Infinity, Number(a), Number(b)));
    }
    for (const [name, first] of firstLine) {
      assert.equal(lines[first - 1]?.split('\t')[0], byName.get(name), `${what}: the face first in the list for "${name}" is not the rule's`);
    }
    assert.deepEqual([...firstLine.keys()].sort(), [...byName.keys()].sort(), `${what}: the reported names are the rules' names`);
    return reported.length;
  }

  it("XeLaTeX finds the core's fonts by name through the core's list, bold and italic from the rules' files; the stand-in's report matches the rules", async () => {
    const coreAssets = bundledEngineAssets(root);
    assert.ok(coreAssets);
    // The stand-in's collision report, which the engine host never asks for, on the shipped list.
    const engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => ({ ...coreAssets, env: { LIVEMD2TEX_FONT_LIST_CHECK: '1' } }), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    try {
      for (const [name, font] of [
        ['core-serif', 'DejaVu Serif'],
        ['core-lm', 'Latin Modern Roman'],
      ]) {
        const prepared = await prepareCompile({ fs: nodeFs(fontDoc(name, [`\\setmainfont{${font}}`])), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([]) });
        const r = (await engine.compile({ ...prepared.job, readBack: ['/engine/fonts.list'] })).result;
        assert.ok(r.pdf, `${font}: ${r.log.split('\n').slice(-15).join('\n')}`);
        assert.doesNotMatch(r.log, /cannot be\s+found/, font);
        // DejaVu Serif's bold and italic faces are found by its family names; Latin Modern's optical families are
        // fontspec's business, as on any TeX Live.
        if (font === 'DejaVu Serif') {
          assert.doesNotMatch(r.log, /Font shape .* undefined/, font);
          // The bold face is the file the rule "DejaVu Serif Bold" chooses, not the condensed face of the same name:
          // the PDF embeds DejaVuSerif-Bold (its PostScript name), and no condensed face.
          const fonts = await pdfFonts(r.pdf);
          assert.ok(fonts.some((n) => /\+DejaVuSerif-Bold$/.test(n)), fonts.join(' '));
          assert.ok(!fonts.some((n) => /Condensed/.test(n)), fonts.join(' '));
        }
        // The stand-in reports every name two faces share; on the core's list they are exactly core-data's rules.
        checkReport(r.transcript, r.readBack?.['/engine/fonts.list'] ?? '', rules()['core-data'], `core only (${font})`);
      }
    } finally {
      await engine.stop();
    }
  });

  it("with the add-on mounted, the stand-in's report on the joined lists matches both sets' rules", async function () {
    const extra = await needAddOn(this);
    const coreAssets = bundledEngineAssets(root);
    assert.ok(coreAssets);
    const engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => ({ ...coreAssets, env: { LIVEMD2TEX_FONT_LIST_CHECK: '1' } }), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    try {
      const prepared = await prepareCompile({ fs: nodeFs(fontDoc('joined', ['\\setmainfont{DejaVu Serif}'])), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([]) });
      const r = (await engine.compile({ ...prepared.job, dataImages: [extra.image], readBack: ['/engine/fonts.list'] })).result;
      assert.ok(r.pdf, r.log.split('\n').slice(-15).join('\n'));
      const all = [...rules()['core-data'], ...rules()['extra-data']];
      const count = checkReport(r.transcript, r.readBack?.['/engine/fonts.list'] ?? '', all, 'core and add-on');
      console.log(`      ${count} collisions reported, ${all.length} rules`);
    } finally {
      await engine.stop();
    }
  });

  it('XeTeX finds an add-on font by name through the add-on\'s own list, once the add-on is mounted', async () => {
    const font = renamed(readFileSync(dejavu), [
      ['DejaVu Sans', 'Livemd Sans'],
      ['DejaVuSans', 'LivemdSans'],
    ]);
    const folder = await dataExtension('fonts-byname', { 'fonts/truetype/test/livemd/LivemdSans.ttf': font });
    const extra = await readDataExtension(folder, 'livemd2tex-extra-data', expected);
    assert.ok('image' in extra, 'problem' in extra ? extra.problem : '');
    const doc = fontDoc('byname', ['\\setmainfont{Livemd Sans}']);
    const engine = fresh();
    try {
      // Without the add-on installed: the font is not there, and the message has help.
      const without = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([]) });
      const r0 = (await engine.compile(without.job)).result;
      assert.match(r0.log, /The font "Livemd Sans" cannot be\s+found/);
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
      // xdvipdfmx read the font from the add-on's tree (its object streams hide the font's name in the PDF).
      assert.match(r2.transcript, /\/texmf-extra\/fonts\/truetype\/test\/livemd\/LivemdSans\.ttf/);
    } finally {
      await engine.stop();
    }
  });

  it('an updated add-on: the new version\'s list is the one read, and the old version\'s font is gone', async () => {
    const sans = renamed(readFileSync(dejavu), [
      ['DejaVu Sans', 'Livemd Sans'],
      ['DejaVuSans', 'LivemdSans'],
    ]);
    const mono = renamed(readFileSync(path.join(assets, 'ctan-dejavu', 'truetype', 'DejaVuSansMono.ttf')), [
      ['DejaVu Sans Mono', 'Livemd Sans Mono'],
      ['DejaVuSansMono', 'LivemdSansMono'],
    ]);
    // The same folder in both versions, with another font in it.
    const v1 = await readDataExtension(await dataExtension('fonts-v1', { 'fonts/truetype/test/livemd/LivemdSans.ttf': sans }), 'livemd2tex-extra-data', expected);
    const v2 = await readDataExtension(await dataExtension('fonts-v2', { 'fonts/truetype/test/livemd/LivemdSansMono.ttf': mono }), 'livemd2tex-extra-data', expected);
    assert.ok('image' in v1 && 'image' in v2);
    const engine = fresh();
    try {
      const run = async (folder: string, extra: typeof v1) => {
        const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'xelatex', packages: context([extra as never]), mountSets: new Set(['livemd2tex-extra-data']) });
        return (await engine.compile(prepared.job)).result;
      };
      const r1 = await run(fontDoc('v1-doc', ['\\setmainfont{Livemd Sans}']), v1);
      assert.doesNotMatch(r1.log, /cannot be\s+found/, 'version 1 finds its font');
      const r2 = await run(fontDoc('v2-doc', ['\\setmainfont{Livemd Sans Mono}']), v2);
      assert.doesNotMatch(r2.log, /cannot be\s+found/, 'version 2 finds its font');
      assert.match(r2.transcript, /\/texmf-extra\/fonts\/truetype\/test\/livemd\/LivemdSansMono\.ttf/);
      const r3 = await run(fontDoc('v2-old', ['\\setmainfont{Livemd Sans}']), v2);
      assert.match(r3.log, /The font "Livemd Sans" cannot be\s+found/, 'version 1\'s font is gone with version 1');
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
