// What a release carries (scripts/release-sources.mjs, .github/workflows/release-sources.yml; the licence gates, M1,
// M4, M6, F2-S1, L2-01, L2-03 and L2-06): README.md and THIRD_PARTY_NOTICES.md give this version's tag as its source,
// a package with the engine brings the engine's source archives, a data package the snapshot archives its
// licences.json lists, and every file is checked before it is attached: its hash, a commit archive's files against
// the commit's tree, TeXlyre's Makefile against the manifest, a data archive against the pinned package database.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { importScript, root } from '../support/helpers';
import { lzma2Encode, xzStream } from '../support/xzEncode';

type Source = { name: string; url: string; sha256?: string; sha512?: string; commit?: string; repository?: string; for: string[]; attachedSha256?: string };
type Entry = { path: string; type: string; data?: Buffer; link?: string; mode: number };
interface Lib {
  sourceTree(tag: string): string;
  sourceStatement(tag: string): string;
  namesSource(text: string, tag: string): boolean;
  releaseSources(packages: Map<string, Map<string, Buffer>>, tag: string, notices: unknown, bundlePins: unknown): Record<string, Source[]>;
  curlConfig(groups: Record<string, Source[]>, dir: string, bundlePins: unknown): string;
  gitList(groups: Record<string, Source[]>): string;
  treeDifferences(entries: Entry[], lsTree: string): string[];
  makefileDifferences(entries: Entry[], makefile: { sha256: string; lines: Record<string, string> }): string[];
  checkSources(groups: Record<string, Source[]>, dir: string, context?: unknown): { problems: string[]; notes: string[] };
}

const sha = (algo: string, b: Buffer | string) => createHash(algo).update(b).digest('hex');
const blob = (b: Buffer) => sha('sha1', Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

/** A ustar archive of files (path -> text), each under one top folder, as GitHub's archives are. */
function tarOf(files: Record<string, string>, top = 'repo-abc'): Buffer {
  const blocks: Buffer[] = [];
  for (const [p, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(`${top}/${p}`, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) {
      sum += b;
    }
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('the sources a release carries (scripts/release-sources.mjs)', () => {
  let lib: Lib;
  let tar: { readTar(b: Buffer): Entry[] };
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;
  const notices = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-notices.json'), 'utf8'));
  const bundlePins = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-pins.json'), 'utf8'));
  const snap = 'https://texlive.info/tlnet-archive/2026/10/15/tlnet/';
  before(async () => {
    lib = await importScript<Lib>('scripts/release-sources.mjs');
    tar = await importScript('scripts/lib/tar.mjs');
  });

  it("README.md and THIRD_PARTY_NOTICES.md name this version's tag as its source, not a page that does not exist yet (M1)", () => {
    assert.equal(lib.sourceStatement(`v${version}`), `for this version, the tag \`v${version}\` of https://github.com/haberwooki/liveMd2Tex`);
    for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
      const text = readFileSync(path.join(root, file), 'utf8');
      assert.ok(lib.namesSource(text, `v${version}`), `${file}: change the tag with the version`);
      // The tag's tree opens only once the release has made the tag, so neither file links it.
      assert.ok(!text.includes(lib.sourceTree(`v${version}`)), `${file} links the tag's tree`);
    }
    // The release's own page links the tree.
    assert.equal(lib.sourceTree('v1.2.3'), 'https://github.com/haberwooki/liveMd2Tex/tree/v1.2.3');
  });

  it('lists the engine source for a package with the engine and the snapshot archives for a data package', () => {
    const readme = Buffer.from('The source code of each release is the tag of its version in this repository: for this version, the tag `v1.2.3`\nof https://github.com/haberwooki/liveMd2Tex.\n');
    const main = new Map([
      ['extension/package.json', Buffer.from(JSON.stringify({ name: 'livemd2tex', version: '1.2.3' }))],
      ['extension/dist/extension.js', Buffer.from('')],
      ['extension/dist/engine/busytex.wasm', Buffer.from('')],
      // vsce stores README.md under this name.
      ['extension/readme.md', readme],
    ]);
    const licences = { 'cm-super': { licence: ['gpl'], archives: [{ kind: 'run', url: `${snap}archive/cm-super.tar.xz`, sha512: 'ab' }, { kind: 'source', url: `${snap}archive/cm-super.source.tar.xz`, sha512: 'cd' }] }, xcolor: { licence: ['lppl1.3c'] } };
    const dataPackage = (l: unknown) =>
      new Map([
        ['extension/package.json', Buffer.from(JSON.stringify({ name: 'livemd2tex-core-data', version: '2026.10.15' }))],
        ['extension/data/licences.json', Buffer.from(JSON.stringify(l))],
      ]);
    const groups = lib.releaseSources(new Map([['main.vsix', main], ['core.vsix', dataPackage(licences)]]), 'v1.2.3', notices, bundlePins);
    assert.deepEqual(Object.keys(groups), ['core-data', 'engine']);
    const byName = (a: string[], b: string[]) => (a[0] < b[0] ? -1 : 1);
    assert.deepEqual(groups.engine.map((s) => [s.name, s.url, s.sha256]), notices.sources.map((s: Source) => [s.name, s.url, s.sha256]).sort(byName));
    assert.deepEqual(groups['core-data'].map((s) => [s.name, s.sha512, s.for]), [
      ['cm-super.source.tar.xz', 'cd', ['core.vsix: cm-super (source)']],
      ['cm-super.tar.xz', 'ab', ['core.vsix: cm-super (run)']],
    ]);
    // The commit archives go to git for their trees; the tlpdb comes with a data group.
    assert.deepEqual(lib.gitList(groups).trim().split('\n').map((l) => l.split('\t')[0]).sort(), notices.sources.filter((s: Source) => s.commit).map((s: Source) => s.name).sort());
    assert.ok(lib.curlConfig(groups, '/out', bundlePins).includes(`url = "${snap}tlpkg/texlive.tlpdb.xz"\noutput = "/out/meta/texlive.tlpdb.xz"\n`));
    // The extension's tag is v<version>, and its README gives that tag's tree.
    assert.throws(() => lib.releaseSources(new Map([['main.vsix', main]]), 'v1.2.4', notices, bundlePins), /its release tag must be v1\.2\.3, not v1\.2\.4/);
    const noPointer = new Map(main).set('extension/readme.md', Buffer.from('No pointer.\n'));
    assert.throws(() => lib.releaseSources(new Map([['main.vsix', noPointer]]), 'v1.2.3', notices, bundlePins), /README\.md does not name the tag v1\.2\.3 of https:\/\/github\.com\/haberwooki\/liveMd2Tex as the source of this version/);
    // A data archive must be the pinned snapshot's, under a plain name.
    for (const url of ['https://example.org/archive/cm-super.tar.xz', `${snap}archive/../cm-super.tar.xz`, `${snap}archive/sub/cm-super.tar.xz`, `${snap}archive/cm-super.zip`]) {
      assert.throws(() => lib.releaseSources(new Map([['core.vsix', dataPackage({ x: { archives: [{ kind: 'run', url, sha512: 'ab' }] } })]]), 'x', notices, bundlePins), /is not an archive of the pinned snapshot/, url);
    }
    // Two packages that name one file with different bytes stop it.
    const other = dataPackage({ 'cm-super': { licence: ['gpl'], archives: [{ kind: 'run', url: `${snap}archive/cm-super.tar.xz`, sha512: 'ff' }] } });
    assert.throws(() => lib.releaseSources(new Map([['a.vsix', dataPackage(licences)], ['b.vsix', other]]), 'x', notices, bundlePins), /core-data\/cm-super\.tar\.xz: two packages name it/);
  });

  it("checks a commit archive's files against the commit's tree, allowing git's CRLF export of .bat files", () => {
    const files = { 'a.c': 'int a;\n', 'tools/run.bat': '@echo off\r\nrem\r\n' };
    const entries = tar.readTar(tarOf(files));
    const tree = [`100644 blob ${blob(Buffer.from('int a;\n'))}\ta.c`, `100644 blob ${blob(Buffer.from('@echo off\nrem\n'))}\ttools/run.bat`, '160000 commit 0000000000000000000000000000000000000000\tsubmodule'].join('\n');
    assert.deepEqual(lib.treeDifferences(entries, tree), []);
    const changed = tar.readTar(tarOf({ ...files, 'a.c': 'int b;\n', 'extra.h': '' }));
    assert.deepEqual(lib.treeDifferences(changed, tree), ['a.c: other contents', 'extra.h: in the archive, not in the commit']);
    assert.deepEqual(lib.treeDifferences(tar.readTar(tarOf({ 'a.c': 'int a;\n' })), tree), ['tools/run.bat: in the commit, not in the archive']);
  });

  it("checks TeXlyre's Makefile against the manifest's hash and link lines (L2-01)", () => {
    const makefile = 'one\nOBJ = a.o\nthree\n';
    const entries = tar.readTar(tarOf({ Makefile: makefile }));
    assert.deepEqual(lib.makefileDifferences(entries, { sha256: sha('sha256', makefile), lines: { 2: 'OBJ = a.o' } }), []);
    assert.deepEqual(lib.makefileDifferences(entries, { sha256: '0'.repeat(64), lines: { 2: 'OBJ = b.o' } }), [`Makefile: SHA-256 ${sha('sha256', makefile)} is not the manifest's ${'0'.repeat(64)}`, "Makefile line 2 is not the manifest's copy"]);
    assert.deepEqual(lib.makefileDifferences(tar.readTar(tarOf({ 'src/Makefile': '' })), { sha256: '', lines: {} }), ['the archive has no Makefile at its top']);
  });

  it('checks every download: its hash, a commit archive by its tree, a data archive against the pinned tlpdb', async () => {
    const xz = await importScript<{ crc64(b: Uint8Array): string }>('scripts/lib/xz.mjs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-release-'));
    try {
      const put = (rel: string, b: Buffer) => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), b);
      };
      const commitTar = gzipSync(tarOf({ 'a.c': 'int a;\n' }));
      const good = Buffer.from('an archive');
      const pkg = Buffer.from('a package archive');
      const tlpdbText = Buffer.from(`name pkg\ncategory Package\ncontainerchecksum ${sha('sha512', pkg)}\n\n`);
      const tlpdbXz = Buffer.from(xzStream(lzma2Encode(tlpdbText, [{ kind: 'stored', bytes: tlpdbText.length, dictReset: true }]), tlpdbText, 4, xz.crc64));
      const pins = { ...bundlePins, tlpdb: { ...bundlePins.tlpdb, sha256: sha('sha256', tlpdbXz) } };
      const groups: Record<string, Source[]> = {
        engine: [
          { name: 'a.tar.gz', url: 'https://example.org/a.tar.gz', sha256: sha('sha256', good), for: [] },
          { name: 'c.tar.gz', url: 'https://github.com/o/r/archive/abc.tar.gz', sha256: '0'.repeat(64), commit: 'abc', repository: 'https://github.com/o/r', for: [] },
          { name: 'd.tar.gz', url: 'https://example.org/d.tar.gz', sha256: '0'.repeat(64), for: [] },
        ],
        'core-data': [
          { name: 'pkg.tar.xz', url: `${snap}archive/pkg.tar.xz`, sha512: sha('sha512', pkg), for: [] },
          { name: 'pkg.doc.tar.xz', url: `${snap}archive/pkg.doc.tar.xz`, sha512: sha('sha512', good), for: [] },
        ],
      };
      put('files/engine/a.tar.gz', good);
      put('files/engine/c.tar.gz', commitTar);
      put('files/core-data/pkg.tar.xz', pkg);
      put('files/core-data/pkg.doc.tar.xz', good);
      put('meta/texlive.tlpdb.xz', tlpdbXz);
      put('trees/c.tar.gz.ls-tree', Buffer.from(`100644 blob ${blob(Buffer.from('int a;\n'))}\ta.c\n`));
      const { problems, notes } = lib.checkSources(groups, dir, { bundlePins: pins });
      // The commit archive's bytes are not the pinned ones, but its files are the commit's: a note, and its new hash.
      assert.deepEqual(notes, [`engine/c.tar.gz: its bytes are not the pinned ones (GitHub made the archive again), but its files are commit abc's; attached with SHA-256 ${sha('sha256', commitTar)}`]);
      assert.equal(groups.engine[1].attachedSha256, sha('sha256', commitTar));
      assert.deepEqual(problems, ['engine/d.tar.gz: not downloaded (https://example.org/d.tar.gz)', "core-data/pkg.doc.tar.xz: its SHA-512 in licences.json is not the pinned tlpdb's"]);
      // Without the tree listing, a commit archive whose bytes differ fails; so does a tlpdb that is not the pinned one.
      rmSync(path.join(dir, 'trees'), { recursive: true });
      put('meta/texlive.tlpdb.xz', Buffer.from('not it'));
      const again = lib.checkSources(groups, dir, { bundlePins: pins }).problems;
      assert.ok(again.includes('engine/c.tar.gz: no tree listing of commit abc (trees/c.tar.gz.ls-tree)'), again.join('\n'));
      assert.ok(again.some((p) => /^meta\/texlive\.tlpdb\.xz: not the pinned tlpdb/.test(p)), again.join('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
