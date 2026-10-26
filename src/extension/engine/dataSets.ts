// The data sets a compile can draw packages from (docs/DESIGN.md#store-and-packaging, #engine-and-data), read from disk without VS Code:
// the core data (inside this extension until the core-data package exists: dist/data/manifest.json and its
// packages.json), a data extension's folder (data/manifest.json, its package index, and its data image; see
// DataManifest for the contract), and the checks that a data set fits this engine: the same TeX Live year and the same engine ABI.
// One plain message when it does not.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { PACKING_T1C, type DataImageRef } from '../../shared/engineJobs';
import { INDEX_FORMAT, isPackageIndex, type PackageIndex } from '../../shared/packageIndex';
import type { PackageContext } from '../compile/pipeline';
import type { InstalledSet, KnownSet } from '../project/packageScan';

/** The parts of a data manifest the resolver reads. */
/**
 * The data manifest, data/manifest.json, format 1: the contract between the extension and its data, the core set
 * and every data extension (build gate 2, G2E-02; B1 builds to it).
 *
 *   format   1
 *   texLive  the TeX Live year (2026); must equal the extension's
 *   abi      the SHA-256 of the engine WebAssembly the data was built for; must equal the extension's; never empty
 *   image    the data itself, one image (a data extension may not ship a texmf tree of loose files):
 *              file   the image's .data file, beside the manifest
 *              index  its index (.index.json: the file list and chunk table, { compressed, metadata }), beside it
 *              bytes  the .data file's size; sha256 its SHA-256
 *            The image is Emscripten's file_packager LZ4 layout (scripts/lib/data-image.mjs); its file names are
 *            texmf-relative TDS paths with a leading "/" (/tex/latex/revtex/revtex4-2.cls). The engine host mounts
 *            it whole under /texmf-extra, searched after the user's package folder and before the core.
 *            The resolver and the engine host check the size, not the SHA-256 (reading 150 MB twice per session
 *            would cost more than it protects); the SHA-256 is the image's identity: with the id and version it
 *            is the key under which the engine host keeps and mounts it, so an update replaces it (G2E-R1).
 *            packed (core-data, B1) { method: "t1c", files }: the image's Type 1 fonts are stored with their
 *            eexec section and charstrings decrypted, so they compress (font packing: decided by the maintainer,
 *            2026-10-22). files maps each packed file's name to the SHA-256 of its original; the index carries the
 *            same list, and the engine host encrypts each file again when TeX reads it, checks the SHA-256, and
 *            serves the original bytes or, on a mismatch, none (src/engine-host/engine/t1c.ts). The engine host
 *            refuses an image whose index lists other packed files than this; the resolver refuses a data set
 *            packed with a method other than t1c (t1c gate, S-1 and S-6).
 *   no overlap  a data extension holds no file name that the core has: it is searched before the core, so an
 *            overlap would change the core's files for every document. The resolver refuses such a set; B1's
 *            builder checks it too (G2E-R3).
 *   version  the data set's version, part of the image's identity.
 *   snapshot (B1) the dated TeX Live snapshot the set was built from. When the core names one, a data extension
 *            must name the same: the core's font maps (pdftex.map) name the add-on's fonts, so the two come from
 *            one build (build gate B1, GB1E-06).
 *   index    the package index (file name to package; each package's files and requires), inline or { file }
 *   core     (core-data, B1) { root, formats }: the core's mount root (/texlive/texmf-dist, the worker's
 *            TEXMFDIST) and each format's path and SHA-256 (G2E-R3). The core image also holds the engine build's
 *            own files (ICU data, fontconfig's file, /etc, /bin), taken from the engine build's pinned image, so
 *            every core build needs that image too (GB1E-10). The interim core (TeXlyre's image) has no "core".
 *   elsewhere  (core only) the data sets this one knows of: their file lists, so a missing file can name the
 *            add-on that has it, and each package's requires, so the first message also names a dependency that
 *            no set has (build gate 2, G2S-04); B1's core manifest lists the real extra-data files and requires.
 */
export interface DataManifest {
  format: number;
  set?: string;
  texLive: number;
  /** The engine ABI the data was built for: the SHA-256 of the engine WebAssembly. */
  abi: string;
  version?: string;
  /** The TeX Live snapshot the set was built from (B1). */
  snapshot?: string;
  /** The data image (required for a data extension). */
  image?: { file: string; index?: string; bytes: number; sha256: string; packed?: { method: string; files: Record<string, string> } };
  /** The package index, inline or in a file beside the manifest. */
  index?: PackageIndex | { file: string };
  /** Data sets this one knows of, by extension name, with their file lists. */
  elsewhere?: Record<string, { set?: string; files: Record<string, string>; requires?: Record<string, string[]> }>;
}

export interface Expected {
  texLive: number;
  abi: string;
  /** The core's TeX Live snapshot, when it names one (B1): a data extension must come from the same one. */
  snapshot?: string;
}

/** Whether a data set fits this engine; a plain message when not. */
export function checkDataManifest(manifest: unknown, expected: Expected, label: string): { ok: true } | { ok: false; message: string } {
  const m = manifest as Partial<DataManifest> | null;
  if (!m || typeof m !== 'object' || m.format !== 1) {
    return { ok: false, message: `The ${label} has a data description this version cannot read. Update both to the same release.` };
  }
  if (m.texLive !== expected.texLive) {
    return {
      ok: false,
      message: `The ${label} is built from TeX Live ${String(m.texLive)}, but this version of the extension uses TeX Live ${expected.texLive}. Update both to the same release.`,
    };
  }
  if (typeof m.abi !== 'string' || m.abi === '' || !expected.abi || m.abi !== expected.abi) {
    return { ok: false, message: `The ${label} is built for a different engine build than this version of the extension. Update both to the same release.` };
  }
  // The core's font maps name the add-on's fonts, so the two must come from one build (build gate B1, GB1E-06).
  if (expected.snapshot !== undefined && m.snapshot !== expected.snapshot) {
    return {
      ok: false,
      message: `The ${label} is built from another TeX Live snapshot (${String(m.snapshot ?? 'none')}) than the core packages (${expected.snapshot}). Update both to the same release.`,
    };
  }
  // Files stored packed in a way this version cannot unpack: refused here, not deep in the engine host (t1c gate, S-6).
  const packed = (m.image as { packed?: { method?: unknown } } | undefined)?.packed;
  if (packed !== undefined && packed.method !== PACKING_T1C) {
    return { ok: false, message: `The ${label} stores some of its files in a form this version of the extension cannot read. Update both to the same release.` };
  }
  return { ok: true };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function indexOf(manifest: DataManifest, folder: string): Promise<PackageIndex | null> {
  const index = manifest.index;
  if (!index) {
    return null;
  }
  const value = 'file' in index && typeof index.file === 'string' ? await readJson(path.join(folder, path.basename(index.file))) : index;
  return isPackageIndex(value) ? value : null;
}

/** The core data inside this extension (dist/data). */
export async function readCoreData(dataDir: string): Promise<{ manifest: DataManifest; index: PackageIndex | null; elsewhere: KnownSet[] } | null> {
  let manifest: DataManifest;
  try {
    manifest = (await readJson(path.join(dataDir, 'manifest.json'))) as DataManifest;
  } catch {
    return null;
  }
  const elsewhere = Object.entries(manifest.elsewhere ?? {}).map(([id, e]) => ({ id, label: labelOf(id), files: e.files, requires: e.requires }));
  return { manifest, index: await indexOf(manifest, dataDir), elsewhere };
}

/** The user-facing name of a data set. */
export function labelOf(id: string): string {
  if (id.endsWith('-extra-data')) {
    return 'Extra Packages add-on';
  }
  if (id.endsWith('-core-data')) {
    return 'core data package';
  }
  return id === 'user' ? 'your package folder' : id;
}

/**
 * A data extension's folder: its manifest is checked against the engine, and its image (data/<image.file> and its
 * index) must be there with the size the manifest gives. The engine host mounts the image; nothing is copied.
 */
export async function readDataExtension(
  folder: string,
  id: string,
  expected: Expected,
): Promise<{ set: InstalledSet; image: DataImageRef } | { problem: string }> {
  const label = labelOf(id);
  let manifest: unknown;
  try {
    manifest = await readJson(path.join(folder, 'data', 'manifest.json'));
  } catch {
    return { problem: `The ${label} is installed, but its data description could not be read. Reinstall it.` };
  }
  const check = checkDataManifest(manifest, expected, label);
  if (!check.ok) {
    return { problem: check.message };
  }
  const index = await indexOf(manifest as DataManifest, path.join(folder, 'data'));
  if (!index) {
    return { problem: `The ${label} has no package list in format ${INDEX_FORMAT}. Update both to the same release.` };
  }
  const image = (manifest as DataManifest).image;
  if (!image || typeof image.file !== 'string' || typeof image.bytes !== 'number') {
    return { problem: `The ${label} has no data image. Update both to the same release.` };
  }
  const data = path.join(folder, 'data', path.basename(image.file));
  const indexFile = path.join(folder, 'data', path.basename(image.index ?? image.file.replace(/\.data$/i, '.index.json')));
  try {
    const [d] = await Promise.all([stat(data), stat(indexFile)]);
    if (d.size !== image.bytes) {
      throw new Error('size');
    }
  } catch {
    return { problem: `The ${label} is damaged: its data image is missing or has the wrong size. Reinstall it.` };
  }
  // The image's identity: the set, its version and its content (G2E-R1).
  const version = String((manifest as DataManifest).version ?? '0');
  return { set: { id, label, index }, image: { id, data, index: indexFile, version, sha256: String(image.sha256) } };
}

/** The package context for a compile from the parts the resolver found. */
export function packageContext(
  core: { index: PackageIndex | null; elsewhere: KnownSet[] } | null,
  installed: PackageContext['installed'],
): PackageContext {
  const ids = new Set(installed.map((i) => i.set.id));
  return {
    core: core?.index ?? null,
    installed,
    // A set that is installed is no longer "elsewhere".
    elsewhere: (core?.elsewhere ?? []).filter((e) => !ids.has(e.id)),
  };
}
