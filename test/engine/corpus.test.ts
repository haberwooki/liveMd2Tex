// S1 pass tests on the public corpus P1 to P8 (docs/DESIGN.md#testing). P1, P5 and the project part of P8 are in the
// repository (CC0); the CTAN files are fetched and pinned by scripts/pin-ctan.mjs into ../engine_assets and read
// from there (the publisher classes go in through the project-folder route of docs/DESIGN.md#engine-and-data).

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import type { ProjectFile } from '../../src/shared/engineJobs';
import { importScript, root, stubState } from '../support/helpers';
import { assetsRoot, compileAndRecord, engineAssetPaths, job, readFolder, sharedEngine, writeResults } from './support';

interface Pins {
  sources: { id: string; folder: string }[];
}
const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as Pins;
const ctan = (id: string) => path.join(assetsRoot, pins.sources.find((s) => s.id === id)?.folder ?? id);
const corpus = (id: string) => path.join(root, 'test', 'corpus', id);
const text = (s: string) => new TextEncoder().encode(s);

/** Files of a CTAN folder, flattened into the project root (the project-folder route). */
function flat(dir: string, names: string[]): ProjectFile[] {
  return names.map((n) => ({ path: path.basename(n), data: new Uint8Array(readFileSync(path.join(dir, ...n.split('/')))) }));
}

/** A figure for P1, drawn in code (CC0): a resonance curve. */
async function responseFigure(): Promise<ProjectFile> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 180]);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 200; i++) {
    const w = 0.5 + i / 100;
    const y = 1 / Math.sqrt((1 - w * w) ** 2 + (w / 8) ** 2);
    pts.push({ x: 20 + i * 1.3, y: 20 + Math.min(y, 9) * 16 });
  }
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 290, y: 20 }, thickness: 1 });
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 20, y: 170 }, thickness: 1 });
  for (let i = 1; i < pts.length; i++) {
    page.drawLine({ start: pts[i - 1], end: pts[i], thickness: 1.5, color: rgb(0.1, 0.2, 0.7) });
  }
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  return { path: 'fig-response.pdf', data: await doc.save() };
}

describe('S1 pass tests on the public corpus P1 to P8', function () {
  this.timeout(900000);

  before(function () {
    if (!engineAssetPaths() || !existsSync(ctan('ctan-revtex'))) {
      this.skip();
    }
  });

  after(() => {
    console.log(`      results: ${writeResults()}`);
  });

  /** PDF, SyncTeX, no mktex, no font fallback, no spawn or connection; errors only where `allowedErrors` says. */
  function assertPass(name: string, r: Awaited<ReturnType<typeof compileAndRecord>>, allowedErrors?: RegExp) {
    const { result, analysis } = r;
    assert.ok(result.pdf, `${name}: no PDF (${result.error ?? analysis.errors.join(' | ')})`);
    assert.ok(result.synctex && result.synctex.length > 0, `${name}: no SyncTeX`);
    assert.deepEqual(analysis.mktex, [], `${name}: mktex lines`);
    assert.deepEqual(analysis.fallbacks, [], `${name}: font fallback`);
    const unexpected = analysis.errors.filter((e) => !allowedErrors || !allowedErrors.test(e));
    assert.deepEqual(unexpected, [], `${name}: errors`);
    assert.ok(result.stubs && result.stubs.blocked.length === 0, `${name}: the compile worker tried to spawn or connect`);
    assert.deepEqual(stubState().blocked, []);
  }

  const summary = (name: string, r: Awaited<ReturnType<typeof compileAndRecord>>) =>
    console.log(
      `      ${name}: ${r.result.steps.map((s) => `${s.argv[0]} ${s.ms} ms`).join(', ')}; pages ${r.analysis.pages}; ` +
        `errors ${r.analysis.errors.length}; total ${r.result.timings.totalMs} ms`,
    );

  it('P1: two-column article (amsmath, graphicx, natbib, hyperref, booktabs, siunitx), BibTeX', async () => {
    const files = [...readFolder(corpus('P1')), await responseFigure()];
    const r = await compileAndRecord('P1', job({ main: 'paper.tex', files, engine: 'pdflatex', bibtex: 'auto', maxPasses: 4, synctex: true }));
    summary('P1', r);
    assertPass('P1', r);
    assert.equal(r.analysis.undefinedRefs, 0);
  });

  it('P2: REVTeX 4.2 sample (apssamp.tex) with apsrev4-2.bst and BibTeX; its .eps figures cannot be shown', async () => {
    const { readZip } = await importScript<{ readZip(b: Buffer): Map<string, Buffer> }>('scripts/lib/zip.mjs');
    const zip = readZip(readFileSync(path.join(ctan('ctan-revtex'), 'revtex.tds.zip')));
    const files: ProjectFile[] = [];
    for (const [name, data] of zip) {
      if (/^tex\/latex\/revtex\/|^bibtex\/bst\/revtex\/apsrev4-2\.bst$|^doc\/latex\/revtex\/sample\/aps\/(apssamp\.(tex|bib)|.*\.eps)$/.test(name)) {
        files.push({ path: path.posix.basename(name), data: new Uint8Array(data) });
      }
    }
    const r = await compileAndRecord('P2', job({ main: 'apssamp.tex', files, engine: 'pdflatex', bibtex: 'auto', maxPasses: 4, synctex: true }));
    summary('P2', r);
    // The sample's figures are .eps files, which need Ghostscript (docs/DESIGN.md#engine-and-data): expected errors.
    assertPass('P2', r, /eps-converted-to\.pdf' not found|Unknown graphics extension: \.eps/);
    assert.ok(r.result.steps.some((s) => s.argv[0] === 'bibtex8' && s.exitCode <= 1), 'bibtex8 ran');
  });

  it('P3: IEEEtran bare_jrnl.tex', async () => {
    const files = flat(ctan('ctan-ieeetran'), ['IEEEtran.cls', 'bare_jrnl.tex', 'bibtex/IEEEtran.bst']);
    const r = await compileAndRecord('P3', job({ main: 'bare_jrnl.tex', files, engine: 'pdflatex', bibtex: 'auto', maxPasses: 3, synctex: true }));
    summary('P3', r);
    assertPass('P3', r);
  });

  it('P4: Elsevier elsarticle-template-num.tex, with elsarticle.cls built from its .dtx inside the engine', async () => {
    const { host } = await sharedEngine();
    const src = flat(ctan('ctan-elsarticle'), ['elsarticle.dtx', 'elsarticle.ins']);
    const fmt = '/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt';
    const built = await host.compile(
      job({
        main: 'elsarticle.ins',
        files: src,
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 1,
        synctex: false,
        steps: [['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-fmt', fmt, 'elsarticle.ins']],
        readBack: ['elsarticle.cls'],
      }),
    );
    const cls = built.readBack?.['elsarticle.cls'];
    // The class names itself through a macro (\ProvidesClass{\@shortjid}); docstrip's header names the file.
    assert.ok(cls && cls.includes("This is file `elsarticle.cls'"), 'docstrip did not build elsarticle.cls');
    const files = [...flat(ctan('ctan-elsarticle'), ['elsarticle-template-num.tex', 'elsarticle-num.bst']), { path: 'elsarticle.cls', data: text(cls) }];
    const r = await compileAndRecord('P4', job({ main: 'elsarticle-template-num.tex', files, engine: 'pdflatex', bibtex: 'auto', maxPasses: 3, synctex: true }));
    console.log(`      P4 docstrip: ${built.steps[0].ms} ms, elsarticle.cls ${cls.length} bytes`);
    summary('P4', r);
    assertPass('P4', r);
  });

  it('P5: a Nature-style manuscript on article (authblk, lineno, natbib super), BibTeX', async () => {
    const r = await compileAndRecord('P5', job({ main: 'manuscript.tex', files: readFolder(corpus('P5')), engine: 'pdflatex', bibtex: 'auto', maxPasses: 4, synctex: true }));
    summary('P5', r);
    assertPass('P5', r);
    assert.equal(r.analysis.undefinedRefs, 0);
  });

  it("P6: beamer's conference-talk example (Darmstadt theme)", async () => {
    const files = flat(ctan('ctan-beamer-example'), ['beamerexample-conference-talk.tex']);
    const r = await compileAndRecord('P6', job({ main: 'beamerexample-conference-talk.tex', files, engine: 'pdflatex', bibtex: 'never', maxPasses: 3, synctex: true }));
    summary('P6', r);
    assertPass('P6', r);
  });

  it('P7: ucbthesis sample (memoir-based, \\include chapters), biblatex through bibtex8', async () => {
    const files = flat(ctan('ctan-ucbthesis'), ['ucbthesis.cls', 'thesis.tex', 'abstract.tex', 'chap1.tex', 'chap2.tex', 'references.bib']);
    // biblatex's default backend is Biber, which S1 does not run (it comes with the extra data,
    // docs/DESIGN.md#engine-and-data); the test asks biblatex for its bibtex8 backend instead. Edited in memory only.
    const thesis = files.find((f) => f.path === 'thesis.tex');
    assert.ok(thesis);
    thesis.data = text(new TextDecoder().decode(thesis.data).replace('\\usepackage{biblatex}', '\\usepackage[backend=bibtex8]{biblatex}'));
    const r = await compileAndRecord('P7', job({ main: 'thesis.tex', files, engine: 'pdflatex', bibtex: 'auto', maxPasses: 4, synctex: true }));
    summary('P7', r);
    assertPass('P7', r);
    assert.ok(r.result.steps.some((s) => s.argv[0] === 'bibtex8'), 'bibtex8 ran for biblatex');
  });

  it('P8: TikZ and pgfplots: the project pictures and two pictures from the pgf manual', async () => {
    const own = await compileAndRecord('P8-project', job({ main: 'pictures.tex', files: readFolder(corpus('P8')), engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: true }));
    summary('P8 project', own);
    assertPass('P8 project', own);

    // Two tikzpictures from the manual's tutorial chapter, wrapped in a standalone document at test time.
    const tutorial = readFileSync(path.join(ctan('ctan-pgf-manual'), 'pgfmanual-en-tutorial.tex'), 'utf8');
    const pictures = [...tutorial.matchAll(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g)].map((m) => m[0]);
    assert.ok(pictures.length >= 2);
    const doc = [
      '\\documentclass[border=4pt]{standalone}',
      '\\usepackage{tikz}',
      '\\usetikzlibrary{arrows.meta,calc,intersections,through,backgrounds}',
      '\\begin{document}',
      pictures[0],
      '\\quad',
      pictures[1],
      '\\end{document}',
      '',
    ].join('\n');
    const manual = await compileAndRecord('P8-manual', job({ main: 'tutorial.tex', files: [{ path: 'tutorial.tex', data: text(doc) }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: true }));
    summary('P8 manual', manual);
    assertPass('P8 manual', manual);
  });
});
