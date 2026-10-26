// M2-A's SyncTeX exit criteria at Node level (docs/DESIGN.md#testing), on public documents: ten random clicks in
// P1's PDF land within one line of the true source line, ten in P10's within one Markdown line, and forward
// search from ten random lines lands on the right page with the highlight over the line (syncHarness.ts). P9
// (Markdown typeset with XeTeX) checks the preamble offsets XeTeX writes. Each document is compiled through
// the extension's route; its .synctex.gz is read by the SyncTeX worker (dist/synctex-worker.js). Private
// documents are checked by the private test overlay (.private-fixtures.json), when there is one.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import type { EngineService } from '../../src/extension/engine/engineService';
import type { CompileResult } from '../../src/shared/engineJobs';
import { SyncClient } from '../../src/extension/sync/syncClient';
import { materializeMarkdownCorpus, responseFigure, type CorpusProject } from '../support/corpusProjects';
import { requireBuilt, root } from '../support/helpers';
import { folderFs, markdownEngineService, typesetMarkdown } from './markdownRoute';
import { assertHarness, auxOf, generatedTexts, markdownSubject, reportLine, runHarness, texSubject, type Lists } from './syncHarness';
import { record, writeResults } from './support';

/** The list lookup's inputs for a compile: its auxiliary files, and the project's other files (the .bib files). */
function listsOf(folder: string, result: CompileResult): Lists {
  return {
    aux: auxOf(result),
    read: async (file) => (existsSync(path.join(folder, file)) ? readFileSync(path.join(folder, file), 'utf8').split(/\r?\n/) : undefined),
  };
}

describe('M2-A SyncTeX: inverse and forward search on public documents (Node)', function () {
  this.timeout(1800000);
  let service: EngineService;
  let client: SyncClient;
  let tmp = '';
  let corpus: CorpusProject[] = [];

  before(async function () {
    const s = markdownEngineService();
    if (!s) {
      this.skip(); // needs node scripts/stage-engine.mjs --data after the build
    }
    service = s as EngineService;
    client = new SyncClient(requireBuilt('dist/synctex-worker.js'));
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-sync-'));
    corpus = await materializeMarkdownCorpus(tmp);
  });

  after(async () => {
    await client?.dispose();
    await service?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  it('P1 (pdfLaTeX, two columns): ten clicks within one line, ten forward searches on the line', async () => {
    const folder = path.join(tmp, 'P1');
    cpSync(path.join(root, 'test', 'corpus', 'P1'), folder, { recursive: true });
    writeFileSync(path.join(folder, 'fig-response.pdf'), await responseFigure());
    const prepared = await prepareCompile({ fs: folderFs(folder), mainRel: 'paper.tex', engineSetting: 'pdflatex' });
    const { result } = await service.compile(prepared.job);
    assert.ok(result.pdf && result.synctex, 'no PDF or no SyncTeX');
    const loaded = await client.load('P1', result.synctex);
    assert.ok(loaded.files.includes('paper.tex'));
    const sources = [{ file: 'paper.tex', text: readFileSync(path.join(folder, 'paper.tex'), 'utf8') }];
    const r = await runHarness(texSubject(client, 'P1', sources, listsOf(folder, result)), result.pdf, sources, { others: generatedTexts(result) });
    record('M2A-sync-P1', r);
    console.log(`      ${reportLine('P1', r)}`);
    assertHarness('P1', r);
  });

  for (const id of ['P10', 'P9']) {
    it(`${id} (Markdown${id === 'P9' ? ', XeTeX' : ''}): clicks within one Markdown line, forward search through the line map`, async () => {
      const p = corpus.find((x) => x.id === id) as CorpusProject;
      const text = readFileSync(path.join(p.folder, p.main), 'utf8');
      const t = await typesetMarkdown(service, folderFs(p.folder), p.main, text);
      assert.ok(t.result.pdf && t.result.synctex, 'no PDF or no SyncTeX');
      assert.equal(t.conversion.engine, id === 'P9' ? 'xelatex' : 'pdflatex');
      await client.load(id, t.result.synctex);
      const origin = { main: t.prepared.job.main, markdown: p.main, lineMap: t.conversion.lineMap, bodyStartLine: t.conversion.bodyStartLine, latexLines: t.conversion.latex.split('\n'), markdownLines: text.split(/\r?\n/) };
      const sources = [{ file: p.main, text }];
      const r = await runHarness(markdownSubject(client, id, origin, sources, listsOf(p.folder, t.result)), t.result.pdf, sources, { others: generatedTexts(t.result) });
      record(`M2A-sync-${id}`, r);
      console.log(`      ${reportLine(id, r)}`);
      assertHarness(id, r, id === 'P9' ? 5 : 10);
    });
  }
});
