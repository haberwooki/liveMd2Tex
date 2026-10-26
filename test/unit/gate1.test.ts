// Build gate 1 (agent A's MUST findings), the parts that need no engine: a failed engine load starts one process
// and fails quietly after that (G1E-02); only changed files cross to the engine host, with a full resend when
// the host lacks the base (G1E-03); the read cache reads a file again only after a change (G1E-03); and a link
// inside the project folder that leads outside it is refused, with a plain message on the referencing line
// (G1S-02, with a Windows junction as the fixture).

import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareCompile } from '../../src/extension/compile/pipeline';
import { EngineService, EngineUnavailableError, type EngineHostLike } from '../../src/extension/engine/engineService';
import { FileCache, type ProjectFs } from '../../src/extension/project/collect';
import type { CompileJob, CompileResult, EngineAssetPaths } from '../../src/shared/engineJobs';
import { pdfProblem } from '../../src/shared/pdfCheck';
import { nodeFs } from '../support/nodeFs';

const ASSETS: EngineAssetPaths = { glue: 'g', wasm: 'w', data: 'd', loader: 'l', cnfOverride: 'c', fontsConf: 'f' };

const okResult = (job: CompileJob, error?: string): CompileResult => ({
  id: job.id,
  ok: !error,
  error,
  pdf: error ? null : new Uint8Array([37, 80, 68, 70]),
  synctex: null,
  log: '',
  blg: null,
  state: [],
  passes: 1,
  bibtexRan: false,
  transcript: '',
  steps: [],
  timings: { workerBootMs: 0, instantiateMs: 0, mountMs: 0, runMs: 0, totalMs: 0 },
  stubs: null,
});

/** A fake engine host: counts what is made, started, stopped and sent. */
function fakeHosts(behaviour: { initFails?: boolean; needFullOnce?: boolean } = {}) {
  const made: { started: number; stopped: number; jobs: CompileJob[] }[] = [];
  let needFull = behaviour.needFullOnce === true;
  const createHost = (): EngineHostLike => {
    const record = { started: 0, stopped: 0, jobs: [] as CompileJob[] };
    made.push(record);
    let running = false;
    return {
      get running() {
        return running;
      },
      async start() {
        record.started++;
        running = true;
      },
      async init() {
        if (behaviour.initFails) {
          throw new Error('image is 1 bytes, its metadata says 2');
        }
        return { compileMs: 1, readImageMs: 1, metadataMs: 1, imageBytes: 2, files: 1 };
      },
      async compile(job) {
        record.jobs.push(job);
        if (needFull && job.project?.base !== null) {
          needFull = false;
          return okResult(job, 'need-full');
        }
        return okResult(job);
      },
      async cancel() {
        return false;
      },
      async memory() {
        return { rss: 0, maxRss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
      },
      async stop() {
        record.stopped++;
        running = false;
      },
    };
  };
  return { made, createHost };
}

const job = (files: [string, string][], id = 1): CompileJob => ({
  id,
  main: 'main.tex',
  files: files.map(([p, t]) => ({ path: p, data: new TextEncoder().encode(t) })),
  engine: 'pdflatex',
  bibtex: 'auto',
  maxPasses: 1,
  synctex: false,
});

describe('gate 1, G1E-02: a failed engine load', () => {
  it('stops the process it started, forks no other on later compiles, and reports the cause once', async () => {
    const { made, createHost } = fakeHosts({ initFails: true });
    const service = new EngineService({ modulePath: 'x', assets: () => ASSETS, idleMinutes: () => 0, log: () => undefined, createHost });
    const errors: EngineUnavailableError[] = [];
    for (let i = 0; i < 3; i++) {
      await service.compile(job([['main.tex', 'x']])).catch((e: EngineUnavailableError) => errors.push(e));
    }
    assert.equal(made.length, 1, 'more than one engine host was forked');
    assert.equal(made[0].stopped, 1, 'the failed host was not stopped');
    assert.deepEqual(errors.map((e) => [e.name, e.firstTime]), [['EngineUnavailableError', true], ['EngineUnavailableError', false], ['EngineUnavailableError', false]]);
    assert.match(errors[0].message, /could not be loaded: image is 1 bytes/);
    assert.match(errors[0].message, /Run "Compile this document now" to try again/);
    // The compile command asks for a new try.
    service.retry();
    await service.compile(job([['main.tex', 'x']])).catch(() => undefined);
    assert.equal(made.length, 2);
  });

  it('missing engine files fork nothing and are reported once', async () => {
    const { made, createHost } = fakeHosts();
    const service = new EngineService({ modulePath: 'x', assets: () => null, idleMinutes: () => 0, log: () => undefined, createHost });
    const first = await service.compile(job([])).catch((e: EngineUnavailableError) => e);
    const second = await service.compile(job([])).catch((e: EngineUnavailableError) => e);
    assert.equal(made.length, 0);
    assert.deepEqual([(first as EngineUnavailableError).firstTime, (second as EngineUnavailableError).firstTime], [true, false]);
  });
});

describe('gate 1, G1E-03: only changed files cross to the engine host', () => {
  it('sends the whole project once, then only what changed and what was removed', async () => {
    const { made, createHost } = fakeHosts();
    const service = new EngineService({ modulePath: 'x', assets: () => ASSETS, idleMinutes: () => 0, log: () => undefined, createHost });
    const big = 'x'.repeat(100000);
    await service.compile(job([['main.tex', 'v1'], ['fig.pdf', big], ['old.tex', 'o']]), 'doc');
    await service.compile(job([['main.tex', 'v2'], ['fig.pdf', big]]), 'doc');
    const [first, second] = made[0].jobs;
    assert.deepEqual(first.project, { key: 'doc', base: null, version: 1, removed: [] });
    assert.equal(first.files.length, 3);
    assert.deepEqual(second.project, { key: 'doc', base: 1, version: 2, removed: ['old.tex'] });
    assert.deepEqual(second.files.map((f) => f.path), ['main.tex']);
    assert.deepEqual(service.lastTransfer, { project: 'doc', changed: 1, removed: 1, full: false, bytes: 2 });
  });

  it('forget(): the service drops its copy and asks the engine host to drop its own (re-gate G1BE-03)', async () => {
    const { made, createHost } = fakeHosts();
    const dropped: string[] = [];
    const service = new EngineService({
      modulePath: 'x',
      assets: () => ASSETS,
      idleMinutes: () => 0,
      log: () => undefined,
      createHost: () => Object.assign(createHost(), { dropProject: async (key: string) => dropped.push(key) > 0 }),
    });
    await service.compile(job([['main.tex', 'v1']]), 'doc');
    service.forget('doc');
    await service.compile(job([['main.tex', 'v1']]), 'doc');
    assert.deepEqual(dropped, ['doc']);
    assert.deepEqual(made[0].jobs[1].project, { key: 'doc', base: null, version: 1, removed: [] });
    assert.equal(service.lastTransfer?.full, true);
  });

  it('resends everything when the engine host lacks the base', async () => {
    const { made, createHost } = fakeHosts({ needFullOnce: true });
    const service = new EngineService({ modulePath: 'x', assets: () => ASSETS, idleMinutes: () => 0, log: () => undefined, createHost });
    await service.compile(job([['main.tex', 'v1'], ['b.tex', 'b']]), 'doc');
    const { result } = await service.compile(job([['main.tex', 'v2'], ['b.tex', 'b']]), 'doc');
    assert.equal(result.ok, true);
    const jobs = made[0].jobs;
    assert.equal(jobs.length, 3);
    assert.deepEqual(jobs[2].project?.base, null);
    assert.equal(jobs[2].files.length, 2);
  });

  it('the read cache reads a file again only after a watcher reports a change', async () => {
    const reads: string[] = [];
    const fs: ProjectFs = {
      readDirectory: async (rel) => (rel === '' ? [['main.tex', 'file'], ['fig.png', 'file']] : []),
      readFile: async (rel) => {
        reads.push(rel);
        return new TextEncoder().encode(rel);
      },
    };
    const cache = new FileCache();
    const cached = cache.wrap(fs);
    await prepareCompile({ fs: cached, mainRel: 'main.tex', engineSetting: 'pdflatex' });
    await prepareCompile({ fs: cached, mainRel: 'main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(reads.sort(), ['fig.png', 'main.tex']);
    cache.invalidate('fig.png');
    await prepareCompile({ fs: cached, mainRel: 'main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(reads.sort(), ['fig.png', 'fig.png', 'main.tex']);
  });

  it('unsaved editors of files that are not TeX inputs stay out of the compile', async () => {
    const fs: ProjectFs = { readDirectory: async () => [['main.tex', 'file']], readFile: async () => new TextEncoder().encode('x') };
    const prepared = await prepareCompile({
      fs,
      mainRel: 'main.tex',
      engineSetting: 'pdflatex',
      overrides: new Map([['notes.md', new Uint8Array([1])], ['new.tex', new Uint8Array([2])]]),
    });
    assert.deepEqual(prepared.job.files.map((f) => f.path).sort(), ['main.tex', 'new.tex']);
  });
});

describe('gate 1, G1S-02: links inside the project folder that lead outside it', () => {
  let tmp = '';
  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-links-'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('a folder junction: \\input{linkdir/key} reads nothing outside and says so on its line', async () => {
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'key.tex'), 'SECRET-VIA-JUNCTION\n');
    const project = path.join(tmp, 'project');
    mkdirSync(project);
    writeFileSync(path.join(project, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{linkdir/key}\n\\end{document}\n');
    // A junction needs no privilege on Windows; elsewhere this is a directory symbolic link.
    symlinkSync(outside, path.join(project, 'linkdir'), 'junction');
    const prepared = await prepareCompile({ fs: nodeFs(project), mainRel: 'main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(prepared.job.files.map((f) => f.path), ['main.tex']);
    for (const f of prepared.job.files) {
      assert.ok(!new TextDecoder().decode(f.data).includes('SECRET'));
    }
    assert.deepEqual(prepared.confinement.map((d) => [d.file, d.line]), [['main.tex', 3]]);
    assert.match(prepared.confinement[0].message, /^Not read: "linkdir\/key" is reached through a link that leads outside the project folder/);
  });

  it('a file symbolic link (where the system allows making one) is refused the same way', async function () {
    const outside = path.join(tmp, 'outside2');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.tex'), 'SECRET-VIA-FILE-LINK\n');
    const project = path.join(tmp, 'project2');
    mkdirSync(project);
    writeFileSync(path.join(project, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{notes}\n\\end{document}\n');
    try {
      symlinkSync(path.join(outside, 'secret.tex'), path.join(project, 'notes.tex'), 'file');
    } catch {
      // Windows without Developer Mode cannot make file links; CI on Linux and macOS runs this case.
      this.skip();
    }
    const prepared = await prepareCompile({ fs: nodeFs(project), mainRel: 'main.tex', engineSetting: 'pdflatex' });
    assert.deepEqual(prepared.job.files.map((f) => f.path), ['main.tex']);
    assert.equal(prepared.confinement.length, 1);
  });
});

describe('gate 1, G1E-06: the backend interface and a cancel bound to its job', () => {
  it('cancels only the job in flight, by its id; a cancel for another job sends nothing', async () => {
    const cancels: (number | undefined)[] = [];
    let release: ((r: CompileResult) => void) | undefined;
    const host: EngineHostLike = {
      running: true,
      async start() {},
      async init() {
        return { compileMs: 1, readImageMs: 1, metadataMs: 1, imageBytes: 2, files: 1 };
      },
      compile(j) {
        return new Promise<CompileResult>((resolve) => (release = () => resolve(okResult(j, 'cancelled'))));
      },
      async cancel(jobId) {
        cancels.push(jobId);
        release?.(okResult(job([]), 'cancelled'));
        return true;
      },
      async memory() {
        return { rss: 0, maxRss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
      },
      async stop() {},
    };
    const service = new EngineService({ modulePath: 'x', assets: () => ASSETS, idleMinutes: () => 0, log: () => undefined, createHost: () => host });
    await service.cancel();
    assert.deepEqual(cancels, [], 'a cancel with nothing in flight reached the engine host');
    const running = service.compile(job([['main.tex', 'x']], 41));
    while (!release) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await service.cancel(40);
    assert.deepEqual(cancels, [], 'a cancel for another job reached the engine host');
    await service.cancel();
    assert.deepEqual(cancels, [41]);
    assert.equal((await running).result.error, 'cancelled');
    assert.deepEqual(service.capabilities().engines, ['pdflatex', 'xelatex']);
    assert.deepEqual(service.canCompile({ engine: 'pdflatex', main: 'main.tex' }), { ok: true });
    const none = new EngineService({ modulePath: 'x', assets: () => null, idleMinutes: () => 0, log: () => undefined, createHost: () => host });
    assert.deepEqual(none.canCompile({ engine: 'pdflatex', main: 'main.tex' }), { ok: false, reason: 'The TeX engine files are not part of this copy of the extension.' });
  });
});

describe('gate 1: a PDF cut short is recognised', () => {
  it('a whole PDF passes; one cut anywhere, or of a few bytes, does not', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText('Whole.');
    for (const useObjectStreams of [true, false]) {
      const whole = await doc.save({ useObjectStreams });
      assert.equal(pdfProblem(whole), null, `useObjectStreams ${useObjectStreams}`);
      for (const cut of [15, 782, Math.floor(whole.length / 2), whole.length - 8]) {
        assert.notEqual(pdfProblem(whole.slice(0, cut)), null, `cut at ${cut} of ${whole.length}`);
      }
    }
    assert.match(pdfProblem(new TextEncoder().encode('%PDF-1.5\n%')) ?? '', /only 10 bytes/);
  });
});

describe('re-gate G1BE-01 and G1BE-02: the read cache never serves a stale saved file', () => {
  /** A folder whose files change "on disk" without any watcher event. */
  function disk(files: Record<string, string>) {
    const reads: string[] = [];
    let clock = 1000;
    const stamps = new Map(Object.keys(files).map((k) => [k, clock]));
    const fs: ProjectFs = {
      readDirectory: async (rel) => (rel === '' ? Object.keys(files).map((n) => [n, 'file'] as [string, 'file']) : []),
      readFile: async (rel) => {
        reads.push(rel);
        return new TextEncoder().encode(files[rel]);
      },
      stat: async (rel) => ({ size: files[rel].length, mtime: stamps.get(rel) ?? 0 }),
    };
    const write = (rel: string, text: string) => {
      files[rel] = text;
      stamps.set(rel, ++clock);
    };
    return { fs, reads, write };
  }

  it('a file open in an editor is read from disk every time: two quick saves, no watcher event, the second text wins', async () => {
    const { fs, write } = disk({ 'main.tex': '\\documentclass{article}\\begin{document}SAVE-ONE\\end{document}' });
    const cache = new FileCache();
    const open = new Set(['main.tex']);
    const first = await prepareCompile({ fs: cache.wrap(fs, { open }), mainRel: 'main.tex', engineSetting: 'pdflatex' });
    assert.match(new TextDecoder().decode(first.job.files[0].data), /SAVE-ONE/);
    write('main.tex', '\\documentclass{article}\\begin{document}SAVE-TWO\\end{document}');
    const second = await prepareCompile({ fs: cache.wrap(fs, { open }), mainRel: 'main.tex', engineSetting: 'pdflatex', pass: 'quick' });
    assert.match(new TextDecoder().decode(second.job.files[0].data), /SAVE-TWO/);
    // Without the rule, the same cache answers with the text it holds, whatever the disk now says.
    write('main.tex', '\\documentclass{article}\\begin{document}SAVE-THREE\\end{document}');
    const stale = await prepareCompile({ fs: cache.wrap(fs), mainRel: 'main.tex', engineSetting: 'pdflatex', pass: 'quick' });
    assert.match(new TextDecoder().decode(stale.job.files[0].data), /SAVE-TWO/);
  });

  it('a full pass checks size and time, so a change no watcher reported is read; a quick pass trusts the cache', async () => {
    const { fs, reads, write } = disk({ 'main.tex': 'main', 'refs.bib': '@book{a,}' });
    const cache = new FileCache();
    await cache.wrap(fs).readFile('refs.bib');
    write('refs.bib', '@book{a,}\n@book{b,}');
    assert.equal(new TextDecoder().decode(await cache.wrap(fs).readFile('refs.bib')), '@book{a,}', 'a quick pass read the disk');
    assert.equal(new TextDecoder().decode(await cache.wrap(fs, { verify: true }).readFile('refs.bib')), '@book{a,}\n@book{b,}');
    const before = reads.length;
    await cache.wrap(fs, { verify: true }).readFile('refs.bib');
    assert.equal(reads.length, before, 'an unchanged file was read again on a full pass');
  });
});
