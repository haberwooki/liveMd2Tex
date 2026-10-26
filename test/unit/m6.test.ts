// M6, package help, without the engine (docs/DESIGN.md#architecture, #engine-and-data): the preamble scan's reading of a document,
// its resolution through the data sets' package indexes, the plain messages, the data-set checks, and the
// preparation of picked package files (ZIP, .dtx with .ins, single files).

import * as assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { imagesForNotFound, type PreparedCompile } from '../../src/extension/compile/pipeline';
import { checkDataManifest } from '../../src/extension/engine/dataSets';
import type { CompileResult } from '../../src/shared/engineJobs';
import { preparePackages, projectCopies, texmfPathFor } from '../../src/extension/packages/userPackages';
import { missingMessage, packageRequests, scanDiagnostics, scanPackages, type ScanInput } from '../../src/extension/project/packageScan';
import { buildPackageIndex, loadsOf, type PackageIndex } from '../../src/shared/packageIndex';
import { importScript } from '../support/helpers';

const index = (packages: Record<string, { files: string[]; requires?: string[]; kind?: 'tex' | 'fonts' }>): PackageIndex => {
  const out: PackageIndex = { format: 1, packages: {}, files: {} };
  for (const [name, p] of Object.entries(packages)) {
    out.packages[name] = { kind: p.kind ?? 'tex', files: p.files.map((f) => `tex/latex/${name}/${f}`), requires: p.requires ?? [] };
    for (const f of p.files) {
      out.files[f] = name;
    }
  }
  return out;
};

/** A ZIP with stored (uncompressed) entries, for the preparation tests. */
function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('M6: the preamble scan reads the document', () => {
  it('finds every kind of request, with options and lists, in the preamble only (inputs anywhere)', () => {
    const text = [
      '\\documentclass[11pt,twocolumn]{revtex4-2}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{amsmath, amssymb}',
      '% \\usepackage{commented}',
      '\\RequirePackage{xcolor}',
      '\\usetikzlibrary{calc,arrows.meta}',
      '\\usepgfplotslibrary{fillbetween}',
      '\\usetheme{Darmstadt}',
      '\\usecolortheme{beaver}',
      '\\bibliographystyle{apsrev4-2}',
      '\\begin{document}',
      '\\usepackage{toolate}',
      '\\input{glyphtounicode}',
      '\\include{chapter1}',
      '\\end{document}',
    ].join('\n');
    const r = packageRequests(text, 'paper.tex', true);
    const got = r.map((x) => `${x.command} ${x.name} ${x.candidates[0]} @${x.line}`);
    assert.deepEqual(got, [
      '\\documentclass revtex4-2 revtex4-2.cls @1',
      '\\usepackage inputenc inputenc.sty @2',
      '\\usepackage amsmath amsmath.sty @3',
      '\\usepackage amssymb amssymb.sty @3',
      '\\RequirePackage xcolor xcolor.sty @5',
      '\\usetikzlibrary calc tikzlibrarycalc.code.tex @6',
      '\\usetikzlibrary arrows.meta tikzlibraryarrows.meta.code.tex @6',
      '\\usepgfplotslibrary fillbetween pgfplotslibraryfillbetween.code.tex @7',
      '\\usetheme Darmstadt beamerthemeDarmstadt.sty @8',
      '\\usecolortheme beaver beamercolorthemebeaver.sty @9',
      '\\bibliographystyle apsrev4-2 apsrev4-2.bst @10',
      '\\input glyphtounicode glyphtounicode @13',
      '\\include chapter1 chapter1 @14',
    ]);
    assert.equal(r[0].options, '11pt,twocolumn');
    assert.deepEqual(r.find((x) => x.name === 'calc')?.candidates, ['tikzlibrarycalc.code.tex', 'pgflibrarycalc.code.tex']);
  });
});

describe('M6: the preamble scan resolves through the data sets', () => {
  const core = index({ amsmath: { files: ['amsmath.sty'] }, xcolor: { files: ['xcolor.sty'] }, base: { files: ['article.cls'] } });
  const extra = index({ fancy: { files: ['fancy.sty', 'fancy.cfg'], requires: ['xcolor.sty', 'gone.sty'] } });
  const input = (over: Partial<ScanInput> = {}): ScanInput => ({
    projectFiles: ['paper/main.tex', 'paper/mine.sty', 'shared/macros.tex'],
    mainRel: 'paper/main.tex',
    core,
    installed: [],
    elsewhere: [{ id: 'livemd2tex-extra-data', label: 'Extra Packages add-on', files: { 'fancy.sty': 'fancy', 'revtex4-2.cls': 'revtex' } }],
    ...over,
  });
  const reqs = (text: string) => packageRequests(text, 'paper/main.tex', true);

  it('lists every missing file at once, says where it is, and leaves the project and the core alone', () => {
    const text = '\\documentclass{revtex4-2}\n\\usepackage{amsmath}\n\\usepackage{mine}\n\\usepackage{fancy,nowhere}\n\\input{../shared/macros}\n\\begin{document}\\end{document}';
    const r = scanPackages(reqs(text), input());
    assert.deepEqual(
      r.missing.map((m) => [m.file, m.package, m.offer?.id ?? null]),
      [
        ['revtex4-2.cls', 'revtex', 'livemd2tex-extra-data'],
        ['fancy.sty', 'fancy', 'livemd2tex-extra-data'],
        ['nowhere.sty', 'nowhere', null],
      ],
    );
    assert.equal(r.requests, 6);
  });

  it('an installed add-on supplies the package and its own dependencies, and names a dependency nobody has', () => {
    const r = scanPackages(reqs('\\documentclass{article}\n\\usepackage{fancy}\n\\begin{document}\\end{document}'), input({ installed: [{ id: 'livemd2tex-extra-data', label: 'Extra Packages add-on', index: extra }], elsewhere: [] }));
    assert.deepEqual([...(r.needed.get('livemd2tex-extra-data') ?? [])], ['fancy']);
    assert.deepEqual(
      r.missing.map((m) => [m.file, 'package' in m.via ? m.via.package : 'doc']),
      [['gone.sty', 'fancy']],
    );
    assert.match(missingMessage(r.missing[0]), /^"gone\.sty", which fancy loads, is not inside the installed packages/);
  });

  it('a package only in a set that is not installed: its dependency that no set has is named now (G2S-04)', () => {
    const elsewhere = [{ id: 'livemd2tex-extra-data', label: 'Extra Packages add-on', files: { 'fancy.sty': 'fancy', 'fancy.cfg': 'fancy' }, requires: { fancy: ['xcolor.sty', 'gone.sty', 'fancy.cfg'] } }];
    const r = scanPackages(reqs('\\documentclass{article}\n\\usepackage{fancy}\n\\begin{document}\\end{document}'), input({ elsewhere }));
    assert.deepEqual(
      r.missing.map((m) => [m.file, m.offer?.id ?? null, 'package' in m.via ? m.via.package : 'doc']),
      [
        ['fancy.sty', 'livemd2tex-extra-data', 'doc'],
        ['gone.sty', null, 'fancy'],
      ],
    );
  });

  it('a \\bibliographystyle in the body counts too (G2E-04)', () => {
    const r = scanPackages(reqs('\\documentclass{article}\n\\begin{document}\nText.\n\\bibliographystyle{elsarticle-num}\n\\bibliography{refs}\n\\end{document}'), input());
    assert.deepEqual(r.missing.map((m) => [m.file, m.via && 'line' in m.via ? m.via.line : 0]), [['elsarticle-num.bst', 4]]);
  });

  it('without a core index nothing is called missing', () => {
    assert.deepEqual(scanPackages(reqs('\\usepackage{anything}'), input({ core: null })).missing, []);
  });

  it('font packages and outside programs get their own messages', () => {
    const text = '\\usepackage{newtxtext}\n\\usepackage{minted}\n\\usepackage[backend=biber]{biblatex}\n\\usepackage[record]{glossaries-extra}\n\\usepackage[backend=bibtex]{biblatex}\n\\begin{document}';
    const r = scanPackages(reqs(text), input({ core: index({ minted: { files: ['minted.sty'] }, biblatex: { files: ['biblatex.sty'] }, 'glossaries-extra': { files: ['glossaries-extra.sty'] } }) }));
    assert.deepEqual(r.missing.map((m) => [m.file, m.font]), [['newtxtext.sty', true]]);
    assert.match(missingMessage(r.missing[0]), /font package.*a copy of the \.sty is not enough/);
    assert.deepEqual(r.outside.map((o) => o.name), ['minted', 'biblatex', 'glossaries-extra']);
    const diags = scanDiagnostics(r, 'paper/main.tex');
    assert.ok(diags.every((d) => d.severity === 'warning' && d.source === 'liveMd2Tex'));
    assert.match(diags.find((d) => /minted/.test(d.message))?.message ?? '', /minted needs Pygments, a Python program, which liveMd2Tex cannot run: use the listings package/);
  });

  it('the plain messages name the file, the package and the fix', () => {
    const base = { via: { file: 'main.tex', line: 2 }, font: false, command: '\\usepackage' } as const;
    assert.equal(
      missingMessage({ ...base, file: 'revtex4-2.cls', package: 'revtex', offer: { id: 'x', label: 'Extra Packages add-on' } }),
      '"revtex4-2.cls" (class revtex) is not inside the installed packages. The Extra Packages add-on has it: run "liveMd2Tex: Install Extra Packages".',
    );
    assert.equal(
      missingMessage({ ...base, file: 'foo.sty', package: 'foo' }),
      '"foo.sty" (package foo) is not inside the installed packages. Add it with "liveMd2Tex: Add a package from a file" (download it from CTAN: https://ctan.org/pkg/foo), or put a copy in the project folder.',
    );
  });
});

describe('M6: data sets must fit the engine', () => {
  const expected = { texLive: 2026, abi: 'abc' };
  it('accepts a matching set and refuses another year, another engine build or another format, in plain words', () => {
    assert.deepEqual(checkDataManifest({ format: 1, texLive: 2026, abi: 'abc' }, expected, 'Extra Packages add-on'), { ok: true });
    const year = checkDataManifest({ format: 1, texLive: 2027, abi: 'abc' }, expected, 'Extra Packages add-on');
    assert.ok(!year.ok && /built from TeX Live 2027, but this version of the extension uses TeX Live 2026/.test(year.message));
    const abi = checkDataManifest({ format: 1, texLive: 2026, abi: 'zzz' }, expected, 'Extra Packages add-on');
    assert.ok(!abi.ok && /different engine build/.test(abi.message));
    const format = checkDataManifest({ format: 9 }, expected, 'Extra Packages add-on');
    assert.ok(!format.ok && /cannot read/.test(format.message));
    // Two missing engine builds are not a match (build gate 2, G2S-05).
    assert.equal(checkDataManifest({ format: 1, texLive: 2026 }, { texLive: 2026, abi: undefined as unknown as string }, 'Extra Packages add-on').ok, false);
    assert.equal(checkDataManifest({ format: 1, texLive: 2026, abi: '' }, { texLive: 2026, abi: '' }, 'Extra Packages add-on').ok, false);
  });

  it('B1: refuses an add-on from another TeX Live snapshot than the core (their font maps go together; GB1E-06)', () => {
    const b1 = { ...expected, snapshot: '2026/10/15' };
    assert.deepEqual(checkDataManifest({ format: 1, texLive: 2026, abi: 'abc', snapshot: '2026/10/15' }, b1, 'Extra Packages add-on'), { ok: true });
    for (const other of [{ snapshot: '2026/11/01' }, {}]) {
      const r = checkDataManifest({ format: 1, texLive: 2026, abi: 'abc', ...other }, b1, 'Extra Packages add-on');
      assert.ok(!r.ok && /built from another TeX Live snapshot .* than the core packages \(2026\/10\/15\)\. Update both to the same release\./.test(r.message));
    }
    // The interim core names no snapshot: no check (the stand-in add-on has none either).
    assert.equal(checkDataManifest({ format: 1, texLive: 2026, abi: 'abc', snapshot: '2026/10/15' }, expected, 'Extra Packages add-on').ok, true);
  });

  it('B1: a font the add-on holds brings the add-on: a Type 1 file pdfTeX cannot open, a font XeTeX cannot find by name', () => {
    const index = (files: Record<string, string>) => ({ format: 1, packages: {}, files }) as unknown as PackageIndex;
    const fonts = { set: { id: 'livemd2tex-extra-data', label: 'Extra Packages add-on', index: index({ 'pbkl8r.pfb': 'bookman', 'FiraSans-Regular.otf': 'fira' }) }, image: { id: 'livemd2tex-extra-data' } };
    const macros = { set: { id: 'other-data', label: 'other', index: index({ 'foo.sty': 'foo' }) }, image: { id: 'other-data' } };
    const prepared = (mounted: string[] = []) =>
      ({ packages: { core: null, installed: [fonts, macros], elsewhere: [] }, job: { dataImages: mounted.map((id) => ({ id })) } }) as unknown as PreparedCompile;
    const result = (log: string) => ({ log, blg: null }) as unknown as CompileResult;
    const type1 = '!pdfTeX error: /bin/busytex (file pbkl8r.pfb): cannot open Type 1 font file for reading\n';
    assert.deepEqual(imagesForNotFound(result(type1), prepared()), ['livemd2tex-extra-data']);
    assert.deepEqual(imagesForNotFound(result(type1), prepared(['livemd2tex-extra-data'])), [], 'already mounted');
    assert.deepEqual(imagesForNotFound(result(type1.replace('pbkl8r', 'other8r')), prepared()), [], 'a file no set holds');
    // A name is no file: every installed add-on with OpenType or TrueType fonts is offered.
    const byName = './main.tex:3: Package fontspec Error: \n(fontspec)                The font "Fira Sans" cannot be found; this\n';
    assert.deepEqual(imagesForNotFound(result(byName), prepared()), ['livemd2tex-extra-data']);
  });
});

describe('M6: "Add a package from a file" prepares the files', () => {
  it('places files by kind', () => {
    assert.equal(texmfPathFor('foo', 'foo.sty'), 'tex/latex/foo/foo.sty');
    assert.equal(texmfPathFor('foo', 'foo.bst'), 'bibtex/bst/foo/foo.bst');
    assert.equal(texmfPathFor('foo', 'foo.tfm'), 'fonts/tfm/public/foo/foo.tfm');
    assert.equal(texmfPathFor('foo', 'README.md'), null);
  });

  it('runs a .ins file with its .dtx and keeps what docstrip made', async () => {
    const runs: string[] = [];
    const prepared = await preparePackages(
      [
        { name: 'tensor.dtx', data: new TextEncoder().encode('%<package>\\ProvidesPackage{tensor}') },
        { name: 'tensor.ins', data: new TextEncoder().encode('\\input docstrip') },
      ],
      async (files, ins) => {
        runs.push(`${ins}: ${files.map((f) => f.path).sort().join(',')}`);
        return [{ path: 'tensor.sty', data: new TextEncoder().encode('\\ProvidesPackage{tensor}') }];
      },
    );
    assert.deepEqual(runs, ['tensor.ins: tensor.dtx,tensor.ins']);
    assert.deepEqual(prepared.packages, ['tensor']);
    assert.deepEqual(prepared.built, ['tensor.sty']);
    assert.deepEqual([...prepared.files.keys()], ['tex/latex/tensor/tensor.sty']);
    assert.deepEqual(projectCopies(prepared).map((f) => f.path), ['tensor.sty']);
  });

  it('opens a CTAN ZIP: a TDS tree keeps its paths; a plain folder is placed by kind; documentation is left out', async () => {
    const tds = storedZip({ 'tex/latex/pkg/pkg.sty': 'x', 'bibtex/bst/pkg/pkg.bst': 'y', 'doc/latex/pkg/pkg.pdf': 'z' });
    const a = await preparePackages([{ name: 'pkg.tds.zip', data: new Uint8Array(tds) }], async () => []);
    assert.deepEqual([...a.files.keys()].sort(), ['bibtex/bst/pkg/pkg.bst', 'tex/latex/pkg/pkg.sty']);
    assert.deepEqual(a.skipped, ['doc/latex/pkg/pkg.pdf']);
    const plain = storedZip({ 'other/other.sty': 'x', 'other/README.md': 'r', 'other/other.cfg': 'c' });
    const b = await preparePackages([{ name: 'other.zip', data: new Uint8Array(plain) }], async () => []);
    assert.deepEqual([...b.files.keys()].sort(), ['tex/latex/other/other.cfg', 'tex/latex/other/other.sty']);
    const evil = storedZip({ '../escape.sty': 'x' });
    const c = await preparePackages([{ name: 'evil.zip', data: new Uint8Array(evil) }], async () => []);
    assert.equal(c.files.size, 0);
  });
});

describe('M6: the package index is the same in the extension and in the build scripts', () => {
  it('loadsOf and buildPackageIndex give the same results in TypeScript and in scripts/lib/package-index.mjs', async () => {
    const mjs = await importScript<{
      loadsOf(t: string): string[];
      buildPackageIndex(files: string[], read: (rel: string) => string): PackageIndex;
    }>('scripts/lib/package-index.mjs');
    const texts: Record<string, string> = {
      'tex/latex/a/a.sty': '\\RequirePackage[opt]{b,c}\n% \\RequirePackage{commented}\n\\input{d.cfg}\n\\LoadClass{article}\n\\usepackage{\\x}',
      'tex/latex/b/b.sty': '\\RequirePackageWithOptions{a}\n\\input e.tex ',
      'tex/latex/a/d.cfg': '',
      'bibtex/bst/a/a.bst': '',
      'fonts/tfm/public/f/f.tfm': '',
      'fonts/map/dvips/f/f.map': '',
      'tex/generic/c/c.sty': '',
    };
    for (const t of Object.values(texts)) {
      assert.deepEqual(loadsOf(t), mjs.loadsOf(t));
    }
    const files = Object.keys(texts);
    assert.deepEqual(buildPackageIndex(files, (r) => texts[r]), mjs.buildPackageIndex(files, (r: string) => texts[r]));
    assert.deepEqual(buildPackageIndex(files, (r) => texts[r]).packages.a.requires, ['article.cls', 'b.sty', 'c.sty']);
  });
});
