// Markdown-to-PDF unit tests (docs/DESIGN.md#converter): the font rule of the XeTeX route (font sets, the fallback
// classes, the math fallback), the engine choice of a preset mode on engine "auto", one plain warning per
// unsupported construct, and the compile route's interim fonts. The engine side is test/engine/m1.test.ts.

import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { anyFontHas, chooseFontSet, covers, emptyCharacterUse, fontPlan } from '../../src/converter/fonts/fonts';
import { braceScriptCommands } from '../../src/converter/latexWriter';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { resolveMode } from '../../src/converter/preset/load';
import { prepareMarkdownCompile } from '../../src/extension/compile/pipeline';
import { readInterimFonts } from '../../src/extension/engine/interimFonts';
import type { ProjectFs } from '../../src/extension/project/collect';
import { examplePreset, testDir } from './support';

const use = (text: string, code = '', math = '') => {
  const u = emptyCharacterUse();
  [...text].forEach((c) => u.text.add(c));
  [...code].forEach((c) => u.code.add(c));
  [...math].forEach((c) => u.math.add(c));
  return u;
};

describe('the font rule of the XeTeX route', () => {
  it('reads the coverage table', () => {
    assert.equal(covers('lmroman', 0x117), true); // ė
    assert.equal(covers('DejaVuSerif', 0x2500), false); // box drawing: not in every serif face
    assert.equal(covers('DejaVuSansMono-upright', 0x2500), true);
    assert.equal(covers('texgyredejavu-math', 0x1d4a9), true); // 𝒩
    assert.equal(anyFontHas('🚀'), false);
    assert.equal(anyFontHas('a'), true);
  });

  it('keeps Latin Modern when it has every character of text and code, else takes the DejaVu notes set', () => {
    assert.equal(chooseFontSet(use('ėūņș')), 'latin-modern');
    assert.equal(chooseFontSet(use('α')), 'dejavu'); // Greek in text
    assert.equal(chooseFontSet(use('', '─')), 'dejavu'); // box drawing in code
    assert.equal(chooseFontSet(use('🚀')), 'latin-modern'); // no font has it: shown as [U+...] either way
  });

  it('gives each character the first font that has it, for the serif text and for the code', () => {
    const plan = fontPlan(use('✓𝒩', '✓─'), 'dejavu');
    const byChar = Object.fromEntries(plan.fallbacks.map(([ch, rm, tt]) => [ch, [rm, tt]]));
    assert.deepEqual(byChar['✓'], ['DejaVuSans.ttf', 'DejaVuSansMono.ttf']);
    assert.deepEqual(byChar['𝒩'], ['texgyredejavu-math.otf', 'texgyredejavu-math.otf']);
    assert.deepEqual(byChar['─'], ['DejaVuSerif.ttf', 'DejaVuSansMono.ttf']); // upright faces have it
    assert.equal(plan.files.length, 12);
    // One interchar class per pair of fallbacks, with tokens in both directions between classes.
    const classes = plan.preamble.filter((l) => l.startsWith('\\newXeTeXintercharclass'));
    assert.equal(classes.length, 3);
    assert.ok(plan.preamble.includes('\\XeTeXinterchartokenstate=1'));
  });

  it('takes math characters Latin Modern Math lacks from DejaVu Math TeX Gyre, and names those neither has', () => {
    const math = [...'∫'].concat(['\u{1F680}']).join('');
    const plan = fontPlan(use('', '', math), 'latin-modern');
    assert.deepEqual(plan.missingMath, ['\u{1F680}']);
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.fallbacks, []);
  });
});

describe('the converter (Markdown to PDF)', () => {
  it('writes a run of three or more "=" as text: a grid-table border is no highlight', () => {
    const r = convertMarkdown('Title\n=====\n\na ==hi== b === c\n\n+===+===+\n| x | y |\n+===+===+');
    assert.match(r.latex, /a \\hl\{hi\} b === c/);
    assert.doesNotMatch(r.latex, /\\hl\{\\hl/);
  });

  it('braces a bare alphabet command in a sub- or superscript on XeTeX only (unicode-math rejects it)', () => {
    assert.equal(braceScriptCommands('\\hat{\\theta}_\\mathcal{M} = u_\\text{eff} + a_\\mathbf{v_{1}}'), '\\hat{\\theta}_{\\mathcal{M}} = u_{\\text{eff}} + a_{\\mathbf{v_{1}}}');
    assert.equal(braceScriptCommands('x^\\frac{a}{b} + x_\\alpha + y_{\\mathcal{T}}'), 'x^\\frac{a}{b} + x_\\alpha + y_{\\mathcal{T}}');
    assert.match(convertMarkdown('Box ┌ and $x_\\mathcal{M}$').latex, /\$x_\{\\mathcal\{M\}\}\$/);
    assert.match(convertMarkdown('Plain $x_\\mathcal{M}$').latex, /\$x_\\mathcal\{M\}\$/);
  });

  it('uses unicode-math\'s name for the task box on XeTeX', () => {
    assert.match(convertMarkdown('- [ ] Dovilė\n- [x] done').latex, /\\item\[\$\\mdlgwhtsquare\$\] Dovilė\n\s*\\item\[\$\\boxtimes\$\] done/);
    assert.match(convertMarkdown('- [ ] plain').latex, /\\item\[\$\\square\$\] plain/);
  });

  it('gives one plain warning per unsupported construct, on its first line', () => {
    const r = convertMarkdown(readFileSync(path.join(testDir, 'm1', 'unsupported.md'), 'utf8'));
    const warnings = r.diagnostics.filter((d) => d.kind === 'unsupported').flatMap((d) => d.lines.map((l) => `${d.code}@${l}`));
    assert.deepEqual(warnings.sort(), ['div-class:sidebar@22', 'example-list@12', 'fancy-list@15', 'grid-table@28', 'grid-table@6', 'html:video@26', 'simple-table@19']);
  });

  it('a preset mode on engine "auto" stays on pdfLaTeX unless a character needs XeTeX', () => {
    const { preset, files } = examplePreset();
    const mode = resolveMode(preset, 'letter', files).mode;
    assert.equal(mode.engine, 'auto');
    const plain = convertMarkdown(readFileSync(path.join(testDir, 'preset', 'letter.md'), 'utf8'), { preset: mode });
    assert.equal(plain.engine, 'pdflatex');
    assert.match(plain.latex, /\\usepackage\[T1\]\{fontenc\}/);
    const names = convertMarkdown(readFileSync(path.join(testDir, 'm1', 'cover-letter.md'), 'utf8'), { preset: mode });
    assert.equal(names.engine, 'xelatex');
    assert.match(names.latex, /\\usepackage\{fontspec\}/);
    assert.doesNotMatch(names.latex, /fontenc|inputenc/);
    assert.match(names.latex, /Žilvinas Petrauskas/);
    assert.ok(names.diagnostics.some((d) => d.code === 'engine'));
  });
});

describe('the compile route (Markdown to PDF)', () => {
  it('reads the interim fonts by plain file name only, and leaves out missing files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-fonts-'));
    try {
      writeFileSync(path.join(dir, 'A.ttf'), 'font');
      const files = await readInterimFonts(dir, ['A.ttf', 'B.ttf', '../A.ttf', 'A.txt']);
      assert.deepEqual(files.map((f) => f.path), ['A.ttf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the extra files to the compile, unless the project has a file of the same name', async () => {
    const fs: ProjectFs = {
      readDirectory: async (rel) => (rel === '' ? [['DejaVuSans.ttf', 'file']] : []),
      readFile: async () => new TextEncoder().encode('own'),
    };
    const prepared = await prepareMarkdownCompile({
      fs,
      markdownRel: 'notes.md',
      latex: '\\documentclass{article}\\usepackage{fontspec}\\begin{document}x\\end{document}',
      lineMap: [1],
      engine: 'xelatex',
      extraFiles: [
        { path: 'DejaVuSans.ttf', data: new TextEncoder().encode('interim') },
        { path: 'DejaVuSerif.ttf', data: new TextEncoder().encode('interim') },
      ],
    });
    const byPath = new Map(prepared.job.files.map((f) => [f.path, new TextDecoder().decode(f.data)]));
    assert.equal(byPath.get('DejaVuSans.ttf'), 'own');
    assert.equal(byPath.get('DejaVuSerif.ttf'), 'interim');
    assert.equal(prepared.job.engine, 'xelatex');
  });
});
