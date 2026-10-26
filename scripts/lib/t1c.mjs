// t1c packing of Type 1 fonts (docs/DESIGN.md#engine-and-data): a .pfb is stored with its eexec section and every
// charstring decrypted, so the image's LZ4 layer and the package's zip compress it; the engine host encrypts it
// again when TeX reads the file (src/engine-host/engine/t1c.ts) and checks the result against the original's SHA-256. Both
// ciphers are Type 1's own (Adobe Type 1 Font Format, chapter 7): eexec with key 55665, charstrings with key 4330,
// c = p XOR (r >> 8), r = (c + r) * 52845 + 22719 (mod 65536). Decrypting and encrypting again gives every byte
// back, whatever the bytes are, so packing is lossless; the builder checks each file anyway and packs only those
// that come back the same. The packed file has the original's length, so offsets and sizes stay as they are.
// src/engine-host/engine/t1c.ts is the same algorithm for the engine host; test/unit/t1c.test.ts holds the two together.

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;

function decrypt(bytes, key) {
  let r = key;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    out[i] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

function encrypt(plain, key) {
  let r = key;
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    const c = plain[i] ^ (r >> 8);
    out[i] = c;
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

/**
 * The charstrings of a decrypted eexec section: "<length> RD <bytes>" (or "-|"), for /Subrs and /CharStrings.
 * The scan reads only the text between charstrings and steps over each charstring by its length, so it finds the
 * same places whether the charstrings are encrypted or not.
 */
export function charstrings(section) {
  const text = Buffer.from(section.buffer, section.byteOffset, section.length).toString('latin1');
  const out = [];
  const re = /(\d+) (RD|-\|) /g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const length = Number(m[1]);
    if (start + length > section.length) {
      break;
    }
    out.push([start, length]);
    re.lastIndex = start + length;
  }
  return out;
}

/** The PFB segments ([type, start, length]: 1 text, 2 binary), or null when the file is not a plain PFB. */
function segments(pfb) {
  const out = [];
  let i = 0;
  while (i + 6 <= pfb.length && pfb[i] === 0x80 && (pfb[i + 1] === 1 || pfb[i + 1] === 2)) {
    const length = pfb[i + 2] | (pfb[i + 3] << 8) | (pfb[i + 4] << 16) | (pfb[i + 5] * 0x1000000);
    if (i + 6 + length > pfb.length) {
      return null;
    }
    out.push([pfb[i + 1], i + 6, length]);
    i += 6 + length;
  }
  return out.some(([type]) => type === 2) ? out : null;
}

/**
 * A .pfb packed: its binary section and its charstrings decrypted. Null when it is not a plain PFB, or when its
 * eexec data is split over several binary segments (one stream across them, which this packing does not follow;
 * no core font has more than one).
 */
export function t1cPack(pfb) {
  const segs = segments(pfb);
  if (!segs || segs.filter(([type]) => type === 2).length !== 1) {
    return null;
  }
  const out = Uint8Array.from(pfb);
  for (const [type, start, length] of segs) {
    if (type !== 2) {
      continue;
    }
    const plain = decrypt(pfb.subarray(start, start + length), EEXEC_KEY);
    for (const [at, n] of charstrings(plain)) {
      plain.set(decrypt(plain.subarray(at, at + n), CHARSTRING_KEY), at);
    }
    out.set(plain, start);
  }
  return out;
}

/** The original .pfb from its packed form: the charstrings and binary sections encrypted again. */
export function t1cUnpack(packed) {
  const segs = segments(packed);
  if (!segs) {
    throw new Error('t1c: not a packed PFB');
  }
  const out = Uint8Array.from(packed);
  for (const [type, start, length] of segs) {
    if (type !== 2) {
      continue;
    }
    const plain = Uint8Array.from(packed.subarray(start, start + length));
    for (const [at, n] of charstrings(plain)) {
      plain.set(encrypt(plain.subarray(at, at + n), CHARSTRING_KEY), at);
    }
    out.set(encrypt(plain, EEXEC_KEY), start);
  }
  return out;
}
