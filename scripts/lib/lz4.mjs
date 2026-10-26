// An LZ4 block compressor (B1; docs/DESIGN.md#engine-and-data) for the data images: Emscripten's file_packager LZ4
// layout stores each 2,048-byte chunk as one LZ4 block when that is smaller, raw otherwise, and the engine's own
// LZ4 reader (MiniLZ4) and scripts/lib/image-files.mjs read it back. Greedy, with a hash of four bytes: chunks are
// small, so the ratio matters more than the speed. The block rules: a match is at least 4 bytes, reaches back at
// most 65,535 bytes, starts no later than 12 bytes before the end, and the last 5 bytes are literals.

const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MF_LIMIT = 12;
const HASH_BITS = 12;

const read32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const hash = (v) => Math.imul(v, 2654435761) >>> (32 - HASH_BITS);

function writeLength(out, n) {
  while (n >= 255) {
    out.push(255);
    n -= 255;
  }
  out.push(n);
}

/** One LZ4 block for `src`. */
export function lz4Compress(src) {
  const n = src.length;
  const out = [];
  let anchor = 0;
  const emit = (literalEnd, offset, matchLen) => {
    const literals = literalEnd - anchor;
    const token = (Math.min(literals, 15) << 4) | (matchLen === undefined ? 0 : Math.min(matchLen - MIN_MATCH, 15));
    out.push(token);
    if (literals >= 15) {
      writeLength(out, literals - 15);
    }
    for (let k = anchor; k < literalEnd; k++) {
      out.push(src[k]);
    }
    if (matchLen !== undefined) {
      out.push(offset & 0xff, offset >>> 8);
      if (matchLen - MIN_MATCH >= 15) {
        writeLength(out, matchLen - MIN_MATCH - 15);
      }
    }
  };
  if (n >= MF_LIMIT + 1) {
    const table = new Int32Array(1 << HASH_BITS).fill(-1);
    const limit = n - MF_LIMIT;
    let i = 0;
    while (i < limit) {
      const seq = read32(src, i);
      const h = hash(seq);
      const ref = table[h];
      table[h] = i;
      if (ref >= 0 && i - ref <= 0xffff && read32(src, ref) === seq) {
        let len = MIN_MATCH;
        while (i + len < n - LAST_LITERALS && src[ref + len] === src[i + len]) {
          len++;
        }
        emit(i, i - ref, len);
        i += len;
        anchor = i;
        if (i < limit) {
          table[hash(read32(src, i - 2))] = i - 2;
        }
      } else {
        i++;
      }
    }
  }
  emit(n, undefined, undefined);
  return Uint8Array.from(out);
}
