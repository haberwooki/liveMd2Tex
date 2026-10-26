// M2-B's multi-root fixture on the engine (test/corpus/multiroot): both root documents compile through the
// extension's pipeline in one project folder, each to its own PDF; the files each compile read (the engine's
// read set) include the shared refs.bib and sections/shared.tex; and a change to refs.bib, decided as the
// extension decides it (roots.ts, previewedTargets), compiles only the previewed document.

import * as assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import type { EngineService } from '../../src/extension/engine/engineService';
import { findRoot, previewedTargets, type RootFs } from '../../src/extension/project/roots';
import { root } from '../support/helpers';
import { folderFs, markdownEngineService } from './markdownRoute';
import { record, writeResults } from './support';

describe('M2-B: the multi-root fixture on the engine', function () {
  this.timeout(900000);
  let service: EngineService;
  let tmp = '';
  let folder = '';

  before(function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip();
    }
    service = s as EngineService;
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-multiroot-'));
    folder = path.join(tmp, 'multiroot');
    cpSync(path.join(root, 'test', 'corpus', 'multiroot'), folder, { recursive: true });
  });

  after(async () => {
    await service?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  it('two roots in one folder: each compiles to its own PDF; refs.bib changes compile only the previewed one', async () => {
    const fs = folderFs(folder);
    const reads = new Map<string, Set<string>>();
    for (const main of ['paper.tex', 'notes.tex']) {
      const prepared = await prepareCompile({ fs, mainRel: main, engineSetting: 'pdflatex' });
      const { result } = await service.compile(prepared.job);
      assert.ok(result.pdf, `${main}: no PDF`);
      assert.equal(result.bibtexRan, true, `${main}: bibtex8 did not run`);
      assert.doesNotMatch(result.log, /undefined (citations|references)/i, `${main}: undefined citations`);
      reads.set(main, new Set(result.readFiles ?? []));
      record(`M2B-multiroot-${main}`, { pages: /\((\d+) pages?/.exec(result.log)?.[1], readFiles: (result.readFiles ?? []).length });
    }
    for (const [main, files] of reads) {
      for (const shared of ['refs.bib', 'sections/shared.tex']) {
        assert.ok(files.has(shared), `${main} did not read ${shared}: ${[...files].join(', ')}`);
      }
    }
    assert.ok(reads.get('notes.tex')?.has('appendix.tex') && !reads.get('paper.tex')?.has('appendix.tex'));

    // A change to refs.bib: every root that read it is a candidate; the previewed one compiles.
    const candidates = [...reads].filter(([, files]) => files.has('refs.bib')).map(([main]) => main);
    assert.deepEqual(candidates, ['paper.tex', 'notes.tex']);
    assert.deepEqual(previewedTargets(candidates, (k) => k === 'notes.tex', undefined, []), ['notes.tex']);
    // A change to sections/shared.tex with no preview showing: its "% !TEX root" document.
    const rootFs: RootFs = { ...fs, exists: async (rel) => (await fs.readDirectory(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))).some(([n]) => n === path.posix.basename(rel)) };
    const own = await findRoot(rootFs, 'sections/shared.tex', readFileSync(path.join(folder, 'sections', 'shared.tex'), 'utf8'));
    assert.equal(own, 'paper.tex');
    assert.deepEqual(previewedTargets(candidates, () => false, own, []), ['paper.tex']);
  });
});
