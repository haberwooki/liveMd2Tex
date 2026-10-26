// Development tool: reads files out of TeXlyre's LZ4 file_packager image (texlive-extra.data) without running
// any of its JavaScript. The image is the uncompressed file contents cut into 2048-byte chunks, each stored
// LZ4-compressed (a plain LZ4 block) or raw; the index (made by scripts/stage-engine.mjs from the loader's
// metadata) gives each chunk's offset, size and whether it is compressed, and each file's start and end in the
// uncompressed stream. Used to build the interim manifest's package index (docs/DESIGN.md#architecture, #engine-and-data).

import { readFileSync } from 'node:fs';

const CHUNK_SIZE = 2048;

/** One LZ4 block into `output`; returns the number of bytes written. Same rules as Emscripten's MiniLZ4. */
export function lz4Block(input, output) {
  let i = 0;
  let j = 0;
  const n = input.length;
  while (i < n) {
    const token = input[i++];
    let literals = token >> 4;
    if (literals > 0) {
      if (literals === 15) {
        let b;
        do {
          b = input[i++];
          literals += b;
        } while (b === 255);
      }
      const end = i + literals;
      while (i < end) {
        output[j++] = input[i++];
      }
      if (i === n) {
        return j;
      }
    }
    const offset = input[i++] | (input[i++] << 8);
    if (offset === 0 || offset > j) {
      throw new Error(`bad LZ4 offset ${offset} at ${i - 2}`);
    }
    let match = token & 0xf;
    if (match === 15) {
      let b;
      do {
        b = input[i++];
        match += b;
      } while (b === 255);
    }
    let pos = j - offset;
    const end = j + match + 4;
    while (j < end) {
      output[j++] = output[pos++];
    }
  }
  return j;
}

/**
 * Opens the image. `compressed` is the index's chunk table ({ offsets, sizes, successes }).
 * Returns read(start, end) -> Buffer of the uncompressed bytes [start, end).
 */
export function openImage(dataPath, compressed) {
  const data = readFileSync(dataPath);
  const { offsets, sizes, successes } = compressed;
  let cachedIndex = -1;
  const cached = Buffer.alloc(CHUNK_SIZE);
  const chunk = (k) => {
    if (k === cachedIndex) {
      return cached;
    }
    if (successes[k]) {
      lz4Block(data.subarray(offsets[k], offsets[k] + sizes[k]), cached);
    } else {
      data.copy(cached, 0, offsets[k], offsets[k] + CHUNK_SIZE);
    }
    cachedIndex = k;
    return cached;
  };
  return {
    read(start, end) {
      const out = Buffer.alloc(end - start);
      let at = start;
      while (at < end) {
        const k = Math.floor(at / CHUNK_SIZE);
        const from = at % CHUNK_SIZE;
        const take = Math.min(CHUNK_SIZE - from, end - at);
        chunk(k).copy(out, at - start, from, from + take);
        at += take;
      }
      return out;
    },
  };
}
