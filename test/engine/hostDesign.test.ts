// S1: the engine-host design of docs/DESIGN.md#architecture. One long-lived process holds the compiled module and the
// image; each compile runs in a worker_thread; cancel terminates that worker and the next compile starts a
// fresh one while the process, the module and the image stay. Host start and worker restart are measured apart.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { stubState } from '../support/helpers';
import { assetsRoot, engineAssetPaths, job, MAX_RSS_BYTES, record, sharedEngine, writeResults } from './support';

const text = (s: string) => new TextEncoder().encode(s);
const hello = '\\documentclass{article}\n\\begin{document}\nHello after a cancel.\n\\end{document}\n';

describe('S1 engine host: cancel, worker restart, host start', function () {
  this.timeout(600000);
  const beamer = path.join(assetsRoot, 'ctan-beamer-example', 'beamerexample-conference-talk.tex');

  before(function () {
    if (!engineAssetPaths() || !existsSync(beamer)) {
      this.skip();
    }
  });

  after(() => {
    console.log(`      results: ${writeResults()}`);
  });

  it('cancels a running compile within a second and compiles again in a fresh worker', async () => {
    const { host, startMs, info, ready } = await sharedEngine();
    const pidBefore = ready.pid;
    // A long compile: beamer's 31-slide example, three passes.
    const long = host.compile(
      job({
        main: 'talk.tex',
        files: [{ path: 'talk.tex', data: new Uint8Array(readFileSync(beamer)) }],
        engine: 'pdflatex',
        bibtex: 'never',
        maxPasses: 3,
        synctex: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // A cancel that names another job leaves the running compile alone (G1E-06).
    assert.equal(await host.cancel(-1), false);
    const t0 = performance.now();
    const cancelled = await host.cancel();
    const result = await long;
    const cancelMs = Math.round(performance.now() - t0);
    assert.equal(cancelled, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cancelled');
    assert.ok(cancelMs < 1000, `the cancel took ${cancelMs} ms`);

    const after = await host.compile(
      job({ main: 'hello.tex', files: [{ path: 'hello.tex', data: text(hello) }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: true }),
    );
    assert.ok(after.pdf, after.error);
    const restartMs = after.timings.workerBootMs + after.timings.instantiateMs + after.timings.mountMs;
    const memory = await host.memory();
    const report = await host.stubReport();
    assert.deepEqual(report?.blocked, []);
    assert.deepEqual(stubState().blocked, []);
    // Same engine-host process throughout: only the worker was replaced.
    assert.equal((await host.start()).pid, pidBefore);

    record('host-design', {
      runtime: { node: ready.node, electron: ready.electron },
      hostStartMs: startMs,
      init: info,
      cancelMs,
      afterCancel: after.timings,
      workerRestartMs: restartMs,
      rssMB: Math.round(memory.rss / 1048576),
      maxRssMB: Math.round(memory.maxRss / 1048576),
    });
    console.log(
      `      host start ${startMs} ms (module ${info.compileMs}, image ${info.readImageMs}, metadata ${info.metadataMs}); ` +
        `cancel ${cancelMs} ms; worker restart ${restartMs} ms (boot ${after.timings.workerBootMs}, instantiate ` +
        `${after.timings.instantiateMs}, mount ${after.timings.mountMs}); next compile ${after.timings.totalMs} ms; ` +
        `RSS ${Math.round(memory.rss / 1048576)} MB, peak ${Math.round(memory.maxRss / 1048576)} MB`,
    );
    assert.ok(memory.maxRss < MAX_RSS_BYTES, `peak memory ${Math.round(memory.maxRss / 1048576)} MB is over 1.5 GB`);
  });
});
