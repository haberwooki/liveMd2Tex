#!/usr/bin/env node
// B1's cleanup command (docs/DESIGN.md#engine-and-data): deletes from a development machine what S1 and V0 put
// there until B1's data sets replace it: the engine build's interim TeX image (texlive-extra.data and its loader
// files, about 340 MB), the pinned CTAN files the corpus and the stand-ins read (ctan-* folders), and the derived
// package index of the interim image. The engine itself (busytex.wasm and its glue) stays.
//
//   node scripts/clean-interim-data.mjs            list what would go, and why it may go
//   node scripts/clean-interim-data.mjs --yes      delete it
//
// It refuses while the interim image is still in use: dist/data must hold B1's core-data (its manifest says
// "set": "core-data"), staged from the bundle, so the extension and the tests no longer read the interim image.
//
// The image goes from this machine only. Every core-data build still needs it: the core image takes the engine
// build's own files from it (ICU data, fontconfig's file, /etc, /bin; scripts/lib/bundle.mjs, engineSupportFiles).
// The bundle workflow fetches it again from engine/pins.json and checks it there (build gate B1, GB1E-10).

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bytes under a path. */
function size(p) {
  const s = statSync(p);
  if (!s.isDirectory()) {
    return s.size;
  }
  return readdirSync(p).reduce((n, name) => n + size(path.join(p, name)), 0);
}

/** What the cleanup deletes, from the pins: [{ path, bytes, why }]. */
export function cleanupList(root = repoRoot, assets = path.join(root, '..', 'engine_assets')) {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
  const out = [];
  const add = (p, why) => {
    if (existsSync(p)) {
      out.push({ path: p, bytes: size(p), why });
    }
  };
  const tl = pins.sources.find((s) => s.id === 'texlyre-busytex');
  if (tl) {
    for (const f of tl.files.filter((x) => /^texlive-extra\./.test(x.name))) {
      add(path.join(assets, tl.folder, f.name), "the engine build's interim TeX image; B1's core-data replaces it");
    }
  }
  for (const source of pins.sources.filter((s) => s.id.startsWith('ctan-') || s.folder?.startsWith('ctan-'))) {
    add(path.join(assets, source.folder), 'pinned CTAN files read until B1; core-data and extra-data hold them now');
  }
  const derived = path.join(assets, 'derived');
  if (existsSync(derived)) {
    for (const name of readdirSync(derived).filter((n) => n.startsWith('package-index-'))) {
      add(path.join(derived, name), "the interim image's package index");
    }
  }
  return out;
}

/** Whether dist/data holds B1's core-data, so the interim image is no longer read. */
export function b1DataStaged(root = repoRoot) {
  const manifest = path.join(root, 'dist', 'data', 'manifest.json');
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).set === 'core-data';
  } catch {
    return false;
  }
}

export function main(argv, root = repoRoot, assets = path.join(root, '..', 'engine_assets')) {
  const list = cleanupList(root, assets);
  const total = list.reduce((n, x) => n + x.bytes, 0);
  for (const x of list) {
    console.log(`${(x.bytes / 1e6).toFixed(1).padStart(8)} MB  ${path.relative(path.join(root, '..'), x.path)}  (${x.why})`);
  }
  console.log(`${(total / 1e6).toFixed(1)} MB in ${list.length} item(s)`);
  console.log("Every core-data build still needs the engine build's image; the bundle workflow fetches it again from engine/pins.json.");
  if (!argv.includes('--yes')) {
    console.log('Nothing deleted. Run again with --yes to delete these.');
    return 0;
  }
  if (!b1DataStaged(root)) {
    console.error("Refused: dist/data does not hold B1's core-data yet, so the interim image is still in use.");
    return 1;
  }
  for (const x of list) {
    rmSync(x.path, { recursive: true, force: true });
  }
  console.log('Deleted.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
