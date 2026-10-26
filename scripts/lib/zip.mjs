// Minimal in-memory ZIP reader for VSIX files (stored and deflated entries, CRC-checked). No temporary files:
// the VSIX is read into a Buffer and every entry is inflated in memory.

import { crc32, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>} entry name -> contents (directories are skipped)
 */
export function readZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a ZIP file (no end-of-central-directory record).');
  }
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported.');
  }
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== CENTRAL) {
      throw new Error(`Bad central directory entry ${n}.`);
    }
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      continue;
    }
    if (flags & 0x1) {
      throw new Error(`${name}: encrypted entries are not supported.`);
    }
    if (zip.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`${name}: bad local header.`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`${name}: compression method ${method} is not supported.`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`${name}: size or CRC mismatch.`);
    }
    if (entries.has(name)) {
      throw new Error(`${name}: duplicate entry.`);
    }
    entries.set(name, data);
  }
  return entries;
}
