#!/usr/bin/env node
// Development tool (never shipped): fetches the pinned engine and TeX inputs of engine/pins.json into a folder
// OUTSIDE the repository (default: ../engine_assets), one folder per source, and checks every file's size and
// SHA-256. Files already present are re-checked, not re-downloaded. Downloads are data: nothing here runs them. A
// source marked "published": null (an engine or data release that is still a draft, whose files cannot be
// downloaded anonymously) is never fetched: a missing file of it fails with a message that says so and what to do.
// A file with "from" is a member of one of its source's "archives" (a .tar.xz with its size and SHA-512, as the test
// inputs' release holds them: scripts/lib/test-inputs.mjs): the archive is downloaded and checked, the file unpacked
// from it with our own xz and tar readers (scripts/lib/xz.mjs, tar.mjs) and checked, and the archive deleted, so the
// folder holds the same files as when each was fetched alone.
//
//   node scripts/engine-assets.mjs [--root DIR] [--source ID] [--verify]

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { archiveProblem, unpackMembers } from './lib/test-inputs.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Why a pinned file cannot be downloaded, or null when it can: a source whose release is not published yet
 * ("published": null in engine/pins.json) has addresses that only work once it is.
 */
export function unpublishedProblem(source, dir) {
  if (!('published' in source) || source.published) {
    return null;
  }
  return `the release ${source.tag ?? source.id} is not published yet (engine/pins.json: "published": null), so its files cannot be downloaded. Publish it, or put its files into ${dir} by hand${source.note ? ` (the pin's note: ${source.note})` : ''}`;
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

async function download(url, file, fetchImpl) {
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'latex-preview-s1-assets' } });
  if (!res.ok || !res.body) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, file);
}

/**
 * Fetches and checks every pinned file of `pins` (engine/pins.json, parsed) under `assetsRoot`; with `only`, the
 * files of that source only; with `verify`, it checks and downloads nothing. Returns the failures and the bytes
 * checked.
 * @param {{ sources: object[] }} pins
 * @param {string} assetsRoot
 * @param {{ only?: string, verify?: boolean, fetchImpl?: typeof fetch, log?: (s: string) => void, error?: (s: string) => void }} options
 */
export async function syncAssets(pins, assetsRoot, { only, verify = false, fetchImpl = fetch, log = console.log, error = console.error } = {}) {
  let failures = 0;
  let bytes = 0;
  const fail = (source, pin, why) => {
    failures++;
    error(`FAIL ${source.id}/${pin.name}: ${why}`);
  };
  for (const source of pins.sources) {
    if (only && source.id !== only) {
      continue;
    }
    const dir = path.join(assetsRoot, source.folder);
    mkdirSync(dir, { recursive: true });
    const fileOf = (pin) => path.join(dir, ...pin.name.split('/'));
    /** The files that are not there as pinned, with why; the others are counted. */
    const wanting = [];
    for (const pin of source.files) {
      const status = await check(fileOf(pin), pin);
      if (status === 'ok') {
        bytes += pin.size;
      } else {
        wanting.push({ pin, status });
      }
    }
    if (wanting.length === 0) {
      continue;
    }
    const unpublished = unpublishedProblem(source, dir);
    if (unpublished || verify) {
      wanting.forEach(({ pin, status }) => fail(source, pin, unpublished ? `${status}; ${unpublished}` : status));
      continue;
    }
    // Files fetched alone.
    for (const { pin } of wanting.filter((w) => !w.pin.from)) {
      const file = fileOf(pin);
      mkdirSync(path.dirname(file), { recursive: true });
      const t0 = Date.now();
      await download(pin.url, file, fetchImpl);
      const status = await check(file, pin);
      log(`fetched ${source.id}/${pin.name} (${pin.size} B) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (status === 'ok') bytes += pin.size;
      else fail(source, pin, status);
    }
    // Files unpacked from an archive: one download per archive.
    const byArchive = new Map();
    for (const w of wanting.filter((x) => x.pin.from)) {
      byArchive.set(w.pin.from, [...(byArchive.get(w.pin.from) ?? []), w.pin]);
    }
    for (const [name, list] of byArchive) {
      const archive = (source.archives ?? []).find((a) => a.name === name);
      if (!archive) {
        list.forEach((pin) => fail(source, pin, `its archive ${name} is not one of the source's archives`));
        continue;
      }
      const tmp = path.join(dir, `.${name}`);
      let members;
      try {
        const t0 = Date.now();
        await download(archive.url, tmp, fetchImpl);
        const data = readFileSync(tmp);
        const problem = archiveProblem(data, archive);
        if (problem) throw new Error(problem);
        members = unpackMembers(data, list.map((pin) => pin.path));
        log(`fetched ${source.id}/${name} (${archive.size} B) in ${((Date.now() - t0) / 1000).toFixed(1)} s; unpacking ${list.length} file(s)`);
      } catch (err) {
        list.forEach((pin) => fail(source, pin, `from ${name}: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      } finally {
        rmSync(tmp, { force: true });
      }
      for (const pin of list) {
        const file = fileOf(pin);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, members.get(pin.path));
        const status = await check(file, pin);
        if (status === 'ok') bytes += pin.size;
        else fail(source, pin, `${status} (unpacked from ${name})`);
      }
    }
  }
  return { failures, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const assetsRoot = path.resolve(arg('--root') ?? path.join(repo, '..', 'engine_assets'));
  if (path.relative(repo, assetsRoot).split(path.sep)[0] !== '..') {
    console.error(`Refusing to put engine assets inside the repository: ${assetsRoot}`);
    process.exit(2);
  }
  const pins = JSON.parse(readFileSync(path.join(repo, 'engine', 'pins.json'), 'utf8'));
  const { failures, bytes } = await syncAssets(pins, assetsRoot, { only: arg('--source'), verify: process.argv.includes('--verify') });
  console.log(`${failures === 0 ? 'all pinned files verified' : `${failures} file(s) failed`} (${(bytes / 1048576).toFixed(1)} MiB) under ${assetsRoot}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
