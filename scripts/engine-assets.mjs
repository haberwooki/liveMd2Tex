#!/usr/bin/env node
// Development tool (never shipped): fetches the pinned engine and TeX inputs of engine/pins.json into a folder
// OUTSIDE the repository (default: ../engine_assets), one folder per source, and checks every file's size and
// SHA-256. Files already present are re-checked, not re-downloaded. Downloads are data: nothing here runs them.
//
//   node scripts/engine-assets.mjs [--root DIR] [--source ID] [--verify]

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
export const assetsRoot = path.resolve(arg('--root') ?? path.join(repo, '..', 'engine_assets'));
const onlySource = arg('--source');
const verifyOnly = process.argv.includes('--verify');

if (path.relative(repo, assetsRoot).split(path.sep)[0] !== '..') {
  console.error(`Refusing to put engine assets inside the repository: ${assetsRoot}`);
  process.exit(2);
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function check(file, pin) {
  if (!existsSync(file)) {
    return 'missing';
  }
  if (statSync(file).size !== pin.size) {
    return `size ${statSync(file).size}, pinned ${pin.size}`;
  }
  const digest = await sha256(file);
  return digest === pin.sha256 ? 'ok' : `sha256 ${digest}, pinned ${pin.sha256}`;
}

async function download(url, file) {
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'latex-preview-s1-assets' } });
  if (!res.ok || !res.body) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, file);
}

const pins = JSON.parse(readFileSync(path.join(repo, 'engine', 'pins.json'), 'utf8'));
let failures = 0;
let bytes = 0;
for (const source of pins.sources) {
  if (onlySource && source.id !== onlySource) {
    continue;
  }
  const dir = path.join(assetsRoot, source.folder);
  mkdirSync(dir, { recursive: true });
  for (const pin of source.files) {
    const file = path.join(dir, ...pin.name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    let status = await check(file, pin);
    if (status !== 'ok' && !verifyOnly) {
      const t0 = Date.now();
      await download(pin.url, file);
      status = await check(file, pin);
      console.log(`fetched ${source.id}/${pin.name} (${pin.size} B) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    bytes += pin.size;
    if (status !== 'ok') {
      failures++;
      console.error(`FAIL ${source.id}/${pin.name}: ${status}`);
    }
  }
}
console.log(`${failures === 0 ? 'all pinned files verified' : `${failures} file(s) failed`} (${(bytes / 1048576).toFixed(1)} MiB) under ${assetsRoot}`);
process.exitCode = failures === 0 ? 0 : 1;
