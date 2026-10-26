// The font coverage table (src/converter/fonts/coverage.ts) that the converter's font rule reads (docs/DESIGN.md#converter): which characters each font of the XeTeX templates has. XeTeX itself
// measures it (\iffontchar over U+0020 to U+1FFFF), on the pinned DejaVu files (the project-folder route until
// B1 ships them) and on the Latin Modern and TeX Gyre fonts of the engine image. A family's coverage is the
// intersection of its faces and optical sizes, so a character it "has" prints in bold, italic and every size.
// The test fails when the committed table no longer matches the fonts; UPDATE_FONT_COVERAGE=1 rewrites it.

import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { COVERAGE, type CoverageId } from '../../src/converter/fonts/coverage';
import type { ProjectFile } from '../../src/shared/engineJobs';
import { root } from '../support/helpers';
import { assetsRoot, compileAndRecord, engineAssetPaths, job } from './support';

const LAST = 0x1ffff;

function dejavuFolder(): string {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; folder: string }[] };
  return path.join(assetsRoot, pins.sources.find((s) => s.id === 'ctan-dejavu')?.folder ?? 'ctan-dejavu', 'truetype');
}

/** The image's font files by base name (from the image's file list). */
function imageFonts(): string[] {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; folder: string }[] };
  const folder = pins.sources.find((s) => s.id === 'texlyre-busytex')?.folder ?? '';
  return readFileSync(path.join(assetsRoot, folder, 'texlive-extra.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim().replace(/^.*\//, ''))
    .filter((n) => /\.(otf|ttf)$/.test(n));
}

function groups(): Record<CoverageId, string[]> {
  const image = imageFonts();
  const faces = (stem: string, italic: string) => ['', '-Bold', `-${italic}`, `-Bold${italic}`].map((s) => `${stem}${s}.ttf`);
  return {
    // The notes template's own families: a character outside these needs the fallback.
    DejaVuSerif: faces('DejaVuSerif', 'Italic'),
    DejaVuSansMono: faces('DejaVuSansMono', 'Oblique'),
    // The fallback fonts, used upright only (one file for every face).
    'DejaVuSerif-upright': ['DejaVuSerif.ttf'],
    'DejaVuSans-upright': ['DejaVuSans.ttf'],
    'DejaVuSansMono-upright': ['DejaVuSansMono.ttf'],
    'texgyredejavu-math': ['texgyredejavu-math.otf'],
    'latinmodern-math': ['latinmodern-math.otf'],
    // Every optical size and face that the TU encoding's Latin Modern families (lmr, lmtt) load.
    lmroman: image.filter((n) => /^lmroman\d+-(regular|bold|italic|bolditalic)\.otf$/.test(n)).sort(),
    lmmono: image.filter((n) => /^(lmmono\d+-(regular|italic)|lmmonolt10-(bold|oblique|boldoblique))\.otf$/.test(n)).sort(),
  };
}

/** A document that writes, for each font file, the ranges of code points it has to coverage.txt. */
function scanDocument(files: string[]): string {
  return [
    '\\documentclass{article}',
    '\\newcount\\mdcp \\newcount\\mdstart \\newif\\ifmdin',
    '\\newwrite\\mdout \\immediate\\openout\\mdout=coverage.txt',
    '\\def\\mdflush{\\ifmdin \\advance\\mdcp-1 \\immediate\\write\\mdout{\\the\\mdstart\\space\\the\\mdcp}\\advance\\mdcp 1 \\mdinfalse\\fi}',
    '\\def\\mdscan#1{\\font\\mdf="[#1]" at 10pt\\relax \\immediate\\write\\mdout{font #1}\\mdcp=32 \\mdinfalse',
    `  \\loop \\iffontchar\\mdf\\mdcp \\ifmdin\\else\\mdstart=\\mdcp \\mdintrue\\fi \\else\\mdflush\\fi \\advance\\mdcp 1 \\ifnum\\mdcp<${LAST + 1} \\repeat \\mdflush}`,
    ...files.map((f) => `\\mdscan{${f}}`),
    '\\immediate\\closeout\\mdout',
    '\\begin{document}x\\end{document}',
    '',
  ].join('\n');
}

type Ranges = [number, number][];

function intersect(a: Ranges, b: Ranges): Ranges {
  const out: Ranges = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo <= hi) {
      out.push([lo, hi]);
    }
    if (a[i][1] < b[j][1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

const encode = (r: Ranges) => r.map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`)).join(' ');

describe('font coverage table (M1)', function () {
  this.timeout(900000);

  before(function () {
    if (!engineAssetPaths()) {
      this.skip();
    }
  });

  it('matches the fonts, measured by XeTeX', async () => {
    const g = groups();
    const all = [...new Set(Object.values(g).flat())];
    const dejavu = dejavuFolder();
    const files: ProjectFile[] = [{ path: 'scan.tex', data: new TextEncoder().encode(scanDocument(all)) }];
    for (const f of all.filter((n) => n.startsWith('DejaVu'))) {
      files.push({ path: f, data: new Uint8Array(readFileSync(path.join(dejavu, f))) });
    }
    const r = await compileAndRecord('font-coverage', job({ main: 'scan.tex', files, engine: 'xelatex', bibtex: 'never', maxPasses: 1, synctex: false, readBack: ['coverage.txt'] }));
    const text = r.result.readBack?.['coverage.txt'];
    assert.ok(text, `no coverage.txt (${r.result.error ?? r.analysis.errors.join(' | ')})`);
    const perFile = new Map<string, Ranges>();
    let current: Ranges = [];
    for (const line of text.split('\n')) {
      const font = /^font (.+)$/.exec(line.trim());
      if (font) {
        current = [];
        perFile.set(font[1], current);
      } else if (/^\d+ \d+$/.test(line.trim())) {
        const [a, b] = line.trim().split(' ').map(Number);
        current.push([a, b]);
      }
    }
    const measured = {} as Record<CoverageId, string>;
    for (const [id, names] of Object.entries(g) as [CoverageId, string[]][]) {
      assert.ok(names.length > 0, `${id}: no font files`);
      let ranges: Ranges | undefined;
      for (const n of names) {
        const own = perFile.get(n);
        assert.ok(own && own.length > 0, `${id}: ${n} was not measured (not found?)`);
        ranges = ranges ? intersect(ranges, own) : own;
      }
      measured[id] = encode(ranges ?? []);
      console.log(`      ${id}: ${names.length} file(s), ${(ranges ?? []).reduce((s, [a, b]) => s + b - a + 1, 0)} characters in ${(ranges ?? []).length} ranges`);
    }
    if (process.env.UPDATE_FONT_COVERAGE === '1') {
      const body = Object.entries(measured).map(([id, s]) => `  ${/^[A-Za-z]+$/.test(id) ? id : `'${id}'`}: '${s}',`);
      const sources = (Object.entries(g) as [CoverageId, string[]][]).map(([id, names]) => `//   ${id}: ${names.join(', ')}`);
      writeFileSync(
        path.join(root, 'src', 'converter', 'fonts', 'coverage.ts'),
        [
          '// Generated by test/engine/fontCoverage.test.ts (UPDATE_FONT_COVERAGE=1); do not edit by hand. For each font',
          '// family of the XeTeX templates, the code points (hexadecimal ranges) that every one of its files has,',
          '// measured by XeTeX (\\iffontchar) on the pinned DejaVu 2.34 files and on the engine image. Files:',
          ...sources,
          '',
          `export type CoverageId = ${Object.keys(g).map((k) => `'${k}'`).join(' | ')};`,
          '',
          'export const COVERAGE: Record<CoverageId, string> = {',
          ...body,
          '};',
          '',
        ].join('\n'),
      );
      console.log('      coverage.ts rewritten');
    } else {
      assert.deepEqual(Object.keys(COVERAGE).sort(), Object.keys(measured).sort(), 'the committed coverage table has other families (run with UPDATE_FONT_COVERAGE=1)');
      for (const id of Object.keys(measured) as CoverageId[]) {
        assert.equal(COVERAGE[id], measured[id], `${id}: the committed coverage table is out of date (run with UPDATE_FONT_COVERAGE=1)`);
      }
    }
  });
});
