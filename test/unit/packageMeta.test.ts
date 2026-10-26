// The file_packager loader is read as data, never run (src/engine-host/engine/packageMeta.ts).

import * as assert from 'node:assert/strict';
import { buildImageIndex, readPackageMetadata } from '../../src/engine-host/engine/packageMeta';

const loader = [
  '// \\ProvidesPackage{x} comments with braces { and } and "quotes"',
  'var Module = typeof Module != "undefined" ? Module : {};',
  '(function() {',
  '  var compressedData = {"data":null,"cachedOffset":40,"cachedIndexes":[-1,-1],"cachedChunks":[null,null],"offsets":[0,10,25],"sizes":[10,15,15],"successes":[1,1,0]};',
  '  function loadPackage(metadata) { /* the real loader would run here; it never does */ }',
  '  loadPackage({ \'metadata\': metadata, \'compressedData\': compressedData }, false);',
  '  loadPackage({"files": [{"filename": "/texlive/a.sty", "start": 0, "end": 12}, {"filename": "/texlive/dir/b {x}.tex", "start": 12, "end": 30}], "remote_package_size": 4136, "package_uuid": "sha256-abc"});',
  '})();',
].join('\n');

describe('file_packager metadata (read as data)', () => {
  it('reads the chunk table and the file list without running the loader', () => {
    const { metadata, compressed } = readPackageMetadata(loader);
    assert.equal(metadata.files.length, 2);
    assert.deepEqual(metadata.files[1], { filename: '/texlive/dir/b {x}.tex', start: 12, end: 30 });
    assert.equal(metadata.remote_package_size, 4136);
    assert.deepEqual(compressed.offsets, [0, 10, 25]);
    assert.equal(compressed.cachedOffset, 40);
  });

  it('builds a compact index on shared memory', () => {
    const { metadata, compressed } = readPackageMetadata(loader);
    const index = buildImageIndex(metadata, compressed);
    assert.equal(index.names, '/texlive/a.sty\n/texlive/dir/b {x}.tex');
    assert.ok(index.starts.buffer instanceof SharedArrayBuffer);
    assert.deepEqual([...index.ends], [12, 30]);
    assert.deepEqual([...index.chunkCompressed], [1, 1, 0]);
    assert.equal(index.cacheSlots, 2);
  });

  it('refuses a script that is not a file_packager loader', () => {
    assert.throws(() => readPackageMetadata('var x = 1;'), /markers not found/);
  });
});
