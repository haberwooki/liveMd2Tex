// B1's bundle builder without the engine (scripts/build-bundle.mjs --local --skip-engine; docs/DESIGN.md#engine-and-data), on
// a tiny made-up TeX Live snapshot the test writes itself: a tlpdb and package archives as .tar.xz. It checks the
// pin, the selection with the licence rules, the archive checks, the generated files, the two images and their
// manifests, and that a damaged archive, a wrong pin or a name the tlpdb does not have stops the build. Build gate
// B1's fixes: the pin only on TeX Live's signed checksum and key, the lists of licences, the report kept on an
// error, the closure test's targets, and the guard against python and perl.

import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { t1cUnpack } from '../../src/engine-host/engine/t1c';
import { importScript, root } from '../support/helpers';
import { tarArchive } from '../support/tarWrite';
import { lzma2Encode, xzStream, type Chunk } from '../support/xzEncode';

interface Build {
  main(
    argv: string[],
    options?: { log?: (line: string) => void; fetchImpl?: (url: string) => Promise<unknown> },
  ): Promise<{
    status: number;
    report: {
      problems: string[];
      dropped: { package: string }[];
      notes: string[];
      unclassified?: { core: string[] };
      pin?: { tlpdbSha256: string; core: { none: string[] }; entry: { file: string; sha256: string; signedSha512: string; signatureChecked: string } };
    };
  }>;
  checkSignedHash(signed: string, xz: Uint8Array, text: string): { ok: boolean; matched?: string; sha512?: string; reason?: string };
  guardPrograms(): void;
  releaseProgramGuard(): void;
}
interface Xz {
  crc64(b: Uint8Array): string;
}
interface ImageFiles {
  openImage(dataPath: string, compressed: unknown): { read(start: number, end: number): Buffer };
}

const sha = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest('hex');
/** TeX Live's signing key, as engine/bundle-pins.json pins it. */
const KEY = 'C78B82D8C79512F79CC0D7C80D5E5D9106BAB6BC';
/** A pins file for the made-up snapshot: its tlpdb's SHA-256, with (or without) the note that the signature was checked. */
const pinsOf = (sha256: string | null, checked = true) =>
  JSON.stringify({ texLive: 2026, snapshot: '2026/10/15', mirrors: ['https://texlive.info/tlnet-archive/{snapshot}/tlnet/'], signingKey: { fingerprint: KEY }, tlpdb: { file: 'tlpkg/texlive.tlpdb.xz', sha256, ...(checked ? { signatureChecked: 'test' } : {}) } });

/** A made-up Type 1 font file: a text segment, a binary (eexec) segment, the end marker. */
const PFB = (() => {
  const segment = (type: number, data: Buffer) => {
    const head = Buffer.alloc(6);
    head[0] = 0x80;
    head[1] = type;
    head.writeUInt32LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const binary = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 37 + 11) & 0xff));
  return Buffer.concat([segment(1, Buffer.from('%!PS-AdobeFont-1.0: CMEX7\ncurrentfile eexec\n')), segment(2, binary), Buffer.from([0x80, 3])]);
})();

/**
 * The made-up snapshot: package -> its tlpdb record (without name and checksums), its run archive's files, and the
 * files of its doc archive (written as <name>.doc.tar.xz, listed as its docfiles).
 */
const PACKAGES: Record<string, { record: string[]; files?: Record<string, string | Uint8Array>; doc?: Record<string, string> }> = {
  // As in TeX Live: the fmtutil and updmap headers are in texlive.infra, whose name has a dot but which is no
  // platform package (texlive.infra.ARCH is).
  'collection-basic': { record: ['category Collection', 'depend texlive.infra', 'depend texlive-scripts', 'depend hyphen-base', 'depend amsfonts', 'depend cm-super', 'depend latex-bin'] },
  // Its archive also holds TeX Live's own licence statements, at the root, as TeX Live's does.
  'texlive.infra': {
    record: ['category TLCore', 'depend texlive.infra.ARCH', 'runfiles size=1', ' LICENSE.CTAN', ' LICENSE.TL', ' texmf-dist/web2c/fmtutil-hdr.cnf', ' texmf-dist/web2c/updmap-hdr.cfg', ' tlpkg/TeXLive/TLUtils.pm'],
    files: {
      'LICENSE.CTAN': 'CTAN licences, made up.\n',
      'LICENSE.TL': 'TeX Live licence, made up.\n',
      'texmf-dist/web2c/fmtutil-hdr.cnf': '# fmtutil.cnf: generated\n',
      'texmf-dist/web2c/updmap-hdr.cfg': '# updmap.cfg: generated\n',
      'tlpkg/TeXLive/TLUtils.pm': 'package TeXLive::TLUtils;\n',
    },
  },
  'texlive-scripts': {
    record: ['category TLCore', 'runfiles size=2', ' texmf-dist/fonts/map/dvips/updmap/ps2pk35.map', ' texmf-dist/fonts/map/dvips/updmap/pdftex35.map', ' texmf-dist/fonts/map/dvips/updmap/dvips35.map'],
    files: {
      'texmf-dist/fonts/map/dvips/updmap/ps2pk35.map': 'ptmr8r Times-Roman "TeXBase1Encoding ReEncodeFont" <8r.enc <utmr8a.pfb\n',
      'texmf-dist/fonts/map/dvips/updmap/pdftex35.map': 'ptmr8r Times-Roman "TeXBase1Encoding ReEncodeFont" <8r.enc\n',
      'texmf-dist/fonts/map/dvips/updmap/dvips35.map': '',
      'tlpkg/tlpobj/texlive-scripts.tlpobj': 'name texlive-scripts\n',
    },
  },
  'hyphen-base': {
    record: ['category TLCore', 'execute AddHyphen name=english synonyms=usenglish lefthyphenmin=2 righthyphenmin=3 file=hyphen.tex', 'runfiles size=1', ' texmf-dist/tex/generic/config/language.us', ' texmf-dist/tex/generic/config/language.us.def', ' texmf-dist/tex/generic/config/language.us.lua', ' texmf-dist/tex/generic/hyphen/hyphen.tex'],
    files: {
      'texmf-dist/tex/generic/config/language.us': '% language.dat\n',
      'texmf-dist/tex/generic/config/language.us.def': '%% language.def\n',
      'texmf-dist/tex/generic/config/language.us.lua': 'return {\n',
      'texmf-dist/tex/generic/hyphen/hyphen.tex': '\\patterns{.ach4}\n',
    },
  },
  amsfonts: {
    record: ['category Package', 'relocated 1', 'depend xcolor', 'execute addMap cmextra.map', 'runfiles size=1', ' RELOC/fonts/map/dvips/amsfonts/cmextra.map', ' RELOC/fonts/type1/public/amsfonts/cmex7.pfb', ' RELOC/tex/latex/amsfonts/amsfonts.sty', 'catalogue-license ofl', 'catalogue-ctan /fonts/amsfonts'],
    files: { 'fonts/map/dvips/amsfonts/cmextra.map': 'cmex7 CMEX7 <cmex7.pfb\n', 'fonts/type1/public/amsfonts/cmex7.pfb': PFB, 'tex/latex/amsfonts/amsfonts.sty': '\\ProvidesPackage{amsfonts}\n\\RequirePackage{xcolor}\n' },
    // Its OFL.txt (the copyright notice and the Reserved Font Names) is in its doc archive, as in TeX Live.
    doc: { 'doc/fonts/amsfonts/OFL.txt': '"cmex7" is a Reserved Font Name for this Font Software.\n', 'doc/fonts/amsfonts/amsfndoc.pdf': '%PDF made up\n' },
  },
  // A GPL font package: its Type 1 file is packed with t1c (amsfonts', under the OFL, is not: core-data's t1cSkip).
  'cm-super': {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/fonts/type1/public/cm-super/sfrm1000.pfb', 'catalogue-license gpl'],
    files: { 'fonts/type1/public/cm-super/sfrm1000.pfb': PFB },
  },
  'latex-bin': { record: ['category TLCore', 'execute AddFormat name=pdflatex engine=pdftex patterns=language.dat options="-etex pdflatex.ini"'] },
  xcolor: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/xcolor/xcolor.sty', 'catalogue-license lppl1.3c'],
    files: { 'tex/latex/xcolor/xcolor.sty': '\\ProvidesPackage{xcolor}\n' },
  },
  // Its run files also name a script and a documentation file, as koma-script's and many others' do: both stay out.
  extrapkg: {
    record: ['category Package', 'relocated 1', 'execute addMixedMap extra.map', 'runfiles size=1', ' RELOC/tex/latex/extrapkg/extrapkg.sty', ' RELOC/fonts/map/dvips/extrapkg/extra.map', ' RELOC/scripts/extrapkg/extratool.pl', ' RELOC/doc/latex/extrapkg/README', 'catalogue-license gpl2+'],
    files: {
      'tex/latex/extrapkg/extrapkg.sty': '\\ProvidesPackage{extrapkg}\n',
      'fonts/map/dvips/extrapkg/extra.map': 'xyz10 XYZ10 <xyz10.pfb\n',
      'scripts/extrapkg/extratool.pl': 'print "a program";\n',
      'doc/latex/extrapkg/README': 'Read me.\n',
    },
  },
  // A package with a program file among its TeX files; no set selects it unless a test does.
  pytool: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/pytool/pytool.sty', ' RELOC/tex/latex/pytool/helper.py', 'catalogue-license lppl1.3c'],
    files: { 'tex/latex/pytool/pytool.sty': '\\ProvidesPackage{pytool}\n', 'tex/latex/pytool/helper.py': 'print("a program")\n' },
  },
  // "other-free" packages, which no set selects unless a test does: one whose README states its terms, one whose
  // own file does, and one that states them nowhere.
  oldstyle: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/oldstyle/oldstyle.sty', 'catalogue-license other-free'],
    files: { 'tex/latex/oldstyle/oldstyle.sty': '\\ProvidesPackage{oldstyle}\n' },
    doc: { 'doc/latex/oldstyle/README': 'oldstyle\n\nThis package may be freely distributed and used.\n', 'doc/latex/oldstyle/oldstyle.tex': '\\documentclass{article}\n' },
  },
  headerterms: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/headerterms/headerterms.sty', 'catalogue-license other-free'],
    files: { 'tex/latex/headerterms/headerterms.sty': '% headerterms.sty\n% You may freely use, modify and/or distribute this file.\n\\ProvidesPackage{headerterms}\n' },
  },
  mute: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/mute/mute.sty', 'catalogue-license other-free'],
    files: { 'tex/latex/mute/mute.sty': '% mute.sty, by somebody\n\\ProvidesPackage{mute}\n' },
    doc: { 'doc/latex/mute/README': 'mute: a package. See the manual.\n' },
  },
  noncommercial: {
    record: ['category Package', 'relocated 1', 'runfiles size=1', ' RELOC/tex/latex/noncommercial/noncommercial.sty', 'catalogue-license nosell'],
    files: { 'tex/latex/noncommercial/noncommercial.sty': '% not free\n' },
  },
};

describe('B1 bundle builder, without the engine (scripts/build-bundle.mjs)', function () {
  this.timeout(60000);
  let build: Build;
  let xz: Xz;
  let tmp: string;
  let snapshot: string;
  let pinsFile: string;
  let setsFile: string;

  const toXz = (data: Uint8Array) => {
    const chunks: Chunk[] = [];
    for (let i = 0; i < data.length; i += 65536) {
      chunks.push({ kind: 'stored', bytes: Math.min(65536, data.length - i), dictReset: i === 0 });
    }
    return Buffer.from(xzStream(lzma2Encode(data, chunks.length ? chunks : [{ kind: 'stored', bytes: 0, dictReset: true }]), data, 4, xz.crc64));
  };

  function writeSnapshot(damage?: string): string {
    const dir = path.join(tmp, `tlnet-${damage ?? 'good'}`);
    mkdirSync(path.join(dir, 'archive'), { recursive: true });
    mkdirSync(path.join(dir, 'tlpkg'), { recursive: true });
    const records: string[] = [];
    for (const [name, p] of Object.entries(PACKAGES)) {
      const lines = [`name ${name}`, ...p.record];
      if (p.files) {
        const archive = toXz(tarArchive(p.files));
        writeFileSync(path.join(dir, 'archive', `${name}.tar.xz`), damage === name ? Buffer.concat([archive.subarray(0, 40), Buffer.from('x'), archive.subarray(41)]) : archive);
        lines.push(`containerchecksum ${sha('sha512', archive)}`);
      }
      if (p.doc) {
        const doc = toXz(tarArchive(p.doc));
        writeFileSync(path.join(dir, 'archive', `${name}.doc.tar.xz`), doc);
        lines.push(`doccontainerchecksum ${sha('sha512', doc)}`, 'docfiles size=1', ...Object.keys(p.doc).map((f) => ` RELOC/${f}`));
      }
      records.push(lines.join('\n'));
    }
    const tlpdb = toXz(Buffer.from(`${records.join('\n\n')}\n`));
    writeFileSync(path.join(dir, 'tlpkg', 'texlive.tlpdb.xz'), tlpdb);
    return sha('sha256', tlpdb);
  }

  before(async () => {
    build = await importScript<Build>('scripts/build-bundle.mjs');
    xz = await importScript<Xz>('scripts/lib/xz.mjs');
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-bundle-'));
    snapshot = path.join(tmp, 'tlnet-good');
    const pin = writeSnapshot();
    pinsFile = path.join(tmp, 'pins.json');
    writeFileSync(pinsFile, pinsOf(pin));
    setsFile = path.join(tmp, 'sets.json');
    writeFileSync(
      setsFile,
      JSON.stringify({
        'core-data': { collections: ['collection-basic'], licence: 'free', t1cSkip: { amsfonts: 'the SIL Open Font License' } },
        'extra-data': { packages: ['extrapkg', 'noncommercial', 'xcolor'], licence: 'free' },
        outsideProgram: { minted: 'Pygments' },
      }),
    );
  });
  after(() => {
    // main() puts the program guard on; this process runs other tests after these.
    build.releaseProgramGuard();
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (args: string[], tlnet = snapshot, pins = pinsFile) =>
    build.main(['--local', tlnet, '--pins', pins, '--sets', setsFile, '--out', path.join(tmp, 'out'), '--cache', path.join(tmp, 'cache'), '--engine-assets', path.join(tmp, 'none'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package', ...args], { log: () => undefined });

  it('builds both sets: packages, generated files, images and manifests', async () => {
    const { status, report } = await run([]);
    assert.deepEqual(report.problems, []);
    assert.equal(status, 0);
    assert.deepEqual(report.dropped.map((d) => d.package), ['noncommercial'], 'a package that is not free stays out');
    assert.deepEqual((report as unknown as { moved: unknown[] }).moved, [], 'the report lists the packages moved to extra-data');
    // doc/ and scripts/ that the tlpdb lists as run files are left out, and listed.
    assert.deepEqual((report as unknown as { leftOutTrees: unknown }).leftOutTrees, { core: [], extra: [{ package: 'extrapkg', files: 2, bytes: 28 }] });
    const out = path.join(tmp, 'out');
    const core = JSON.parse(readFileSync(path.join(out, 'core-data', 'data', 'manifest.json'), 'utf8'));
    const extra = JSON.parse(readFileSync(path.join(out, 'extra-data', 'data', 'manifest.json'), 'utf8'));
    assert.equal(core.format, 1);
    assert.equal(core.texLive, 2026);
    assert.match(core.abi, /^[0-9a-f]{64}$/);
    assert.equal(core.core.root, '/texlive/texmf-dist');
    assert.ok(core.index.packages.amsfonts, 'amsfonts is in core-data');
    assert.ok(core.index.packages.xcolor, 'xcolor, which amsfonts depends on, came with core-data');
    assert.ok(extra.index.packages.extrapkg && !extra.index.packages.xcolor);
    assert.deepEqual(Object.keys(core.elsewhere['livemd2tex-extra-data'].files).sort(), ['extra.map', 'extrapkg.sty']);
    assert.deepEqual(core.outsideProgram, { minted: 'Pygments' });
    // The core image, read back as the engine host reads it.
    const { openImage } = await importScript<ImageFiles>('scripts/lib/image-files.mjs');
    const index = JSON.parse(readFileSync(path.join(out, 'core-data', 'data', 'core.index.json'), 'utf8'));
    const reader = openImage(path.join(out, 'core-data', 'data', 'core.data'), index.compressed);
    const get = (name: string) => {
      const f = index.metadata.files.find((x: { filename: string }) => x.filename === name);
      assert.ok(f, `the core image has no ${name}`);
      return reader.read(f.start, f.end).toString('utf8');
    };
    assert.equal(get('/texlive/texmf-dist/tex/latex/amsfonts/amsfonts.sty'), PACKAGES.amsfonts.files?.['tex/latex/amsfonts/amsfonts.sty']);
    assert.equal(get('/texlive/texmf-dist/texmf-var/tex/generic/config/language.dat'), '% language.dat\n% from hyphen-base:\nenglish hyphen.tex\n=usenglish\n');
    assert.equal(
      get('/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map'),
      '% ps2pk35.map\nptmr8r Times-Roman "TeXBase1Encoding ReEncodeFont" <8r.enc <utmr8a.pfb\n% extra.map\nxyz10 XYZ10 <xyz10.pfb\n% cmextra.map\ncmex7 CMEX7 <cmex7.pfb\n',
    );
    assert.match(get('/texlive/texmf-dist/web2c/fmtutil.cnf'), /# from latex-bin:\npdflatex pdftex language\.dat -etex pdflatex\.ini\n/);
    // pdftex.map only: updmap's two copies are read by nothing here.
    assert.ok(!index.metadata.files.some((f: { filename: string }) => /pdftex_n?dl14\.map$/.test(f.filename)));
    // The core's Type 1 fonts are stored packed with t1c: the index and the manifest name them with the SHA-256 of
    // each original, and the stored bytes unpack to it (font packing: decided by the maintainer, 2026-10-22). The
    // fonts of a package that t1cSkip names (amsfonts, under the OFL) are stored as they are.
    const font = '/texlive/texmf-dist/fonts/type1/public/cm-super/sfrm1000.pfb';
    const packedList = { method: 't1c', files: { [font]: sha('sha256', PFB) } };
    assert.deepEqual(index.metadata.packed, packedList);
    assert.deepEqual(core.image.packed, packedList);
    const storedAs = (name: string) => {
      const f = index.metadata.files.find((x: { filename: string }) => x.filename === name);
      return reader.read(f.start, f.end);
    };
    const stored = storedAs(font);
    assert.ok(!stored.equals(PFB), 'stored packed');
    assert.ok(Buffer.from(t1cUnpack(stored)).equals(PFB), 'unpacks to the original');
    assert.ok(storedAs('/texlive/texmf-dist/fonts/type1/public/amsfonts/cmex7.pfb').equals(PFB), "amsfonts' font is stored as it is");
    assert.match(readFileSync(path.join(out, 'report-build.txt'), 'utf8'), /\ncore-data: 1 Type 1 fonts packed with t1c \(each unpacks to its original's SHA-256\); stored as they are: the fonts of amsfonts, and by their own headers none; 1 under the GPL, each in LICENSES\/CHANGES-GPL\n/);
    // The GPL's notice of changes: every packed font under the GPL, with its original's SHA-256, what was done and
    // the date of the build (GPL change notices: decided by the maintainer, 2026-10-26).
    const changes = readFileSync(path.join(out, 'core-data', 'LICENSES', 'CHANGES-GPL'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const date = (report as unknown as { started: string }).started.slice(0, 10);
    assert.deepEqual(changes, [`${font}\tcm-super\t${sha('sha256', PFB)}\tstored with its eexec and charstring encryption removed for compression; restored byte for byte before use\t${date}`]);
    assert.deepEqual((report as unknown as { packed: unknown }).packed, { method: 't1c', files: 1, kept: ['amsfonts'], byClass: { lppl: [], vera: [], gpl: ['cm-super'] }, unpacked: {}, gplChanges: 1 });
    assert.equal(extra.image.packed, undefined, 'extra-data is not packed');
    assert.match(get('/texlive/texmf-dist/ls-R'), /^% ls-R -- filename database for kpathsea; do not change this line\.\n\.\/:\n/);
    // texmf-var lies inside texmf-dist, so the one ls-R must list it: kpathsea finds the generated language.dat
    // only through it (the second CI build read TeX Live's default one instead).
    assert.match(get('/texlive/texmf-dist/ls-R'), /\n\.\/texmf-var\/tex\/generic\/config:\n(?:[^\n]+\n)*language\.dat\n/);
    assert.ok(!index.metadata.files.some((f: { filename: string }) => f.filename === '/texlive/texmf-dist/texmf-var/ls-R'));
    assert.ok(!index.metadata.files.some((f: { filename: string }) => f.filename.includes('tlpkg')), 'tlpkg/ is left out');
    const extraIndex = JSON.parse(readFileSync(path.join(out, 'extra-data', 'data', 'extra.index.json'), 'utf8'));
    assert.deepEqual(extraIndex.metadata.files.map((f: { filename: string }) => f.filename), ['/fonts/map/dvips/extrapkg/extra.map', '/ls-R', '/tex/latex/extrapkg/extrapkg.sty']);
    const licences = JSON.parse(readFileSync(path.join(out, 'core-data', 'data', 'licences.json'), 'utf8'));
    assert.deepEqual(licences.amsfonts, { licence: ['ofl'], ctan: '/fonts/amsfonts', revision: 0 });
    assert.match(readFileSync(path.join(out, 'report-build.txt'), 'utf8'), /core-data: \d+ packages/);
    // Where the bytes go: by kind and by file, with no documentation and no sources.
    const sizes = (JSON.parse(readFileSync(path.join(out, 'report-build.json'), 'utf8')) as { sizes: Record<string, { byKind: Record<string, number>; topFiles: { name: string; bytes: number }[] }> }).sizes;
    assert.ok(sizes.core.byKind['hyphenation patterns'] > 0 && sizes.core.byKind['fonts: other (enc, map, fd, mf, pfm)'] > 0, JSON.stringify(sizes.core.byKind));
    assert.equal(sizes.core.byKind['documentation (doc/)'], undefined);
    assert.equal(sizes.core.byKind['sources (.dtx, .ins, source/)'], undefined);
    assert.ok(sizes.core.topFiles.length > 0 && sizes.core.topFiles.every((f, i, a) => i === 0 || a[i - 1].bytes >= f.bytes));
    assert.match(readFileSync(path.join(out, 'report-build.txt'), 'utf8'), /\ncore-data by kind: [^\n]+\ncore-data, largest packages: [^\n]+\ncore-data, largest files: /);
    const { fileKind } = await importScript<{ fileKind(n: string): string }>('scripts/lib/bundle.mjs');
    assert.deepEqual(
      ['texlive/texmf-dist/fonts/type1/public/cm-super/sfrm1000.pfb', 'texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt', 'texlive/texmf-dist/fonts/afm/public/lm/lmr10.afm', 'texlive/icudt78l.dat', 'texlive/texmf-dist/doc/latex/x/x.pdf', 'texlive/texmf-dist/source/latex/x/x.dtx'].map(fileKind),
      ['fonts: Type 1', 'formats', 'fonts: AFM (metrics no engine here reads)', 'engine support (ICU data, /bin, /etc)', 'documentation (doc/)', 'sources (.dtx, .ins, source/)'],
    );
    // The selection, for the reference install (GB1E-07).
    const selection = JSON.parse(readFileSync(path.join(out, 'selection.json'), 'utf8'));
    assert.deepEqual(selection.extra, ['extrapkg']);
    assert.ok(selection.core.includes('amsfonts') && selection.core.includes('xcolor'));
    // Each data package's licence texts: LICENSES/INDEX lists every package with its files, texts/ holds each
    // licence once (from the repository, at its pinned bytes, or TeX Live's own from texlive.infra's archive), and
    // packages/ holds a package's own licence files, here amsfonts' OFL.txt from its doc archive.
    const licenceFile = (set: string, rel: string) => readFileSync(path.join(out, set, 'LICENSES', rel));
    const rows = (set: string) => licenceFile(set, 'INDEX').toString('utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rows('core-data'), [
      'amsfonts\tofl\ttexts/OFL-1.1.txt packages/amsfonts/doc/fonts/amsfonts/OFL.txt',
      'cm-super\tgpl\ttexts/GPL-2.0.txt texts/GPL-3.0.txt',
      'hyphen-base\t(none)\ttexts/TeX-Live-LICENSE.TL.txt texts/TeX-Live-LICENSE.CTAN.txt',
      'latex-bin\t(none)\tships no files',
      'texlive-scripts\t(none)\ttexts/TeX-Live-LICENSE.TL.txt texts/TeX-Live-LICENSE.CTAN.txt',
      'texlive.infra\t(none)\ttexts/TeX-Live-LICENSE.TL.txt texts/TeX-Live-LICENSE.CTAN.txt',
      'xcolor\tlppl1.3c\ttexts/LPPL-1.3c.txt',
    ]);
    assert.deepEqual(rows('extra-data'), ['extrapkg\tgpl2+\ttexts/GPL-2.0.txt texts/GPL-3.0.txt']);
    assert.ok(licenceFile('core-data', 'texts/GPL-2.0.txt').equals(readFileSync(path.join(root, 'engine', 'licence-texts', 'GPL-2.0.txt'))));
    assert.ok(licenceFile('core-data', 'texts/GPL-3.0.txt').equals(readFileSync(path.join(root, 'LICENSE'))));
    assert.equal(licenceFile('core-data', 'texts/TeX-Live-LICENSE.TL.txt').toString('utf8'), 'TeX Live licence, made up.\n');
    assert.equal(licenceFile('core-data', 'packages/amsfonts/doc/fonts/amsfonts/OFL.txt').toString('utf8'), '"cmex7" is a Reserved Font Name for this Font Software.\n');
    assert.ok(!existsSync(path.join(out, 'core-data', 'LICENSES', 'packages', 'amsfonts', 'doc', 'fonts', 'amsfonts', 'amsfndoc.pdf')), 'a PDF is no licence file');
    assert.ok(!existsSync(path.join(out, 'extra-data', 'LICENSES', 'texts', 'OFL-1.1.txt')), 'each package has only the texts its own licences need');
    assert.match(readFileSync(path.join(out, 'report-build.txt'), 'utf8'), /\ncore-data: licence texts for 7 packages in LICENSES\/ \(\d+ files, [^)]+\); terms found by reading text, to check: none\n/);
  });

  it('knows a licence file by its name, and fetches the doc and source archives only where licence texts are needed', async () => {
    const lt = await importScript<{
      isLicenceFile(rel: string): boolean;
      licenceArchives(name: string, pkg: unknown, licences: string[], rules: unknown): string[];
    }>('scripts/lib/licence-texts.mjs');
    const yes = ['LICENSE', 'doc/fonts/amsfonts/OFL.txt', 'doc/latex/x/COPYING', 'doc/fonts/ec/copyrite.txt', 'doc/latex/beamer/licenses/gpl-2.0.txt', 'doc/fonts/lm/GUST-FONT-LICENSE.TXT', 'doc/latex/x/lppl-1-3c.txt', 'doc/generic/tex-ewd/bsdlic.txt', 'LICENSE.TL'];
    const no = ['tex/latex/copyrightbox/copyrightbox.sty', 'doc/latex/x/license.pdf', 'doc/latex/x/README', 'tex/latex/x/x.sty', 'doc/latex/x/licence.py'];
    assert.deepEqual(yes.filter((f) => !lt.isLicenceFile(f)), []);
    assert.deepEqual(no.filter((f) => lt.isLicenceFile(f)), []);
    const rules = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-licences.json'), 'utf8'));
    const pkg = (docfiles: string[], src = false) => ({ docfiles, docContainerChecksum: 'd', srcContainerChecksum: src ? 's' : '' });
    assert.deepEqual(lt.licenceArchives('x', pkg(['RELOC/doc/latex/x/LICENSE']), ['lppl1.3c'], rules), [], 'the LPPL needs no file of the package');
    assert.deepEqual(lt.licenceArchives('x', pkg(['RELOC/doc/latex/x/LICENSE']), ['mit'], rules), ['doc'], "an MIT notice: the package's own file");
    assert.deepEqual(lt.licenceArchives('x', pkg(['RELOC/doc/latex/x/x.pdf']), ['mit'], rules), [], 'no licence file listed: the MIT text alone');
    assert.deepEqual(lt.licenceArchives('x', pkg(['RELOC/doc/latex/x/README'], true), ['other-free'], rules), ['doc', 'source'], 'terms to find: both');
    assert.deepEqual(lt.licenceArchives('dejavu', pkg(['RELOC/doc/fonts/dejavu/LICENSE']), ['lppl1.3'], rules), ['doc'], 'a package whose own licence files must ship');
    assert.deepEqual(lt.licenceArchives('makeindex', pkg([], true), ['other-free'], rules), [], 'a package whose notice the rules hold');
  });

  it("gives the engine build's files their licence texts (ICU's data), and stops on a file no rule covers", async () => {
    const lt = await importScript<{
      licenceFolder(set: string, packages: unknown[], rules: unknown, texts: Map<string, Buffer>, engineFiles?: string[]): { files: Map<string, Buffer>; index: string; problems: string[] };
      loadTexts(root: string, rules: unknown, fromArchives?: Map<string, Buffer>): { texts: Map<string, Buffer>; problems: string[] };
    }>('scripts/lib/licence-texts.mjs');
    const rules = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-licences.json'), 'utf8'));
    const { texts } = lt.loadTexts(root, rules, new Map([['TeX-Live-LICENSE.TL', Buffer.from('TL')], ['TeX-Live-LICENSE.CTAN', Buffer.from('CTAN')]]));
    const folder = lt.licenceFolder('core-data', [], rules, texts, ['/texlive/icudt78l.dat', '/texlive/texmf.cnf', '/bin/busytex', '/texlive/tex/generic/tex-ini-files/xetex.ini']);
    assert.deepEqual(folder.problems, []);
    const rows = folder.index.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rows, [
      'bin/busytex\t(engine build)\t-',
      'texlive/icudt78l.dat\t(engine build)\ttexts/ICU.txt',
      'texlive/tex/generic/tex-ini-files/xetex.ini\t(engine build)\t-',
      'texlive/texmf.cnf\t(engine build)\ttexts/TeX-Live-LICENSE.TL.txt texts/TeX-Live-LICENSE.CTAN.txt',
    ]);
    assert.ok(folder.files.get('texts/ICU.txt')?.equals(readFileSync(path.join(root, 'LICENSES', 'ICU.txt'))));
    assert.deepEqual(lt.licenceFolder('core-data', [], rules, texts, ['/texlive/unknown.bin']).problems, [
      'core-data: texlive/unknown.bin, from the engine build\'s image, matches no rule in engine/bundle-licences.json ("engineFiles")',
    ]);
  });

  it('ships the licence texts each package needs, and stops when one is missing or not the pinned text', async () => {
    const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
    const build1 = async (name: string, extraPackages: string[], licencesFile?: string) => {
      const file = path.join(tmp, `sets-${name}.json`);
      writeFileSync(file, JSON.stringify({ ...sets, 'extra-data': { ...sets['extra-data'], packages: [...sets['extra-data'].packages, ...extraPackages] } }));
      const outDir = path.join(tmp, `out-${name}`);
      const result = await build.main(['--local', snapshot, '--pins', pinsFile, '--sets', file, '--out', outDir, '--engine-assets', path.join(tmp, 'none'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package', ...(licencesFile ? ['--licences', licencesFile] : [])], { log: () => undefined });
      return { ...result, outDir };
    };
    // "other-free": the terms a README states (the README ships), or that the package's own file states.
    const found = await build1('terms', ['oldstyle', 'headerterms']);
    assert.deepEqual(found.report.problems, []);
    const index = readFileSync(path.join(found.outDir, 'extra-data', 'LICENSES', 'INDEX'), 'utf8');
    assert.match(index, /\noldstyle\tother-free\tpackages\/oldstyle\/doc\/latex\/oldstyle\/README\n/);
    assert.match(index, /\nheaderterms\tother-free\tterms in data:tex\/latex\/headerterms\/headerterms\.sty\n/);
    assert.deepEqual((found.report as unknown as { licences: Record<string, { termsFound: { package: string }[] }> }).licences['extra-data'].termsFound.map((f) => f.package), ['headerterms', 'oldstyle'], 'listed for a person to check');
    // A package that states its terms nowhere stops the build.
    const missing = await build1('mute', ['mute']);
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.report.problems, ['extra-data: mute is under "other-free", and no licence file, no README or source file stating its terms, and no statement in its own files was found; read its files and record them in engine/bundle-licences.json ("readings"), or leave it out']);
    // A text that is not the pinned one, and a licence with no rule, stop it too.
    const rules = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-licences.json'), 'utf8'));
    rules.texts['GPL-2.0'].sha256 = '0'.repeat(64);
    delete rules.keys['lppl1.3c'];
    const rulesFile = path.join(tmp, 'licences-wrong.json');
    writeFileSync(rulesFile, JSON.stringify(rules));
    const wrong = await build1('wrong-text', [], rulesFile);
    assert.equal(wrong.status, 1);
    assert.ok(wrong.report.problems.some((p) => /^licence text GPL-2\.0: engine\/licence-texts\/GPL-2\.0\.txt is not the pinned text/.test(p)), wrong.report.problems.join('\n'));
    assert.ok(wrong.report.problems.includes('core-data: cm-super needs the licence text GPL-2.0, which the build does not have'));
    assert.ok(wrong.report.problems.includes('core-data: xcolor is under the licence "lppl1.3c", which engine/bundle-licences.json has no rule for'));
  });

  it('packs a font only under terms whose stored form was read, decided per font; t1cSkip must name core packages', async () => {
    const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
    const withSkip = async (name: string, t1cSkip: Record<string, string>) => {
      const file = path.join(tmp, `sets-${name}.json`);
      writeFileSync(file, JSON.stringify({ ...sets, 'core-data': { ...sets['core-data'], t1cSkip } }));
      return build.main(['--local', snapshot, '--pins', pinsFile, '--sets', file, '--out', path.join(tmp, `out-${name}`), '--engine-assets', path.join(tmp, 'none'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package'], { log: () => undefined });
    };
    // Without t1cSkip, amsfonts' font (its header states nothing; its package is under the OFL) is still stored as it
    // is, with the reason: the build decides per font (the t1c gate, T1S-01).
    const ofl = await withSkip('no-skip', {});
    assert.deepEqual(ofl.report.problems, []);
    const packed = (ofl.report as unknown as { packed: { files: number; unpacked: Record<string, { reason: string; files: number }[]> } }).packed;
    assert.equal(packed.files, 1, "only cm-super's font");
    assert.deepEqual(packed.unpacked, { amsfonts: [{ reason: "its header states no licence, and its package's licence is not the LPPL, the GUST Font License or the GPL", files: 1 }] });
    const licence = readFileSync(path.join(tmp, 'out-no-skip', 'core-data', 'LICENSES', 'INDEX'), 'utf8');
    assert.match(licence, /\namsfonts\tofl\ttexts\/OFL-1\.1\.txt packages\/amsfonts\/doc\/fonts\/amsfonts\/OFL\.txt\n/);
    const stale = await withSkip('stale-skip', { amsfonts: 'OFL', 'no-such-font': 'gone' });
    assert.equal(stale.status, 1);
    assert.deepEqual(stale.report.problems, ["core-data's t1cSkip names no-such-font, which core-data does not hold"]);
  });

  it('stops on a damaged archive, a tlpdb that is not the pinned one, and a name the tlpdb lacks', async () => {
    // The damaged snapshot has a tlpdb of its own: pin it, so only the archive is wrong.
    writeSnapshot('amsfonts');
    const pin = sha('sha256', readFileSync(path.join(tmp, 'tlnet-amsfonts', 'tlpkg', 'texlive.tlpdb.xz')));
    writeFileSync(path.join(tmp, 'pins-damaged.json'), pinsOf(pin));
    const archive = await run([], path.join(tmp, 'tlnet-amsfonts'), path.join(tmp, 'pins-damaged.json'));
    assert.equal(archive.status, 1);
    assert.ok(archive.report.problems.some((p) => /amsfonts\.tar\.xz: the SHA-512 is not the tlpdb's/.test(p)), archive.report.problems.join('\n'));
    // The good snapshot against another pin.
    writeFileSync(path.join(tmp, 'pins-wrong.json'), pinsOf('0'.repeat(64)));
    const wrong = await run([], snapshot, path.join(tmp, 'pins-wrong.json'));
    assert.equal(wrong.status, 1);
    assert.match(wrong.report.problems[0], /not the pinned/);
    // A pin that does not say its signature was checked is no pin (GB1E-02).
    writeFileSync(path.join(tmp, 'pins-unchecked.json'), pinsOf(sha('sha256', readFileSync(path.join(snapshot, 'tlpkg', 'texlive.tlpdb.xz'))), false));
    assert.equal((await run([], snapshot, path.join(tmp, 'pins-unchecked.json'))).status, 2);
    // A name the tlpdb does not have.
    const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
    sets['extra-data'].packages.push('no-such-package');
    const other = path.join(tmp, 'sets-missing.json');
    writeFileSync(other, JSON.stringify(sets));
    const missing = await build.main(['--local', snapshot, '--pins', pinsFile, '--sets', other, '--out', path.join(tmp, 'out2'), '--engine-assets', path.join(tmp, 'none'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package'], { log: () => undefined });
    assert.equal(missing.status, 1);
    assert.ok(missing.report.problems.some((p) => p.includes('no-such-package')));
  });

  it('lists the packages with no Catalogue licence (TeX Live\'s own files) in the report (GB1E-01)', async () => {
    const { report } = await run([]);
    assert.ok(report.unclassified?.core.includes('hyphen-base'), JSON.stringify(report.unclassified));
    assert.ok(report.unclassified?.core.includes('texlive-scripts'));
  });

  it('pins only a tlpdb that TeX Live\'s signed SHA-512 vouches for (GB1E-02)', async () => {
    const xzFile = readFileSync(path.join(snapshot, 'tlpkg', 'texlive.tlpdb.xz'));
    assert.match(build.checkSignedHash('', xzFile, '').reason ?? '', /no SHA-512/);
    const tlpdbText = (await importScript<{ unxz(b: Uint8Array): Buffer }>('scripts/lib/xz.mjs')).unxz(xzFile).toString('utf8');
    const textHash = sha('sha512', Buffer.from(tlpdbText));
    assert.deepEqual(build.checkSignedHash(`${textHash}  texlive.tlpdb\n`, xzFile, tlpdbText), { ok: true, matched: 'texlive.tlpdb', sha512: textHash });
    assert.deepEqual(build.checkSignedHash(`${sha('sha512', xzFile)}  texlive.tlpdb.xz\n`, xzFile, tlpdbText), { ok: true, matched: 'texlive.tlpdb.xz', sha512: sha('sha512', xzFile) });
    assert.equal(build.checkSignedHash(`${'0'.repeat(128)}  texlive.tlpdb\n`, xzFile, tlpdbText).ok, false);
    const unpinned = path.join(tmp, 'pins-unpinned.json');
    writeFileSync(unpinned, pinsOf(null, false));
    const pin = (signed?: string, by: string | undefined = KEY) =>
      build.main(
        ['--local', snapshot, '--pins', unpinned, '--sets', setsFile, '--out', path.join(tmp, 'out-pin'), '--stage', 'pin', ...(signed ? ['--signed-sha512', signed] : []), ...(by ? ['--signed-by', by] : [])],
        { log: () => undefined },
      );
    const good = path.join(tmp, 'good.sha512');
    writeFileSync(good, `${textHash}  texlive.tlpdb\n`);
    assert.equal((await pin()).status, 2, 'no pin without the signed checksum');
    assert.equal((await pin(good, '')).status, 2, 'no pin without the key gpg reported');
    const otherKey = await pin(good, '0123456789ABCDEF0123456789ABCDEF01234567');
    assert.equal(otherKey.status, 1);
    assert.match(otherKey.report.problems[0], /not by TeX Live's key C78B82D8/);
    const ok = await pin(good, KEY.toLowerCase().replace(/(.{4})/g, '$1 '));
    assert.equal(ok.status, 0);
    assert.equal(ok.report.pin?.tlpdbSha256, sha('sha256', xzFile));
    assert.ok(ok.report.pin?.core.none.includes('hyphen-base'));
    // What to pin: the SHA-256, the signed SHA-512, and the note that the signature was checked.
    const entry = ok.report.pin?.entry;
    assert.deepEqual([entry?.file, entry?.sha256, entry?.signedSha512], ['tlpkg/texlive.tlpdb.xz', sha('sha256', xzFile), textHash]);
    assert.match(entry?.signatureChecked ?? '', /^\d{4}-\d\d-\d\d: gpg verified tlpkg\/texlive\.tlpdb\.sha512\.asc with key C78B82D8C79512F79CC0D7C80D5E5D9106BAB6BC; its SHA-512 is that of texlive\.tlpdb$/);
    assert.ok(readFileSync(path.join(tmp, 'out-pin', 'report-pin.txt'), 'utf8').includes(`"tlpdb": ${JSON.stringify(entry)}`));
    const bad = path.join(tmp, 'bad.sha512');
    writeFileSync(bad, `${'1'.repeat(128)}  texlive.tlpdb\n`);
    const refused = await pin(bad);
    assert.equal(refused.status, 1);
    assert.match(refused.report.problems[0], /not the one TeX Live signed/);
  });

  it('fetches from a copy the workflow downloaded, lists for curl what is missing or wrong, and opens no connection', async () => {
    const copy = path.join(tmp, 'downloaded');
    cpSync(snapshot, copy, { recursive: true });
    rmSync(path.join(copy, 'archive', 'xcolor.tar.xz'));
    writeFileSync(path.join(copy, 'archive', 'extrapkg.tar.xz'), 'an HTML page from a bot check');
    const config = path.join(tmp, 'to-fetch.curl');
    const noNetwork = () => Promise.reject(new Error('the builder opened a connection'));
    const fetchStage = (extra: string[]) =>
      build.main(['--local', copy, '--pins', pinsFile, '--sets', setsFile, '--out', path.join(tmp, 'out-fetch'), '--stage', 'fetch', ...extra], { log: () => undefined, fetchImpl: noNetwork });
    const listed = await fetchStage(['--curl-config', config]);
    assert.deepEqual(listed.report.problems, []);
    assert.equal(listed.status, 0);
    const base = 'https://texlive.info/tlnet-archive/2026/10/15/tlnet/';
    const out = (n: string) => path.join(copy, 'archive', `${n}.tar.xz`).replace(/\\/g, '/');
    assert.equal(
      readFileSync(config, 'utf8'),
      ['extrapkg', 'xcolor'].map((n) => `url = "${base}archive/${n}.tar.xz"\noutput = ${JSON.stringify(out(n))}\n`).join(''),
    );
    // Without the list, a missing or wrong archive stops the stage.
    const stopped = await fetchStage([]);
    assert.equal(stopped.status, 1);
    assert.deepEqual(stopped.report.problems.sort(), ["extrapkg.tar.xz: the SHA-512 is not the tlpdb's", 'xcolor.tar.xz is not in the downloaded copy']);
    // A tlpdb missing from the copy is an error that says so.
    await assert.rejects(
      build.main(['--local', path.join(tmp, 'none'), '--pins', pinsFile, '--sets', setsFile, '--out', path.join(tmp, 'out-fetch'), '--stage', 'fetch'], { log: () => undefined, fetchImpl: noNetwork }),
      /tlpkg\/texlive\.tlpdb\.xz is not in the downloaded copy/,
    );
  });

  it('ships no program: a package that holds one stops the build, and doc/, source/ and scripts/ stay out', async () => {
    const { isProgramFile, NOT_TEX } = await importScript<{ isProgramFile(rel: string): boolean; NOT_TEX: RegExp }>('scripts/lib/bundle.mjs');
    for (const rel of ['scripts/pax/pax.jar', 'tex/latex/x/helper.py', 'tex/latex/x/tool.pl', 'scripts/minted/latexminted-0.7.0-py3-none-any.whl', 'bin/x.exe', 'lib/x.dll', 'lib/x.so', 'tex/x/run.sh', 'fonts/misc/x.lua']) {
      assert.equal(isProgramFile(rel), true, rel);
    }
    for (const rel of ['tex/luatex/luaotfload/luaotfload-main.lua', 'texmf-var/tex/generic/config/language.dat.lua', 'tex/latex/x/x.sty', 'fonts/type1/public/x/x.pfb', 'tex/latex/x/x.js']) {
      assert.equal(isProgramFile(rel), false, rel);
    }
    assert.deepEqual(['doc/latex/x/README', 'source/latex/x/x.dtx', 'scripts/x/x.pl', 'tex/latex/x/x.dtx'].map((r) => NOT_TEX.test(r)), [true, true, true, false]);
    const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
    sets['extra-data'].packages.push('pytool');
    const withPy = path.join(tmp, 'sets-pytool.json');
    writeFileSync(withPy, JSON.stringify(sets));
    const r = await build.main(['--local', snapshot, '--pins', pinsFile, '--sets', withPy, '--out', path.join(tmp, 'out-pytool'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package'], { log: () => undefined });
    assert.equal(r.status, 1);
    assert.deepEqual(r.report.problems, ['extra-data: pytool holds tex/latex/pytool/helper.py, a program file; a data set may not ship one (leave the package out with its reason)']);
    // Left out with its reason, the package is listed and the build goes on.
    sets['extra-data'].exclude = { pytool: 'a program in a data set: helper.py' };
    writeFileSync(withPy, JSON.stringify(sets));
    const ok = await build.main(['--local', snapshot, '--pins', pinsFile, '--sets', withPy, '--out', path.join(tmp, 'out-pytool'), '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package'], { log: () => undefined });
    assert.deepEqual(ok.report.problems, []);
    assert.ok(ok.report.dropped.some((d) => d.package === 'pytool'));
  });

  it('moves a package and its dependency to extra-data (toExtra), and leaves it out of core-data even as a dependency', async () => {
    type Db = Map<string, unknown>;
    const { parseTlpdb } = await importScript<{ parseTlpdb(text: string): Db }>('scripts/lib/tlpdb.mjs');
    const { selectSets } = await importScript<{
      selectSets(db: Db, sets: unknown): { core: Set<string>; extra: Set<string>; moved: { package: string; inExtra: boolean }[]; problems: string[] };
    }>('scripts/lib/bundle.mjs');
    const record = (name: string, ...lines: string[]) => [`name ${name}`, ...lines].join('\n');
    const db = parseTlpdb(
      [
        record('collection-latexrecommended', 'category Collection', 'depend fontspec'),
        record('fontspec', 'category Package', 'depend xunicode', 'catalogue-license lppl1.3c'),
        record('xunicode', 'category Package', 'depend tipa', 'catalogue-license lppl1.3'),
        record('tipa', 'category Package', 'catalogue-license lppl1.3'),
      ].join('\n\n') + '\n',
    );
    const r = selectSets(db, {
      'core-data': { packages: ['fontspec'], licence: 'free', toExtra: { xunicode: 'obsolete', tipa: 'only for xunicode' } },
      'extra-data': { collections: ['collection-latexrecommended'], licence: 'free' },
    });
    assert.deepEqual(r.problems, []);
    assert.deepEqual([...r.core], ['fontspec']);
    assert.deepEqual([...r.extra].sort(), ['tipa', 'xunicode']);
    assert.deepEqual(r.moved.map((m) => [m.package, m.inExtra]), [['xunicode', true], ['tipa', true]]);
  });

  it('judges the closure test with its rules: expected failures with reasons, setup preambles, stale entries', async () => {
    const { closureDocument, judgeClosure } = await importScript<{
      closureDocument(t: { kind: string; name: string }, preamble?: string): string;
      judgeClosure(
        results: { set: string; package: string; file: string; engine: string; ok: boolean; missing: string[] }[],
        rules: { expected?: Record<string, string> },
        extraFiles: Record<string, string>,
      ): { problems: string[]; expected: { file: string; reason: string; inExtra: string[] }[]; stale: string[] };
    }>('scripts/lib/bundle-engine.mjs');
    assert.equal(closureDocument({ kind: 'package', name: 'babelbib' }, '\\usepackage[english]{babel}'), '\\documentclass{article}\n\\usepackage[english]{babel}\n\\usepackage{babelbib}\n\\begin{document}\nx\n\\end{document}\n');
    assert.equal(closureDocument({ kind: 'class', name: 'ltxdoc' }), '\\documentclass{ltxdoc}\n\\begin{document}\nx\n\\end{document}\n');
    const fail = (file: string, missing: string[]) => ({ set: 'core', package: file.split('/')[2], file, engine: 'pdflatex', ok: false, missing });
    const verdict = judgeClosure(
      [
        fail('tex/latex/base/ltxdoc.cls', ["! LaTeX Error: File `hypdoc.sty' not found", 'no PDF (see the log)']),
        fail('tex/latex/algorithm2e/algorithm2e.sty', ["! LaTeX Error: File `ifoddpage.sty' not found"]),
        { ...fail('tex/latex/psnfss/bookman.sty', []), ok: true },
      ],
      { expected: { 'tex/latex/base/ltxdoc.cls': 'needs hypdoc', 'tex/latex/psnfss/bookman.sty': 'fonts in extra' } },
      { 'hypdoc.sty': 'hypdoc' },
    );
    assert.deepEqual(verdict.problems, ["closure test: algorithm2e (core, tex/latex/algorithm2e/algorithm2e.sty, pdflatex): ! LaTeX Error: File `ifoddpage.sty' not found"]);
    assert.deepEqual(verdict.expected.map((e) => [e.file, e.reason, e.inExtra]), [['tex/latex/base/ltxdoc.cls', 'needs hypdoc', ['hypdoc.sty']]]);
    assert.deepEqual(verdict.stale, ['tex/latex/psnfss/bookman.sty']);
    // The repository's rules: a reason for every expected failure, and a preamble and a reason for every setup.
    const rules = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'engine', 'bundle-closure.json'), 'utf8'));
    for (const [file, reason] of Object.entries(rules.expected as Record<string, string>)) {
      assert.match(file, /^tex\/latex\/[^/]+\/[^/]+\.(sty|cls)$/, file);
      assert.ok(reason.length > 20, file);
    }
    for (const [file, s] of Object.entries(rules.setup as Record<string, { preamble: string; reason: string }>)) {
      assert.ok(s.preamble.startsWith('\\') && s.reason.length > 20, file);
    }
  });

  it('runs the closure stage without the tlpdb: it opens no connection and reads only the build\'s lists', async () => {
    let fetched = 0;
    const counting = () => {
      fetched++;
      return Promise.reject(new Error('no network'));
    };
    const empty = path.join(tmp, 'out-closure');
    await assert.rejects(
      build.main(['--pins', pinsFile, '--sets', setsFile, '--out', empty, '--stage', 'closure'], { log: () => undefined, fetchImpl: counting }),
      /closure-targets\.json/,
    );
    assert.equal(fetched, 0);
  });

  it('keeps its report when a step fails with an error (GB1E-03)', async () => {
    const sets = JSON.parse(readFileSync(setsFile, 'utf8'));
    sets['core-data'] = { packages: ['amsfonts'], licence: 'free' };
    const other = path.join(tmp, 'sets-noheader.json');
    writeFileSync(other, JSON.stringify(sets));
    const outDir = path.join(tmp, 'out-error');
    await assert.rejects(
      build.main(['--local', snapshot, '--pins', pinsFile, '--sets', other, '--out', outDir, '--engine-image', path.join(tmp, 'none'), '--stage', 'build', '--skip-engine', '--no-package'], { log: () => undefined }),
      /fmtutil-hdr\.cnf/,
    );
    const saved = JSON.parse(readFileSync(path.join(outDir, 'report-build.json'), 'utf8'));
    assert.match(saved.error, /fmtutil-hdr\.cnf/);
    assert.deepEqual(saved.steps.map((s: { name: string }) => s.name), ['sets', 'unpack']);
    assert.match(readFileSync(path.join(outDir, 'report-build.txt'), 'utf8'), /stopped by an error/);
  });

  it('lists the closure test\'s targets: every class, every .sty of a package\'s own folder, without case (GB1E-04)', async () => {
    await run([]);
    const { targets, untestable } = JSON.parse(readFileSync(path.join(tmp, 'out', 'closure-targets.json'), 'utf8'));
    assert.deepEqual(
      targets.map((t: { package: string; targets: { file: string; main: boolean }[] }) => [t.package, t.targets.map((x) => `${x.file}${x.main ? ' (main)' : ''}`)]),
      [
        ['amsfonts', ['tex/latex/amsfonts/amsfonts.sty (main)']],
        ['extrapkg', ['tex/latex/extrapkg/extrapkg.sty (main)']],
        ['xcolor', ['tex/latex/xcolor/xcolor.sty (main)']],
      ],
    );
    assert.ok(untestable.some((u: { package: string }) => u.package === 'hyphen-base'));
    const { loadTargets } = await importScript<{ loadTargets(n: string, f: string[]): { file: string; main: boolean }[] }>('scripts/lib/bundle-engine.mjs');
    assert.deepEqual(
      loadTargets('ieeetran', ['tex/latex/ieeetran/IEEEtran.cls', 'tex/latex/ieeetran/IEEEtrantools.sty']).map((t) => [t.file, t.main]),
      [['tex/latex/ieeetran/IEEEtran.cls', true], ['tex/latex/ieeetran/IEEEtrantools.sty', false]],
    );
    assert.deepEqual(
      loadTargets('revtex', ['tex/latex/revtex/revtex4-2.cls', 'tex/latex/revtex/ltxutil.sty', 'tex/latex/revtex/sub/helper.sty']).map((t) => [t.file, t.main]),
      [['tex/latex/revtex/ltxutil.sty', false], ['tex/latex/revtex/revtex4-2.cls', true]],
    );
  });

  it('takes a "collection" package by the licences read in its files, and lists a package left out on purpose', async () => {
    type Db = Map<string, unknown>;
    const { parseTlpdb } = await importScript<{ parseTlpdb(text: string): Db }>('scripts/lib/tlpdb.mjs');
    const { selectSets } = await importScript<{
      selectSets(db: Db, sets: unknown): { core: Set<string>; extra: Set<string>; dropped: { package: string; set: string; reason: string }[]; problems: string[] };
    }>('scripts/lib/bundle.mjs');
    const record = (name: string, ...lines: string[]) => [`name ${name}`, ...lines].join('\n');
    const db = parseTlpdb(
      [
        record('collection-basic', 'category Collection', 'depend mixed', 'depend misc'),
        record('mixed', 'category Package', 'catalogue-license collection'),
        record('misc', 'category Package', 'catalogue-license collection'),
        record('needs-misc', 'category Package', 'depend misc', 'catalogue-license lppl1.3c'),
        record('other', 'category Package', 'catalogue-license collection'),
      ].join('\n\n') + '\n',
    );
    const sets = {
      licenceReviews: { mixed: { licences: ['lppl1'], read: 'each file says LPPL' } },
      'core-data': { collections: ['collection-basic'], packages: ['needs-misc'], licence: 'free', exclude: { misc: 'not free: one file forbids selling it' } },
      'extra-data': { packages: ['other'], licence: 'free' },
    };
    const r = selectSets(db, sets);
    assert.deepEqual(r.problems, []);
    assert.deepEqual([...r.core].sort(), ['mixed', 'needs-misc'], 'an excluded package stays out, also as a dependency');
    assert.deepEqual(r.dropped, [
      { package: 'misc', set: 'core-data', reason: 'not free: one file forbids selling it' },
      { package: 'other', set: 'extra-data', reason: 'licence collection is not free' },
    ]);
    // Without its review, a "collection" in core-data stops the build.
    assert.deepEqual(selectSets(db, { ...sets, licenceReviews: {} }).problems, ['core-data: mixed has a licence that is not free (collection)']);

    // A group's narrower rule is for its own members only: a font a member depends on, or a package the set
    // already selects, keeps the set's own rule (the first run lost relsize, libertine and others this way).
    const pub = parseTlpdb(
      [
        record('collection-basic', 'category Collection'),
        record('collection-latexextra', 'category Collection', 'depend tool'),
        record('collection-publishers', 'category Collection', 'depend lppl-class', 'depend mit-class'),
        record('tool', 'category Package', 'catalogue-license pd'),
        record('font', 'category Package', 'catalogue-license ofl'),
        record('lppl-class', 'category Package', 'depend font', 'depend tool', 'catalogue-license lppl1.3c'),
        record('mit-class', 'category Package', 'catalogue-license mit'),
      ].join('\n\n') + '\n',
    );
    const group = selectSets(pub, {
      'core-data': { collections: ['collection-basic'], licence: 'free' },
      'extra-data': { collections: ['collection-latexextra'], licence: 'free', groups: [{ collections: ['collection-publishers'], licences: ['^lppl', '^gpl'] }] },
    });
    assert.deepEqual([...group.extra].sort(), ['font', 'lppl-class', 'tool']);
    assert.deepEqual(group.dropped, [{ package: 'mit-class', set: 'extra-data', reason: 'licence mit is not one the group allows' }]);

    // The publisher rule as decided (2026-10-22): the set's free rule, but a class labelled "other-free", or with no
    // licence at all, comes in only once its files are read (readFirst, licenceReviews).
    const wide = parseTlpdb(
      [
        record('collection-basic', 'category Collection'),
        record('collection-publishers', 'category Collection', 'depend mit-class', 'depend vague-class', 'depend read-class', 'depend bare-class', 'depend nc-class'),
        record('mit-class', 'category Package', 'catalogue-license mit'),
        record('vague-class', 'category Package', 'catalogue-license other-free'),
        record('read-class', 'category Package', 'catalogue-license lppl1.3 other-free'),
        record('bare-class', 'category Package'),
        record('nc-class', 'category Package', 'catalogue-license cc-by-nc-4'),
      ].join('\n\n') + '\n',
    );
    const decided = selectSets(wide, {
      licenceReviews: { 'read-class': { licences: ['lppl1.3'], read: 'every file says LPPL 1.3 or later' } },
      'core-data': { collections: ['collection-basic'], licence: 'free' },
      'extra-data': { licence: 'free', groups: [{ collections: ['collection-publishers'], readFirst: ['other-free', 'none'] }] },
    });
    assert.deepEqual([...decided.extra].sort(), ['mit-class', 'read-class']);
    assert.deepEqual(decided.dropped, [
      { package: 'vague-class', set: 'extra-data', reason: 'licence other-free: its files are not read yet (licenceReviews)' },
      { package: 'bare-class', set: 'extra-data', reason: 'licence none: its files are not read yet (licenceReviews)' },
      { package: 'nc-class', set: 'extra-data', reason: 'licence cc-by-nc-4 is not free' },
    ]);
  });

  it('refuses python and perl from its start (GB1E-08)', async () => {
    // main() installs the guard first; the unit tests' own stub, which blocks every program with another message,
    // sits beneath it, so nothing is started either way and the message shows which refused.
    build.guardPrograms();
    const refused = /^Error: B1: the builder may not start \S*(perl|python)/;
    for (const program of ['perl', 'python3', '/usr/bin/perl', 'C:\\Strawberry\\perl\\bin\\perl.exe']) {
      assert.throws(() => childProcess.spawnSync(program, ['-v']), refused, program);
    }
    assert.throws(() => childProcess.execFile('python', ['-V']), refused);
    assert.throws(() => childProcess.execSync('perl -v'), refused);
    assert.throws(() => childProcess.fork('job.js', [], { execPath: '/usr/bin/perl' }), refused, 'a fork with perl as its execPath');
    await assert.rejects(async () => promisify(childProcess.exec)('perl -v'), refused, 'util.promisify(exec) is guarded too');
    // Released, only the unit tests' stub is left.
    build.releaseProgramGuard();
    assert.throws(() => childProcess.spawnSync('perl', ['-v']), /^Error: \[stub\] child_process\.spawnSync is blocked/);
  });
});
