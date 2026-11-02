// An image's index (Emscripten's file_packager metadata as JSON) becomes the compact index workers share
// (src/engine-host/engine/packageMeta.ts).

import * as assert from 'node:assert/strict';
import { buildImageIndex, type CompressedTable, type PackageMetadata } from '../../src/engine-host/engine/packageMeta';

const metadata: PackageMetadata = {
  files: [
    { filename: '/texlive/a.sty', start: 0, end: 12 },
    { filename: '/texlive/dir/b {x}.tex', start: 12, end: 30 },
  ],
  remote_package_size: 4136,
  package_uuid: 'sha256-abc',
} as PackageMetadata;
const compressed = { data: null, cachedOffset: 40, cachedIndexes: [-1, -1], cachedChunks: [null, null], offsets: [0, 10, 25], sizes: [10, 15, 15], successes: [1, 1, 0] } as unknown as CompressedTable;

describe('file_packager metadata (an image index)', () => {
  it('builds a compact index on shared memory', () => {
    const index = buildImageIndex(metadata, compressed);
    assert.equal(index.names, '/texlive/a.sty\n/texlive/dir/b {x}.tex');
    assert.ok(index.starts.buffer instanceof SharedArrayBuffer);
    assert.deepEqual([...index.ends], [12, 30]);
    assert.deepEqual([...index.chunkCompressed], [1, 1, 0]);
    assert.equal(index.cacheSlots, 2);
  });
});
