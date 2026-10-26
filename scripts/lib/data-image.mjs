// The image of a data set (build gate 2, G2E-02; B1; docs/DESIGN.md#store-and-packaging, #engine-and-data): a few
// large files, not a tree of thousands. The layout is Emscripten's file_packager LZ4 package, the same as TeXlyre's
// texlive-extra image that S1 loads unchanged: one byte blob (`.data`), and an index (`.index.json`, the JSON that
// scripts/stage-engine.mjs extracts from TeXlyre's loader) with the file list and the chunk table. The engine host
// reads both with fs and mounts the image in each compile worker with the same code as the core image
// (src/engine-host/engine/worker.ts, mountImage): a data extension's under /texmf-extra, which kpathsea searches
// after the user's package folder and before the core; the core's at the root of the worker's file system.
//
// The file contents are one stream cut into 2,048-byte chunks. Each chunk is stored as one LZ4 block when that is
// smaller (successes 1), raw otherwise (successes 0); without `compress` every chunk is raw (the test stand-in).
// File names: a data extension's are texmf-relative TDS paths (/tex/latex/revtex/revtex4-2.cls), the core's are
// absolute in the worker's file system (/texlive/texmf-dist/tex/latex/base/article.cls).

import { createHash } from 'node:crypto';
import { lz4Compress } from './lz4.mjs';

export const CHUNK_SIZE = 2048;

const SAFE = /^(?:[A-Za-z0-9][A-Za-z0-9._+-]*\/)*[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** A name the index can hold: no empty, "." or ".." segment, and no newline, NUL or backslash. */
function plainPath(rel, strict) {
  if (strict) {
    return SAFE.test(rel) && !rel.split('/').some((s) => s === '..' || s === '.');
  }
  return rel !== '' && !/[\0\n\\]/.test(rel) && !rel.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/**
 * Builds an image from files.
 * @param {Iterable<[string, Uint8Array]>} files path (without the leading "/") -> bytes
 * @param {{ compress?: boolean, strictNames?: boolean }} [options] compress: LZ4 chunks; strictNames: only the
 *   plain TDS characters (the default, for data extensions)
 * @returns {{ data: Buffer, index: { compressed: object, metadata: object }, sha256: string, bytes: number }}
 */
export function buildDataImage(files, options = {}) {
  const strict = options.strictNames ?? true;
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const list = [];
  let total = 0;
  for (const [rel, bytes] of entries) {
    if (!plainPath(rel, strict)) {
      throw new Error(`not a plain texmf path: ${rel}`);
    }
    list.push({ filename: `/${rel}`, start: total, end: total + bytes.length });
    total += bytes.length;
  }
  const stream = Buffer.concat(entries.map(([, bytes]) => Buffer.from(bytes)));
  const chunks = Math.ceil(total / CHUNK_SIZE);
  const parts = [];
  const offsets = [];
  const sizes = [];
  const successes = [];
  let at = 0;
  for (let k = 0; k < chunks; k++) {
    const raw = stream.subarray(k * CHUNK_SIZE, Math.min(total, (k + 1) * CHUNK_SIZE));
    const packed = options.compress ? lz4Compress(raw) : null;
    const use = packed && packed.length < raw.length ? packed : raw;
    offsets.push(at);
    sizes.push(use.length);
    successes.push(use === raw ? 0 : 1);
    parts.push(use);
    at += use.length;
  }
  const data = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.length)));
  const sha256 = createHash('sha256').update(data).digest('hex');
  return {
    data,
    sha256,
    bytes: data.length,
    index: {
      compressed: { data: null, cachedOffset: data.length, cachedIndexes: [-1, -1], cachedChunks: [null, null], offsets, sizes, successes },
      metadata: { files: list, remote_package_size: data.length, package_uuid: sha256 },
    },
  };
}
