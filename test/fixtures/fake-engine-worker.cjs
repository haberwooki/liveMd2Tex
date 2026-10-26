'use strict';
// A stand-in for the engine's compile worker (src/engine-host/engine/worker.ts), for test/unit/engineCore.test.ts:
// it answers a job at once with the names of the files it received, except a job whose main file is "hang.tex",
// which it never answers (a compile that is still running when the next one comes).

const { parentPort } = require('node:worker_threads');

parentPort.once('message', ({ job }) => {
  if (job.main === 'hang.tex') {
    setInterval(() => undefined, 1000);
    return;
  }
  parentPort.postMessage({
    id: job.id,
    ok: true,
    pdf: null,
    synctex: null,
    log: `files: ${job.files.map((f) => f.path).join(', ')}`,
    blg: null,
    transcript: '',
    steps: [],
    state: [],
    passes: 1,
    bibtexRan: false,
    timings: { workerBootMs: 0, instantiateMs: 0, mountMs: 0, runMs: 0, totalMs: 0 },
    stubs: null,
  });
});
