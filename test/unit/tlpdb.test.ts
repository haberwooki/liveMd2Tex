// TeX Live's package database and the generated tree files (scripts/lib/tlpdb.mjs, scripts/lib/texmf-config.mjs; B1,
// docs/DESIGN.md#engine-and-data), on a small made-up tlpdb in TeX Live's format.

import * as assert from 'node:assert/strict';
import { importScript } from '../support/helpers';

interface TlPackage {
  name: string;
  category: string;
  revision: number;
  depends: string[];
  executes: string[];
  runfiles: string[];
  runSize: number;
  containerSize: number;
  containerChecksum: string;
  license: string[];
  relocated: boolean;
}
interface Hyphen {
  package: string;
  name: string;
  file: string;
  lefthyphenmin: string;
  righthyphenmin: string;
  synonyms: string[];
  filePatterns?: string;
  fileExceptions?: string;
  databases: string[];
}
interface Format {
  package: string;
  name: string;
  engine: string;
  patterns: string;
  options: string;
  mode: boolean;
}
interface Tlpdb {
  parseTlpdb(text: string): Map<string, TlPackage>;
  texmfPath(file: string): string | null;
  resolveSelection(db: Map<string, TlPackage>, s: { collections?: string[]; packages?: string[]; exclude?: string[] }): { packages: Set<string>; missing: string[] };
  installActions(db: Map<string, TlPackage>, names: Iterable<string>): { maps: Map<string, { kind: string; package: string }>; hyphens: Hyphen[]; formats: Format[] };
  licenceClass(p: TlPackage): 'free' | 'nonfree' | 'none';
  isPlatform(name: string): boolean;
}
interface Config {
  languageDat(template: string, h: Hyphen[]): string;
  languageDef(template: string, h: Hyphen[]): string;
  languageLua(template: string, h: Hyphen[]): string;
  fmtutilCnf(header: string, f: Format[]): string;
  updmapCfg(header: string, maps: Map<string, { kind: string }>): string;
  buildFontMaps(maps: Map<string, { kind: string }>, read: (file: string) => string | undefined): { pdftexDl14: string; pdftexNdl14: string; kanjix: string; missing: string[]; conflicts: string[] };
  lsR(paths: string[]): string;
}

const TLPDB = [
  'name collection-basic',
  'category Collection',
  'revision 1',
  'depend amsfonts',
  'depend hyphen-base',
  'depend latex-bin',
  '',
  'name collection-latexextra',
  'category Collection',
  'depend collection-pictures',
  'depend tcolorbox',
  '',
  'name amsfonts',
  'category Package',
  'revision 61937',
  'relocated 1',
  'execute addMap cmextra.map',
  'containersize 3600',
  'containerchecksum abc123',
  'runfiles size=4',
  ' RELOC/fonts/map/dvips/amsfonts/cmextra.map',
  ' RELOC/tex/latex/amsfonts/amsfonts.sty details="Package"',
  'catalogue-license ofl',
  '',
  'name hyphen-base',
  'category TLCore',
  'execute AddHyphen name=english synonyms=usenglish,american lefthyphenmin=2 righthyphenmin=3 file=hyphen.tex file_patterns= file_exceptions= comment="American English"',
  'runfiles size=2',
  ' texmf-dist/tex/generic/config/language.us',
  ' texmf-dist/tex/generic/hyphen/hyphen.tex',
  '',
  'name hyphen-german',
  'category TLCore',
  'depend dehyph',
  'execute AddHyphen name=german synonyms= lefthyphenmin=2 righthyphenmin=2 file=loadhyph-de-1901.tex file_patterns=hyph-de-1901.pat.txt file_exceptions=hyph-de-1901.hyp.txt',
  'execute AddHyphen name=ngerman-x-latest lefthyphenmin=2 righthyphenmin=2 file=dehyphn-x.tex databases=dat',
  'runfiles size=1',
  ' texmf-dist/tex/generic/hyph-utf8/loadhyph/loadhyph-de-1901.tex',
  '',
  'name dehyph',
  'category Package',
  'catalogue-license lppl1.3c',
  '',
  'name latex-bin',
  'category TLCore',
  'depend latex-bin.ARCH',
  'execute AddFormat name=pdflatex engine=pdftex patterns=language.dat           options="-etex -translate-file=cp227.tcx pdflatex.ini"           fmttriggers=atbegshi,babel',
  'execute AddFormat name=dvilualatex mode=disabled engine=luatex patterns=language.dat,language.dat.lua options="dvilualatex.ini"',
  '',
  'name tcolorbox',
  'category Package',
  'depend pgf',
  'catalogue-license lppl1.3c',
  '',
  'name pgf',
  'category Package',
  'catalogue-license lppl1.3c gpl2 fdl',
  '',
  'name nocommercial-pkg',
  'category Package',
  'catalogue-license nosell',
  '',
].join('\n');

describe('TeX Live package database and generated files (B1)', () => {
  let t: Tlpdb;
  let c: Config;
  let db: Map<string, TlPackage>;
  before(async () => {
    t = await importScript<Tlpdb>('scripts/lib/tlpdb.mjs');
    c = await importScript<Config>('scripts/lib/texmf-config.mjs');
    db = t.parseTlpdb(TLPDB);
  });

  it('parses packages, their run files, actions, archive checksums and licences', () => {
    const ams = db.get('amsfonts') as TlPackage;
    assert.equal(ams.revision, 61937);
    assert.equal(ams.relocated, true);
    assert.deepEqual(ams.runfiles, ['RELOC/fonts/map/dvips/amsfonts/cmextra.map', 'RELOC/tex/latex/amsfonts/amsfonts.sty']);
    assert.equal(ams.containerChecksum, 'abc123');
    assert.deepEqual(ams.license, ['ofl']);
    assert.equal(t.texmfPath(ams.runfiles[1]), 'tex/latex/amsfonts/amsfonts.sty');
    assert.equal(t.texmfPath('texmf-dist/tex/generic/hyphen/hyphen.tex'), 'tex/generic/hyphen/hyphen.tex');
    assert.equal(t.texmfPath('tlpkg/tlpobj/x.tlpobj'), null);
    assert.equal(t.licenceClass(db.get('pgf') as TlPackage), 'free');
    // The GUST Font License and GUST Font Source License (Latin Modern, TeX Gyre) are free (GB1E-01).
    for (const licence of ['gfl', 'gfsl', 'ofl', 'knuth', 'lppl1.3c', '0bsd']) {
      assert.equal(t.licenceClass({ ...(db.get('pgf') as TlPackage), license: [licence] }), 'free', licence);
    }
    for (const licence of ['nosell', 'nocommercial', 'noinfo', 'nosource', 'cc-by-nc-4', 'other-nonfree']) {
      assert.equal(t.licenceClass({ ...(db.get('pgf') as TlPackage), license: [licence] }), 'nonfree', licence);
    }
    assert.equal(t.licenceClass(db.get('nocommercial-pkg') as TlPackage), 'nonfree');
    assert.equal(t.licenceClass(db.get('latex-bin') as TlPackage), 'none');
  });

  it('resolves a selection: collection packages and dependencies, not other collections or programs', () => {
    const r = t.resolveSelection(db, { collections: ['collection-basic', 'collection-latexextra'], packages: ['hyphen-german'], exclude: ['amsfonts'] });
    assert.deepEqual([...r.packages].sort(), ['dehyph', 'hyphen-base', 'hyphen-german', 'latex-bin', 'pgf', 'tcolorbox']);
    assert.deepEqual(t.resolveSelection(db, { packages: ['nothere'] }).missing, ['nothere']);
    // Platform packages are left out; texlive.infra, a package with a dot in its name, is not one (the first CI run).
    for (const n of ['latex-bin.ARCH', 'kpathsea.x86_64-linux', 'xetex.aarch64-linuxmusl', 'texlive.infra.windows', 'luatex.universal-darwin', '00texlive.installer']) {
      assert.equal(t.isPlatform(n), true, n);
    }
    assert.equal(t.isPlatform('texlive.infra'), false);
  });

  it('writes language.dat, language.def and language.dat.lua as tlmgr does', () => {
    const { hyphens } = t.installActions(db, ['hyphen-german', 'hyphen-base']);
    assert.deepEqual(hyphens.map((h) => h.name), ['english', 'german', 'ngerman-x-latest']);
    assert.equal(
      c.languageDat('% language.dat\n', hyphens),
      ['% language.dat', '% from hyphen-base:', '% American English', 'english hyphen.tex', '=usenglish', '=american', '% from hyphen-german:', 'german loadhyph-de-1901.tex', 'ngerman-x-latest dehyphn-x.tex', ''].join('\n'),
    );
    const def = c.languageDef('%% language.def\n', hyphens);
    assert.match(def, /\\addlanguage\{american\}\{hyphen\.tex\}\{\}\{2\}\{3\}/);
    assert.doesNotMatch(def, /ngerman-x-latest/, 'databases=dat keeps it out of language.def');
    assert.match(def, /\\uselanguage \{USenglish\} {13}%%% This MUST be the last line of the file\.\n$/);
    const lua = c.languageLua('return {\n', hyphens);
    assert.match(lua, /\['german'\] = \{\n\t\tloader = 'loadhyph-de-1901\.tex',\n\t\tlefthyphenmin = 2,\n\t\trighthyphenmin = 2,\n\t\tsynonyms = \{ {2}\},\n\t\tpatterns = 'hyph-de-1901\.pat\.txt',\n\t\thyphenation = 'hyph-de-1901\.hyp\.txt',\n\t\},/);
    assert.match(lua, /synonyms = \{ 'usenglish', 'american' \}/);
    assert.match(lua, /\n\}\n$/);
  });

  it('writes fmtutil.cnf and updmap.cfg', () => {
    const { formats, maps } = t.installActions(db, ['latex-bin', 'amsfonts']);
    assert.equal(
      c.fmtutilCnf('# fmtutil.cnf\n', formats),
      ['# fmtutil.cnf', '#', '# from latex-bin:', 'pdflatex pdftex language.dat -etex -translate-file=cp227.tcx pdflatex.ini', '#! dvilualatex luatex language.dat,language.dat.lua dvilualatex.ini', ''].join('\n'),
    );
    assert.equal(c.updmapCfg('# updmap.cfg\n', maps), '# updmap.cfg\nMap cmextra.map\n');
  });

  it('builds pdftex.map and kanjix.map as updmap does', () => {
    const files: Record<string, string> = {
      'ps2pk35.map': '% base 35, downloaded\nphvr8r  NimbusSans-Regular "TeXBase1Encoding ReEncodeFont" <8r.enc <uhvr8a.pfb\n',
      'pdftex35.map': 'phvr8r  NimbusSans-Regular "TeXBase1Encoding ReEncodeFont" <8r.enc\n',
      'dvips35.map': '',
      'b.map': 'cmex10 CMEX10 <cmex10.pfb\n% comment\n\ncmr10 CMR10 <cmr10.pfb\n',
      'a.map': 'cmr10 OTHER <other.pfb\nphvr8r OVERRIDE <x.pfb\n',
      'mixed.map': 'ecrm1000 SFRM1000 <sfrm1000.pfb\n',
      'kanji.map': 'rml H :0:ipaexm.ttf\n',
    };
    const maps = new Map<string, { kind: string }>([
      ['b.map', { kind: 'Map' }],
      ['a.map', { kind: 'Map' }],
      ['mixed.map', { kind: 'MixedMap' }],
      ['kanji.map', { kind: 'KanjiMap' }],
      ['gone.map', { kind: 'Map' }],
    ]);
    const r = c.buildFontMaps(maps, (f) => files[f]);
    assert.equal(
      r.pdftexDl14,
      ['% ps2pk35.map', 'phvr8r NimbusSans-Regular "TeXBase1Encoding ReEncodeFont" <8r.enc <uhvr8a.pfb', '% mixed.map', 'ecrm1000 SFRM1000 <sfrm1000.pfb', '% a.map', 'cmr10 OTHER <other.pfb', 'phvr8r OVERRIDE <x.pfb', '% b.map', 'cmex10 CMEX10 <cmex10.pfb', ''].join('\n'),
    );
    assert.match(r.pdftexNdl14, /^% pdftex35\.map\nphvr8r NimbusSans-Regular "TeXBase1Encoding ReEncodeFont" <8r\.enc\n/);
    assert.equal(r.kanjix, '% kanji.map\nrml H :0:ipaexm.ttf\n');
    assert.deepEqual(r.missing, ['gone.map']);
    assert.deepEqual(r.conflicts, ['cmr10: a.map and b.map (a.map kept)']);
  });

  it('writes ls-R in the order kpathsea expects', () => {
    assert.equal(
      c.lsR(['tex/latex/foo/foo.sty', 'tex/latex/bar.sty', 'bibtex/bst/x.bst', 'README']),
      ['% ls-R -- filename database for kpathsea; do not change this line.', './:', 'README', 'bibtex', 'tex', '', './bibtex:', 'bst', '', './bibtex/bst:', 'x.bst', '', './tex:', 'latex', '', './tex/latex:', 'bar.sty', 'foo', '', './tex/latex/foo:', 'foo.sty', '', ''].join('\n'),
    );
  });
});
