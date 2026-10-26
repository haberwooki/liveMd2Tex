// The engine host's compile core (src/engine-host/engine/core.ts) with a stand-in worker
// (test/fixtures/fake-engine-worker.cjs), so the rules can be checked without the engine:
// - G1E-01 (re-gate G1B-S-05): when a compile is cancelled by the next one, the next job is posted to its worker
//   only after the old worker has exited. Without that rule the order below would be "post, post, exited".
// - G1BE-03: kept project files are bounded by bytes, and a dropped project gets "need-full" at its next compile.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EngineCore, type LoadedEngine } from '../../src/engine-host/engine/core';
import type { CompileJob } from '../../src/shared/engineJobs';
import { root } from '../support/helpers';

const fakeWorker = path.join(root, 'test', 'fixtures', 'fake-engine-worker.cjs');
const fakeEngine = { setup: {} } as unknown as LoadedEngine;
const tick = () => new Promise((resolve) => setImmediate(resolve));

let nextId = 1;
const job = (main: string, files: [string, number][] = [], project?: CompileJob['project']): CompileJob => ({
  id: nextId++,
  main,
  files: files.map(([p, size]) => ({ path: p, data: new Uint8Array(size) })),
  engine: 'pdflatex',
  bibtex: 'never',
  maxPasses: 1,
  synctex: false,
  project,
});

describe('engine core with a stand-in worker', () => {
  const originalPost = Worker.prototype.postMessage;
  const originalTerminate = Worker.prototype.terminate;
  let events: string[] = [];

  beforeEach(() => {
    events = [];
    Worker.prototype.postMessage = function (this: Worker, message: { job?: CompileJob }, ...rest: unknown[]) {
      events.push(`post ${message.job?.main}`);
      return (originalPost as (...a: unknown[]) => void).call(this, message, ...rest);
    } as typeof Worker.prototype.postMessage;
    Worker.prototype.terminate = function (this: Worker) {
      return originalTerminate.call(this).then((code) => {
        events.push('exited');
        return code;
      });
    };
  });

  afterEach(() => {
    Worker.prototype.postMessage = originalPost;
    Worker.prototype.terminate = originalTerminate;
  });

  it('G1E-01: the next job reaches its worker only after the cancelled worker has exited', async () => {
    const core = new EngineCore(fakeEngine, fakeWorker, false);
    const first = core.compile(job('hang.tex'));
    await tick();
    const second = core.compile(job('main.tex'));
    assert.equal((await first).error, 'cancelled');
    assert.ok((await second).ok);
    assert.deepEqual(events.slice(0, 3), ['post hang.tex', 'exited', 'post main.tex']);
    core.dispose();
  });

  it('G1BE-03: kept project files are bounded by bytes; a dropped project is asked for all its files again', async () => {
    const core = new EngineCore(fakeEngine, fakeWorker, false, 1000);
    const a = await core.compile(job('a.tex', [['a.tex', 600]], { key: 'A', base: null, version: 1, removed: [] }));
    assert.ok(a.ok);
    const b = await core.compile(job('b.tex', [['b.tex', 600]], { key: 'B', base: null, version: 1, removed: [] }));
    assert.ok(b.ok);
    assert.deepEqual(core.keptProjects(), ['B'], 'project A was kept past the byte limit');
    const again = await core.compile(job('a.tex', [], { key: 'A', base: 1, version: 2, removed: [] }));
    assert.equal(again.error, 'need-full');
    assert.equal(core.dropProject('B'), true);
    assert.deepEqual(core.keptProjects(), []);
    core.dispose();
  });
});
