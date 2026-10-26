// t1c, the engine host's side (docs/DESIGN.md#engine-and-data): a Type 1 font that core-data stores packed (its
// eexec section and charstrings decrypted, so it compresses; scripts/lib/t1c.mjs packs it) is encrypted again
// when TeX reads it, giving the original file byte for byte. The engine host checks the result against the
// original's SHA-256, which the image's index records, and never serves other bytes. Type 1's own ciphers: eexec
// key 55665, charstring key 4330, c = p XOR (r >> 8), r = (c + r) * 52845 + 22719 (mod 65536).

import { PACKING_T1C } from '../../shared/engineJobs';

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;

/** The packing a data image may use for some of its files (the index's "packed"). */
export const T1C = PACKING_T1C;

/** Encrypts bytes [start, end) of `buf` in place. */
function encryptInPlace(buf: Uint8Array, start: number, end: number, key: number): void {
  let r = key;
  for (let i = start; i < end; i++) {
    const c = buf[i] ^ (r >> 8);
    buf[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
}

/** "<length> RD <bytes>" (or "-|") in bytes [start, end): the places of the charstrings, as [start, length]. */
function charstrings(buf: Uint8Array, start: number, end: number): [number, number][] {
  const text = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('latin1');
  const out: [number, number][] = [];
  const re = /(\d+) (RD|-\|) /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[0].length;
    const length = Number(m[1]);
    if (at + length > text.length) {
      break;
    }
    out.push([start + at, length]);
    re.lastIndex = at + length;
  }
  return out;
}

/** The original .pfb from its packed form. Throws when the bytes are not a packed PFB. */
export function t1cUnpack(packed: Uint8Array): Uint8Array {
  const out = Uint8Array.from(packed);
  let i = 0;
  let binary = 0;
  while (i + 6 <= out.length && out[i] === 0x80 && (out[i + 1] === 1 || out[i + 1] === 2)) {
    const length = out[i + 2] | (out[i + 3] << 8) | (out[i + 4] << 16) | (out[i + 5] * 0x1000000);
    const start = i + 6;
    if (start + length > out.length) {
      throw new Error('t1c: a segment runs past the end of the file');
    }
    if (out[i + 1] === 2) {
      binary++;
      // The charstrings first (the scan reads only the text between them), then the whole eexec section.
      for (const [at, n] of charstrings(out, start, start + length)) {
        encryptInPlace(out, at, at + n, CHARSTRING_KEY);
      }
      encryptInPlace(out, start, start + length, EEXEC_KEY);
    }
    i = start + length;
  }
  if (binary === 0) {
    throw new Error('t1c: not a packed PFB');
  }
  return out;
}
