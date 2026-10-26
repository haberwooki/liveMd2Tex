// An xz decoder in JavaScript (B1; docs/DESIGN.md#engine-and-data): TeX Live's per-package archives are .tar.xz, and
// the bundle builder may start no outside program, so it unpacks them itself. It reads the .xz container (one or
// more streams, each of blocks, an index and a footer) with the LZMA2 filter, which is the only filter TeX Live's
// archives use, and checks each block's integrity check (CRC32, CRC64 or SHA-256) against the decoded bytes. A
// wrong decode therefore fails loudly instead of producing a damaged file.
//
// The LZMA decoder follows the published format (the LZMA SDK's description, as in xz-embedded): an adaptive
// binary range decoder, literals with lc/lp context, matches and four repeated distances. The whole output is the
// dictionary, so the dictionary size in the header only has to be valid.

import { createHash } from 'node:crypto';

// ---- Checksums ---------------------------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32 (IEEE, as in zip and xz). */
export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// CRC64 (ECMA-182, reflected, as in xz) in two 32-bit halves.
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
(() => {
  const polyLo = 0xd7870f42;
  const polyHi = 0xc96c5795;
  for (let i = 0; i < 256; i++) {
    let lo = i;
    let hi = 0;
    for (let k = 0; k < 8; k++) {
      const bit = lo & 1;
      lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
      hi = hi >>> 1;
      if (bit) {
        lo = (lo ^ polyLo) >>> 0;
        hi = (hi ^ polyHi) >>> 0;
      }
    }
    CRC64_LO[i] = lo;
    CRC64_HI[i] = hi;
  }
})();

/** CRC64 as 16 hex digits. */
export function crc64(bytes, start = 0, end = bytes.length) {
  let lo = 0xffffffff;
  let hi = 0xffffffff;
  for (let i = start; i < end; i++) {
    const idx = (lo ^ bytes[i]) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ CRC64_LO[idx]) >>> 0;
    hi = ((hi >>> 8) ^ CRC64_HI[idx]) >>> 0;
  }
  lo = (lo ^ 0xffffffff) >>> 0;
  hi = (hi ^ 0xffffffff) >>> 0;
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// ---- The output buffer, which is also the LZMA dictionary --------------------------------------------------

class Output {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
  }

  ensure(extra) {
    if (this.pos + extra > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.pos + extra) {
        size *= 2;
      }
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }
  }

  byte(b) {
    if (this.pos === this.buf.length) {
      this.ensure(1);
    }
    this.buf[this.pos++] = b;
  }

  /** Copies `len` bytes from `dist` + 1 bytes back (an LZ77 match; the regions may overlap). */
  copy(dist, len) {
    if (dist >= this.pos) {
      throw new Error('xz: a match reaches before the start of the data');
    }
    this.ensure(len);
    let from = this.pos - dist - 1;
    for (let i = 0; i < len; i++) {
      this.buf[this.pos++] = this.buf[from++];
    }
  }
}

// ---- The range decoder -------------------------------------------------------------------------------------

const PROB_INIT = 1024;

class RangeDecoder {
  constructor(input, start, end) {
    if (input[start] !== 0) {
      throw new Error('xz: an LZMA chunk does not start with a zero byte');
    }
    this.in = input;
    this.pos = start + 5;
    this.end = end;
    this.range = 0xffffffff;
    this.code = ((input[start + 1] << 24) | (input[start + 2] << 16) | (input[start + 3] << 8) | input[start + 4]) >>> 0;
  }

  normalize() {
    if (this.range < 0x1000000) {
      if (this.pos >= this.end) {
        throw new Error('xz: an LZMA chunk ends early');
      }
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.in[this.pos++]) >>> 0;
    }
  }

  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      b = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      b = 1;
    }
    this.normalize();
    return b;
  }

  /** A bit tree of `bits` levels, most significant bit first. */
  tree(probs, base, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) {
      m = (m << 1) | this.bit(probs, base + m);
    }
    return m - (1 << bits);
  }

  /** A bit tree read least significant bit first. */
  reverseTree(probs, base, bits) {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }

  direct(bits) {
    let res = 0;
    for (let i = 0; i < bits; i++) {
      this.range >>>= 1;
      const b = this.code >= this.range ? 1 : 0;
      if (b) {
        this.code = (this.code - this.range) >>> 0;
      }
      res = ((res << 1) | b) >>> 0;
      this.normalize();
    }
    return res;
  }
}

// ---- LZMA --------------------------------------------------------------------------------------------------

const STATES = 12;
const POS_STATES_MAX = 16;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;

class LengthDecoder {
  constructor() {
    this.choice = new Uint16Array(2);
    this.low = new Uint16Array(POS_STATES_MAX << 3);
    this.mid = new Uint16Array(POS_STATES_MAX << 3);
    this.high = new Uint16Array(256);
    this.reset();
  }

  reset() {
    this.choice.fill(PROB_INIT);
    this.low.fill(PROB_INIT);
    this.mid.fill(PROB_INIT);
    this.high.fill(PROB_INIT);
  }

  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) {
      return rc.tree(this.low, posState << 3, 3);
    }
    if (rc.bit(this.choice, 1) === 0) {
      return 8 + rc.tree(this.mid, posState << 3, 3);
    }
    return 16 + rc.tree(this.high, 0, 8);
  }
}

class LzmaState {
  constructor() {
    this.isMatch = new Uint16Array(STATES << 4);
    this.isRep = new Uint16Array(STATES);
    this.isRepG0 = new Uint16Array(STATES);
    this.isRepG1 = new Uint16Array(STATES);
    this.isRepG2 = new Uint16Array(STATES);
    this.isRep0Long = new Uint16Array(STATES << 4);
    this.posSlot = new Uint16Array(4 << 6);
    this.posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
    this.align = new Uint16Array(1 << ALIGN_BITS);
    this.len = new LengthDecoder();
    this.repLen = new LengthDecoder();
    this.literal = new Uint16Array(0x300);
    this.setProps(3, 0, 2);
  }

  setProps(lc, lp, pb) {
    if (lc + lp > 4) {
      throw new Error('xz: LZMA2 allows lc + lp of at most 4');
    }
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    const size = 0x300 << (lc + lp);
    if (this.literal.length !== size) {
      this.literal = new Uint16Array(size);
    }
  }

  reset() {
    for (const a of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posSpecial, this.align, this.literal]) {
      a.fill(PROB_INIT);
    }
    this.len.reset();
    this.repLen.reset();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  /** Decodes until `out` has grown by `size` bytes. */
  decode(rc, out, size) {
    const end = out.pos + size;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    while (out.pos < end) {
      const posState = out.pos & pbMask;
      const s = this.state;
      if (rc.bit(this.isMatch, (s << 4) + posState) === 0) {
        // A literal.
        const prev = out.pos > 0 ? out.buf[out.pos - 1] : 0;
        const base = 0x300 * (((out.pos & lpMask) << this.lc) + (prev >>> (8 - this.lc)));
        let sym = 1;
        if (s >= 7) {
          // After a match: the byte at rep0 guides the first bits.
          let match = out.buf[out.pos - this.rep0 - 1];
          do {
            const matchBit = (match >>> 7) & 1;
            match <<= 1;
            const b = rc.bit(this.literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) {
              break;
            }
          } while (sym < 0x100);
        }
        while (sym < 0x100) {
          sym = (sym << 1) | rc.bit(this.literal, base + sym);
        }
        out.byte(sym & 0xff);
        this.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6;
        continue;
      }
      let len;
      if (rc.bit(this.isRep, s) === 1) {
        if (out.pos === 0) {
          throw new Error('xz: a repeated match before any data');
        }
        if (rc.bit(this.isRepG0, s) === 0) {
          if (rc.bit(this.isRep0Long, (s << 4) + posState) === 0) {
            // A short repeat: one byte at rep0.
            this.state = s < 7 ? 9 : 11;
            out.copy(this.rep0, 1);
            continue;
          }
        } else {
          let dist;
          if (rc.bit(this.isRepG1, s) === 0) {
            dist = this.rep1;
          } else {
            if (rc.bit(this.isRepG2, s) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.repLen.decode(rc, posState);
        this.state = s < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = this.len.decode(rc, posState);
        this.state = s < 7 ? 7 : 10;
        this.rep0 = this.distance(rc, len);
        if (this.rep0 === 0xffffffff) {
          throw new Error('xz: an end marker inside an LZMA2 chunk');
        }
      }
      len += 2;
      if (out.pos + len > end) {
        throw new Error('xz: a match runs past the end of its chunk');
      }
      out.copy(this.rep0, len);
    }
  }

  distance(rc, len) {
    const lenState = len < 4 ? len : 3;
    const slot = rc.tree(this.posSlot, lenState << 6, 6);
    if (slot < 4) {
      return slot;
    }
    const direct = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << direct) >>> 0;
    if (slot < END_POS_MODEL_INDEX) {
      // The tree's first node is dist - slot (its index 1 sits at the base plus 1).
      return (dist + rc.reverseTree(this.posSpecial, dist - slot - 1, direct)) >>> 0;
    }
    dist = (dist + ((rc.direct(direct - ALIGN_BITS) << ALIGN_BITS) >>> 0)) >>> 0;
    return (dist + rc.reverseTree(this.align, 0, ALIGN_BITS)) >>> 0;
  }
}

// ---- LZMA2 -------------------------------------------------------------------------------------------------

/** Decodes LZMA2 data from input[start, end) into `out`; returns the position after the end marker. */
function lzma2(input, start, end, out, lzma) {
  let pos = start;
  let needDictReset = true;
  let needProps = true;
  for (;;) {
    if (pos >= end) {
      throw new Error('xz: LZMA2 data without its end marker');
    }
    const control = input[pos++];
    if (control === 0x00) {
      return pos;
    }
    if (control === 0x01 || control === 0x02) {
      if (control === 0x02 && needDictReset) {
        throw new Error('xz: LZMA2 data does not start with a dictionary reset');
      }
      needDictReset = false;
      const size = ((input[pos] << 8) | input[pos + 1]) + 1;
      pos += 2;
      if (pos + size > end) {
        throw new Error('xz: an uncompressed LZMA2 chunk ends early');
      }
      out.ensure(size);
      out.buf.set(input.subarray(pos, pos + size), out.pos);
      out.pos += size;
      pos += size;
      continue;
    }
    if (control < 0x80) {
      throw new Error(`xz: an unknown LZMA2 control byte 0x${control.toString(16)}`);
    }
    const reset = (control >>> 5) & 3;
    const unpacked = (((control & 0x1f) << 16) | (input[pos] << 8) | input[pos + 1]) + 1;
    const packed = ((input[pos + 2] << 8) | input[pos + 3]) + 1;
    pos += 4;
    if (reset === 3) {
      needDictReset = false;
    } else if (needDictReset) {
      throw new Error('xz: LZMA2 data does not start with a dictionary reset');
    }
    if (reset >= 2) {
      const props = input[pos++];
      if (props > 224) {
        throw new Error('xz: bad LZMA properties');
      }
      const pb = Math.floor(props / 45);
      const lp = Math.floor((props % 45) / 9);
      lzma.setProps(props % 9, lp, pb);
      needProps = false;
    } else if (needProps) {
      throw new Error('xz: an LZMA2 chunk without properties');
    }
    if (reset >= 1) {
      lzma.reset();
    }
    if (pos + packed > end) {
      throw new Error('xz: an LZMA2 chunk ends early');
    }
    lzma.decode(new RangeDecoder(input, pos, pos + packed), out, unpacked);
    pos += packed;
  }
}

// ---- The .xz container -------------------------------------------------------------------------------------

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const CHECK_SIZES = { 0: 0, 1: 4, 4: 8, 10: 32 };

function vli(input, at) {
  let value = 0;
  let pos = at.pos;
  for (let i = 0; i < 9; i++) {
    const b = input[pos++];
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) {
      at.pos = pos;
      return value;
    }
  }
  throw new Error('xz: a variable-length integer is too long');
}

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/**
 * Decodes a whole .xz file (concatenated streams and stream padding included). Throws on any damage: a bad
 * header, a wrong CRC of a header or an index, or a block whose check does not match its decoded bytes.
 * @param {Uint8Array} input
 * @returns {Buffer}
 */
export function unxz(input) {
  const out = new Output(Math.max(1 << 16, input.length * 4));
  let pos = 0;
  let streams = 0;
  while (pos < input.length) {
    // Stream padding: zero bytes, a multiple of four.
    if (streams > 0 && input[pos] === 0) {
      while (pos < input.length && input[pos] === 0) {
        pos++;
      }
      if (pos % 4 !== 0) {
        throw new Error('xz: stream padding is not a multiple of four bytes');
      }
      continue;
    }
    if (!MAGIC.every((m, i) => input[pos + i] === m)) {
      throw new Error(streams === 0 ? 'xz: not an .xz file' : 'xz: garbage after a stream');
    }
    if (crc32(input, pos + 6, pos + 8) !== u32(input, pos + 8)) {
      throw new Error('xz: the stream header is damaged');
    }
    const check = input[pos + 7] & 0x0f;
    const checkSize = CHECK_SIZES[check];
    if (checkSize === undefined || input[pos + 6] !== 0) {
      throw new Error(`xz: an unsupported check type ${check}`);
    }
    pos += 12;
    const records = [];
    for (;;) {
      if (input[pos] === 0x00) {
        break; // the index
      }
      const headerSize = (input[pos] + 1) * 4;
      const headerEnd = pos + headerSize;
      if (crc32(input, pos, headerEnd - 4) !== u32(input, headerEnd - 4)) {
        throw new Error('xz: a block header is damaged');
      }
      const flags = input[pos + 1];
      const at = { pos: pos + 2 };
      const compressed = flags & 0x40 ? vli(input, at) : undefined;
      const uncompressed = flags & 0x80 ? vli(input, at) : undefined;
      const filters = (flags & 3) + 1;
      for (let f = 0; f < filters; f++) {
        const id = vli(input, at);
        const propsSize = vli(input, at);
        if (id !== 0x21 || filters !== 1) {
          throw new Error(`xz: filter 0x${id.toString(16)} is not supported (only LZMA2 alone)`);
        }
        at.pos += propsSize;
      }
      const dataStart = headerEnd;
      const before = out.pos;
      const dataEnd = lzma2(input, dataStart, compressed !== undefined ? dataStart + compressed : input.length, out, new LzmaState());
      if (compressed !== undefined && dataEnd !== dataStart + compressed) {
        throw new Error('xz: a block is not its stated size');
      }
      if (uncompressed !== undefined && out.pos - before !== uncompressed) {
        throw new Error('xz: a block did not decode to its stated size');
      }
      let p = dataEnd;
      while ((p - pos) % 4 !== 0) {
        if (input[p++] !== 0) {
          throw new Error('xz: block padding is not zero');
        }
      }
      const stored = input.subarray(p, p + checkSize);
      const got = out.buf.subarray(before, out.pos);
      if (check === 1 && crc32(got) !== u32(stored, 0)) {
        throw new Error('xz: a block fails its CRC32 check');
      }
      if (check === 4 && crc64(got) !== Buffer.from(stored).reverse().toString('hex')) {
        throw new Error('xz: a block fails its CRC64 check');
      }
      if (check === 10 && createHash('sha256').update(got).digest('hex') !== Buffer.from(stored).toString('hex')) {
        throw new Error('xz: a block fails its SHA-256 check');
      }
      records.push({ unpadded: dataEnd - pos + checkSize, uncompressed: out.pos - before });
      pos = p + checkSize;
    }
    // The index: the records must match the blocks just read.
    const indexStart = pos;
    const at = { pos: pos + 1 };
    const count = vli(input, at);
    if (count !== records.length) {
      throw new Error('xz: the index does not list the blocks');
    }
    for (const r of records) {
      if (vli(input, at) !== r.unpadded || vli(input, at) !== r.uncompressed) {
        throw new Error('xz: the index does not match a block');
      }
    }
    let p = at.pos;
    while ((p - indexStart) % 4 !== 0) {
      p++;
    }
    if (crc32(input, indexStart, p) !== u32(input, p)) {
      throw new Error('xz: the index is damaged');
    }
    pos = p + 4;
    // The footer.
    if (crc32(input, pos + 4, pos + 10) !== u32(input, pos) || input[pos + 10] !== 0x59 || input[pos + 11] !== 0x5a) {
      throw new Error('xz: the stream footer is damaged');
    }
    if ((u32(input, pos + 4) + 1) * 4 !== pos - indexStart) {
      throw new Error('xz: the footer does not point at the index');
    }
    pos += 12;
    streams++;
  }
  if (streams === 0) {
    throw new Error('xz: an empty file');
  }
  return Buffer.from(out.buf.buffer, out.buf.byteOffset, out.pos);
}
