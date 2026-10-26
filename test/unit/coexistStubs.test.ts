// The stubs of the coexistence window (test/stubs/coexist.cjs; docs/DESIGN.md#testing): what they allow LaTeX
// Workshop is narrow. Run in a worker thread, which has its own stubs, against a stand-in LaTeX Workshop folder:
// its viewer's server file may listen on 127.0.0.1 (and the real lookup is put back afterwards); the same file
// on another address, any other file on the loopback address, a fork of its MathJax worker from anywhere but its
// workerpool, and the crossed pairs (its workerpool starting our engine host, our fork file starting its MathJax
// worker) stay blocked.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { root } from '../support/helpers';

const BLOCKED = 'ERR_LIVEMD2TEX_STUB_BLOCKED';

const LISTENER = `'use strict';
const net = require('node:net');
module.exports = (host) => net.createServer().listen(0, host);
`;

/** A stand-in for LaTeX Workshop's workerpool: it forks what it is given, from the allowed caller's file. */
const WORKERPOOL = `'use strict';
module.exports = (target) => require('node:child_process').fork(target);
`;

const PROBE = `'use strict';
const path = require('node:path');
const { once } = require('node:events');
const { workerData, parentPort } = require('node:worker_threads');
require(workerData.coexist).register(workerData.folder);
const state = globalThis[Symbol.for('livemd2tex.stubs')];
const viewerServer = require(path.join(workerData.folder, 'out', 'src', 'preview', 'server.js'));
const otherFile = require(workerData.other);
const code = (fn) => {
  try {
    fn();
    return 'ran';
  } catch (err) {
    return err.code ?? String(err);
  }
};
(async () => {
  const r = {};
  const server = viewerServer('127.0.0.1');
  await once(server, 'listening');
  r.loopback = server.address().address;
  await new Promise((resolve) => server.close(resolve));
  r.otherAddress = code(() => viewerServer('0.0.0.0'));
  r.otherFile = code(() => otherFile('127.0.0.1'));
  r.lookupAfterwards = code(() => require('node:dns').lookup('127.0.0.1', () => undefined));
  r.forkFromElsewhere = code(() => require('node:child_process').fork(path.join(workerData.folder, 'out', 'src', 'preview', 'mathjax', 'mathjax.js')));
  // Crossed pairs: its workerpool starting our engine host, and our fork file starting its MathJax worker.
  const workerpool = require(path.join(workerData.folder, 'node_modules', 'workerpool', 'src', 'WorkerHandler.js'));
  r.crossedFromWorkerpool = code(() => workerpool(path.join(workerData.root, 'dist', 'engine-host.js')));
  r.crossedFromForkFile = workerData.forkFile
    ? code(() => require(workerData.forkFile).forkEngineHost({ modulePath: path.join(workerData.folder, 'out', 'src', 'preview', 'mathjax', 'mathjax.js') }))
    : 'not built';
  r.allowedListens = state.allowedListens.map((l) => l.host);
  r.role = state.role;
  parentPort.postMessage(r);
})().catch((err) => parentPort.postMessage({ error: String(err) }));
`;

describe('the coexistence window\'s stubs (LaTeX Workshop beside ours)', () => {
  let tmp = '';
  after(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('let only its viewer\'s server file listen, only on 127.0.0.1; everything else stays blocked', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-coexist-'));
    const folder = path.join(tmp, 'james-yu.latex-workshop-10.19.0');
    mkdirSync(path.join(folder, 'out', 'src', 'preview', 'mathjax'), { recursive: true });
    writeFileSync(path.join(folder, 'out', 'src', 'preview', 'server.js'), LISTENER);
    writeFileSync(path.join(folder, 'out', 'src', 'preview', 'mathjax', 'mathjax.js'), '');
    mkdirSync(path.join(folder, 'node_modules', 'workerpool', 'src'), { recursive: true });
    writeFileSync(path.join(folder, 'node_modules', 'workerpool', 'src', 'WorkerHandler.js'), WORKERPOOL);
    const other = path.join(tmp, 'other-listener.js');
    writeFileSync(other, LISTENER);
    const probe = path.join(tmp, 'probe.cjs');
    writeFileSync(probe, PROBE);
    const forkFile = path.join(root, 'dist', 'fork.js');
    const worker = new Worker(probe, {
      workerData: { coexist: path.join(root, 'test', 'stubs', 'coexist.cjs'), folder, other, root, forkFile: existsSync(forkFile) ? forkFile : '' },
    });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await worker.terminate();
    assert.deepEqual(result, {
      loopback: '127.0.0.1',
      otherAddress: BLOCKED,
      otherFile: BLOCKED,
      lookupAfterwards: BLOCKED,
      forkFromElsewhere: BLOCKED,
      crossedFromWorkerpool: BLOCKED,
      crossedFromForkFile: existsSync(path.join(root, 'dist', 'fork.js')) ? BLOCKED : 'not built',
      allowedListens: ['127.0.0.1'],
      role: 'extension-host',
    });
  });
});
