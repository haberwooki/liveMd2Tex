// M2-A at engine level (docs/DESIGN.md#testing, #live-behaviour, #confinement-and-trust): the confinement fixture, the
// files a compile reads (what the extension watches), the quick pass and the full pass that follows it, the
// standby worker, and the cold start.

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diagnosticsFor, nextState, prepareCompile } from '../../src/extension/compile/pipeline';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { DISPLAY_NAME } from '../../src/shared/identity';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';
import { record, writeResults } from './support';

const SECRET = 'PRIVATE-KEY-MATERIAL-THAT-MUST-NEVER-BE-READ';

function service(): EngineService {
  const s = new EngineService({
    modulePath: path.join(root, 'dist', 'engine-host.js'),
    assets: () => bundledEngineAssets(root),
    idleMinutes: () => 0,
    log: () => undefined,
  });
  s.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
  return s;
}

describe('M2-A (engine level): confinement, watched files, quick passes, cold start', function () {
  this.timeout(600000);
  let engine: EngineService;
  let tmp = '';
  let projects: CorpusProject[] = [];

  before(async function () {
    if (!bundledEngineAssets(root)) {
      this.skip();
    }
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-m2a-'));
    engine = service();
    projects = await materializeCorpus(path.join(tmp, 'corpus'), docstripWith(engine));
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  it('confinement fixture: \\input{../../.ssh/id_rsa} gets nothing and a plain message; ../shared inside the folder works', async () => {
    // home/.ssh/id_rsa outside the workspace folder home/ws; the document is home/ws/paper/main.tex.
    const home = path.join(tmp, 'home');
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh', 'id_rsa'), `${SECRET}\n`);
    const ws = path.join(home, 'ws');
    mkdirSync(path.join(ws, 'paper'), { recursive: true });
    mkdirSync(path.join(ws, 'shared'), { recursive: true });
    writeFileSync(path.join(ws, 'shared', 'macros.tex'), '\\newcommand\\sharedphrase{text from the shared folder}\n');
    writeFileSync(
      path.join(ws, 'paper', 'main.tex'),
      [
        '\\documentclass{article}',
        '\\input{../shared/macros}',
        '\\begin{document}',
        'Before. \\sharedphrase.',
        '\\input{../../.ssh/id_rsa}',
        '\\input{/etc/passwd}',
        'After.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    const reads: string[] = [];
    const prepared = await prepareCompile({ fs: nodeFs(ws, reads), mainRel: 'paper/main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(
      prepared.confinement.map((d) => [d.file, d.line]),
      [['paper/main.tex', 5], ['paper/main.tex', 6]],
    );
    assert.match(prepared.confinement[0].message, /^Not read: "\.\.\/\.\.\/\.ssh\/id_rsa" is outside the project folder/);
    assert.ok(reads.every((r) => !r.startsWith('..') && !path.isAbsolute(r)), `read outside: ${reads.join(', ')}`);
    assert.deepEqual(prepared.job.files.map((f) => f.path).sort(), ['paper/main.tex', 'shared/macros.tex']);
    for (const f of prepared.job.files) {
      assert.ok(!new TextDecoder().decode(f.data).includes(SECRET));
    }
    const { result } = await engine.compile(prepared.job);
    // TeX itself stops at an \input it cannot find (nonstopmode cannot ask for another name), so this document
    // gives no PDF; the Problems panel says why. Nothing of the key reaches the engine or comes back.
    assert.match(result.log, /File `\.\.\/\.\.\/\.ssh\/id_rsa(\.tex)?' not found/);
    assert.ok(!result.log.includes(SECRET) && !result.transcript.includes(SECRET));
    assert.ok(!result.pdf || !Buffer.from(result.pdf).toString('latin1').includes(SECRET));
    const diagnostics = diagnosticsFor(result, prepared);
    assert.ok(diagnostics.some((d) => d.source === DISPLAY_NAME && d.line === 5 && /outside the project folder/.test(d.message)));
    assert.ok(!diagnostics.some((d) => /Undefined control sequence/.test(d.message)), 'the shared macro was not read');
    assert.deepEqual(result.stubs?.blocked, []);
    record('M2A-confinement', { refused: prepared.confinement.map((d) => d.message), files: prepared.job.files.map((f) => f.path) });
  });

  it('a compile reports the project files it read (TeX -recorder and the .bib files): what the extension watches', async () => {
    const p1 = projects.find((p) => p.id === 'P1') as CorpusProject;
    const prepared = await prepareCompile({ fs: nodeFs(p1.folder), mainRel: p1.main, engineSetting: 'pdflatex' });
    const { result } = await engine.compile(prepared.job);
    assert.deepEqual(result.readFiles, ['fig-response.pdf', 'paper.bib', 'paper.tex']);
    const t1 = projects.find((p) => p.id === 'T1');
    if (t1) {
      const t = await prepareCompile({ fs: nodeFs(t1.folder), mainRel: t1.main, engineSetting: 'pdflatex' });
      const r = (await engine.compile(t.job)).result;
      const files = r.readFiles ?? [];
      assert.ok(files.includes(t1.main) && files.some((f) => /\.bib$/.test(f)) && files.some((f) => /\.(pdf|png)$/.test(f)));
      // Files in the folder that the document does not use are not watched.
      assert.ok(files.length < t.job.files.length, 'every collected file was reported as read');
      record('M2A-readSet-T1', { read: files.length, collected: t.job.files.length });
    }
  });

  it('quick pass: one TeX pass on the carried state, no bibtex8; a new citation makes it ask for the full pass, which runs bibtex8', async () => {
    const p1 = projects.find((p) => p.id === 'P1') as CorpusProject;
    const fs = nodeFs(p1.folder);
    const full = await prepareCompile({ fs, mainRel: p1.main, engineSetting: 'pdflatex' });
    const r0 = (await engine.compile(full.job)).result;
    let state = nextState(r0, full);
    const text = readFileSync(path.join(p1.folder, p1.main), 'utf8');

    const quick = await prepareCompile({ fs, mainRel: p1.main, engineSetting: 'pdflatex', previous: state, pass: 'quick', overrides: new Map([[p1.main, new TextEncoder().encode(text.replace('resonance~', 'resonance (edited)~'))]]) });
    assert.deepEqual([quick.job.bibtex, quick.job.maxPasses], ['never', 1]);
    const r1 = (await engine.compile(quick.job)).result;
    assert.deepEqual([r1.passes, r1.bibtexRan, r1.bibtexNeeded], [1, false, false]);
    assert.ok(r1.pdf);
    assert.equal(r1.timings.warm, true, 'the quick pass did not get the standby worker');
    state = nextState(r1, quick);

    const withNewCitation = new TextEncoder().encode(text.replace('\\citep{knuth1984}', '\\citep{knuth1984,newkey2026}'));
    const q2 = await prepareCompile({ fs, mainRel: p1.main, engineSetting: 'pdflatex', previous: state, pass: 'quick', overrides: new Map([[p1.main, withNewCitation]]) });
    const r2 = (await engine.compile(q2.job)).result;
    assert.equal(r2.bibtexRan, false);
    assert.equal(r2.bibtexNeeded, true, 'a new citation did not ask for bibtex8');
    state = nextState(r2, q2);
    assert.equal(state.bibtexPending, true);
    const after = await prepareCompile({ fs, mainRel: p1.main, engineSetting: 'pdflatex', previous: state, overrides: new Map([[p1.main, withNewCitation]]) });
    assert.equal(after.job.bibChanged, true);
    const r3 = (await engine.compile(after.job)).result;
    assert.equal(r3.bibtexRan, true, 'the full pass after the quick one did not run bibtex8');
    assert.equal(nextState(r3, after).bibtexPending, false);
    record('M2A-quickPass-P1', { quickMs: r1.timings.totalMs, quickTexMs: r1.steps.reduce((n, s) => n + s.ms, 0), warm: r1.timings.warm });
  });

  it('the engine host starts on the first compile and stops after the idle period', async () => {
    const idle = new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => bundledEngineAssets(root),
      idleMinutes: () => 0.01, // 0.6 s
      log: () => undefined,
    });
    idle.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    try {
      assert.equal(idle.running, false, 'the engine host started before any compile');
      const folder = path.join(tmp, 'idle');
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'idle.tex'), '\\documentclass{article}\n\\begin{document}\nIdle.\n\\end{document}\n');
      const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'idle.tex', engineSetting: 'pdflatex' });
      const { result, engineStartMs } = await idle.compile(prepared.job);
      assert.ok(result.pdf && engineStartMs > 0);
      assert.equal(idle.running, true);
      const until = performance.now() + 10000;
      while (idle.running && performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(idle.running, false, 'the engine host did not stop when idle');
      const again = await idle.compile(prepared.job);
      assert.ok(again.result.pdf && again.engineStartMs > 0, 'the next compile did not start it again');
    } finally {
      await idle.stop();
    }
  });

  it('cold start: a fresh engine host to the first PDF in under 5 s', async () => {
    const cold = service();
    try {
      const folder = path.join(tmp, 'cold');
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'hello.tex'), '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n');
      const t0 = performance.now();
      const prepared = await prepareCompile({ fs: nodeFs(folder), mainRel: 'hello.tex', engineSetting: 'pdflatex' });
      const { result, engineStartMs, init } = await cold.compile(prepared.job);
      const toPdf = Math.round(performance.now() - t0);
      assert.ok(result.pdf);
      console.log(
        `      cold start: engine host and engine ${engineStartMs} ms (module ${init?.compileMs} ms, image ${init?.readImageMs} ms); ` +
          `first PDF ${toPdf} ms after the request (format load and one pass ${result.timings.totalMs} ms)`,
      );
      record('M2A-coldStart', { engineStartMs, toPdfMs: toPdf, compileMs: result.timings.totalMs, init });
      assert.ok(toPdf < 5000, `cold start took ${toPdf} ms`);
    } finally {
      await cold.stop();
    }
  });
});
