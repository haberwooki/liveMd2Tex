// The data image of a data extension (scripts/lib/data-image.mjs; build gate 2, G2E-02): the layout of the core
// image, read back by the same readers the build and the engine host use.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildImageIndex, type CompressedTable, type PackageMetadata } from '../../src/engine-host/engine/packageMeta';
import { importScript } from '../support/helpers';

interface DataImage {
  buildDataImage(files: Iterable<[string, Uint8Array]>): { data: Buffer; sha256: string; index: { compressed: CompressedTable; metadata: PackageMetadata } };
}
interface ImageFiles {
  openImage(dataPath: string, compressed: CompressedTable): { read(start: number, end: number): Buffer };
}

describe('build gate 2, G2E-02: a data extension is one image in the core image\'s layout', () => {
  it('holds every file whole, across chunk boundaries, and the engine host\'s index reads it', async () => {
    const { buildDataImage } = await importScript<DataImage>('scripts/lib/data-image.mjs');
    const { openImage } = await importScript<ImageFiles>('scripts/lib/image-files.mjs');
    const big = Buffer.alloc(5000, 0x41);
    big.write('MIDDLE', 2500);
    const files = new Map<string, Uint8Array>([
      ['tex/latex/demo/demo.sty', new TextEncoder().encode('\\ProvidesPackage{demo}\n')],
      ['tex/latex/demo/demo-big.def', big],
      ['bibtex/bst/demo/demo.bst', new TextEncoder().encode('ENTRY {} {} {}\n')],
    ]);
    const image = buildDataImage(files);
    assert.equal(image.index.metadata.remote_package_size, image.data.length);
    assert.ok(image.index.compressed.successes.every((s) => s === 0), 'chunks are stored, not compressed');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-image-'));
    try {
      const dataPath = path.join(tmp, 'extra.data');
      writeFileSync(dataPath, image.data);
      const reader = openImage(dataPath, image.index.compressed);
      for (const f of image.index.metadata.files) {
        const original = files.get(f.filename.slice(1)) as Uint8Array;
        assert.ok(Buffer.from(original).equals(reader.read(f.start, f.end)), f.filename);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const index = buildImageIndex(image.index.metadata, image.index.compressed);
    assert.deepEqual(index.names.split('\n'), ['/bibtex/bst/demo/demo.bst', '/tex/latex/demo/demo-big.def', '/tex/latex/demo/demo.sty']);
    assert.equal(index.cacheSlots, 2);
  });

  it('B1: compresses chunks with LZ4 where that is smaller, and the image reader gives every file back', async () => {
    const { buildDataImage } = await importScript<{ buildDataImage(files: Iterable<[string, Uint8Array]>, o?: { compress?: boolean; strictNames?: boolean }): ReturnType<DataImage['buildDataImage']> & { bytes: number } }>('scripts/lib/data-image.mjs');
    const { openImage, lz4Block } = await importScript<ImageFiles & { lz4Block(input: Uint8Array, output: Uint8Array): number }>('scripts/lib/image-files.mjs');
    const { lz4Compress } = await importScript<{ lz4Compress(src: Uint8Array): Uint8Array }>('scripts/lib/lz4.mjs');
    // The compressor alone: short, long literal runs, long matches, nothing to match.
    let x = 1;
    const random = (n: number) => Uint8Array.from({ length: n }, () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24);
    const text = new TextEncoder().encode('\\usepackage{amsmath}\n'.repeat(60) + 'unique tail of the file');
    // (A chunk is never empty, so an empty block is not tried.)
    for (const input of [random(5), random(13), random(2048), text, Buffer.alloc(2048, 7), Uint8Array.from([...random(300), ...random(1).fill(9), ...Buffer.alloc(400, 3), ...random(40)])]) {
      const out = new Uint8Array(input.length + 16);
      assert.equal(lz4Block(lz4Compress(input), out), input.length);
      assert.ok(Buffer.from(out.subarray(0, input.length)).equals(Buffer.from(input)));
    }
    // In an image: a text file compresses, random bytes stay raw; names may hold any plain character in the core.
    const files = new Map<string, Uint8Array>([
      ['texlive/texmf-dist/tex/latex/base/article.cls', Buffer.from('\\ProvidesClass{article}\n'.repeat(400))],
      ['texlive/texmf-dist/fonts/type1/public/x/x~y=z.pfb', random(5000)],
      ['etc/passwd', Buffer.from('root:x:0:0::/root:/bin/sh\n')],
    ]);
    const image = buildDataImage(files, { compress: true, strictNames: false });
    assert.ok(image.index.compressed.successes.some((s) => s === 1) && image.index.compressed.successes.some((s) => s === 0));
    assert.ok(image.bytes < 9800 + 5000, 'the text part compressed');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-image-'));
    try {
      const dataPath = path.join(tmp, 'core.data');
      writeFileSync(dataPath, image.data);
      const reader = openImage(dataPath, image.index.compressed);
      for (const f of image.index.metadata.files) {
        assert.ok(Buffer.from(files.get(f.filename.slice(1)) as Uint8Array).equals(reader.read(f.start, f.end)), f.filename);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    assert.throws(() => buildDataImage([['a/../b', new Uint8Array(1)]], { strictNames: false }), /not a plain texmf path/);
  });

  it('refuses a name that is not a plain texmf path', async () => {
    const { buildDataImage } = await importScript<DataImage>('scripts/lib/data-image.mjs');
    for (const bad of ['../x.sty', 'tex//x.sty', '/abs.sty', 'tex/./x.sty', 'a b.sty']) {
      assert.throws(() => buildDataImage([[bad, new Uint8Array(1)]]), /not a plain texmf path/, bad);
    }
  });
});
