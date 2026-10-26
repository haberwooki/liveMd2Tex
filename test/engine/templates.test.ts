// C0b exit criterion (docs/DESIGN.md#testing): each class template typesets its document on the bundled engine.
// The starting documents in templates/markdown (CC0) are converted by the extension's own converter with the
// class's template (src/converter/classes.ts) and compiled with pdfLaTeX and bibtex8, with each class and its
// .bst file from the pinned CTAN set (../engine_assets, docs/DESIGN.md#testing; elsarticle and acmart built from their
// .dtx by docstrip inside the engine). acmart needs fonts (libertine, newtxmath, inconsolata) that the interim
// TeXlyre image lacks; its test records the missing files instead of a PDF until the data packages carry them
// (B1 / extra-data). Results (numbers only) go to ../s1_runs/, outside the repository.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import type { ProjectFile } from '../../src/shared/engineJobs';
import { root } from '../support/helpers';
import { haveCtanClasses, journalClassFiles, type JournalClass } from './classFiles';
import { compileAndRecord, engineAssetPaths, job, record, sharedEngine, writeResults } from './support';

const templates = path.join(root, 'templates', 'markdown');
const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);

/** A journal class and its .bst, from the pinned CTAN set (docstrip runs on the shared engine). */
async function classFiles(name: JournalClass): Promise<ProjectFile[]> {
  const { host } = await sharedEngine();
  return journalClassFiles(name, (j) => host.compile(j));
}

/** Converts a starting document; returns the project files for its compile. */
function project(file: string): { main: string; files: ProjectFile[]; latex: string } {
  const markdown = readFileSync(path.join(templates, file), 'utf8');
  const result = convertMarkdown(markdown, { sourceName: file });
  assert.deepEqual(result.diagnostics.filter((d) => d.kind === 'unsupported'), [], `${file}: unsupported constructs`);
  const main = file.replace(/\.md$/, '.tex');
  return {
    main,
    latex: result.latex,
    files: [
      { path: main, data: text(result.latex) },
      { path: 'references.bib', data: new Uint8Array(readFileSync(path.join(templates, 'references.bib'))) },
    ],
  };
}

describe('class templates typeset their documents on the bundled engine (C0b)', function () {
  this.timeout(900000);

  before(function () {
    if (!engineAssetPaths() || !haveCtanClasses()) {
      this.skip();
    }
  });
  after(() => {
    console.log(`      results: ${writeResults()}`);
  });

  async function typeset(name: string, file: string, extra: ProjectFile[]) {
    const p = project(file);
    const r = await compileAndRecord(`template-${name}`, job({ main: p.main, files: [...p.files, ...extra], engine: 'pdflatex', bibtex: 'auto', maxPasses: 4, synctex: true }));
    console.log(
      `      ${name}: ${r.result.steps.map((s) => `${s.argv[0]} ${s.ms} ms`).join(', ')}; pages ${r.analysis.pages}; errors ${r.analysis.errors.length}; undefined refs ${r.analysis.undefinedRefs}`,
    );
    return r;
  }

  function assertTypeset(name: string, r: Awaited<ReturnType<typeof typeset>>) {
    assert.ok(r.result.pdf, `${name}: no PDF (${r.result.error ?? r.analysis.errors.slice(0, 5).join(' | ')})`);
    assert.deepEqual(r.analysis.errors, [], `${name}: errors`);
    assert.deepEqual(r.analysis.fallbacks, [], `${name}: font fallback`);
    assert.equal(r.analysis.undefinedRefs, 0, `${name}: undefined references or citations`);
    assert.ok(r.result.steps.some((s) => s.argv[0] === 'bibtex8'), `${name}: bibtex8 ran`);
    assert.ok(r.result.stubs && r.result.stubs.blocked.length === 0, `${name}: the compile worker tried to spawn or connect`);
  }

  it('report (LaTeX report class: chapters)', async () => {
    const r = await typeset('report', 'report.md', []);
    assertTypeset('report', r);
    assert.match(project('report.md').latex, /\\chapter\{Introduction\}/);
  });

  it('REVTeX 4.2 (revtex4-2, apsrev4-2.bst from the pinned revtex.tds.zip)', async () => {
    assertTypeset('revtex', await typeset('revtex', 'revtex.md', await classFiles('revtex')));
  });

  it('IEEEtran (IEEEtran.cls and IEEEtran.bst)', async () => {
    assertTypeset('ieeetran', await typeset('ieeetran', 'ieeetran.md', await classFiles('ieeetran')));
  });

  it('elsarticle (class built by docstrip in the engine, elsarticle-num.bst)', async () => {
    assertTypeset('elsarticle', await typeset('elsarticle', 'elsarticle.md', await classFiles('elsarticle')));
  });

  it('llncs (llncs.cls and splncs04.bst; CTAN has no sample paper, so the template has its own document)', async () => {
    assertTypeset('llncs', await typeset('llncs', 'llncs.md', await classFiles('llncs')));
  });

  it('acmart (class built by docstrip in the engine, ACM-Reference-Format.bst)', async () => {
    const r = await typeset('acmart', 'acmart.md', await classFiles('acmart'));
    // The interim image has no Libertine: acmart then keeps Computer Modern (its fonts arrive with the data
    // packages, B1). Recorded, not a failure.
    const fonts = [...new Set([...r.result.log.matchAll(/Class acmart Warning: ([^\n]*font[^\n]*)/gi)].map((m) => m[1]))];
    record('template-acmart-font-warnings', fonts);
    assertTypeset('acmart', r);
  });
});
