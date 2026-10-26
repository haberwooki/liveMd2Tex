// The engine host: one long-lived process per VS Code window, forked by the extension from
// src/extension/engineHostFork.ts (docs/DESIGN.md#architecture). It holds the TeX engine (S1): the compiled WebAssembly
// module and the image, loaded once on 'init', and runs each compile in a worker_thread. This process starts
// nothing and opens no connection: child_process, network modules, fetch and WebSocket are banned here by
// ESLint, and in tests the stubs are loaded into it (and inherited by its workers) with --require.

import * as path from 'node:path';

import {
  STUB_STATE_KEY,
  TINY_WASM_ADD,
  type FromEngine,
  type StubReport,
  type ToEngine,
} from '../shared/engineProtocol';
import { EngineCore, loadEngine } from './engine/core';

let core: EngineCore | null = null;
const workerFile = path.join(__dirname, 'engine-worker.js');

function send(msg: FromEngine): void {
  process.send?.(msg);
}

function stubReport(): StubReport | null {
  const state = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as
    | { report(): StubReport }
    | undefined;
  return state ? state.report() : null;
}

async function wasmCheck(): Promise<number> {
  const { instance } = await WebAssembly.instantiate(TINY_WASM_ADD);
  const add = instance.exports.add as (a: number, b: number) => number;
  return add(2, 3);
}

async function handle(msg: ToEngine): Promise<void> {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id: msg.id, payload: msg.payload });
      return;
    case 'wasmCheck':
      send({ type: 'wasmCheck', id: msg.id, result: await wasmCheck() });
      return;
    case 'stubReport':
      send({ type: 'stubReport', id: msg.id, report: stubReport() });
      return;
    case 'dropProject':
      send({ type: 'dropProject', id: msg.id, dropped: core?.dropProject(msg.key) ?? false });
      return;
    case 'init': {
      const engine = await loadEngine(msg.assets);
      core = new EngineCore(engine, workerFile);
      send({ type: 'init', id: msg.id, info: engine.info });
      return;
    }
    case 'compile': {
      if (!core) {
        throw new Error('The engine is not loaded; send init first.');
      }
      const result = await core.compile(msg.job);
      send({ type: 'compile', id: msg.id, result });
      return;
    }
    case 'cancel':
      send({ type: 'cancel', id: msg.id, cancelled: core?.cancel(msg.jobId) ?? false });
      return;
    case 'memory': {
      const usage = process.memoryUsage();
      send({
        type: 'memory',
        id: msg.id,
        memory: {
          rss: usage.rss,
          maxRss: process.resourceUsage().maxRSS * 1024,
          heapUsed: usage.heapUsed,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers,
        },
      });
      return;
    }
    case 'shutdown':
      core?.dispose();
      process.disconnect?.();
      process.exit(0);
  }
}

if (!process.send) {
  console.error('The engine host must be started by the extension, with an IPC channel.');
  process.exit(2);
}

process.on('message', (raw: unknown) => {
  const msg = raw as ToEngine;
  handle(msg).catch((err: unknown) => {
    const id = 'id' in msg ? msg.id : undefined;
    send({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  });
});

// Exit when the extension host goes away (docs/DESIGN.md#architecture: the child exits on disconnect).
process.on('disconnect', () => process.exit(0));

send({
  type: 'ready',
  pid: process.pid,
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  execPath: process.execPath,
});
