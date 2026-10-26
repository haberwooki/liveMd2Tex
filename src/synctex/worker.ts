// The SyncTeX worker (a worker_threads thread of the extension host, bundled as dist/synctex-worker.js): it
// keeps the parsed .synctex of each preview's last compile and answers inverse and forward queries, so that
// reading a large .synctex file never blocks the extension host's main thread (docs/DESIGN.md#engine-and-data).

import { parentPort } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { forwardSearch, inverseSearch, parseSyncTex, projectRelative, tagOf, type SyncIndex } from './parser';
import type { SyncRequest, SyncResponse, SyncResult } from './protocol';

const indexes = new Map<string, SyncIndex>();

function handle(msg: SyncRequest): SyncResult {
  switch (msg.type) {
    case 'load': {
      const bytes = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
      const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');
      const index = parseSyncTex(text);
      indexes.set(msg.key, index);
      const files = [...index.inputs.values()].map(projectRelative).filter((f): f is string => f !== undefined);
      return { pages: index.pages.length - 1, files };
    }
    case 'inverse': {
      const index = indexes.get(msg.key);
      const hit = index ? inverseSearch(index, msg.page, msg.x, msg.y) : null;
      return hit ? { file: projectRelative(hit.file) ?? null, line: hit.line } : null;
    }
    case 'forward': {
      const index = indexes.get(msg.key);
      const tag = index ? tagOf(index, msg.file) : undefined;
      return index && tag !== undefined ? forwardSearch(index, tag, msg.line) : null;
    }
    case 'drop':
      indexes.delete(msg.key);
      return null;
  }
}

parentPort?.on('message', (msg: SyncRequest) => {
  let response: SyncResponse;
  try {
    response = { id: msg.id, ok: true, result: handle(msg) };
  } catch (err) {
    response = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort?.postMessage(response);
});
