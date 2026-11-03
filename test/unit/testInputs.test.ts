// The test inputs' release (scripts/lib/test-inputs.mjs, scripts/test-inputs.mjs, scripts/pin-test-inputs.mjs) and
// the fetch of files unpacked from its archives (scripts/engine-assets.mjs). Everything runs on archives made here,
// with no network: the fetch gets a stand-in for fetch.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importScript, root } from '../support/helpers';
import { tarArchive } from '../support/tarWrite';
import { lzma2Encode, xzStream } from '../support/xzEncode';

type Pin = { name: string; size: number; sha256: string; url?: string; from?: string; path?: string };
type Archive = { name: string; url?: string; size: number; sha512: string };
type Source = { id: string; folder: string; files: Pin[]; archives?: Archive[]; release?: string; tag?: string; published?: string | null; note?: string };
type TlPackage = { name: string; containerSize: number; containerChecksum: string; docContainerSize?: number; docContainerChecksum?: string; srcContainerSize?: number; srcContainerChecksum?: string };
interface Lib {
  TEST_INPUTS: Record<string, { package: string; version: string; licence: string; files: Record<string, [string, string]> }>;
  REVTEX: { source: string; file: string };
  TAG: RegExp;
  testInputsTag(snapshot: string, candidate: unknown): string;
  archiveName(pkg: string, kind: string): string;
  packageArchives(db: Map<string, TlPackage>, pkg: string): { name: string; kind: string; size: number; sha512: string }[];
  releaseContents(db: Map<string, TlPackage>, pins: { sources: Source[] }, bundlePins: unknown): { archives: { name: string; package: string }[]; zip: { name: string; sha256: string } };
  archiveProblem(bytes: Buffer, a: Archive & { name: string }): string | null;
  unpackMembers(archive: Uint8Array, paths: string[]): Map<string, Buffer>;
}
interface Assets {
  syncAssets(pins: { sources: Source[] }, root: string, o: { only?: string; verify?: boolean; fetchImpl: (url: string) => Promise<Response>; log: (s: string) => void; error: (s: string) => void }): Promise<{ failures: number; bytes: number }>;
}

const sha = (algo: string, b: Uint8Array | string) => createHash(algo).update(b).digest('hex');
let xzCrc64: (b: Uint8Array) => string;
/** A .tar.xz of `files`, stored (the LZMA2 "uncompressed" chunks), as the xz tests make them. */
const tarXz = (files: Record<string, string>) => {
  const tar = tarArchive(files);
  const chunks = [];
  for (let at = 0; at < tar.length; at += 65536) chunks.push({ kind: 'stored' as const, bytes: Math.min(65536, tar.length - at), dictReset: at === 0 });
  return Buffer.from(xzStream(lzma2Encode(tar, chunks), tar, 4, xzCrc64));
};
const pinOf = (name: string, text: string, extra: Partial<Pin> = {}): Pin => ({ name, size: Buffer.byteLength(text), sha256: sha('sha256', text), ...extra });

describe('the test inputs: one release of whole, unchanged works, and the files unpacked from it', () => {
  let lib: Lib;
  let assets: Assets;
  let tmp = '';
  before(async () => {
    lib = await importScript<Lib>('scripts/lib/test-inputs.mjs');
    assets = await importScript<Assets>('scripts/engine-assets.mjs');
    xzCrc64 = (await importScript<{ crc64(b: Uint8Array): string }>('scripts/lib/xz.mjs')).crc64;
  });
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-inputs-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("names every pinned CTAN file's archive and path, and nothing that is not pinned", () => {
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: Source[] };
    const ctan = pins.sources.filter((s) => s.id.startsWith('ctan-'));
    assert.deepEqual(ctan.map((s) => s.id).sort(), [...Object.keys(lib.TEST_INPUTS), lib.REVTEX.source].sort());
    for (const s of ctan.filter((x) => x.id !== lib.REVTEX.source)) {
      assert.deepEqual(s.files.map((f) => f.name).sort(), Object.keys(lib.TEST_INPUTS[s.id].files).sort(), s.id);
      for (const [kind, p] of Object.values(lib.TEST_INPUTS[s.id].files)) {
        assert.ok(['run', 'doc', 'source'].includes(kind), `${s.id}: ${kind}`);
        assert.match(p, kind === 'run' ? /^(tex|bibtex|fonts)\// : kind === 'doc' ? /^doc\// : /^source\//, `${s.id}: ${p}`);
      }
    }
    assert.deepEqual(ctan.find((s) => s.id === lib.REVTEX.source)?.files.map((f) => f.name), ['revtex.tds.zip']);
  });

  it('tags the release test-inputs-<snapshot date>-<n>', () => {
    assert.equal(lib.testInputsTag('2026/10/15', 1), 'test-inputs-20261015-1');
    assert.equal(lib.testInputsTag('2026/10/15', '12'), 'test-inputs-20261015-12');
    for (const bad of [0, '01', 'a', '1;x', '']) assert.throws(() => lib.testInputsTag('2026/10/15', bad), /candidate must be a number from 1/, String(bad));
    assert.throws(() => lib.testInputsTag('20261015', 1), /not a snapshot date/);
    assert.ok(lib.TAG.test('test-inputs-20261015-1'));
    for (const t of ['test-inputs-20261015-0', 'test-inputs-2026-1', 'test-inputs-20261015-1\nx']) assert.ok(!lib.TAG.test(t), t);
  });

  it("holds each package whole: every archive the tlpdb has for it, and fails a pin with no archive", () => {
    const rec = (name: string, kinds: string[]): TlPackage => ({
      name,
      containerSize: 10,
      containerChecksum: 'a'.repeat(128),
      ...(kinds.includes('doc') ? { docContainerSize: 20, docContainerChecksum: 'b'.repeat(128) } : {}),
      ...(kinds.includes('source') ? { srcContainerSize: 30, srcContainerChecksum: 'c'.repeat(128) } : {}),
    });
    assert.deepEqual(lib.packageArchives(new Map([['acmart', rec('acmart', ['doc', 'source'])]]), 'acmart').map((a) => [a.name, a.kind, a.size]), [
      ['acmart.tar.xz', 'run', 10],
      ['acmart.doc.tar.xz', 'doc', 20],
      ['acmart.source.tar.xz', 'source', 30],
    ]);
    assert.throws(() => lib.packageArchives(new Map(), 'acmart'), /the pinned snapshot has no package acmart/);
    const db = new Map(Object.values(lib.TEST_INPUTS).map((t) => [t.package, rec(t.package, ['doc', 'source'])]));
    const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: Source[] };
    const bundlePins = { tlpdb: { sha256: 'd'.repeat(64) } };
    const contents = lib.releaseContents(db, pins, bundlePins);
    assert.equal(contents.archives.length, Object.keys(lib.TEST_INPUTS).length * 3, 'run, doc and source of each package');
    assert.equal(contents.zip.name, 'revtex.tds.zip');
    const extra = structuredClone(pins);
    extra.sources.find((s) => s.id === 'ctan-tensor')?.files.push(pinOf('tensor.sty', 'x'));
    assert.throws(() => lib.releaseContents(db, extra, bundlePins), /ctan-tensor: tensor\.sty has no archive and path/);
    const unknown = structuredClone(pins);
    unknown.sources.push({ id: 'ctan-new', folder: 'ctan-new', files: [] });
    assert.throws(() => lib.releaseContents(db, unknown, bundlePins), /ctan-new is pinned, but the release has no entry for it/);
  });

  it("unpacks the named members, and fails a member the archive does not hold, or an archive of other bytes", () => {
    const archive = tarXz({ 'source/latex/x/x.dtx': 'dtx', 'source/latex/x/x.ins': 'ins' });
    assert.equal(lib.unpackMembers(archive, ['source/latex/x/x.ins']).get('source/latex/x/x.ins')?.toString(), 'ins');
    assert.throws(() => lib.unpackMembers(archive, ['source/latex/x/x.sty']), /the archive does not hold source\/latex\/x\/x\.sty/);
    const pinned = { name: 'x.source.tar.xz', size: archive.length, sha512: sha('sha512', archive) };
    assert.equal(lib.archiveProblem(archive, pinned), null);
    assert.match(lib.archiveProblem(Buffer.concat([archive, Buffer.from('!')]), pinned) ?? '', /has \d+ bytes, not the pinned/);
    assert.match(lib.archiveProblem(Buffer.from(archive).fill(0, 0, 1), pinned) ?? '', /is not the pinned archive/);
  });

  describe('engine-assets.mjs: files unpacked from a release archive', () => {
    const archive = () => tarXz({ 'source/latex/x/x.dtx': 'the dtx\n', 'source/latex/x/x.ins': 'the ins\n', 'doc/latex/x/README': 'readme\n' });
    const source = (a: Buffer, extra: Partial<Source> = {}): Source => ({
      id: 'ctan-x',
      folder: 'ctan-x',
      release: 'https://example.invalid/releases/tag/test-inputs-20261015-1',
      tag: 'test-inputs-20261015-1',
      published: '2026-11-04',
      archives: [{ name: 'x.source.tar.xz', url: 'https://example.invalid/x.source.tar.xz', size: a.length, sha512: sha('sha512', a) }],
      files: [pinOf('x.dtx', 'the dtx\n', { from: 'x.source.tar.xz', path: 'source/latex/x/x.dtx' }), pinOf('x.ins', 'the ins\n', { from: 'x.source.tar.xz', path: 'source/latex/x/x.ins' })],
      ...extra,
    });
    const run = async (s: Source, served: Record<string, Buffer>, opts: { verify?: boolean } = {}) => {
      const fetched: string[] = [];
      const lines: string[] = [];
      const fetchImpl = async (url: string) => {
        fetched.push(url);
        return served[url] ? new Response(served[url]) : new Response('not found', { status: 404 });
      };
      const r = await assets.syncAssets({ sources: [s] }, tmp, { ...opts, fetchImpl, log: (l) => lines.push(l), error: (l) => lines.push(l) });
      return { ...r, fetched, lines };
    };

    it('downloads the archive once, writes each file where a file fetched alone would be, and deletes the archive', async () => {
      const a = archive();
      const first = await run(source(a), { 'https://example.invalid/x.source.tar.xz': a });
      assert.equal(first.failures, 0, first.lines.join('\n'));
      assert.deepEqual(first.fetched, ['https://example.invalid/x.source.tar.xz']);
      assert.equal(readFileSync(path.join(tmp, 'ctan-x', 'x.dtx'), 'utf8'), 'the dtx\n');
      assert.equal(readFileSync(path.join(tmp, 'ctan-x', 'x.ins'), 'utf8'), 'the ins\n');
      assert.ok(!existsSync(path.join(tmp, 'ctan-x', '.x.source.tar.xz')), 'the archive is deleted');
      // Present and right: checked, and nothing downloaded.
      const second = await run(source(a), {});
      assert.equal(second.failures, 0);
      assert.deepEqual(second.fetched, []);
      // One file changed on disk: only its archive is fetched again.
      writeFileSync(path.join(tmp, 'ctan-x', 'x.ins'), 'changed');
      const third = await run(source(a), { 'https://example.invalid/x.source.tar.xz': a });
      assert.equal(third.failures, 0);
      assert.equal(readFileSync(path.join(tmp, 'ctan-x', 'x.ins'), 'utf8'), 'the ins\n');
    });

    it('fails an archive of other bytes, a member it does not hold, and a member that is not its pin', async () => {
      const a = archive();
      const other = tarXz({ 'source/latex/x/x.dtx': 'the dtx\n' });
      const wrong = await run(source(a), { 'https://example.invalid/x.source.tar.xz': other });
      assert.equal(wrong.failures, 2);
      assert.match(wrong.lines.join('\n'), /FAIL ctan-x\/x\.dtx: from x\.source\.tar\.xz: x\.source\.tar\.xz has \d+ bytes, not the pinned/);
      const s = source(a);
      s.files[1] = { ...s.files[1], path: 'source/latex/x/x.sty' };
      const missing = await run(s, { 'https://example.invalid/x.source.tar.xz': a });
      assert.match(missing.lines.join('\n'), /FAIL ctan-x\/x\.ins: from x\.source\.tar\.xz: the archive does not hold source\/latex\/x\/x\.sty/);
      const t = source(a);
      t.files[0] = { ...t.files[0], sha256: sha('sha256', 'another dtx') };
      const notPin = await run(t, { 'https://example.invalid/x.source.tar.xz': a });
      assert.equal(notPin.failures, 1);
      assert.match(notPin.lines.join('\n'), /FAIL ctan-x\/x\.dtx: sha256 [0-9a-f]{64}, pinned [0-9a-f]{64} \(unpacked from x\.source\.tar\.xz\)/);
      // A file whose archive the source does not list (from an empty folder: the runs above left right files).
      rmSync(path.join(tmp, 'ctan-x'), { recursive: true, force: true });
      const u = source(a);
      u.files[0] = { ...u.files[0], from: 'x.doc.tar.xz' };
      const noArchive = await run(u, {});
      assert.match(noArchive.lines.join('\n'), /FAIL ctan-x\/x\.dtx: its archive x\.doc\.tar\.xz is not one of the source's archives/);
    });

    it('downloads nothing for --verify or an unpublished release, and says why', async () => {
      const a = archive();
      const verify = await run(source(a), { 'https://example.invalid/x.source.tar.xz': a }, { verify: true });
      assert.equal(verify.failures, 2);
      assert.deepEqual(verify.fetched, []);
      const draft = await run(source(a, { published: null }), { 'https://example.invalid/x.source.tar.xz': a });
      assert.equal(draft.failures, 2);
      assert.deepEqual(draft.fetched, []);
      assert.match(draft.lines.join('\n'), /FAIL ctan-x\/x\.dtx: missing; the release test-inputs-20261015-1 is not published yet/);
    });
  });

  it('the release notes say where the files come from, that they are unchanged, and what each licence asks', async () => {
    const tool = await importScript<{ releaseNotes(o: unknown): string }>('scripts/test-inputs.mjs');
    const archives = Object.values(lib.TEST_INPUTS).map((t) => ({ name: lib.archiveName(t.package, 'run'), package: t.package, size: 1e6 }));
    const notes = tool.releaseNotes({
      tag: 'test-inputs-20261015-1',
      contents: { archives, zip: { name: 'revtex.tds.zip', size: 6711510, sha256: 'e'.repeat(64) } },
      snapshotUrl: 'https://texlive.info/tlnet-archive/2026/10/15/tlnet/',
      bundlePins: { tlpdb: { sha256: 'f'.repeat(64), signatureChecked: 'checked' } },
      commit: 'c'.repeat(40),
      repository: 'https://github.com/haberwooki/liveMd2Tex',
    });
    const flat = notes.replace(/\s+/g, ' ');
    for (const words of [
      'as whole works and unchanged',
      'used only by the tests and are in no store package',
      'counts the distribution of part of a work as a modification',
      'https://texlive.info/tlnet-archive/2026/10/15/tlnet/',
      `its SHA-256 is \`${'f'.repeat(64)}\``,
      'Copyright (c) 1996-2025 Springer, under the Creative Commons Attribution license, version 4.0 or later',
      'https://creativecommons.org/licenses/by/4.0/',
      // splncs04.bst's own notice, apart from llncs's CC BY.
      "Its `splncs04.bst`, generated with makebst, carries Patrick W Daly's notice: the LaTeX Project Public License, version 1 or later.",
      // DejaVu's whole terms, as its LICENSE gives them.
      'the fonts are (c) Bitstream under the Bitstream Vera terms, with the DejaVu changes in the public domain and the glyphs from the Arev fonts (c) Tavmjong Bah under their terms',
      '`doc/fonts/dejavu/LICENSE` in `dejavu.doc.tar.xz`',
      // Where the licence texts travel.
      '`doc/latex/beamer/licenses/` in `beamer.doc.tar.xz`',
      '`doc/generic/pgf/pgfmanual-en-license.tex` in `pgf.doc.tar.xz`',
      'GNU FDL 1.3 or later',
      `https://github.com/haberwooki/liveMd2Tex/commit/${'c'.repeat(40)}`,
    ]) {
      assert.ok(flat.includes(words), words);
    }
    for (const t of Object.values(lib.TEST_INPUTS)) assert.ok(notes.includes(`| ${t.package} | ${t.version} | ${t.licence} |`), t.package);
  });

  it('pin-test-inputs.mjs pins a source to the release only when every archive and file is the pinned one', async () => {
    const { pinToRelease } = await importScript<{ pinToRelease(pins: unknown, list: unknown, read: (n: string) => Buffer, bundlePins: unknown, published?: string | null): { sources: Source[] } }>('scripts/pin-test-inputs.mjs');
    const dtx = (lib.TEST_INPUTS['ctan-tensor'].files['tensor.dtx'] as [string, string])[1];
    const ins = (lib.TEST_INPUTS['ctan-tensor'].files['tensor.ins'] as [string, string])[1];
    const src = tarXz({ [dtx]: 'the tensor dtx\n', [ins]: 'the tensor ins\n' });
    const run = tarXz({ 'tex/latex/tensor/tensor.sty': 'sty\n' });
    const zip = Buffer.from('a zip');
    const tlpdbText = `name tensor\ncategory Package\ncontainersize ${run.length}\ncontainerchecksum ${sha('sha512', run)}\nsrccontainersize ${src.length}\nsrccontainerchecksum ${sha('sha512', src)}\n\n`;
    const tlpdbBytes = Buffer.from(tlpdbText);
    const tlpdb = Buffer.from(xzStream(lzma2Encode(tlpdbBytes, [{ kind: 'stored', bytes: tlpdbBytes.length, dictReset: true }]), tlpdbBytes, 4, xzCrc64));
    const bundlePins = { tlpdb: { sha256: sha('sha256', tlpdb) } };
    const pins = {
      sources: [
        { id: 'livemd2tex-engine', folder: 'e', files: [] },
        { id: 'ctan-tensor', folder: 'ctan-tensor', note: 'n', files: [pinOf('tensor.dtx', 'the tensor dtx\n', { url: 'https://mirror.invalid/tensor.dtx' }), pinOf('tensor.ins', 'the tensor ins\n', { url: 'https://mirror.invalid/tensor.ins' })] },
        { id: 'ctan-revtex', folder: 'ctan-revtex', note: 'n', files: [{ name: 'revtex.tds.zip', url: 'https://mirror.invalid/revtex.tds.zip', size: zip.length, sha256: sha('sha256', zip) }] },
      ],
    };
    const list = {
      tag: 'test-inputs-20261015-1',
      tlpdb: { name: 'texlive.tlpdb.xz', size: tlpdb.length, sha256: sha('sha256', tlpdb) },
      archives: [
        { name: 'tensor.tar.xz', package: 'tensor', kind: 'run', size: run.length, sha512: sha('sha512', run) },
        { name: 'tensor.source.tar.xz', package: 'tensor', kind: 'source', size: src.length, sha512: sha('sha512', src) },
      ],
    };
    const files: Record<string, Buffer> = { 'tensor.tar.xz': run, 'tensor.source.tar.xz': src, 'revtex.tds.zip': zip, 'texlive.tlpdb.xz': tlpdb };
    const read = (n: string) => files[n];
    const out = pinToRelease(pins, list, read, bundlePins);
    const tensor = out.sources.find((s) => s.id === 'ctan-tensor') as Source;
    assert.equal(tensor.tag, 'test-inputs-20261015-1');
    assert.equal(tensor.published, null);
    assert.deepEqual(tensor.archives?.map((a) => [a.name, a.url]), [['tensor.source.tar.xz', 'https://github.com/haberwooki/liveMd2Tex/releases/download/test-inputs-20261015-1/tensor.source.tar.xz']]);
    assert.deepEqual(tensor.files.map((f) => [f.name, f.from, f.path, f.size, f.sha256]), pins.sources[1].files.map((f) => [f.name, 'tensor.source.tar.xz', f.name === 'tensor.dtx' ? dtx : ins, f.size, f.sha256]));
    assert.ok(tensor.files.every((f) => !f.url), 'a file unpacked from an archive has no address of its own');
    const revtex = out.sources.find((s) => s.id === 'ctan-revtex') as Source;
    assert.equal(revtex.files[0].url, 'https://github.com/haberwooki/liveMd2Tex/releases/download/test-inputs-20261015-1/revtex.tds.zip');
    assert.equal(pinToRelease(pins, list, read, bundlePins, '2026-11-04').sources[1].published, '2026-11-04');
    // A file that is not its pin, an archive that is not the tlpdb's, or another tlpdb: nothing is pinned.
    assert.throws(() => pinToRelease(pins, list, (n) => (n === 'tensor.source.tar.xz' ? tarXz({ [dtx]: 'other\n', [ins]: 'the tensor ins\n' }) : read(n)), bundlePins), /size and SHA-512|not the pinned archive|bytes, not the pinned/);
    const badList = { ...list, archives: [{ ...list.archives[1], sha512: '0'.repeat(128) }] };
    assert.throws(() => pinToRelease(pins, badList, read, bundlePins), /does not give the pinned tlpdb's size and SHA-512/);
    assert.throws(() => pinToRelease(pins, list, read, { tlpdb: { sha256: '0'.repeat(64) } }), /the release's tlpdb is not the pinned one/);
    assert.throws(() => pinToRelease(pins, list, read, bundlePins, 'today'), /published must be a date/);
  });
});
