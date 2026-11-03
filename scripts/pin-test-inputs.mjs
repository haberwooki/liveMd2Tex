#!/usr/bin/env node
// Development tool: pins the CTAN test inputs (engine/pins.json's ctan-* sources) to the test inputs' release,
// test-inputs-<snapshot date>-<n> (.github/workflows/test-inputs.yml; scripts/lib/test-inputs.mjs). It reads the
// release's test-inputs.json and its archives from a folder (a download of the release, or the workflow's
// assets), checks each archive against the list's size and SHA-512 and the list against engine/bundle-pins.json's
// tlpdb, unpacks each pinned file and checks it against its pin, and only then writes each source's release, tag,
// "published": null, archives (those a file is unpacked from) and each file's "from" and "path". The sizes and
// SHA-256 of the files never change here: a file that is not its pin stops the tool. It opens no connection.
//
//   node scripts/pin-test-inputs.mjs --release DIR [--published YYYY-MM-DD]

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVTEX, TAG, TEST_INPUTS, archiveName, archiveProblem, fileProblem, packageArchives, unpackMembers } from './lib/test-inputs.mjs';
import { parseTlpdb } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/haberwooki/liveMd2Tex';

/**
 * engine/pins.json (parsed) with the ctan-* sources pinned to the release `list` (its test-inputs.json); `read`
 * gives a release file's bytes by name. Throws on any file that is not as listed or pinned.
 */
export function pinToRelease(pins, list, read, bundlePins, published = null) {
  if (!TAG.test(list.tag)) throw new Error(`not a test inputs tag: ${list.tag}`);
  if (list.tlpdb.sha256 !== bundlePins.tlpdb.sha256) throw new Error(`the release's tlpdb is not the pinned one (${bundlePins.tlpdb.sha256})`);
  if (published !== null && !/^\d{4}-\d{2}-\d{2}$/.test(published)) throw new Error(`published must be a date (YYYY-MM-DD), not ${published}`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const tlpdb = read('texlive.tlpdb.xz');
  if (sha(tlpdb) !== list.tlpdb.sha256) throw new Error('texlive.tlpdb.xz is not the listed file');
  // Each listed archive must be the one the pinned tlpdb gives its package.
  const db = parseTlpdb(Buffer.from(unxz(tlpdb)).toString('utf8'));
  for (const a of list.archives) {
    const want = packageArchives(db, a.package).find((x) => x.name === a.name);
    if (!want || want.sha512 !== a.sha512 || want.size !== a.size) throw new Error(`${a.name}: the release's list does not give the pinned tlpdb's size and SHA-512`);
  }
  const url = (name) => `${REPOSITORY}/releases/download/${list.tag}/${name}`;
  const release = { release: `${REPOSITORY}/releases/tag/${list.tag}`, tag: list.tag, published };
  const out = structuredClone(pins);
  for (const source of out.sources.filter((s) => s.id.startsWith('ctan-'))) {
    const entry = TEST_INPUTS[source.id];
    if (!entry && source.id !== REVTEX.source) throw new Error(`${source.id} has no entry in scripts/lib/test-inputs.mjs`);
    if (!entry) {
      const pin = source.files.find((f) => f.name === REVTEX.file);
      const problem = fileProblem(read(REVTEX.file), pin);
      if (problem) throw new Error(`${source.id}: ${problem}`);
      Object.assign(source, release);
      pin.url = url(REVTEX.file);
      continue;
    }
    const used = new Map();
    for (const pin of source.files) {
      const at = entry.files[pin.name];
      if (!at) throw new Error(`${source.id}: ${pin.name} has no archive and path in scripts/lib/test-inputs.mjs`);
      const name = archiveName(entry.package, at[0]);
      const listed = list.archives.find((a) => a.name === name);
      if (!listed) throw new Error(`${source.id}: the release lists no ${name}`);
      if (!used.has(name)) {
        const bytes = read(name);
        const problem = archiveProblem(bytes, listed);
        if (problem) throw new Error(problem);
        used.set(name, { listed, bytes, pins: [] });
      }
      used.get(name).pins.push([pin, at[1]]);
    }
    for (const [name, { bytes, pins: list2 }] of used) {
      const members = unpackMembers(bytes, list2.map(([, p]) => p));
      for (const [pin, p] of list2) {
        const problem = fileProblem(members.get(p), pin);
        if (problem) throw new Error(`${source.id}: ${problem} (unpacked from ${name})`);
      }
    }
    Object.assign(source, release);
    source.archives = [...used.values()].map(({ listed }) => ({ name: listed.name, url: url(listed.name), size: listed.size, sha512: listed.sha512 }));
    source.files = source.files.map((pin) => {
      const at = entry.files[pin.name];
      return { name: pin.name, from: archiveName(entry.package, at[0]), path: at[1], size: pin.size, sha256: pin.sha256 };
    });
  }
  // Each ctan-* source's fields in the order the engine's and the data packages' pins have them: who it is, the
  // release, what it is, then the archives and the files.
  const order = ['id', 'folder', 'release', 'tag', 'published', 'package', 'licence', 'note', 'pinned', 'archives', 'files'];
  out.sources = out.sources.map((s) => (s.id.startsWith('ctan-') ? Object.fromEntries([...order.filter((k) => k in s).map((k) => [k, s[k]]), ...Object.entries(s).filter(([k]) => !order.includes(k))]) : s));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const dir = arg('--release');
  if (!dir) {
    console.error('give --release DIR, a folder with the release test-inputs-<date>-<n> (its test-inputs.json and archives)');
    process.exit(2);
  }
  const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const pinsFile = path.join(root, 'engine', 'pins.json');
  try {
    const list = readJson(path.join(dir, 'test-inputs.json'));
    const out = pinToRelease(readJson(pinsFile), list, (name) => readFileSync(path.join(dir, name)), readJson(path.join(root, 'engine', 'bundle-pins.json')), arg('--published') ?? null);
    writeFileSync(pinsFile, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`engine/pins.json: the ctan-* sources now come from ${list.tag}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
