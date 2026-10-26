// A small LZMA2 and .xz encoder for the tests of the xz decoder (scripts/lib/xz.mjs; B1). No program on the
// development machine may make .xz files, so the tests make their own. It is plain and slow: a greedy match finder
// over a short window, but it uses every kind of LZMA packet (literals, matched literals, matches with every
// distance coding, all four repeated distances, short repeats) and every LZMA2 chunk kind, so the decoder's paths
// all run. The real archives are checked on CI, where every block also carries its own CRC64.

import { crc32 as zlibCrc32 } from 'node:zlib';

const PROB_INIT = 1024;

/** How often each LZMA packet kind was written (the tests check that every kind ran). */
export const packetCounts: Record<string, number> = {};
const count = (kind: string) => {
  packetCounts[kind] = (packetCounts[kind] ?? 0) + 1;
};

class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  readonly out: number[] = [];

  private shiftLow(): void {
    const carry = Math.floor(this.low / 2 ** 32);
    const lo = this.low % 2 ** 32;
    if (lo < 0xff000000 || carry !== 0) {
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(lo / 2 ** 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (lo % 2 ** 24) * 256;
  }

  bit(probs: Uint16Array, i: number, bit: number): void {
    const p = probs[i];
    const bound = Math.floor(this.range / 2048) * p;
    if (bit === 0) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
    } else {
      this.low += bound;
      this.range -= bound;
      probs[i] = p - (p >>> 5);
    }
    while (this.range < 0x1000000) {
      this.range = (this.range * 256) % 2 ** 32;
      this.shiftLow();
    }
  }

  tree(probs: Uint16Array, base: number, bits: number, sym: number): void {
    let m = 1;
    for (let i = bits - 1; i >= 0; i--) {
      const b = (sym >>> i) & 1;
      this.bit(probs, base + m, b);
      m = (m << 1) | b;
    }
  }

  reverseTree(probs: Uint16Array, base: number, bits: number, sym: number): void {
    let m = 1;
    for (let i = 0; i < bits; i++) {
      const b = (sym >>> i) & 1;
      this.bit(probs, base + m, b);
      m = (m << 1) | b;
    }
  }

  direct(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.range = Math.floor(this.range / 2);
      if ((value >>> i) & 1) {
        this.low += this.range;
      }
      while (this.range < 0x1000000) {
        this.range = (this.range * 256) % 2 ** 32;
        this.shiftLow();
      }
    }
  }

  finish(): number[] {
    for (let i = 0; i < 5; i++) {
      this.shiftLow();
    }
    return this.out;
  }
}

class Lengths {
  choice = new Uint16Array(2).fill(PROB_INIT);
  low = new Uint16Array(16 << 3).fill(PROB_INIT);
  mid = new Uint16Array(16 << 3).fill(PROB_INIT);
  high = new Uint16Array(256).fill(PROB_INIT);

  encode(rc: RangeEncoder, len: number, posState: number): void {
    if (len < 8) {
      rc.bit(this.choice, 0, 0);
      rc.tree(this.low, posState << 3, 3, len);
    } else if (len < 16) {
      rc.bit(this.choice, 0, 1);
      rc.bit(this.choice, 1, 0);
      rc.tree(this.mid, posState << 3, 3, len - 8);
    } else {
      rc.bit(this.choice, 0, 1);
      rc.bit(this.choice, 1, 1);
      rc.tree(this.high, 0, 8, len - 16);
    }
  }
}

/** The encoder's model, the mirror of the decoder's. */
class Model {
  isMatch = new Uint16Array(12 << 4);
  isRep = new Uint16Array(12);
  isRepG0 = new Uint16Array(12);
  isRepG1 = new Uint16Array(12);
  isRepG2 = new Uint16Array(12);
  isRep0Long = new Uint16Array(12 << 4);
  posSlot = new Uint16Array(4 << 6);
  posSpecial = new Uint16Array(1 + 128 - 14);
  align = new Uint16Array(16);
  len = new Lengths();
  repLen = new Lengths();
  literal = new Uint16Array(0x300);
  state = 0;
  reps = [0, 0, 0, 0];
  lc = 3;
  lp = 0;
  pb = 2;

  setProps(lc: number, lp: number, pb: number): void {
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.literal = new Uint16Array(0x300 << (lc + lp));
  }

  reset(): void {
    for (const a of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posSpecial, this.align, this.literal]) {
      a.fill(PROB_INIT);
    }
    this.len = new Lengths();
    this.repLen = new Lengths();
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }
}

function posSlotOf(dist: number): number {
  if (dist < 4) {
    return dist;
  }
  const n = 31 - Math.clz32(dist);
  return 2 * n + ((dist >>> (n - 1)) & 1);
}

/** Encodes data[from, to) as one LZMA chunk's range-coded bytes, continuing `m`'s state. */
function encodeChunk(m: Model, data: Uint8Array, from: number, to: number): number[] {
  const rc = new RangeEncoder();
  const pbMask = (1 << m.pb) - 1;
  const lpMask = (1 << m.lp) - 1;
  let pos = from;
  const matchLen = (dist: number, at: number) => {
    let n = 0;
    while (at + n < to && n < 273 && at - dist - 1 >= 0 && data[at + n] === data[at + n - dist - 1]) {
      n++;
    }
    return n;
  };
  while (pos < to) {
    const posState = pos & pbMask;
    const s = m.state;
    // Repeated distances first (all four), then a fresh match within a short window, else a literal.
    let best = { kind: 'literal' as 'literal' | 'rep' | 'match' | 'short', len: 0, rep: 0, dist: 0 };
    if (pos > 0) {
      for (let r = 0; r < 4; r++) {
        const n = matchLen(m.reps[r], pos);
        if (n >= 2 && n > best.len) {
          best = { kind: 'rep', len: n, rep: r, dist: m.reps[r] };
        }
      }
      for (let dist = 0; dist < Math.min(pos, 4096); dist++) {
        const n = matchLen(dist, pos);
        if (n >= 3 && n > best.len + 1) {
          best = { kind: 'match', len: n, rep: 0, dist };
        }
      }
      if (best.kind === 'literal' && data[pos] === data[pos - m.reps[0] - 1] && pos - m.reps[0] - 1 >= 0 && (pos % 3 === 0)) {
        best = { kind: 'short', len: 1, rep: 0, dist: m.reps[0] };
      }
    }
    if (best.kind === 'literal') {
      rc.bit(m.isMatch, (s << 4) + posState, 0);
      const prev = pos > 0 ? data[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << m.lc) + (prev >>> (8 - m.lc)));
      const byte = data[pos];
      let sym = 1;
      count(s >= 7 ? 'matched literal' : 'literal');
      if (s >= 7) {
        let match = data[pos - m.reps[0] - 1];
        let differ = false;
        for (let i = 7; i >= 0; i--) {
          const b = (byte >>> i) & 1;
          if (!differ) {
            const matchBit = (match >>> 7) & 1;
            match <<= 1;
            rc.bit(m.literal, base + ((1 + matchBit) << 8) + sym, b);
            differ = matchBit !== b;
          } else {
            rc.bit(m.literal, base + sym, b);
          }
          sym = (sym << 1) | b;
        }
      } else {
        rc.tree(m.literal, base, 8, byte);
      }
      m.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
      pos++;
      continue;
    }
    rc.bit(m.isMatch, (s << 4) + posState, 1);
    if (best.kind === 'short') {
      count('short repeat');
      rc.bit(m.isRep, s, 1);
      rc.bit(m.isRepG0, s, 0);
      rc.bit(m.isRep0Long, (s << 4) + posState, 0);
      m.state = s < 7 ? 9 : 11;
      pos++;
      continue;
    }
    if (best.kind === 'rep') {
      count(`repeat ${best.rep}`);
      rc.bit(m.isRep, s, 1);
      if (best.rep === 0) {
        rc.bit(m.isRepG0, s, 0);
        rc.bit(m.isRep0Long, (s << 4) + posState, 1);
      } else {
        rc.bit(m.isRepG0, s, 1);
        if (best.rep === 1) {
          rc.bit(m.isRepG1, s, 0);
        } else {
          rc.bit(m.isRepG1, s, 1);
          rc.bit(m.isRepG2, s, best.rep === 2 ? 0 : 1);
        }
        const d = m.reps[best.rep];
        m.reps.splice(best.rep, 1);
        m.reps.unshift(d);
      }
      m.repLen.encode(rc, best.len - 2, posState);
      m.state = s < 7 ? 8 : 11;
      pos += best.len;
      continue;
    }
    rc.bit(m.isRep, s, 0);
    m.len.encode(rc, best.len - 2, posState);
    const lenState = Math.min(best.len - 2, 3);
    const slot = posSlotOf(best.dist);
    rc.tree(m.posSlot, lenState << 6, 6, slot);
    count(slot < 4 ? 'match, short distance' : slot < 14 ? 'match, middle distance' : 'match, long distance');
    if (best.len - 2 >= 16) {
      count('long length');
    }
    if (slot >= 4) {
      const direct = (slot >>> 1) - 1;
      const base = ((2 | (slot & 1)) << direct) >>> 0;
      const rem = best.dist - base;
      if (slot < 14) {
        rc.reverseTree(m.posSpecial, base - slot - 1, direct, rem);
      } else {
        rc.direct(rem >>> 4, direct - 4);
        rc.reverseTree(m.align, 0, 4, rem & 15);
      }
    }
    m.reps = [best.dist, m.reps[0], m.reps[1], m.reps[2]];
    m.state = s < 7 ? 7 : 10;
    pos += best.len;
  }
  return rc.finish();
}

export interface Chunk {
  /** "lzma" (with a reset kind 0 to 3, and lc/lp/pb when the reset sets properties) or "stored". */
  kind: 'lzma' | 'stored';
  bytes: number;
  reset?: 0 | 1 | 2 | 3;
  props?: [number, number, number];
  dictReset?: boolean;
}

/** LZMA2 data for `data`, in the chunks given (their sizes must add up to data.length). */
export function lzma2Encode(data: Uint8Array, chunks: Chunk[]): Uint8Array {
  const m = new Model();
  const out: number[] = [];
  let pos = 0;
  for (const c of chunks) {
    const end = pos + c.bytes;
    if (c.kind === 'stored') {
      out.push(c.dictReset ? 0x01 : 0x02, ((c.bytes - 1) >>> 8) & 0xff, (c.bytes - 1) & 0xff, ...data.subarray(pos, end));
    } else {
      const reset = c.reset ?? 0;
      if (reset >= 2) {
        const [lc, lp, pb] = c.props ?? [3, 0, 2];
        m.setProps(lc, lp, pb);
      }
      if (reset >= 1) {
        m.reset();
      }
      const packed = encodeChunk(m, data, pos, end);
      const u = c.bytes - 1;
      const p = packed.length - 1;
      out.push(0x80 | (reset << 5) | ((u >>> 16) & 0x1f), (u >>> 8) & 0xff, u & 0xff, (p >>> 8) & 0xff, p & 0xff);
      if (reset >= 2) {
        const [lc, lp, pb] = c.props ?? [3, 0, 2];
        out.push((pb * 5 + lp) * 9 + lc);
      }
      out.push(...packed);
    }
    pos = end;
  }
  out.push(0x00);
  return Uint8Array.from(out);
}

const crc32 = (b: Uint8Array) => zlibCrc32(b) >>> 0;
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const vli = (n: number) => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};

/** A one-block .xz stream around LZMA2 data, with a CRC32 (check 1) or CRC64 (check 4) check of `data`. */
export function xzStream(lzma2: Uint8Array, data: Uint8Array, check: 1 | 4, crc64Hex: (b: Uint8Array) => string): Uint8Array {
  const flags = [0x00, check];
  const header = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, ...flags, ...le32(crc32(Uint8Array.from(flags)))];
  // Block header: size byte, flags (one filter, no sizes), LZMA2 (0x21) with one property byte, padding, CRC32.
  const bh = [0, 0x00, 0x21, 0x01, 0x16];
  while ((bh.length + 4) % 4 !== 0) {
    bh.push(0);
  }
  bh[0] = (bh.length + 4) / 4 - 1;
  const blockHeader = [...bh, ...le32(crc32(Uint8Array.from(bh)))];
  const body = [...blockHeader, ...lzma2];
  const unpadded = body.length + (check === 1 ? 4 : 8);
  while (body.length % 4 !== 0) {
    body.push(0);
  }
  const checkBytes = check === 1 ? le32(crc32(data)) : [...Buffer.from(crc64Hex(data), 'hex').reverse()];
  const index = [0x00, ...vli(1), ...vli(unpadded), ...vli(data.length)];
  while (index.length % 4 !== 0) {
    index.push(0);
  }
  const indexFull = [...index, ...le32(crc32(Uint8Array.from(index)))];
  const backward = le32(indexFull.length / 4 - 1);
  const footerTail = [...backward, ...flags];
  const footer = [...le32(crc32(Uint8Array.from(footerTail))), ...footerTail, 0x59, 0x5a];
  return Uint8Array.from([...header, ...body, ...checkBytes, ...indexFull, ...footer]);
}
