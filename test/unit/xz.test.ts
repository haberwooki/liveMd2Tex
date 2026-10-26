// The xz decoder of the bundle builder (scripts/lib/xz.mjs; B1, docs/DESIGN.md#engine-and-data). The test makes its own
// .xz files (test/support/xzEncode.ts): every LZMA packet kind and every LZMA2 chunk kind, both check types, more
// than one stream, and damaged files that must fail.

import * as assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { importScript } from '../support/helpers';
import { lzma2Encode, packetCounts, xzStream, type Chunk } from '../support/xzEncode';

interface Xz {
  unxz(input: Uint8Array): Buffer;
  crc32(bytes: Uint8Array): number;
  crc64(bytes: Uint8Array): string;
}

/** Text with repeats at many distances, and some random bytes (long distances and literals). */
function sample(size: number, seed = 7): Uint8Array {
  const words = ['\\usepackage', '{amsmath}', ' the ', 'TeX ', 'Live ', '\n', '%% comment ', 'abcabcabc', 'pdftex.map '];
  const out: number[] = [];
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
  while (out.length < size) {
    const r = next();
    if (r < 0.15) {
      out.push(Math.floor(next() * 256));
    } else if (r < 0.25 && out.length > 600) {
      const from = out.length - 1 - Math.floor(next() * Math.min(out.length - 1, 3000));
      const len = 2 + Math.floor(next() * 40);
      for (let i = 0; i < len; i++) {
        out.push(out[from + i]);
      }
    } else {
      out.push(...Buffer.from(words[Math.floor(next() * words.length)]));
    }
  }
  return Uint8Array.from(out.slice(0, size));
}

describe('xz decoder (scripts/lib/xz.mjs; B1)', () => {
  let xz: Xz;
  before(async () => {
    xz = await importScript<Xz>('scripts/lib/xz.mjs');
  });

  it('computes CRC32 as zlib does, and CRC64 with the standard check value', () => {
    const text = Buffer.from('123456789');
    assert.equal(xz.crc32(text), zlibCrc32(text) >>> 0);
    assert.equal(xz.crc64(text), '995dc9bbdf1939fa');
  });

  it('reads the empty .xz file (no block)', () => {
    const empty = Buffer.from('fd377a585a000004e6d6b44600000000' + '1cdf44211fb6f37d010000000004595a', 'hex');
    assert.equal(xz.unxz(empty).length, 0);
  });

  it('decodes every LZMA packet kind and every LZMA2 chunk kind, with CRC64 and CRC32 checks', () => {
    const data = sample(40000);
    const chunks: Chunk[] = [
      { kind: 'lzma', bytes: 12000, reset: 3, props: [3, 0, 2] },
      { kind: 'stored', bytes: 1500 },
      { kind: 'lzma', bytes: 9000, reset: 0 },
      { kind: 'lzma', bytes: 8000, reset: 1 },
      { kind: 'lzma', bytes: 9500, reset: 2, props: [1, 1, 0] },
    ];
    const body = lzma2Encode(data, chunks);
    for (const check of [4, 1] as const) {
      const file = xzStream(body, data, check, xz.crc64);
      assert.deepEqual(new Uint8Array(xz.unxz(file)), data, `check ${check}`);
    }
    for (const kind of ['literal', 'matched literal', 'short repeat', 'repeat 0', 'repeat 1', 'repeat 2', 'repeat 3', 'match, short distance', 'match, middle distance', 'match, long distance', 'long length']) {
      assert.ok((packetCounts[kind] ?? 0) > 0, `the sample never used: ${kind} (${JSON.stringify(packetCounts)})`);
    }
  });

  it('reads concatenated streams with stream padding between them', () => {
    const a = sample(3000, 1);
    const b = sample(5000, 2);
    const one = xzStream(lzma2Encode(a, [{ kind: 'lzma', bytes: a.length, reset: 3 }]), a, 4, xz.crc64);
    const two = xzStream(lzma2Encode(b, [{ kind: 'stored', bytes: b.length, dictReset: true }]), b, 4, xz.crc64);
    const joined = Buffer.concat([one, Buffer.alloc(8), two]);
    assert.deepEqual(new Uint8Array(xz.unxz(joined)), Uint8Array.from([...a, ...b]));
  });

  it('fails on damage: a wrong check, a damaged header, a cut file, a file that is not .xz', () => {
    const data = sample(6000);
    const file = xzStream(lzma2Encode(data, [{ kind: 'lzma', bytes: data.length, reset: 3 }]), data, 4, xz.crc64);
    // The check sits just before the index (8 bytes) and the 12-byte footer and the index (12 bytes here).
    const badCheck = Buffer.from(file);
    badCheck[badCheck.length - 12 - 12 - 1] ^= 1;
    assert.throws(() => xz.unxz(badCheck), /CRC64 check|index/);
    const badHeader = Buffer.from(file);
    badHeader[7] = 1;
    assert.throws(() => xz.unxz(badHeader), /stream header is damaged/);
    assert.throws(() => xz.unxz(file.subarray(0, file.length - 30)), /xz:/);
    assert.throws(() => xz.unxz(Buffer.from('PK\u0003\u0004 not xz')), /not an \.xz file/);
    const flipped = Buffer.from(file);
    flipped[40] ^= 0x10;
    assert.throws(() => xz.unxz(flipped), /xz:/);
  });
});
