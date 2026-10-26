// B1's acceptance check on the built bundle (docs/DESIGN.md#engine-and-data, #testing): the public corpus, compiled through the
// extension's route with core-data's image (and extra-data's mounted), and its page counts. The bundle workflow
// runs it after scripts/build-bundle.mjs, with LIVEMD2TEX_BUNDLE_OUT naming the build's folder; it writes the
// materialized corpus, each document's log (<main>.bundle.log) and the page counts there, and
// scripts/bundle-reference.mjs compiles the same folders with
// a full TeX Live and compares. Then the core's packed Type 1 fonts (t1c): each unpacks to its original, the
// engine reads each one as the original (pdfTeX's MD5 of the file), and the corpus gives the same PDFs with the
// fonts packed and unpacked. Skipped without LIVEMD2TEX_BUNDLE_OUT (it never runs on a development machine).

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData, readDataExtension } from '../../src/extension/engine/dataSets';
import { EngineService } from '../../src/extension/engine/engineService';
import { EXTRA_DATA_NAME } from '../../src/shared/identity';
import { t1cUnpack } from '../../src/engine-host/engine/t1c';
import { materializeCorpus } from '../support/corpusProjects';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';

describe('B1: the public corpus on the built bundle', function () {
  this.timeout(1800000);
  const out = process.env.LIVEMD2TEX_BUNDLE_OUT ?? '';
  const engineDir = path.join(root, 'dist', 'engine');

  /** The extension's engine on a core image: the built core-data's, or another image given as { file, index }. */
  function coreEngine(coreDir: string, image?: { file: string; index: string }): EngineService {
    const manifest = image ?? (JSON.parse(readFileSync(path.join(coreDir, 'manifest.json'), 'utf8')) as { image: { file: string; index: string } }).image;
    return new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => ({
        glue: path.join(engineDir, 'busytex.js'),
        wasm: path.join(engineDir, 'busytex.wasm'),
        cnfOverride: path.join(engineDir, 'texmf-override.cnf'),
        fontsConf: path.join(engineDir, 'fonts.conf'),
        data: path.join(coreDir, manifest.file),
        loader: path.join(coreDir, manifest.index),
      }),
      idleMinutes: () => 0,
      log: () => undefined,
    });
  }

  it('compiles P1 to P8 on core-data with extra-data mounted, and writes the page counts', async function () {
    if (!out || !existsSync(path.join(out, 'core-data', 'data', 'manifest.json'))) {
      this.skip();
    }
    const coreDir = path.join(out, 'core-data', 'data');
    const core = await readCoreData(coreDir);
    assert.ok(core?.index, 'core-data has no package index');
    const manifest = core.manifest as typeof core.manifest & { image: { file: string; index: string } };
    const extra = await readDataExtension(path.join(out, 'extra-data'), EXTRA_DATA_NAME, { texLive: manifest.texLive, abi: manifest.abi, snapshot: manifest.snapshot });
    assert.ok(!('problem' in extra), 'problem' in extra ? extra.problem : '');
    const engine = coreEngine(coreDir);
    try {
      const corpus = path.join(out, 'corpus');
      mkdirSync(corpus, { recursive: true });
      const projects = (await materializeCorpus(corpus, docstripWith(engine), { includePrivate: false })).filter((p) => /^P[1-8]$/.test(p.id));
      const documents: Record<string, { folder: string; main: string; engine: string; pages: number | null; missing: string[] }> = {};
      for (const p of projects) {
        const packages = packageContext({ index: core.index, elsewhere: core.elsewhere }, 'set' in extra ? [extra] : []);
        const prepared = await prepareCompile({ fs: nodeFs(p.folder), mainRel: p.main, engineSetting: 'pdflatex', packages });
        const { result } = await engine.compile(prepared.job);
        // The log beside the document, so the workflow's corpus artifact shows why a compile failed.
        writeFileSync(path.join(p.folder, p.main.replace(/\.tex$/i, '.bundle.log')), result.log ?? '');
        documents[p.id] = {
          folder: path.relative(out, p.folder).replace(/\\/g, '/'),
          main: p.main,
          engine: prepared.engine.engine,
          pages: result.pdf ? (await PDFDocument.load(result.pdf)).getPageCount() : null,
          missing: (prepared.packageScan?.missing ?? []).map((m) => m.file).sort(),
        };
      }
      writeFileSync(path.join(out, 'corpus-bundle.json'), `${JSON.stringify({ image: manifest.image, documents }, null, 2)}\n`);
      console.log(`      ${Object.entries(documents).map(([id, d]) => `${id} ${d.pages ?? 'no'} page(s)${d.missing.length ? `, missing ${d.missing.join(' ')}` : ''}`).join('; ')}`);
      for (const [id, d] of Object.entries(documents)) {
        assert.ok(d.pages !== null, `${id}: no PDF`);
        assert.deepEqual(d.missing, [], `${id}: missing ${d.missing.join(', ')}`);
      }
    } finally {
      await engine.stop();
    }
  });

  // t1c (font packing: decided by the maintainer, 2026-10-22): core-data stores its Type 1 fonts packed.

  /** The built core image's files, read as stored, and its packed list (file name -> SHA-256 of the original). */
  async function coreFiles(): Promise<{ files: Map<string, Buffer>; packed: Record<string, string>; coreDir: string }> {
    const coreDir = path.join(out, 'core-data', 'data');
    const manifest = JSON.parse(readFileSync(path.join(coreDir, 'manifest.json'), 'utf8')) as { image: { file: string; index: string; packed?: { method: string; files: Record<string, string> } } };
    const index = JSON.parse(readFileSync(path.join(coreDir, manifest.image.index), 'utf8')) as { compressed: unknown; metadata: { files: { filename: string; start: number; end: number }[]; packed?: { method: string; files: Record<string, string> } } };
    assert.deepEqual(index.metadata.packed, manifest.image.packed, 'the index and the manifest name the same packed files');
    const { openImage } = await importScript<{ openImage(p: string, c: unknown): { read(s: number, e: number): Buffer } }>('scripts/lib/image-files.mjs');
    const reader = openImage(path.join(coreDir, manifest.image.file), index.compressed);
    return { files: new Map(index.metadata.files.map((f) => [f.filename, reader.read(f.start, f.end)])), packed: index.metadata.packed?.files ?? {}, coreDir };
  }

  /** A PDF with its streams inflated and without what changes from run to run (dates, ID, subset tags, lengths). */
  function normalized(pdf: Uint8Array): string {
    const text = Buffer.from(pdf).toString('latin1');
    const inflated = text.replace(/(\/FlateDecode[^]*?stream\r?\n)([^]*?)(\r?\nendstream)/g, (all: string, head: string, body: string, tail: string) => {
      try {
        return `${head}${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}${tail}`;
      } catch {
        return all;
      }
    });
    return inflated
      .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '')
      .replace(/\/ID\s*\[\s*<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\]/g, '')
      .replace(/\/Length \d+/g, '')
      .replace(/\b[A-Z]{6}\+/g, '');
  }

  it('t1c: every packed font of core-data unpacks to its original, byte for byte', async function () {
    if (!out || !existsSync(path.join(out, 'core-data', 'data', 'manifest.json'))) {
      this.skip();
    }
    const { files, packed } = await coreFiles();
    const { t1cUnpack: builderUnpack } = await importScript<{ t1cUnpack(b: Uint8Array): Uint8Array }>('scripts/lib/t1c.mjs');
    const names = Object.keys(packed);
    assert.ok(names.length > 500, `${names.length} packed fonts`);
    assert.deepEqual(names.filter((n) => !n.endsWith('.pfb')), []);
    for (const name of names) {
      const stored = files.get(name);
      assert.ok(stored, name);
      const original = t1cUnpack(stored);
      assert.equal(createHash('sha256').update(original).digest('hex'), packed[name], name);
      assert.ok(Buffer.from(builderUnpack(stored)).equals(Buffer.from(original)), name);
    }
    console.log(`      ${names.length} packed Type 1 fonts unpack to their originals`);
  });

  it("t1c: the engine reads every packed font as its original (pdfTeX's MD5 of each file)", async function () {
    if (!out || !existsSync(path.join(out, 'core-data', 'data', 'manifest.json'))) {
      this.skip();
    }
    const { files, packed, coreDir } = await coreFiles();
    const names = Object.keys(packed);
    const md5 = new Map(names.map((n) => [n, createHash('md5').update(t1cUnpack(files.get(n) ?? Buffer.alloc(0))).digest('hex').toUpperCase()]));
    const lines = names.map((n, i) => `\\typeout{T1C-MD5 ${i} \\pdfmdfivesum file {${n}}}`);
    const engine = coreEngine(coreDir);
    try {
      const { result } = await engine.compile({
        id: 1,
        main: 'md5.tex',
        files: [{ path: 'md5.tex', data: new TextEncoder().encode(['\\documentclass{article}', ...lines, '\\begin{document}', 'x', '\\end{document}', ''].join('\n')) }],
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: false,
      });
      assert.equal(result.error, undefined, result.error);
      const seen = new Map([...`${result.log}\n${result.transcript}`.matchAll(/T1C-MD5 (\d+) ([0-9A-F]{32})/g)].map((m) => [names[Number(m[1])], m[2]]));
      assert.equal(seen.size, names.length, `the engine read ${seen.size} of ${names.length} fonts`);
      for (const n of names) {
        assert.equal(seen.get(n), md5.get(n), n);
      }
    } finally {
      await engine.stop();
    }
  });

  it('t1c: the corpus gives the same PDFs on core-data with its fonts packed and unpacked', async function () {
    if (!out || !existsSync(path.join(out, 'corpus-bundle.json'))) {
      this.skip();
    }
    const { files, packed, coreDir } = await coreFiles();
    // The same image with every packed font stored as its original.
    const { buildDataImage } = await importScript<{ buildDataImage(f: Iterable<[string, Uint8Array]>, o: unknown): { data: Buffer; index: unknown } }>('scripts/lib/data-image.mjs');
    const plainFiles = new Map([...files].map(([n, b]): [string, Uint8Array] => [n.slice(1), n in packed ? t1cUnpack(b) : b]));
    const image = buildDataImage(plainFiles, { compress: false, strictNames: false });
    const plainDir = path.join(out, 'core-unpacked');
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(path.join(plainDir, 'core.data'), image.data);
    writeFileSync(path.join(plainDir, 'core.index.json'), JSON.stringify(image.index));
    const documents = (JSON.parse(readFileSync(path.join(out, 'corpus-bundle.json'), 'utf8')) as { documents: Record<string, { folder: string; main: string }> }).documents;
    const core = await readCoreData(coreDir);
    assert.ok(core);
    const manifest = core.manifest;
    const extra = await readDataExtension(path.join(out, 'extra-data'), EXTRA_DATA_NAME, { texLive: manifest.texLive, abi: manifest.abi, snapshot: manifest.snapshot });
    assert.ok(!('problem' in extra));
    const packedEngine = coreEngine(coreDir);
    const plainEngine = coreEngine(plainDir, { file: 'core.data', index: 'core.index.json' });
    try {
      for (const [id, doc] of Object.entries(documents)) {
        const prepared = await prepareCompile({ fs: nodeFs(path.join(out, doc.folder)), mainRel: doc.main, engineSetting: 'pdflatex', packages: packageContext({ index: core.index, elsewhere: core.elsewhere }, [extra]) });
        const a = (await packedEngine.compile(prepared.job)).result;
        const b = (await plainEngine.compile(prepared.job)).result;
        assert.ok(a.pdf && b.pdf, `${id}: a PDF on both`);
        assert.equal(normalized(a.pdf), normalized(b.pdf), `${id}: the same PDF with and without packing`);
      }
      console.log(`      ${Object.keys(documents).length} documents give the same PDFs with and without packing`);
    } finally {
      await Promise.all([packedEngine.stop(), plainEngine.stop()]);
    }
  });
});
