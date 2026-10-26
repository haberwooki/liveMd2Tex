// A ZIP reader for "Add a package from a file" (docs/DESIGN.md#engine-and-data): CTAN serves packages as .zip files, which
// the user downloads in the browser and picks. Read in memory with Node's zlib (stored and deflated entries,
// CRC-checked); nothing is unpacked to a temporary folder and no program runs. Limits keep a hostile archive
// from filling memory or the disk.

import { crc32, inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const ZIP_LIMITS = { entries: 5000, bytes: 200 * 1024 * 1024 };

/** The entries of a ZIP file (name -> bytes; folders skipped). Throws a plain-words error on anything else. */
export function readZip(zip: Buffer, limits = ZIP_LIMITS): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('This is not a ZIP file.');
  }
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported.');
  }
  if (count > limits.entries) {
    throw new Error(`The ZIP file has ${count} entries; at most ${limits.entries} are read.`);
  }
  const entries = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== CENTRAL) {
      throw new Error(`The ZIP file is damaged (entry ${n}).`);
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
    total += size;
    if (total > limits.bytes) {
      throw new Error(`The ZIP file unpacks to more than ${Math.round(limits.bytes / 1048576)} MB; it was not read.`);
    }
    if (zip.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`${name}: the ZIP file is damaged.`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: size + 1 });
    } else {
      throw new Error(`${name}: compression method ${method} is not supported.`);
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`${name}: the ZIP file is damaged (size or checksum).`);
    }
    entries.set(name, data);
  }
  return entries;
}
