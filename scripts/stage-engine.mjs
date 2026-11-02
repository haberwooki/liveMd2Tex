#!/usr/bin/env node
// Development tool: puts the engine (and, with --data, the core TeX data) inside dist/ so that F5, the integration
// tests and a test-copy VSIX find them where the extension looks (src/extension/engine/engineService.ts):
//   dist/engine/  engine.js and engine.wasm (our engine release, pinned in engine/pins.json as livemd2tex-engine,
//                 from ../engine_assets/<its folder>/), texmf-override.cnf
//   dist/data/    the data/ folder of a core-data package: manifest.json, the image and its index, licences.json;
//                 and its LICENSES/ folder as dist/data/LICENSES/
// The engine's files are hard links to ../engine_assets when the file system allows, so nothing is copied twice;
// they are checked against engine/pins.json first (size and SHA-256). The core data is hard-linked too when it is
// given as an unpacked package folder (the data builder's <out>/core-data/); a .vsix is unpacked instead, about
// 180 MB written on each run. build.mjs empties dist/, so run this after it.
//
//   node scripts/stage-engine.mjs [--data [--data-package PATH]] [--if-present]
// --data: stages a core-data package built for this engine (its manifest's abi must be the pinned engine.wasm's
//         SHA-256), as a .vsix or as the package's unpacked folder (the one with data/ and LICENSES/):
//         --data-package PATH, else the path the variable LIVEMD2TEX_CORE_DATA names (so npm run test:engine, which
//         stages with --data alone, finds a local build), else the package engine/pins.json pins as
//         livemd2tex-core-data, from ../engine_assets/<its folder>/ (scripts/engine-assets.mjs downloads it, and
//         it is checked against its pinned size and SHA-256: scripts/lib/data-pins.mjs, checkedDataPackage). The
//         package is checked before dist/data is replaced.
// --if-present: when an input is simply not there, say so and stop without an error, and the engine tests then
//         skip: the engine downloads are missing (a fresh clone, CI), --data has no package (none given and none
//         pinned), or the pinned package is not downloaded (on a laptop, or on CI before both data packages are
//         pinned). Anything else (a file of the wrong size or hash, a package that is not there or not built for
//         this engine, a pinned package missing on CI once both are pinned) still fails.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkedDataPackage } from './lib/data-pins.mjs';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The pin of our engine release in engine/pins.json. */
export const ENGINE_SOURCE = 'livemd2tex-engine';
/** The engine's files dist/engine holds, by the release's names. */
export const ENGINE_FILES = ['engine.js', 'engine.wasm'];

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function linkOrCopy(from, to) {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
    return 'linked';
  } catch {
    copyFileSync(from, to);
    return 'copied';
  }
}

/** An input that is simply not there: the one error --if-present passes over. */
export class NotPresent extends Error {}

/** The pinned engine's source in engine/pins.json and its folder under ../engine_assets. */
export function enginePin(repo = root) {
  const pins = JSON.parse(readFileSync(path.join(repo, 'engine', 'pins.json'), 'utf8'));
  const source = pins.sources.find((s) => s.id === ENGINE_SOURCE);
  if (!source) {
    throw new Error(`engine/pins.json has no ${ENGINE_SOURCE} source`);
  }
  return { source, dir: path.join(repo, '..', 'engine_assets', source.folder) };
}

/**
 * The files of an unpacked core-data package folder: data/ as they are, LICENSES/ under LICENSES/. Each entry is
 * [path under dist/data, a reader of its bytes, the file to link].
 */
function folderFiles(dir) {
  const out = [];
  const walk = (from, prefix) => {
    if (!existsSync(from)) return;
    for (const name of readdirSync(from)) {
      const file = path.join(from, name);
      if (statSync(file).isDirectory()) walk(file, `${prefix}${name}/`);
      else out.push([`${prefix}${name}`, () => readFileSync(file), file]);
    }
  };
  walk(path.join(dir, 'data'), '');
  walk(path.join(dir, 'LICENSES'), 'LICENSES/');
  return out;
}

/** The same from a .vsix: extension/data/ and extension/LICENSES/, read from the archive (nothing to link). */
function zipFiles(file) {
  const entries = readZip(readFileSync(file));
  const out = [];
  for (const [n, bytes] of entries) {
    if (n.endsWith('/')) continue;
    if (n.startsWith('extension/data/')) out.push([n.slice('extension/data/'.length), () => bytes, null]);
    else if (n.startsWith('extension/LICENSES/')) out.push([`LICENSES/${n.slice('extension/LICENSES/'.length)}`, () => bytes, null]);
  }
  return out;
}

export function stageEngine({ data = false, dataPackage = null } = {}) {
  const { source, dir } = enginePin();
  const checked = (name) => {
    const pin = source.files.find((f) => f.name === name);
    const file = path.join(dir, name);
    if (!pin) {
      throw new Error(`engine/pins.json pins no ${name}`);
    }
    if (!existsSync(file)) {
      throw new NotPresent(`${name} is not downloaded; run node scripts/engine-assets.mjs --source ${ENGINE_SOURCE}`);
    }
    if (statSync(file).size !== pin.size) {
      throw new Error(`${name} has the wrong size; run node scripts/engine-assets.mjs --source ${ENGINE_SOURCE}`);
    }
    if (sha256File(file) !== pin.sha256) {
      throw new Error(`${name} is not the pinned file (SHA-256 ${pin.sha256}); run node scripts/engine-assets.mjs --source ${ENGINE_SOURCE}`);
    }
    return file;
  };
  const engineDir = path.join(root, 'dist', 'engine');
  rmSync(engineDir, { recursive: true, force: true });
  mkdirSync(engineDir, { recursive: true });
  const how = ENGINE_FILES.map((name) => linkOrCopy(checked(name), path.join(engineDir, name)));
  copyFileSync(path.join(root, 'engine', 'texmf-override.cnf'), path.join(engineDir, 'texmf-override.cnf'));
  const report = [`dist/engine: ${ENGINE_FILES.map((n, i) => `${n} (${how[i]})`).join(', ')}, texmf-override.cnf`];

  const dataDir = path.join(root, 'dist', 'data');
  const wasm = source.files.find((f) => f.name === 'engine.wasm').sha256;
  if (!data) {
    rmSync(dataDir, { recursive: true, force: true });
    return report;
  }
  if (!dataPackage) {
    dataPackage = pinnedCoreData();
  }
  if (!existsSync(dataPackage)) {
    throw new Error(`${dataPackage} is not there: give a core-data package built for this engine`);
  }
  // The package's files, as [path under dist/data, how to put it there], checked before dist/data is replaced.
  const folder = existsSync(dataPackage) && statSync(dataPackage).isDirectory();
  const files = folder ? folderFiles(dataPackage) : zipFiles(dataPackage);
  if (!files.some(([rel]) => rel === 'manifest.json')) {
    throw new Error(`${dataPackage} holds no data/manifest.json`);
  }
  const manifest = JSON.parse(files.find(([rel]) => rel === 'manifest.json')[1]().toString('utf8'));
  if (manifest.abi !== wasm) {
    throw new Error(`${path.basename(dataPackage)} was built for the engine ${manifest.abi}, not the pinned ${wasm}`);
  }
  rmSync(dataDir, { recursive: true, force: true });
  const ways = new Map();
  for (const [rel, bytes, from] of files) {
    const out = path.join(dataDir, ...rel.split('/'));
    mkdirSync(path.dirname(out), { recursive: true });
    const way = from ? linkOrCopy(from, out) : (writeFileSync(out, bytes()), 'written');
    ways.set(way, (ways.get(way) ?? 0) + 1);
  }
  const summary = [...ways].map(([w, n]) => `${n} ${w}`).join(', ');
  report.push(`dist/data: ${files.length} files from ${path.basename(dataPackage)} (${summary}; image ${manifest.image?.file}, ${manifest.image?.bytes} bytes)`);
  return report;
}

/**
 * The data package of livemd2tex-core-data's pin (engine/pins.json), downloaded into ../engine_assets and checked
 * (checkedDataPackage: a file of another size or SHA-256 throws, and so does a missing one on CI once both data
 * packages are pinned). NotPresent when nothing is pinned, or when the pinned file is not downloaded otherwise.
 */
export function pinnedCoreData(repo = root, env = process.env) {
  const pins = JSON.parse(readFileSync(path.join(repo, 'engine', 'pins.json'), 'utf8'));
  const pinned = checkedDataPackage(pins, 'livemd2tex-core-data', path.join(repo, '..', 'engine_assets'), env);
  if (!pinned) {
    throw new NotPresent('no core-data package is pinned yet: give --data-package PATH (or LIVEMD2TEX_CORE_DATA), a livemd2tex-core-data .vsix or unpacked package folder built for this engine');
  }
  if (pinned.missing) {
    throw new NotPresent(`the pinned core-data package ${path.basename(pinned.path)} is not downloaded; run node scripts/engine-assets.mjs`);
  }
  return pinned.path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--data-package');
  try {
    const dataPackage = at >= 0 ? process.argv[at + 1] : process.env.LIVEMD2TEX_CORE_DATA || null;
    console.log(stageEngine({ data: process.argv.includes('--data'), dataPackage }).join('\n'));
  } catch (err) {
    if (!(err instanceof NotPresent) || !process.argv.includes('--if-present')) {
      throw err;
    }
    console.log(`stage-engine: skipped (${err.message})`);
  }
}
