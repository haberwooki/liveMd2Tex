// M5's canaries and its XeLaTeX corpus document on the engine (docs/coverage-method.md; docs/DESIGN.md#testing):
// the two known-good documents every coverage shard compiles before and after its documents, and
// test/corpus/xelatex, which the corpus check needs to compile on the extension. Run here, a fontspec or font problem
// shows before a CI run, not as a failed check on CI.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { importScript, root, stubState } from '../support/helpers';
import { compileAndRecord, engineAssetPaths, job, readFolder } from './support';

const text = (s: string) => new TextEncoder().encode(s);

describe('M5: the coverage canaries and the XeLaTeX corpus document on the engine', function () {
  this.timeout(600000);
  let canaries: Record<'pdflatex' | 'xelatex', string>;

  before(async function () {
    if (!engineAssetPaths()) {
      this.skip();
    }
    canaries = (await importScript<{ CANARY_DOCUMENTS: Record<'pdflatex' | 'xelatex', string> }>('scripts/lib/coverage.mjs')).CANARY_DOCUMENTS;
  });

  /** A PDF with a page, no error, no font problem (a missing character or font), and no spawn or connection. */
  function assertGood(name: string, r: Awaited<ReturnType<typeof compileAndRecord>>) {
    assert.ok(r.result.pdf && r.result.pdf.length > 0, `${name}: no PDF (${r.result.error ?? r.analysis.errors.join(' | ')})`);
    assert.deepEqual(r.analysis.errors, [], `${name}: errors`);
    assert.deepEqual(r.analysis.fallbacks, [], `${name}: a missing character or font`);
    assert.ok(r.result.stubs && r.result.stubs.blocked.length === 0, `${name}: the compile worker tried to spawn or connect`);
    assert.deepEqual(stubState().blocked, []);
  }

  for (const engine of ['pdflatex', 'xelatex'] as const) {
    it(`the ${engine} canary compiles`, async () => {
      const r = await compileAndRecord(`canary-${engine}`, job({ main: 'main.tex', files: [{ path: 'main.tex', data: text(canaries[engine]) }], engine, bibtex: 'never', maxPasses: 2, synctex: false }));
      assertGood(`canary-${engine}`, r);
    });
  }

  it('the XeLaTeX corpus document compiles on XeLaTeX', async () => {
    const files = readFolder(path.join(root, 'test', 'corpus', 'xelatex'));
    const r = await compileAndRecord('corpus-xelatex', job({ main: 'xelatex.tex', files, engine: 'xelatex', bibtex: 'never', maxPasses: 2, synctex: false }));
    assertGood('corpus-xelatex', r);
  });
});
