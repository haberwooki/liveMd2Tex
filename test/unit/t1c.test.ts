// t1c, B1's lossless packing of Type 1 fonts (scripts/lib/t1c.mjs packs, src/engine-host/engine/t1c.ts unpacks in the engine
// host; docs/DESIGN.md#engine-and-data): a made-up font with both kinds of encrypted data, the builder's packing
// rule and its licence groups, the data package's licence text, the checks that refuse damaged or unknown packing
// and the plain message they give, and, when the interim image is staged in dist/data, every Computer Modern and
// AMS Type 1 font in it. The built core's fonts are checked on CI (test/engine/bundleCorpus.test.ts).

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildImageIndex, DamagedData, damagedMessage, packedMismatch } from '../../src/engine-host/engine/packageMeta';
import { t1cUnpack } from '../../src/engine-host/engine/t1c';
import { diagnosticsFor, imagesForNotFound, type PreparedCompile } from '../../src/extension/compile/pipeline';
import { checkDataManifest } from '../../src/extension/engine/dataSets';
import type { CompileResult } from '../../src/shared/engineJobs';
import { importScript, root } from '../support/helpers';

interface T1c {
  t1cPack(pfb: Uint8Array): Uint8Array | null;
  t1cUnpack(packed: Uint8Array): Uint8Array;
}

/** Type 1's cipher (Adobe Type 1 Font Format, chapter 7), written out here once more, to make test fonts. */
function encrypt(plain: Uint8Array, key: number): Uint8Array {
  let r = key;
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    const c = plain[i] ^ (r >> 8);
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

/** A PFB segment: 0x80, its type (1 text, 2 binary), its length, its bytes. */
function segment(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head[0] = 0x80;
  head[1] = type;
  head.writeUInt32LE(data.length, 2);
  return Buffer.concat([head, data]);
}

/** A PFB: a text segment, a binary (eexec) segment holding two charstrings, and the end marker. */
function madeUpFont(): Buffer {
  const cs1 = encrypt(Buffer.from([1, 2, 3, 4, 0x8b, 0x8b, 0x0d, 0x0e]), 4330);
  const cs2 = encrypt(Buffer.from([9, 9, 9, 9, 0xf7, 0x1e, 0x0e]), 4330);
  const plain = Buffer.concat([
    Buffer.from('abcd dup /Private 8 dict dup begin\n/Subrs 1 array\ndup 0 8 RD ', 'latin1'),
    cs1,
    Buffer.from(' NP\n2 index /CharStrings 1 dict dup begin\n/a 7 -| ', 'latin1'),
    cs2,
    Buffer.from(' |-\nend\nmark currentfile closefile\n', 'latin1'),
  ]);
  return Buffer.concat([segment(1, Buffer.from('%!PS-AdobeFont-1.0: Test\ncurrentfile eexec\n', 'latin1')), segment(2, Buffer.from(encrypt(plain, 55665))), Buffer.from([0x80, 3])]);
}

/** The same font with its eexec data split over two binary segments, as some converters write it. */
function twoSegmentFont(): Buffer {
  const font = madeUpFont();
  const textLength = font.readUInt32LE(2);
  const binaryAt = 6 + textLength;
  const binary = font.subarray(binaryAt + 6, binaryAt + 6 + font.readUInt32LE(binaryAt + 2));
  const half = binary.length >> 1;
  return Buffer.concat([font.subarray(0, binaryAt), segment(2, binary.subarray(0, half)), segment(2, binary.subarray(half)), Buffer.from([0x80, 3])]);
}

describe('t1c: lossless packing of Type 1 fonts (B1, core-data)', () => {
  let t1c: T1c;
  before(async () => {
    t1c = await importScript<T1c>('scripts/lib/t1c.mjs');
  });

  it('packs a font so its charstrings read as plain bytes, and both sides give the original back', () => {
    const font = madeUpFont();
    const packed = t1c.t1cPack(font);
    assert.ok(packed);
    assert.equal(packed.length, font.length, 'the same length, so offsets and sizes stay');
    const text = Buffer.from(packed).toString('latin1');
    assert.match(text, /dup \/Private 8 dict/, 'the eexec section is decrypted');
    assert.ok(Buffer.from(packed).includes(Buffer.from([1, 2, 3, 4, 0x8b, 0x8b, 0x0d, 0x0e])), 'the charstrings are decrypted');
    assert.ok(Buffer.from(t1cUnpack(packed)).equals(font), "the engine host's unpacking gives the original");
    assert.ok(Buffer.from(t1c.t1cUnpack(packed)).equals(font), "the builder's check gives the original");
  });

  it('packs no file that is not a PFB, and the engine host refuses one', () => {
    for (const notPfb of [Buffer.from('%!PS-AdobeFont-1.0'), Buffer.from([0x80, 1, 255, 0, 0, 0, 1, 2]), Buffer.alloc(0)]) {
      assert.equal(t1c.t1cPack(notPfb), null);
      assert.throws(() => t1cUnpack(notPfb), /t1c:/);
    }
  });

  it('leaves a font whose eexec data spans two binary segments unpacked (one stream across them)', () => {
    const font = twoSegmentFont();
    assert.ok(font.length > madeUpFont().length, 'a second segment header');
    assert.equal(t1c.t1cPack(font), null);
  });

  it('the builder packs a .pfb only when it comes back the same, and records the original\'s SHA-256', async () => {
    const { packType1 } = await importScript<{ packType1(tree: Map<string, Uint8Array>, keep?: (p: string) => boolean): { files: Map<string, Uint8Array>; packed: Record<string, string> } }>('scripts/lib/bundle.mjs');
    const font = madeUpFont();
    const tree = new Map<string, Uint8Array>([
      ['texlive/texmf-dist/fonts/type1/public/test/test.pfb', font],
      ['texlive/texmf-dist/fonts/type1/public/test/broken.pfb', Buffer.from('not a pfb')],
      ['texlive/texmf-dist/tex/latex/test/test.sty', Buffer.from('\\ProvidesPackage{test}\n')],
    ]);
    const { files, packed } = packType1(tree);
    assert.deepEqual(packed, { '/texlive/texmf-dist/fonts/type1/public/test/test.pfb': createHash('sha256').update(font).digest('hex') });
    assert.ok(Buffer.from(files.get('texlive/texmf-dist/fonts/type1/public/test/broken.pfb') ?? []).equals(Buffer.from('not a pfb')));
    assert.ok(!Buffer.from(files.get('texlive/texmf-dist/fonts/type1/public/test/test.pfb') ?? []).equals(font));
    // A font the keep rule names (core-data's t1cSkip: a licence that does not plainly cover a stored form) stays as it is.
    const kept = packType1(tree, (p) => p.includes('/test/test.pfb'));
    assert.deepEqual(kept.packed, {});
    assert.ok(Buffer.from(kept.files.get('texlive/texmf-dist/fonts/type1/public/test/test.pfb') ?? []).equals(font));
  });

  it('sorts packed fonts by licence: the LPPL 1.3 to 1.3c and GUST, the GPL, and the rest, which stops the build', async () => {
    const { packedFontLicences } = await importScript<{ packedFontLicences(n: string[], l: (n: string) => string[]): Record<string, string[]> }>('scripts/lib/bundle.mjs');
    const licences: Record<string, string[]> = { lm: ['gfl'], newtx: ['lppl1.3'], dejavu: ['lppl1.3c'], 'cm-super': ['gpl'], libertine: ['gpl', 'ofl', 'lppl'], fpl: ['gpl2', 'lppl1'], amsfonts: ['ofl'], rsfs: ['other-free'], old: ['lppl1.2'] };
    assert.deepEqual(packedFontLicences(['lm', 'newtx', 'dejavu', 'cm-super', 'cm-super', 'libertine', 'fpl', 'amsfonts', 'rsfs', 'old'], (n) => licences[n]), {
      lppl: ['dejavu', 'lm', 'newtx'],
      gpl: ['cm-super', 'fpl', 'libertine'],
      unread: ['amsfonts', 'old', 'rsfs'],
    });
  });

  it("decides per font, by the font's own header, which fonts may be packed (the t1c gate, T1S-01)", async () => {
    type Classified = { fonts: Map<string, { class: string; pack: boolean; reason: string }>; texts: Map<string, Set<string>>; notices: Map<string, { class: string; files: string[]; lines: string[] }[]> };
    const { classifyFonts } = await importScript<{ classifyFonts(f: { path: string; package: string; group: string; bytes: Uint8Array }[], rules: unknown): Classified }>('scripts/lib/licence-texts.mjs');
    const rules = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-licences.json'), 'utf8'));
    // A font with the given clear-text header (headers as TeX Live's fonts write them).
    const font = (header: string) => Buffer.concat([segment(1, Buffer.from(`%!PS-AdobeFont-1.0: Test\n${header}\ncurrentfile eexec\n`, 'latin1')), segment(2, Buffer.from([1, 2, 3])), Buffer.from([0x80, 3])]);
    const fonts = [
      // newtx-like: an LPPL package whose fonts state other terms, and some that state none.
      { path: 'mixed/gpl.pfb', package: 'mixed', group: 'lppl', bytes: font('%Copyright: Version 3.0, GPL') },
      { path: 'mixed/stix.pfb', package: 'mixed', group: 'lppl', bytes: font('%Copyright: Copyright 2001-2011 by the STI Pub Companies,') },
      { path: 'mixed/gust.pfb', package: 'mixed', group: 'lppl', bytes: font('%Copyright: This work is released under the GUST Font License') },
      { path: 'mixed/derived.pfb', package: 'mixed', group: 'lppl', bytes: font('%Copyright: Modification of part of cmex10 for use in ntxmath') },
      { path: 'mixed/silent.pfb', package: 'mixed', group: 'lppl', bytes: font('/Notice () readonly def') },
      // courier-like: URW fonts that point to the package's GPL, and IBM's fonts.
      { path: 'courier/ucrr8a.pfb', package: 'courier', group: 'gpl', bytes: font('% See the file COPYING (GNU General Public License) for license conditions.') },
      { path: 'courier/pcrr8a.pfb', package: 'courier', group: 'gpl', bytes: font('%% Copyright International Business Machines,Corp. 1991\n%% IBM Courier is a Trademark of the IBM Corporation.') },
      // Uniform packages: a GPL package's silent fonts, DejaVu's own terms, a Libertine font (GPL or OFL).
      { path: 'tx/txr.pfb', package: 'tx', group: 'gpl', bytes: font('/Notice () readonly def') },
      { path: 'dejavu/DejaVuSans.pfb', package: 'dejavu', group: 'lppl', bytes: font('%Copyright: Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved.\n%Copyright: DejaVu changes are in public domain') },
      { path: 'lib/LinLibertine.pfb', package: 'lib', group: 'gpl', bytes: font('%Copyright: GPL (with font-exception) and OFL') },
      { path: 'other/x.pfb', package: 'other', group: 'unread', bytes: font('') },
    ];
    const { fonts: out, texts, notices } = classifyFonts(fonts, rules);
    const got = Object.fromEntries([...out].map(([p, f]) => [p, `${f.class} ${f.pack ? 'packed' : 'kept'}`]));
    assert.deepEqual(got, {
      'mixed/gpl.pfb': 'gpl packed',
      'mixed/stix.pfb': 'ofl kept',
      'mixed/gust.pfb': 'lppl packed',
      'mixed/derived.pfb': 'derived kept',
      'mixed/silent.pfb': 'unclear kept',
      'courier/ucrr8a.pfb': 'gpl packed',
      'courier/pcrr8a.pfb': 'ibm kept',
      'tx/txr.pfb': 'gpl packed',
      'dejavu/DejaVuSans.pfb': 'vera packed',
      'lib/LinLibertine.pfb': 'gpl packed',
      'other/x.pfb': 'unread kept',
    });
    assert.match(out.get('mixed/silent.pfb')?.reason ?? '', /other fonts of its package state different terms/);
    // A font's own terms add their texts to its package's, and IBM's notice is taken from the fonts' headers.
    assert.deepEqual([...(texts.get('mixed') ?? [])].sort(), ['GPL-2.0', 'GPL-3.0', 'GUST-Font-License', 'LPPL-1.3c', 'OFL-1.1']);
    assert.deepEqual([...(texts.get('courier') ?? [])].sort(), ['GPL-2.0', 'GPL-3.0', 'IBM-Courier']);
    assert.deepEqual(notices.get('courier'), [{ class: 'ibm', files: ['courier/pcrr8a.pfb'], lines: ['%% Copyright International Business Machines,Corp. 1991', '%% IBM Courier is a Trademark of the IBM Corporation.'] }]);
  });

  it("the data package's README and LICENSE.txt say how the fonts are stored, and quote the LPPL's clause 9 word for word", async () => {
    type Fonts = { lppl: string[]; vera?: string[]; gpl: string[]; kept: Record<string, string>; unpacked?: Record<string, { reason: string; files: string[] }[]>; gplChanges?: boolean };
    const { licenceFile, readmeFiles } = await importScript<{ licenceFile(f: Fonts | undefined, s: { date: string; url: string; releases: string }): string; readmeFiles(y: string, p: boolean, g?: boolean): string }>('scripts/lib/bundle-package.mjs');
    const snapshot = { date: '2026/10/15', url: 'https://texlive.info/tlnet-archive/2026/10/15/tlnet/', releases: 'https://github.com/haberwooki/liveMd2Tex/releases' };
    // The groups come from each font's own terms (the t1c gate, T1S-02): DejaVu under its own terms, not the LPPL.
    const text = licenceFile({
      lppl: ['lm'],
      vera: ['dejavu'],
      gpl: ['cm-super'],
      kept: { amsfonts: 'the SIL Open Font License' },
      unpacked: { courier: [{ reason: "IBM's Courier terms", files: ['fonts/type1/adobe/courier/pcrb8a.pfb', 'fonts/type1/adobe/courier/pcrr8a.pfb'] }] },
    }, snapshot);
    const flat = text.replace(/\s+/g, ' ');
    const lppl = readFileSync(path.join(root, 'LICENSES', 'LPPL-1.3c.txt'), 'utf8');
    // The LaTeX Project's own text (LICENSES/LPPL-1.3c.txt) wraps the clause over several lines.
    const clause9 = /^9\.\s+([\s\S]+?)\n\s*\n/m.exec(lppl)?.[1].replace(/\s+/g, ' ').trim();
    assert.ok(clause9 && flat.includes(`"${clause9}"`), 'clause 9 as the licence has it');
    assert.doesNotMatch(flat, /unchanged/);
    assert.match(flat, /stored with their encryption removed .* gives back the original file byte for byte, and checks the result against the SHA-256 of the original/);
    assert.match(flat, /decided font by font, by the terms the font's own header states/);
    assert.match(flat, /or under the LPPL 1\.3 to 1\.3c: lm\. Clause 9 of the LPPL/);
    assert.match(flat, /The packed fonts of these packages carry the Bitstream Vera and Arev terms: dejavu\./);
    assert.match(flat, /The packed fonts of these packages are under the GNU General Public License: cm-super\./);
    assert.match(text, /\n- amsfonts: the SIL Open Font License\.\n/);
    assert.match(flat, /These fonts are stored as they are, by the terms their own headers state: - courier, 2 fonts \(pcrb8a\.pfb, pcrr8a\.pfb\): IBM's Courier terms\./);
    assert.ok(text.split('\n').every((l) => l.length <= 115), 'wrapped');
    // A set that packs nothing keeps the plain statement, and names no font licence.
    const plain = licenceFile(undefined, snapshot).replace(/\s+/g, ' ');
    assert.match(plain, /are distributed unchanged from TeX Live/);
    assert.doesNotMatch(plain, /clause 9|DejaVu|Type 1/);
    // Where the sources are: the pinned snapshot, which keeps the version shipped, and the release's copies; CTAN
    // has only the newest version (the licence gate, M6).
    for (const t of [flat, plain]) {
      for (const words of [
        "Where the sources are. The files are taken from TeX Live's snapshot of 2026/10/15, https://texlive.info/tlnet-archive/2026/10/15/tlnet/, which keeps each package as this data package has it",
        'its sources in archive/<package>.source.tar.xz',
        'For each package under the GNU GPL, LGPL or AGPL, and each package with a packed font under the GPL, data/licences.json lists these archives',
        'the GitHub release that publishes this data package (https://github.com/haberwooki/liveMd2Tex/releases) carries a copy of each',
      ]) {
        assert.ok(t.includes(words), words);
      }
    }
    assert.throws(() => licenceFile(undefined, undefined as never), /the snapshot \(date, url, releases\) is needed/);
    assert.match(readmeFiles('2026', false), /TeX Live 2026's packages, unchanged;/);
    assert.match(readmeFiles('2026', true), /^The TeX files are TeX Live 2026's packages\. The Type 1 font files \(\.pfb\) whose terms allow it are stored with their encryption removed/);
    assert.doesNotMatch(readmeFiles('2026', true), /unchanged/);
    // The GPL's notice of changes (decided by the maintainer, 2026-10-26): both texts point to LICENSES/CHANGES-GPL.
    assert.doesNotMatch(flat, /CHANGES-GPL/);
    const withChanges = licenceFile({ lppl: [], gpl: ['cm-super'], kept: {}, gplChanges: true }, snapshot).replace(/\s+/g, ' ');
    assert.match(withChanges, /\(version 2, section 2\(a\); version 3, section 5\(a\)\)\. LICENSES\/CHANGES-GPL lists every packed font under the GPL/);
    assert.match(readmeFiles('2026', true, true), /LICENSES\/CHANGES-GPL lists each font under the GNU GPL that is stored this way/);
    assert.doesNotMatch(readmeFiles('2026', true), /CHANGES-GPL/);
  });

  it("the engine host carries an index's packed list to its workers, and refuses a packing it does not know", () => {
    const metadata = (packed?: { method: string; files: Record<string, string> }) => ({ files: [{ filename: '/fonts/a.pfb', start: 0, end: 10 }], remote_package_size: 10, ...(packed ? { packed } : {}) });
    const compressed = { data: null, cachedOffset: 10, cachedIndexes: [-1], cachedChunks: [null], offsets: [0], sizes: [10], successes: [0] };
    assert.equal(buildImageIndex(metadata(), compressed).packed, undefined);
    assert.deepEqual(buildImageIndex(metadata({ method: 't1c', files: { '/fonts/a.pfb': 'ab'.repeat(32) } }), compressed).packed, { '/fonts/a.pfb': 'ab'.repeat(32) });
    assert.throws(() => buildImageIndex(metadata({ method: 'zip', files: {} }), compressed), /packed with zip, which this engine host cannot unpack/);
  });

  it("the engine host refuses an index whose packed list is not the manifest's (t1c gate, S-1)", () => {
    const sha = 'ab'.repeat(32);
    const meta = (files?: Record<string, string>) => ({ files: [], remote_package_size: 0, ...(files ? { packed: { method: 't1c', files } } : {}) });
    const manifest = (files?: Record<string, string>, index = 'core.index.json') => ({ image: { file: 'core.data', index, ...(files ? { packed: { method: 't1c', files } } : {}) } });
    assert.equal(packedMismatch(meta({ '/a.pfb': sha }), manifest({ '/a.pfb': sha }), 'core.index.json'), null);
    assert.equal(packedMismatch(meta(), manifest(), 'core.index.json'), null);
    assert.deepEqual(packedMismatch(meta(), manifest({ '/a.pfb': sha }), 'core.index.json'), ['/a.pfb'], 'the list dropped from the index');
    assert.deepEqual(packedMismatch(meta({ '/a.pfb': sha }), manifest({ '/a.pfb': sha, '/b.pfb': sha }), 'core.index.json'), ['/b.pfb'], 'one entry cut');
    assert.deepEqual(packedMismatch(meta({ '/a.pfb': sha }), manifest({ '/a.pfb': 'cd'.repeat(32) }), 'core.index.json'), ['/a.pfb'], 'another SHA-256');
    assert.deepEqual(packedMismatch(meta({}), { image: { index: 'core.index.json', packed: { method: 'zip', files: {} } } }, 'core.index.json'), [], 'another method');
    assert.equal(packedMismatch(meta(), manifest({ '/a.pfb': sha }, 'other.index.json'), 'core.index.json'), null, 'a manifest of another index');
    assert.equal(packedMismatch(meta({ '/a.pfb': sha }), null, 'core.index.json'), null, 'no manifest');
  });

  it('names the damaged data set and what to reinstall (t1c gate, S-3)', () => {
    assert.equal(
      damagedMessage(null, 'the font file cmr10.pfb did not pass its check'),
      'The core TeX data is damaged: the font file cmr10.pfb did not pass its check, so nothing was made from it. Reinstall the liveMd2Tex Core Packages extension.',
    );
    assert.equal(
      damagedMessage('livemd2tex-extra-data', 'its index and its manifest list different packed fonts', 'so the engine does not use it'),
      "The Extra Packages add-on's TeX data is damaged: its index and its manifest list different packed fonts, so the engine does not use it. Reinstall the add-on.",
    );
    const err = new DamagedData('m', ['/a.pfb']);
    assert.ok(err instanceof Error);
    assert.deepEqual(err.files, ['/a.pfb']);
  });

  it('the extension refuses a data set packed in a way it does not know, with a plain message (t1c gate, S-6)', () => {
    const expected = { texLive: 2026, abi: 'abc' };
    const manifest = (method: string) => ({ format: 1, texLive: 2026, abi: 'abc', image: { file: 'extra.data', bytes: 1, sha256: '0', packed: { method, files: {} } } });
    assert.deepEqual(checkDataManifest(manifest('t1c'), expected, 'Extra Packages add-on'), { ok: true });
    assert.deepEqual(checkDataManifest(manifest('zip'), expected, 'Extra Packages add-on'), {
      ok: false,
      message: 'The Extra Packages add-on stores some of its files in a form this version of the extension cannot read. Update both to the same release.',
    });
  });

  it('a damaged font shows the plain message alone: no "engine stopped", no "cannot open" help, no add-on offered (t1c gate, S-3)', () => {
    const log = '!pdfTeX error: /bin/busytex (file sfrm1000.pfb): cannot open Type 1 font file for reading\n';
    const fonts = { set: { id: 'livemd2tex-extra-data', label: 'Extra Packages add-on', index: { format: 1, packages: {}, files: { 'sfrm1000.pfb': 'cm-super' } } }, image: { id: 'livemd2tex-extra-data' } };
    const prepared = { job: { main: 'main.tex', files: [], dataImages: [] }, confinement: [], packages: { core: null, installed: [fonts], elsewhere: [] } } as unknown as PreparedCompile;
    const error = 'The core TeX data is damaged: the font file sfrm1000.pfb did not pass its check, so nothing was made from it. Reinstall the liveMd2Tex Core Packages extension.';
    const damaged = { ok: false, error, damaged: ['/texlive/texmf-dist/fonts/type1/public/cm-super/sfrm1000.pfb'], log, blg: null, bibtexRan: false } as unknown as CompileResult;
    assert.deepEqual(
      diagnosticsFor(damaged, prepared).map((d) => d.message),
      [error],
    );
    assert.deepEqual(imagesForNotFound(damaged, prepared), []);
    // The same log without the damage: the engine's own failure, with pdfTeX's error and the add-on offered.
    const missing = { ok: false, error: 'pdflatex stopped', log, blg: null, bibtexRan: false } as unknown as CompileResult;
    const messages = diagnosticsFor(missing, prepared).map((d) => d.message);
    assert.equal(messages[0], 'The engine stopped: pdflatex stopped');
    assert.ok(messages.some((m) => m.includes('cannot open Type 1 font file')), messages.join('\n'));
    assert.deepEqual(imagesForNotFound(missing, prepared), ['livemd2tex-extra-data']);
  });

  it('every Computer Modern and AMS Type 1 font of the interim image round-trips byte for byte', async function () {
    const data = path.join(root, 'dist', 'data', 'texlive-extra.data');
    if (!existsSync(data)) {
      this.skip();
    }
    const { openImage } = await importScript<{ openImage(p: string, c: unknown): { read(s: number, e: number): Buffer } }>('scripts/lib/image-files.mjs');
    const index = JSON.parse(readFileSync(path.join(root, 'dist', 'data', 'texlive-extra.index.json'), 'utf8')) as { compressed: unknown; metadata: { files: { filename: string; start: number; end: number }[] } };
    const reader = openImage(data, index.compressed);
    const fonts = index.metadata.files.filter((f) => /\/fonts\/type1\/public\/amsfonts\/.*\.pfb$/.test(f.filename));
    assert.ok(fonts.length > 100, `${fonts.length} fonts`);
    for (const f of fonts) {
      const original = reader.read(f.start, f.end);
      const packed = t1c.t1cPack(original);
      assert.ok(packed, f.filename);
      assert.ok(Buffer.from(t1cUnpack(packed)).equals(original), f.filename);
    }
  });
});
