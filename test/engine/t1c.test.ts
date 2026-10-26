// t1c on the real engine (B1: the core's Type 1 fonts are stored packed; docs/DESIGN.md#engine-and-data): a data
// image whose index names a packed font. The engine host unpacks it when TeX reads it, so the PDF is the same as
// with the font stored as it is, and TeX's partial reads give the original's bytes; a packed font that does not
// unpack to its original's SHA-256 gives no PDF and a plain message, never other bytes, and so does an index whose
// packed list is not the manifest's. cmr10's Type 1 file under another name stands in for a core font.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData, readDataExtension, type Expected } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { buildPackageIndex } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';

const tex = (lines: string[]) => `${lines.join('\n')}\n`;
const FONT = 'fonts/type1/public/b1probe/b1probe.pfb';

/** A PDF without what changes from run to run: its dates and its ID. */
const stable = (pdf: Uint8Array) =>
  Buffer.from(pdf)
    .toString('latin1')
    .replace(/\/(CreationDate|ModDate) \([^)]*\)/g, '')
    .replace(/\/ID \[<[0-9A-Fa-f]+> <[0-9A-Fa-f]+>\]/g, '');

describe('B1: t1c, packed Type 1 fonts on the engine', function () {
  this.timeout(600000);
  let tmp = '';
  let core: Awaited<ReturnType<typeof readCoreData>>;
  let expected: Expected;
  let pfb: Buffer;
  let tfm: Buffer;

  before(async function () {
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json'))) {
      this.skip();
    }
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-t1c-'));
    core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index);
    expected = { texLive: core.manifest.texLive, abi: core.manifest.abi };
    const { openImage } = await importScript<{ openImage(p: string, c: unknown): { read(s: number, e: number): Buffer } }>('scripts/lib/image-files.mjs');
    const index = JSON.parse(readFileSync(path.join(root, 'dist', 'data', 'texlive-extra.index.json'), 'utf8')) as { compressed: unknown; metadata: { files: { filename: string; start: number; end: number }[] } };
    const reader = openImage(path.join(root, 'dist', 'data', 'texlive-extra.data'), index.compressed);
    const read = (name: string) => {
      const f = index.metadata.files.find((x) => x.filename.endsWith(name));
      assert.ok(f, name);
      return reader.read(f.start, f.end);
    };
    pfb = read('/fonts/type1/public/amsfonts/cm/cmr10.pfb');
    tfm = read('/fonts/tfm/public/cm/cmr10.tfm');
  });

  after(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * A data extension holding the font, stored as `bytes`, with the packed list in the index and the manifest when
   * `packedSha` is given; `manifestPacked: false` leaves the manifest's list out (an index and manifest that disagree).
   */
  async function fontExtension(name: string, bytes: Uint8Array, packedSha?: string, manifestPacked = true): Promise<string> {
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>): { data: Buffer; index: { metadata: Record<string, unknown> }; sha256: string } }>('scripts/lib/data-image.mjs');
    const image = buildDataImage(new Map([[FONT, bytes]]));
    const packed = packedSha ? { packed: { method: 't1c', files: { [`/${FONT}`]: packedSha } } } : {};
    const index = { ...image.index, metadata: { ...image.index.metadata, ...packed } };
    const folder = path.join(tmp, name);
    mkdirSync(path.join(folder, 'data'), { recursive: true });
    writeFileSync(path.join(folder, 'data', 'extra.data'), image.data);
    writeFileSync(path.join(folder, 'data', 'extra.index.json'), JSON.stringify(index));
    const imageEntry = { file: 'extra.data', index: 'extra.index.json', bytes: image.data.length, sha256: image.sha256, ...(manifestPacked ? packed : {}) };
    const manifest = { format: 1, version: '1', texLive: expected.texLive, abi: expected.abi, image: imageEntry, index: buildPackageIndex([FONT], () => '') };
    writeFileSync(path.join(folder, 'data', 'manifest.json'), JSON.stringify(manifest));
    return folder;
  }

  const PROBE = ['\\documentclass{article}', '\\pdfmapline{+b1probe CMR10 <b1probe.pfb}', '\\font\\probe=b1probe', '\\begin{document}', '{\\probe Packed fonts read as the original.}', '\\end{document}'];

  async function compileWith(folderName: string, lines = PROBE) {
    const extra = await readDataExtension(path.join(tmp, folderName), 'livemd2tex-extra-data', expected);
    assert.ok('image' in extra, 'problem' in extra ? extra.problem : '');
    const doc = path.join(tmp, `${folderName}-doc-${lines === PROBE ? 'probe' : 'other'}`);
    mkdirSync(doc, { recursive: true });
    writeFileSync(path.join(doc, 'b1probe.tfm'), tfm);
    writeFileSync(path.join(doc, 'main.tex'), tex(lines));
    const prepared = await prepareCompile({ fs: nodeFs(doc), mainRel: 'main.tex', engineSetting: 'pdflatex', packages: packageContext(core, [extra]), mountSets: new Set(['livemd2tex-extra-data']) });
    const engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    try {
      return (await engine.compile(prepared.job)).result;
    } finally {
      await engine.stop();
    }
  }

  it('a packed font gives the same PDF as the font stored as it is', async () => {
    const { t1cPack } = await importScript<{ t1cPack(b: Uint8Array): Uint8Array | null }>('scripts/lib/t1c.mjs');
    const packed = t1cPack(pfb);
    assert.ok(packed && !Buffer.from(packed).equals(pfb));
    await fontExtension('plain', pfb);
    await fontExtension('packed', packed, createHash('sha256').update(pfb).digest('hex'));
    const plain = await compileWith('plain');
    const unpacked = await compileWith('packed');
    assert.ok(plain.pdf && unpacked.pdf, unpacked.log.split('\n').slice(-10).join('\n'));
    assert.equal(unpacked.error, undefined);
    assert.equal(stable(unpacked.pdf), stable(plain.pdf), 'the same PDF, but for its dates and ID');
  });

  it('a packed font that does not unpack to its original: no PDF, and a plain message', async () => {
    const { t1cPack } = await importScript<{ t1cPack(b: Uint8Array): Uint8Array | null }>('scripts/lib/t1c.mjs');
    const damaged = Buffer.from(t1cPack(pfb) ?? []);
    damaged[damaged.length >> 1] ^= 0x55;
    await fontExtension('damaged', damaged, createHash('sha256').update(pfb).digest('hex'));
    const r = await compileWith('damaged');
    assert.equal(r.pdf, null);
    assert.equal(r.ok, false);
    assert.equal(r.error, "The Extra Packages add-on's TeX data is damaged: the font file b1probe.pfb did not pass its check, so nothing was made from it. Reinstall the add-on.");
    assert.deepEqual(r.damaged, [`/texmf-extra/${FONT}`]);
  });

  it("an index whose packed list is not the manifest's: the image is refused with the plain message (t1c gate, S-1)", async () => {
    const { t1cPack } = await importScript<{ t1cPack(b: Uint8Array): Uint8Array | null }>('scripts/lib/t1c.mjs');
    await fontExtension('mismatch', t1cPack(pfb) ?? new Uint8Array(), createHash('sha256').update(pfb).digest('hex'), false);
    const r = await compileWith('mismatch');
    assert.equal(r.pdf, null);
    assert.equal(r.error, "The Extra Packages add-on's TeX data is damaged: its index and its manifest list different packed fonts, so the engine does not use it. Reinstall the add-on.");
    assert.deepEqual(r.damaged, [`/${FONT}`]);
  });

  it("TeX's partial reads of a packed font give the original's bytes: inside the eexec section, and past the end (t1c gate, S-4)", async () => {
    const { t1cPack } = await importScript<{ t1cPack(b: Uint8Array): Uint8Array | null }>('scripts/lib/t1c.mjs');
    await fontExtension('dump', t1cPack(pfb) ?? new Uint8Array(), createHash('sha256').update(pfb).digest('hex'));
    const eexec = 6 + pfb.readUInt32LE(2) + 6;
    // 16 bytes at most each, so the hex fits on one log line.
    const ranges: [number, number][] = [[0, 16], [eexec + 100, 16], [eexec + 5000, 16], [pfb.length - 10, 16]];
    const file = `/texmf-extra/${FONT}`;
    const lines = ['\\documentclass{article}', ...ranges.map(([at, n], i) => `\\typeout{T1C-DUMP ${i} \\pdffiledump offset ${at} length ${n} {${file}}}`), '\\begin{document}', 'x', '\\end{document}'];
    const r = await compileWith('dump', lines);
    assert.equal(r.error, undefined, r.log.split('\n').slice(-10).join('\n'));
    const seen = new Map([...`${r.log}\n${r.transcript}`.matchAll(/T1C-DUMP (\d) ([0-9A-F]*)/g)].map((m) => [Number(m[1]), m[2]]));
    ranges.forEach(([at, n], i) => assert.equal(seen.get(i), pfb.subarray(at, Math.min(at + n, pfb.length)).toString('hex').toUpperCase(), `range ${i}: ${at}, ${n}`));
    assert.equal(seen.get(3)?.length, 20, 'the range past the end stops at the end');
  });
});
