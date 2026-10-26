// Build gate 1 at engine level: a cancel followed in the same tick by the next job, many times, never corrupts
// what the next compile reads (G1E-01: each worker decompresses into its own buffers, and the next job waits for
// the old worker to exit); and a project's second compile sends only the changed file, which the engine host
// combines with the files it kept (G1E-03), also after the engine host restarts.

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, tinyPng, type CorpusProject } from '../support/corpusProjects';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';
import { record, writeResults } from './support';

describe('gate 1 (engine level): cancel races and change sets', function () {
  this.timeout(900000);
  let engine: EngineService;
  let tmp = '';
  let projects: CorpusProject[] = [];

  before(async function () {
    if (!bundledEngineAssets(root)) {
      this.skip();
    }
    engine = new EngineService({ modulePath: path.join(root, 'dist', 'engine-host.js'), assets: () => bundledEngineAssets(root), idleMinutes: () => 0, log: () => undefined });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-gate1-'));
    projects = await materializeCorpus(path.join(tmp, 'corpus'), docstripWith(engine));
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  it('G1E-01: twenty times, a compile is cancelled by the next one in the same tick; every surviving PDF is whole', async () => {
    const p1 = projects.find((p) => p.id === 'P1') as CorpusProject;
    const p8 = projects.find((p) => p.id === 'P8') as CorpusProject;
    const a = await prepareCompile({ fs: nodeFs(p1.folder), mainRel: p1.main, engineSetting: 'pdflatex', pass: 'full' });
    const b = await prepareCompile({ fs: nodeFs(p8.folder), mainRel: p8.main, engineSetting: 'pdflatex', pass: 'full' });
    let cancelled = 0;
    for (let round = 0; round < 20; round++) {
      const [first, second] = [round % 2 === 0 ? a : b, round % 2 === 0 ? b : a];
      const pending = engine.compile(first.job);
      const winner = engine.compile(second.job);
      const [x, y] = await Promise.all([pending, winner]);
      cancelled += x.result.error === 'cancelled' ? 1 : 0;
      assert.ok(y.result.pdf, `round ${round}: no PDF (${y.result.error ?? ''})\n${y.result.log.split('\n').slice(-8).join('\n')}`);
      const doc = await PDFDocument.load(y.result.pdf);
      assert.ok(doc.getPageCount() >= 1, `round ${round}: the PDF has no page`);
      assert.doesNotMatch(y.result.log, /^! |Fatal format file error|I can't find the format file/m, `round ${round}: the compile read a damaged file`);
    }
    // And while the first compile is reading the image: the next job arrives 30 to 300 ms in.
    let midway = 0;
    for (let round = 0; round < 12; round++) {
      const pending = engine.compile(a.job);
      await new Promise((resolve) => setTimeout(resolve, 30 + ((round * 53) % 271)));
      const y = await engine.compile(b.job);
      const x = await pending;
      midway += x.result.error === 'cancelled' ? 1 : 0;
      assert.ok(y.result.pdf, `midway round ${round}: no PDF (${y.result.error ?? ''})`);
      assert.ok((await PDFDocument.load(y.result.pdf)).getPageCount() >= 1);
      assert.doesNotMatch(y.result.log, /^! |Fatal format file error|I can't find the format file/m, `midway round ${round}: the compile read a damaged file`);
    }
    record('gate1-cancel-race', { rounds: 20, cancelled, midwayRounds: 12, midwayCancelled: midway });
    console.log(`      20 rounds in the same tick (${cancelled} cancelled) and 12 midway (${midway} cancelled); every surviving PDF whole`);
  });

  it('G1E-13: main files named "My Paper.tex", "résumé.tex" and "Paper.TEX", in a folder with a space, compile', async () => {
    const folder = path.join(tmp, 'names with space');
    mkdirSync(folder, { recursive: true });
    for (const name of ['My Paper.tex', 'résumé.tex', 'Paper.TEX']) {
      writeFileSync(path.join(folder, name), `\\documentclass{article}\n\\begin{document}\nThe file ${name.replace(/[^A-Za-z. ]/g, '')}.\n\\end{document}\n`);
    }
    for (const name of ['My Paper.tex', 'résumé.tex', 'Paper.TEX']) {
      const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: name, engineSetting: 'pdflatex' });
      const { result } = await engine.compile(prepared.job);
      assert.ok(result.pdf, `${name}: no PDF (${result.error ?? ''})\n${result.log.split('\n').slice(-6).join('\n')}`);
      assert.ok((await PDFDocument.load(result.pdf)).getPageCount() === 1);
    }
  });

  it('G1E-03: the second compile of a project sends only the changed file; the host adds the rest', async () => {
    const folder = path.join(tmp, 'delta');
    mkdirSync(path.join(folder, 'figs'), { recursive: true });
    const p1 = projects.find((p) => p.id === 'P1') as CorpusProject;
    const main = (n: number) => `\\documentclass{article}\n\\usepackage{graphicx}\n\\typeout{DELTA-MARK-${n}}\n\\begin{document}\nVersion ${n}.\n\\includegraphics[width=3cm]{figs/fig}\n\\input{part}\n\\end{document}\n`;
    writeFileSync(path.join(folder, 'main.tex'), main(1));
    writeFileSync(path.join(folder, 'part.tex'), 'A part.\n');
    writeFileSync(path.join(folder, 'figs', 'fig.pdf'), (await import('node:fs')).readFileSync(path.join(p1.folder, 'fig-response.pdf')));
    const compile = async () => {
      const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'main.tex', engineSetting: 'pdflatex' });
      return (await engine.compile(prepared.job, 'delta-project')).result;
    };
    const r1 = await compile();
    assert.ok(r1.pdf);
    assert.deepEqual(engine.lastTransfer && [engine.lastTransfer.full, engine.lastTransfer.changed], [true, 3]);
    writeFileSync(path.join(folder, 'main.tex'), main(2));
    const r2 = await compile();
    assert.ok(r2.pdf, 'no PDF from the change set');
    assert.deepEqual(engine.lastTransfer && [engine.lastTransfer.full, engine.lastTransfer.changed, engine.lastTransfer.removed], [false, 1, 0]);
    assert.match(r2.log, /DELTA-MARK-2/);
    assert.doesNotMatch(r2.log, /not found/);
    // A restarted engine host has nothing kept: the service sends the whole project again.
    await engine.stop();
    writeFileSync(path.join(folder, 'main.tex'), main(3));
    const r3 = await compile();
    assert.ok(r3.pdf);
    assert.equal(engine.lastTransfer?.full, true);
    assert.match(r3.log, /DELTA-MARK-3/);
    record('gate1-delta', { secondChanged: 1, bytesSecond: 0 });
  });

  it('a PDF cut short is no PDF: xdvipdfmx failing at once, and a program stopping in the middle of the file', async () => {
    const tex = (body: string) => new TextEncoder().encode(`\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n${body}\n\\end{document}\n`);
    const png = new Uint8Array(tinyPng());
    const cases = [
      // xdvipdfmx exits 1 on a missing image and leaves a 15-byte file.
      { name: 'xdvipdfmx fails', files: [{ path: 'main.tex', data: tex('Hello.\\special{pdf:image (nofile.pdf)}') }], stopped: /xdvipdfmx stopped with exit code 1\b/ },
      // After page one is written, xdvipdfmx stops (exit -1) on a PNG cut in half: the file has no trailer.
      {
        name: 'stops midway',
        files: [
          { path: 'main.tex', data: tex('Page one.\\clearpage Two \\includegraphics{bad.png}') },
          { path: 'bad.png', data: png.slice(0, Math.floor(png.length * 0.6)) },
        ],
        stopped: /does not end with "startxref".*stopped with exit code -1/,
      },
    ];
    const seen: string[] = [];
    for (const [i, c] of cases.entries()) {
      const { result } = await engine.compile({ id: 990001 + i, main: 'main.tex', files: c.files, engine: 'xelatex', bibtex: 'never', maxPasses: 1, synctex: true });
      const steps = result.steps.map((s) => `${s.argv[0]}:${s.exitCode}`).join(', ');
      assert.equal(result.pdf, null, `${c.name}: a PDF came back (${result.pdf?.length} bytes; ${steps})`);
      assert.equal(result.ok, false, `${c.name}: the compile reports success`);
      assert.match(result.error ?? '', /^The PDF came back cut short \(/, `${c.name}: ${result.error}; ${steps}`);
      assert.match(result.error ?? '', c.stopped, `${c.name}: ${result.error}`);
      seen.push(`${c.name}: ${result.error} [${steps}]`);
    }
    // pdfTeX removes its own PDF when it stops on a corrupt image: no PDF, and no success either.
    const pdftex = await engine.compile({
      id: 990009,
      main: 'main.tex',
      files: [
        { path: 'main.tex', data: tex('Page one.\\clearpage \\includegraphics{bad.png}') },
        { path: 'bad.png', data: png.slice(0, 40) },
      ],
      engine: 'pdflatex',
      bibtex: 'never',
      maxPasses: 1,
      synctex: true,
    });
    assert.equal(pdftex.result.pdf, null);
    assert.equal(pdftex.result.ok, false);
    console.log(`      ${seen.join('\n      ')}`);
  });
});
