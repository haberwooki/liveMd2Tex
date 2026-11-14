// G0's acceptance check: the public corpus, compiled through the extension's route with the core data and the Extra
// Packages add-on installed, gives the same page counts and the same missing-package lists on every runner as on the
// development machine's copy of the same two images (same SHA-256 each). P7-core-only adds the user who has the core
// data and no add-on: biblatex is in the add-on, so the compile reports biblatex.sty missing and makes no PDF.
//
// The development machine writes the baseline once per pair of images: LIVEMD2TEX_WRITE_CORPUS_BASELINE=1 npm run
// test:engine. Every other run compares with test/baselines/corpus.json; a baseline made with other images fails the
// test (on CI and on a laptop alike), never skips it. It skips only when the engine or the data is not staged
// (test/support/missingData.ts). Public documents only (P1 to P8); numbers and file names, nothing else.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { root } from '../support/helpers';
import { missingInput } from '../support/missingData';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';
import { extraAddOn, stagedEngine } from './support';

const BASELINE = path.join(root, 'test', 'baselines', 'corpus.json');

interface Baseline {
  /** SHA-256 of the core data's image and of the add-on's: the key. */
  core: string;
  addon: string;
  documents: Record<string, { pages: number | null; missing: string[] }>;
}

describe('G0 check: corpus page counts and missing-package lists against the laptop baseline', function () {
  this.timeout(900000);
  let engine: EngineService;
  let tmp = '';

  before(function () {
    if (!stagedEngine(this)) {
      return;
    }
    engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-baseline-'));
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('P1 to P8 with the add-on, and P7 with the core data alone: the same numbers as the baseline', async function () {
    const core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index, 'the staged data has no package index');
    const addon = await extraAddOn();
    if (!addon) {
      missingInput('the Extra Packages add-on (the pinned extra-data package, or LIVEMD2TEX_EXTRA_DATA)');
      this.skip();
      return;
    }
    const coreImage = (JSON.parse(readFileSync(path.join(root, 'dist', 'data', 'manifest.json'), 'utf8')) as { image: { sha256: string } }).image.sha256;
    const projects = (await materializeCorpus(path.join(tmp, 'corpus'), docstripWith(engine))).filter((p) => !p.private && /^P[1-8]$/.test(p.id));
    const documents: Baseline['documents'] = {};
    const measure = async (id: string, p: CorpusProject, packages: ReturnType<typeof packageContext>) => {
      const prepared = await prepareCompile({ fs: nodeFs(p.folder), mainRel: p.main, engineSetting: 'pdflatex', packages });
      const { result } = await engine.compile(prepared.job);
      documents[id] = {
        pages: result.pdf ? (await PDFDocument.load(result.pdf)).getPageCount() : null,
        missing: (prepared.packageScan?.missing ?? []).map((m) => m.file).sort(),
      };
    };
    for (const p of projects) {
      await measure(p.id, p, packageContext(core, [addon]));
    }
    await measure('P7-core-only', projects.find((p) => p.id === 'P7') as CorpusProject, packageContext(core, []));
    console.log(`      ${Object.entries(documents).map(([id, d]) => `${id} ${d.pages ?? 'no'} page(s)${d.missing.length ? `, missing ${d.missing.join(' ')}` : ''}`).join('; ')}`);
    if (process.env.LIVEMD2TEX_WRITE_CORPUS_BASELINE === '1') {
      mkdirSync(path.dirname(BASELINE), { recursive: true });
      writeFileSync(BASELINE, `${JSON.stringify({ core: coreImage, addon: addon.image.sha256, documents } satisfies Baseline, null, 2)}
`);
      console.log(`      baseline written: ${path.relative(root, BASELINE)}`);
      return;
    }
    assert.ok(existsSync(BASELINE), 'test/baselines/corpus.json is missing; write it with LIVEMD2TEX_WRITE_CORPUS_BASELINE=1');
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
    assert.ok(
      baseline.core === coreImage && baseline.addon === addon.image.sha256,
      `the baseline was made with another image (core ${baseline.core.slice(0, 12)}, add-on ${baseline.addon.slice(0, 12)}; these are ${coreImage.slice(0, 12)} and ${addon.image.sha256.slice(0, 12)}); rewrite it with LIVEMD2TEX_WRITE_CORPUS_BASELINE=1`,
    );
    assert.deepEqual(documents, baseline.documents);
  });
});
