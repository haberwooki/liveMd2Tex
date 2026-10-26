// Reads the metadata of an Emscripten file_packager image from its loader script WITHOUT running the script:
// the loader embeds two JSON objects, `var compressedData = {...}` (the LZ4 chunk table) and the final
// `loadPackage({"files": [...], ...})` argument (the file list with byte ranges). Both are parsed as JSON.

import { T1C } from './t1c';

export interface PackagedFile {
  filename: string;
  start: number;
  end: number;
}

export interface PackageMetadata {
  files: PackagedFile[];
  remote_package_size: number;
  package_uuid?: string;
  /** Files stored packed (B1: the core's Type 1 fonts, t1c), with the SHA-256 of each original. */
  packed?: PackedFiles;
}

/** Files an image stores packed, by file name, with the SHA-256 of each original; the engine host unpacks them. */
export interface PackedFiles {
  method: string;
  files: Record<string, string>;
}

/**
 * The plain message for damaged TeX data (t1c gate, S-3): which data set is damaged and what to reinstall. `id` is
 * null for the core image (only core-data packs its fonts, so a damaged core is the Core Packages extension), else
 * the data extension's id.
 */
export function damagedMessage(id: string | null, detail: string, outcome = 'so nothing was made from it'): string {
  const [name, fix] =
    id === null
      ? ['The core TeX data', 'Reinstall the liveMd2Tex Core Packages extension.']
      : id.endsWith('-extra-data')
        ? ["The Extra Packages add-on's TeX data", 'Reinstall the add-on.']
        : [`The TeX data of ${id}`, `Reinstall ${id}.`];
  return `${name} is damaged: ${detail}, ${outcome}. ${fix}`;
}

/** An image the engine host refuses because its data is damaged; `files` are the files concerned. */
export class DamagedData extends Error {
  constructor(
    message: string,
    readonly files: string[],
  ) {
    super(message);
  }
}

/**
 * The files whose packed lists differ between an image's index and the data set's manifest beside it
 * (data/manifest.json, image.packed). The engine host checks only the files the index lists, so a list dropped or
 * cut from the index alone would let TeX read a stored form unchecked (t1c gate, S-1). A manifest that describes
 * another index (not `indexName`), or none, is not compared. Null when the two agree.
 */
export function packedMismatch(metadata: PackageMetadata, manifest: unknown, indexName: string): string[] | null {
  const image = (manifest as { image?: { index?: unknown; packed?: PackedFiles } } | null)?.image;
  if (!image || image.index !== indexName) {
    return null;
  }
  const a = metadata.packed;
  const b = image.packed;
  if (a === undefined && b === undefined) {
    return null;
  }
  const names = [...new Set([...Object.keys(a?.files ?? {}), ...Object.keys(b?.files ?? {})])].sort();
  if (a === undefined || b === undefined || a.method !== b.method) {
    return names;
  }
  const differ = names.filter((f) => a.files[f] !== b.files[f]);
  return differ.length > 0 ? differ : null;
}

/** The LZ4 chunk table; `data` is filled in by the engine with the image bytes. */
export interface CompressedTable {
  data: Uint8Array | null;
  cachedOffset: number;
  cachedIndexes: number[];
  cachedChunks: (Uint8Array | null)[];
  offsets: number[];
  sizes: number[];
  successes: number[];
}

/** The JSON value that starts at the first "{" at or after `from`, by brace counting outside strings. */
function balancedJsonAt(source: string, from: number): unknown {
  const start = source.indexOf('{', from);
  if (start < 0) {
    throw new Error('No JSON object found.');
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(source.slice(start, i + 1));
      }
    }
  }
  throw new Error('Unbalanced JSON object.');
}

export function readPackageMetadata(loaderSource: string): { metadata: PackageMetadata; compressed: CompressedTable } {
  const compressedAt = loaderSource.indexOf('var compressedData = ');
  const filesAt = loaderSource.lastIndexOf('loadPackage({"files"');
  if (compressedAt < 0 || filesAt < 0) {
    throw new Error('Not a file_packager loader with LZ4 data (markers not found).');
  }
  const compressed = balancedJsonAt(loaderSource, compressedAt) as CompressedTable;
  const metadata = balancedJsonAt(loaderSource, filesAt) as PackageMetadata;
  if (!Array.isArray(metadata.files) || !Array.isArray(compressed.offsets)) {
    throw new Error('Unexpected file_packager metadata.');
  }
  return { metadata, compressed };
}

/**
 * The image's file list and LZ4 chunk table in a compact form that workers share without copying: names as one
 * string, numbers in typed arrays on SharedArrayBuffers. The LZ4 reader indexes these like plain arrays.
 */
export interface ImageIndex {
  /** File names joined with "\n". */
  names: string;
  starts: Uint32Array;
  ends: Uint32Array;
  chunkOffsets: Uint32Array;
  chunkSizes: Uint32Array;
  chunkCompressed: Uint8Array;
  cachedOffset: number;
  cacheSlots: number;
  /** Files stored packed with t1c (file name -> the original's SHA-256). */
  packed?: Record<string, string>;
}

function sharedU32(values: number[]): Uint32Array {
  const out = new Uint32Array(new SharedArrayBuffer(values.length * 4));
  values.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      throw new Error(`value ${v} does not fit an unsigned 32-bit index`);
    }
    out[i] = v;
  });
  return out;
}

export function buildImageIndex(metadata: PackageMetadata, compressed: CompressedTable): ImageIndex {
  const chunkCompressed = new Uint8Array(new SharedArrayBuffer(compressed.successes.length));
  compressed.successes.forEach((v, i) => (chunkCompressed[i] = v ? 1 : 0));
  if (metadata.packed && metadata.packed.method !== T1C) {
    throw new Error(`files packed with ${metadata.packed.method}, which this engine host cannot unpack`);
  }
  for (const f of metadata.files) {
    if (f.filename.includes('\n')) {
      throw new Error(`file name with a line break: ${JSON.stringify(f.filename)}`);
    }
  }
  return {
    names: metadata.files.map((f) => f.filename).join('\n'),
    starts: sharedU32(metadata.files.map((f) => f.start)),
    ends: sharedU32(metadata.files.map((f) => f.end)),
    chunkOffsets: sharedU32(compressed.offsets),
    chunkSizes: sharedU32(compressed.sizes),
    chunkCompressed,
    cachedOffset: compressed.cachedOffset,
    cacheSlots: compressed.cachedIndexes.length,
    ...(metadata.packed ? { packed: metadata.packed.files } : {}),
  };
}
