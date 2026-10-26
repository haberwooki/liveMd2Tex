// G0's acceptance check, prepared on the laptop (docs/DESIGN.md#testing): the public corpus, compiled through
// the extension's route with TeXlyre's pinned image, gives the same page counts and the same missing-package
// lists on every CI runner as on the laptop's copy of the same image (same SHA-256).
//
// The laptop writes the baseline once: LIVEMD2TEX_WRITE_CORPUS_BASELINE=1 npm run test:engine. Every other run
// compares with test/baselines/corpus.json, when the image's SHA-256 is the one the baseline was made with.
// Public documents only (P1 to P8, and P2 without its REVTeX files for a non-empty missing list); numbers and
// file names, nothing else.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';

const BASELINE = path.join(root, 'test', 'baselines', 'corpus.json');

interface Baseline {
  image: string;
  documents: Record<string, { pages: number | null; missing: string[] }>;
}

describe('G0 check: corpus page counts and missing-package lists against the laptop baseline', function () {
  this.timeout(900000);
  let engine: EngineService;
  let tmp = '';

  before(function () {
    if (!bundledEngineAssets(root) || !existsSync(path.join(root, 'dist', 'data', 'packages.json'))) {
      this.skip();
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

  it('P1 to P8, and P2 without REVTeX: the same numbers as the baseline', async function () {
    const core = await readCoreData(path.join(root, 'dist', 'data'));
    assert.ok(core?.index, 'the staged data has no package index');
    const image = (JSON.parse(readFileSync(path.join(root, 'dist', 'data', 'manifest.json'), 'utf8')) as { image: { sha256: string } }).image.sha256;
    const projects = (await materializeCorpus(path.join(tmp, 'corpus'), docstripWith(engine))).filter((p) => !p.private && /^P[1-8]$/.test(p.id));
    const p2 = projects.find((p) => p.id === 'P2') as CorpusProject;
    const bare = path.join(tmp, 'P2-bare');
    mkdirSync(bare, { recursive: true });
    for (const name of readdirSync(p2.folder).filter((n) => !/\.(cls|rtx|sty|bst)$/i.test(n))) {
      cpSync(path.join(p2.folder, name), path.join(bare, name));
    }
    const documents: Baseline['documents'] = {};
    for (const p of [...projects, { id: 'P2-without-REVTeX', folder: bare, main: p2.main, private: false }]) {
      const prepared = await prepareCompile({ fs: nodeFs(p.folder), mainRel: p.main, engineSetting: 'pdflatex', packages: packageContext(core, []) });
      const { result } = await engine.compile(prepared.job);
      documents[p.id] = {
        pages: result.pdf ? (await PDFDocument.load(result.pdf)).getPageCount() : null,
        missing: (prepared.packageScan?.missing ?? []).map((m) => m.file).sort(),
      };
    }
    console.log(`      ${Object.entries(documents).map(([id, d]) => `${id} ${d.pages ?? 'no'} page(s)${d.missing.length ? `, missing ${d.missing.join(' ')}` : ''}`).join('; ')}`);
    if (process.env.LIVEMD2TEX_WRITE_CORPUS_BASELINE === '1') {
      mkdirSync(path.dirname(BASELINE), { recursive: true });
      writeFileSync(BASELINE, `${JSON.stringify({ image, documents } satisfies Baseline, null, 2)}\n`);
      console.log(`      baseline written: ${path.relative(root, BASELINE)}`);
      return;
    }
    if (!existsSync(BASELINE)) {
      this.skip();
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
    if (baseline.image !== image) {
      this.skip();
    }
    assert.deepEqual(documents, baseline.documents);
  });
});
