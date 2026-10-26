#!/usr/bin/env node
// B1, the bundle builder (docs/DESIGN.md#engine-and-data): builds core-data and extra-data from one pinned TeX Live
// snapshot (engine/bundle-pins.json) and the selection in engine/bundle-sets.json. It runs on CI; it never runs on a
// development machine except on the tiny fixtures of its tests. It starts no program but the
// extension's own engine host, and refuses python and perl from its first line on (build gate B1, GB1E-08).
//
//   node scripts/build-bundle.mjs --stage pin --signed-sha512 FILE --signed-by FINGERPRINT
//   node scripts/build-bundle.mjs --stage fetch
//   node scripts/build-bundle.mjs --stage build [--skip-engine] [--no-package] [--version 2026.10.15]
//   node scripts/build-bundle.mjs --stage closure [--closure core|extra|all] [--shard 0/4] [--hosts 3]   (core by default)
//   (no --stage: fetch, build and closure in one run)
// Common options: --out ../bundle-out, --cache ../bundle-cache, --local DIR, --curl-config FILE, --pins FILE,
// --sets FILE, --licences FILE (engine/bundle-licences.json), --allow-missing, --engine-assets DIR, --engine-image DIR.
//
// --local DIR: the snapshot's files as the workflow downloaded them, in the mirror's layout
// (tlpkg/texlive.tlpdb.xz, archive/<name>.tar.xz, and the <name>.doc.tar.xz and <name>.source.tar.xz archives that
// licence texts come from). The builder then opens no connection at all. Every file is still
// checked: the tlpdb against the pin, each archive against the tlpdb's SHA-512. The workflow downloads with curl,
// because texlive.info's bot check lets only curl and wget through; the builder does not pretend to be either.
// --curl-config FILE (fetch stage, with --local): lists every archive that is missing or wrong in DIR as a curl
// config (url and output pairs), instead of failing; the workflow downloads them with curl and runs the stage again.
//
// Before the build and closure stages: node scripts/engine-assets.mjs, node scripts/engine-patch.mjs,
// node scripts/build.mjs, npm run compile and node scripts/stage-engine.mjs --data (the engine, its host, the client
// in out/, and the engine build's image, whose support files the core image takes).
//
// The stages:
//  pin      The tlpdb from the snapshot, checked against TeX Live's signed SHA-512. The workflow verifies the
//           signature with gpg first; --signed-by gives the key gpg reported, and it must be the TeX Live key whose
//           fingerprint engine/bundle-pins.json pins (GB1E-02). Then the selection is run against the tlpdb, every
//           package that is not plainly free is listed (GB1E-01), and the "tlpdb" entry to pin is printed: its
//           SHA-256, the signed SHA-512 and a note that the signature was checked.
//  fetch    The tlpdb checked against the pin (which must say the signature was checked); the two sets chosen;
//           every archive fetched into the cache and checked against the tlpdb's SHA-512, with the doc and source
//           archives the licence texts need (scripts/lib/licence-texts.mjs).
//  build    The archives unpacked by our own xz and tar readers; every run file the tlpdb lists must be there;
//           the generated files (fmtutil.cnf, updmap.cfg, language.dat/.def/.dat.lua, pdftex.map, kanjix.map) and
//           ls-R; core-data and extra-data may share no file. Each data package's LICENSES/ (the licence texts its
//           packages' licences require, and LICENSES/INDEX; a missing text stops the build). With the engine: pdflatex.fmt and xelatex.fmt in
//           initex mode, and the hyphenation patterns' cost. Then the images (LZ4 chunks), the manifests
//           (DataManifest format 1; core-data adds its mount root, its formats with their SHA-256, and
//           extra-data's files and requires), licences.json, the closure test's targets, the selection
//           (selection.json: every package of each set, for the reference install), and the data packages
//           (VSIX) under 262,144,000 bytes.
//  closure  Every target the build listed (each class, and each .sty of a package's own folder) loads alone in a
//           minimal document on the built images; a shard takes every n-th package.
// Each stage writes report-<stage>.json and .txt into --out after every step, and once more on an error, so a
// failed run keeps what it found (GB1E-03).

import childProcess from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { archiveFile, CORE_ROOT, coreImageFiles, engineSupportFiles, extraImageFiles, fetchArchive, generatedFiles, isProgramFile, licenceGroup, licenceOf, overlap, packType1, selectSets, sizeBreakdown, sha256, sha512, sizeTable, unpackPackage } from './lib/bundle.mjs';
import { buildDataImage } from './lib/data-image.mjs';
import { archiveTexts, classifyFonts, gplChanges, gplChangesPaths, isLicenceFile, licenceArchives, licenceFolder, loadTexts } from './lib/licence-texts.mjs';
import { openImage } from './lib/image-files.mjs';
import { buildPackageIndex } from './lib/package-index.mjs';
import { licenceClass, parseTlpdb, texmfPath } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The store's largest package (the VS Code Marketplace's limit). */
export const MAX_PACKAGE = 262144000;

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** child_process's functions as they were before the guard, while it is on. */
let unguarded = null;

/**
 * Refuses python and perl in this process from here on (the plan's rule for the whole builder; GB1E-08): as the
 * program, as the first word of a command line, and as a fork's execPath. A guard inside the process, not a sandbox.
 */
export function guardPrograms() {
  const refuse = (file) => {
    if (/(^|[\\/])(python[0-9.]*|perl)(\.exe)?$/i.test(String(file))) {
      throw new Error(`B1: the builder may not start ${file}`);
    }
  };
  if (unguarded) {
    return;
  }
  unguarded = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'].map((n) => [n, childProcess[n]]));
  const refuseCall = (program, rest) => {
    refuse(program);
    for (const a of rest) {
      if (a && typeof a === 'object' && !Array.isArray(a) && a.execPath) {
        refuse(a.execPath);
      }
    }
  };
  // Each wrapper keeps the original's own properties; util.promisify's form of exec and execFile is guarded too.
  const custom = promisify.custom;
  const wrap = (original, programOf) => {
    const check = (first, rest) => refuseCall(programOf(first), rest);
    const own = Object.getOwnPropertyDescriptors(original);
    delete own[custom];
    const wrapper = Object.defineProperties((first, ...rest) => (check(first, rest), original(first, ...rest)), own);
    if (typeof original[custom] === 'function') {
      Object.defineProperty(wrapper, custom, { value: (first, ...rest) => (check(first, rest), original[custom](first, ...rest)) });
    }
    return wrapper;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = wrap(childProcess[name], (file) => file);
  }
  for (const name of ['exec', 'execSync']) {
    childProcess[name] = wrap(childProcess[name], (command) => String(command).trim().split(/\s+/)[0]);
  }
  syncBuiltinESMExports();
}

/** Takes the guard off again: for the builder's tests, which share their process with other tests. */
export function releaseProgramGuard() {
  if (unguarded) {
    Object.assign(childProcess, unguarded);
    unguarded = null;
    syncBuiltinESMExports();
  }
}

/** The mirrors of the pinned snapshot, with its date filled in. */
export const mirrorsOf = (pins) => pins.mirrors.map((m) => m.replace('{snapshot}', pins.snapshot));

/**
 * Whether TeX Live's signed checksum file (texlive.tlpdb.sha512: "<sha512>  texlive.tlpdb") vouches for the tlpdb:
 * its hash must be that of the decoded tlpdb (or, should a snapshot sign the compressed file, of the .xz).
 */
export function checkSignedHash(signedText, tlpdbXz, tlpdbText) {
  const hash = /^([0-9a-f]{128})\b/i.exec(signedText.trim())?.[1]?.toLowerCase();
  if (!hash) {
    return { ok: false, reason: 'the checksum file holds no SHA-512' };
  }
  if (hash === sha512(Buffer.from(tlpdbText, 'utf8'))) {
    return { ok: true, matched: 'texlive.tlpdb', sha512: hash };
  }
  if (hash === sha512(tlpdbXz)) {
    return { ok: true, matched: 'texlive.tlpdb.xz', sha512: hash };
  }
  return { ok: false, reason: 'the signed SHA-512 is not the fetched tlpdb\'s' };
}

async function getFile(pins, local, rel, fetchImpl) {
  if (local) {
    const file = path.join(local, rel);
    if (!existsSync(file)) {
      throw new Error(`${rel} is not in the downloaded copy (${local})`);
    }
    return readFileSync(file);
  }
  const errors = [];
  for (const base of mirrorsOf(pins)) {
    try {
      const res = await fetchImpl(`${base}${rel}`);
      if (res.ok) {
        return Buffer.from(await res.arrayBuffer());
      }
      errors.push(`${base}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error(`${rel} could not be fetched: ${errors.join('; ')}`);
}

/** The pinned engine build's image files (texlive-extra.data with its index), by absolute path without "/". */
function pinnedEngineImage(dir) {
  const index = readJson(path.join(dir, 'texlive-extra.index.json'));
  const reader = openImage(path.join(dir, 'texlive-extra.data'), index.compressed);
  return new Map(index.metadata.files.map((f) => [f.filename.slice(1), reader.read(f.start, f.end)]));
}

/**
 * Writes an image and its index. `packed` (file name -> SHA-256 of the original) names the files stored with t1c;
 * the index and the manifest's image entry both carry it, the index for the engine host, which unpacks them.
 */
function writeImage(dir, name, files, options, packed = {}) {
  const image = buildDataImage(files, options);
  const t1c = Object.keys(packed).length > 0 ? { packed: { method: 't1c', files: packed } } : {};
  const index = { ...image.index, metadata: { ...image.index.metadata, ...t1c } };
  writeFileSync(path.join(dir, `${name}.data`), image.data);
  writeFileSync(path.join(dir, `${name}.index.json`), `${JSON.stringify(index)}\n`);
  return { file: `${name}.data`, index: `${name}.index.json`, bytes: image.bytes, sha256: image.sha256, ...t1c };
}

const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);

/**
 * Packages whose licence class is not "free", for the pin's list and the report (GB1E-01), and the "collection"
 * packages whose licences were read in their files (engine/bundle-sets.json, licenceReviews).
 */
function licenceList(db, names, reviews = {}) {
  const out = { nonfree: [], none: [], reviewed: [] };
  for (const n of [...names].sort()) {
    const licence = licenceOf(db.get(n), reviews);
    if (licence !== db.get(n).license) {
      out.reviewed.push(`${n} (${licence.join(' ')}, read in its files)`);
    }
    const c = licenceClass({ ...db.get(n), license: licence });
    if (c === 'nonfree') {
      out.nonfree.push(`${n} (${db.get(n).license.join(' ')})`);
    } else if (c === 'none') {
      out.none.push(n);
    }
  }
  return out;
}

/**
 * Runs one stage (or all). Returns { status, report }: 0 when every check passed, 1 when one failed (the report says
 * which), 2 for a usage error.
 */
export async function main(argv, { fetchImpl = fetch, log = console.log } = {}) {
  guardPrograms();
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const stage = arg('--stage', 'all');
  const pins = readJson(arg('--pins', path.join(root, 'engine', 'bundle-pins.json')));
  const sets = readJson(arg('--sets', path.join(root, 'engine', 'bundle-sets.json')));
  const licenceRules = readJson(arg('--licences', path.join(root, 'engine', 'bundle-licences.json')));
  const local = arg('--local') && path.resolve(arg('--local'));
  const out = path.resolve(arg('--out', path.join(root, '..', 'bundle-out')));
  const cache = local ?? path.resolve(arg('--cache', path.join(root, '..', 'bundle-cache')));
  const version = arg('--version', pins.snapshot.replace(/\//g, '.'));
  mkdirSync(out, { recursive: true });
  const report = { stage, started: new Date().toISOString(), snapshot: pins.snapshot, version, steps: [], problems: [], notes: [] };
  const lines = [];
  const say = (line) => {
    lines.push(line);
    log(line);
  };
  const save = () => {
    writeFileSync(path.join(out, `report-${stage}.json`), `${JSON.stringify(report, null, 1)}\n`);
    writeFileSync(path.join(out, `report-${stage}.txt`), `${[...lines, report.problems.length === 0 ? 'problems: none' : `problems (${report.problems.length}):`, ...report.problems.map((p) => `  - ${p}`)].join('\n')}\n`);
  };
  const step = (name) => {
    report.steps.push({ name, at: new Date().toISOString() });
    save();
  };
  const fail = (msg) => report.problems.push(msg);
  try {
    const status = await run();
    report.finished = new Date().toISOString();
    save();
    return { status, report };
  } catch (err) {
    report.error = err instanceof Error ? err.stack : String(err);
    fail(`stopped by an error: ${err instanceof Error ? err.message : err}`);
    save();
    throw err;
  }

  async function run() {
    // The closure stage works on the built images and closure-targets.json alone: it needs no tlpdb and opens no
    // connection (the third CI build's closure jobs fetched the tlpdb and got the mirror's bot check).
    if (stage === 'closure') {
      return closure();
    }
    // The tlpdb.
    const tlpdbXz = await getFile(pins, local, pins.tlpdb.file, fetchImpl);
    const tlpdbSha = sha256(tlpdbXz);
    const tlpdbText = unxz(tlpdbXz).toString('utf8');
    if (stage === 'pin') {
      const signed = arg('--signed-sha512');
      const signedBy = arg('--signed-by');
      if (!signed || !signedBy) {
        log('Give --signed-sha512 FILE and --signed-by FINGERPRINT: texlive.tlpdb.sha512 after gpg verified its signature, and the key gpg reported.');
        return 2;
      }
      const key = String(pins.signingKey?.fingerprint ?? '').replace(/\s/g, '').toUpperCase();
      const by = signedBy.replace(/\s/g, '').toUpperCase();
      if (!/^[0-9A-F]{40}$/.test(key) || by !== key) {
        fail(`the checksum file was signed by ${by}, not by TeX Live's key ${key || '(none pinned)'} that engine/bundle-pins.json pins`);
        return 1;
      }
      const check = checkSignedHash(readFileSync(signed, 'utf8'), tlpdbXz, tlpdbText);
      if (!check.ok) {
        fail(`the tlpdb is not the one TeX Live signed: ${check.reason}`);
        return 1;
      }
      const db = parseTlpdb(tlpdbText);
      const chosen = selectSets(db, sets);
      const core = licenceList(db, chosen.core, sets.licenceReviews);
      const extra = licenceList(db, chosen.extra, sets.licenceReviews);
      const entry = {
        file: pins.tlpdb.file,
        sha256: tlpdbSha,
        signedSha512: check.sha512,
        signatureChecked: `${new Date().toISOString().slice(0, 10)}: gpg verified tlpkg/texlive.tlpdb.sha512.asc with key ${key}; its SHA-512 is that of ${check.matched}`,
      };
      report.pin = { tlpdbSha256: tlpdbSha, signedBy: key, signedFile: check.matched, entry, missing: chosen.missing, dropped: chosen.dropped, coreProblems: chosen.problems, core, extra };
      say(`tlpdb of ${pins.snapshot}: ${db.size} packages; signed by ${key}; the signed SHA-512 matches ${check.matched}`);
      say(`missing names: ${chosen.missing.length ? chosen.missing.join(', ') : 'none'}`);
      say(`core-data, licence not free (stops the build): ${chosen.problems.length ? chosen.problems.join('; ') : 'none'}`);
      const droppedFrom = (set) => chosen.dropped.filter((d) => d.set === set).map((d) => `${d.package} (${d.reason})`).join('; ') || 'none';
      say(`core-data, left out on purpose: ${droppedFrom('core-data')}`);
      say(`core-data, no Catalogue licence (TeX Live's own files): ${core.none.join(', ') || 'none'}`);
      say(`core-data, "collection" licences read in the files: ${core.reviewed.join('; ') || 'none'}`);
      say(`extra-data, left out for the licence: ${droppedFrom('extra-data')}`);
      say(`extra-data, no Catalogue licence: ${extra.none.join(', ') || 'none'}`);
      say(`extra-data, "collection" licences read in the files: ${extra.reviewed.join('; ') || 'none'}`);
      say(`sha256 to pin: ${tlpdbSha} (${tlpdbXz.length} bytes)`);
      say(`read the lists above, then put this into engine/bundle-pins.json as "tlpdb": ${JSON.stringify(entry)}`);
      return 0;
    }
    if (!pins.tlpdb.sha256 || !pins.tlpdb.signatureChecked) {
      log('engine/bundle-pins.json has no checked tlpdb pin yet (its SHA-256 and the note that its signature was checked): run the pin stage first.');
      return 2;
    }
    if (tlpdbSha !== pins.tlpdb.sha256) {
      fail(`the tlpdb's SHA-256 is ${tlpdbSha}, not the pinned ${pins.tlpdb.sha256}`);
      return 1;
    }
    if (pins.tlpdb.signedSha512 && !checkSignedHash(pins.tlpdb.signedSha512, tlpdbXz, tlpdbText).ok) {
      fail('the tlpdb is not the one whose signed SHA-512 was pinned');
      return 1;
    }
    const db = parseTlpdb(tlpdbText);
    say(`tlpdb: ${db.size} packages`);

    // The sets.
    const chosen = selectSets(db, sets);
    report.missing = chosen.missing;
    report.dropped = chosen.dropped;
    report.moved = chosen.moved;
    report.unclassified = { core: licenceList(db, chosen.core, sets.licenceReviews).none, extra: licenceList(db, chosen.extra, sets.licenceReviews).none };
    chosen.problems.forEach(fail);
    if (chosen.missing.length > 0 && !argv.includes('--allow-missing')) {
      chosen.missing.forEach((m) => fail(`not in the tlpdb: ${m}`));
    }
    say(`core-data: ${chosen.core.size} packages; extra-data: ${chosen.extra.size} (${chosen.dropped.length} left out: for their licence, or on purpose)`);
    say(`no Catalogue licence (TeX Live's own files): core-data ${report.unclassified.core.length}, extra-data ${report.unclassified.extra.length}`);
    step('sets');
    if (report.problems.length > 0) {
      return 1;
    }

    // The archives.
    // With --local, only the downloaded copy, checked as strictly as a download: an archive the tlpdb gives no
    // SHA-512 for is refused too.
    // `kind`: the run archive, or the doc or source archive that a package's licence files come from.
    const archiveOf = async (name, pkg, kind = 'run') => {
      const { file: archiveName, checksum } = archiveFile(name, pkg, kind);
      if (local) {
        const file = path.join(local, 'archive', archiveName);
        if (!existsSync(file)) {
          throw new Error(`${archiveName} is not in the downloaded copy`);
        }
        const bytes = readFileSync(file);
        if (!checksum || sha512(bytes) !== checksum) {
          throw new Error(`${archiveName}: the SHA-512 is not the tlpdb's`);
        }
        return bytes;
      }
      return fetchArchive(name, pkg, { cache, mirrors: mirrorsOf(pins), fetchImpl, kind });
    };
    const all = [...[...chosen.core].map((n) => ['core', n]), ...[...chosen.extra].map((n) => ['extra', n])].filter(([, n]) => db.get(n).runfiles.length > 0).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    // The doc and source archives the licence texts need (scripts/lib/licence-texts.mjs): [name, kind].
    const licenceSources = all.flatMap(([, n]) => licenceArchives(n, db.get(n), licenceOf(db.get(n), sets.licenceReviews), licenceRules).map((kind) => [n, kind]));
    if (stage === 'fetch' || stage === 'all') {
      let fetched = 0;
      const curlConfig = local && arg('--curl-config');
      const wanted = [];
      const archives = [...all.map(([, n]) => [n, 'run']), ...licenceSources];
      for (const [name, kind] of archives) {
        try {
          await archiveOf(name, db.get(name), kind);
          fetched++;
        } catch (err) {
          if (curlConfig) {
            wanted.push(archiveFile(name, db.get(name), kind).file);
          } else {
            fail(err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (curlConfig) {
        const base = mirrorsOf(pins)[0];
        const entries = wanted.map((f) => `url = ${JSON.stringify(`${base}archive/${f}`)}\noutput = ${JSON.stringify(path.join(local, 'archive', f).replace(/\\/g, '/'))}\n`);
        writeFileSync(curlConfig, entries.join(''));
        report.toDownload = wanted;
        say(`archives: ${fetched} of ${archives.length} in the downloaded copy and checked (${licenceSources.length} doc and source archives for licence texts); ${wanted.length} listed for curl in ${curlConfig}`);
      } else {
        say(`archives: ${fetched} of ${archives.length} ${local ? 'in the downloaded copy and checked' : 'fetched and checked'} (${licenceSources.length} doc and source archives for licence texts)`);
      }
      step('fetch');
      if (stage === 'fetch' || report.problems.length > 0) {
        return report.problems.length === 0 ? 0 : 1;
      }
    }

    if (stage === 'build' || stage === 'all') {
      const status = await build(db, chosen, all, archiveOf, licenceSources);
      if (stage === 'build' || status !== 0) {
        return status;
      }
    }
    if (stage === 'all' && !argv.includes('--skip-engine')) {
      return closure();
    }
    if (stage === 'all') {
      return 0;
    }
    log(`unknown stage: ${stage}`);
    return 2;
  }

  async function build(db, chosen, all, archiveOf, licenceSources) {
    const skipEngine = argv.includes('--skip-engine');
    const filesOf = { core: new Map(), extra: new Map() };
    const leftOut = { core: [], extra: [] };
    const ownerOf = new Map();
    /** Each package's licence files by name, from its archives (texmf-relative path, or root name), and its other files that may state its terms. */
    const ownOf = new Map();
    const docsOf = new Map();
    for (const [set, name] of all) {
      let bytes;
      try {
        bytes = await archiveOf(name, db.get(name));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        continue;
      }
      const { files, problems, skipped, licences: licenceFiles } = unpackPackage(name, db.get(name), bytes);
      problems.forEach(fail);
      ownOf.set(name, licenceFiles);
      if (skipped.files > 0) {
        leftOut[set].push({ package: name, files: skipped.files, bytes: skipped.bytes });
      }
      for (const [rel, b] of files) {
        // No data set ships a program (a .jar, a Python wheel, a script, a binary).
        if (isProgramFile(rel)) {
          fail(`${set === 'core' ? 'core-data' : 'extra-data'}: ${name} holds ${rel}, a program file; a data set may not ship one (leave the package out with its reason)`);
        }
        const other = ownerOf.get(rel);
        if (other !== undefined && other !== name) {
          report.notes.push(`${rel}: in ${other} and ${name}; ${other}'s copy is kept`);
          continue;
        }
        ownerOf.set(rel, name);
        filesOf[set].set(rel, b);
      }
    }
    overlap(filesOf.core, filesOf.extra).forEach((f) => fail(`core-data and extra-data both hold ${f}`));
    // doc/, source/ and scripts/ that TeX Live lists as run files: left out, and listed.
    report.leftOutTrees = leftOut;
    for (const [set, list] of Object.entries(leftOut)) {
      if (list.length > 0) {
        say(`${set === 'core' ? 'core-data' : 'extra-data'}: doc/, source/ and scripts/ left out of ${list.length} package(s), ${human(list.reduce((n, x) => n + x.bytes, 0))}: ${list.map((x) => x.package).join(', ')}`);
      }
    }
    step('unpack');
    if (report.problems.length > 0) {
      return 1;
    }

    const generated = generatedFiles(db, chosen.core, chosen.extra, filesOf.core, filesOf.extra);
    report.maps = generated.mapProblems;
    generated.mapProblems.missing.forEach((m) => fail(`a font map the packages name is not there: ${m}`));
    // The engine build's own files (ICU data, fontconfig's file, /etc, /bin), from its pinned image as
    // scripts/stage-engine.mjs --data stages it into dist/data: every core build needs that image (GB1E-10).
    const imageDir = arg('--engine-image', path.join(root, 'dist', 'data'));
    const engineFiles = existsSync(path.join(imageDir, 'texlive-extra.index.json')) ? engineSupportFiles(pinnedEngineImage(imageDir)) : new Map();
    if (engineFiles.size === 0) {
      report.notes.push('no engine support files: the pinned engine build is not here (tests only)');
    }
    step('generated');

    // The licence texts each data package ships: LICENSES/ beside data/, with LICENSES/INDEX (engine/bundle-licences.json;
    // scripts/lib/licence-texts.mjs). A package whose licence text is missing stops the build.
    for (const [name, kind] of licenceSources) {
      let bytes;
      try {
        bytes = await archiveOf(name, db.get(name), kind);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        continue;
      }
      const { own, docs } = archiveTexts(bytes);
      own.forEach((b, rel) => ownOf.get(name)?.set(rel, b));
      docsOf.set(name, new Map([...(docsOf.get(name) ?? []), ...docs]));
    }
    const fromArchives = new Map(
      Object.entries(licenceRules.texts)
        .filter(([, t]) => t.package)
        .flatMap(([id, t]) => (ownOf.get(t.package)?.has(t.path) ? [[id, ownOf.get(t.package).get(t.path)]] : [])),
    );
    const { texts: licenceTextsById, problems: textProblems } = loadTexts(root, licenceRules, fromArchives);
    textProblems.forEach(fail);
    report.licences = {};
    /** Each set's Type 1 fonts, by texmf-relative path: their terms and whether the core may pack them (classifyFonts). */
    const fontClasses = { core: new Map(), extra: new Map() };
    for (const [set, key] of [['core-data', 'core'], ['extra-data', 'extra']]) {
      const shippedOf = new Map();
      for (const [rel, b] of filesOf[key]) {
        const owner = ownerOf.get(rel);
        if (!shippedOf.has(owner)) {
          shippedOf.set(owner, new Map());
        }
        shippedOf.get(owner).set(rel, b);
      }
      // Each Type 1 font's terms, from its own header (the t1c gate, T1S-01): the core packs a font only by these, and
      // a font's own terms add their texts to its package's.
      const fonts = [...filesOf[key]]
        .filter(([rel]) => /\.pfb$/i.test(rel))
        .map(([rel, bytes]) => ({ path: rel, package: ownerOf.get(rel), group: licenceGroup(licenceOf(db.get(ownerOf.get(rel)), sets.licenceReviews)), bytes }));
      const classified = classifyFonts(fonts, licenceRules);
      fontClasses[key] = classified.fonts;
      const packages = [...chosen[key]].map((name) => {
        const shipped = shippedOf.get(name) ?? new Map();
        const own = new Map(ownOf.get(name) ?? []);
        shipped.forEach((b, rel) => isLicenceFile(rel) && own.set(rel, b));
        return { name, licences: licenceOf(db.get(name), sets.licenceReviews), own, docs: docsOf.get(name), shipped, fontTexts: classified.texts.get(name), fontNotices: classified.notices.get(name) };
      });
      const folder = licenceFolder(set, packages, licenceRules, licenceTextsById, key === 'core' ? [...engineFiles.keys()] : []);
      folder.problems.forEach(fail);
      const dir = path.join(out, set, 'LICENSES');
      rmSync(dir, { recursive: true, force: true });
      for (const [rel, b] of folder.files) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), b);
      }
      writeFileSync(path.join(dir, 'INDEX'), folder.index);
      const bytes = [...folder.files.values()].reduce((n, b) => n + b.length, 0);
      report.licences[set] = { packages: packages.length, files: folder.files.size, bytes, termsFound: folder.found };
      say(`${set}: licence texts for ${packages.length} packages in LICENSES/ (${folder.files.size} files, ${human(bytes)}); terms found by reading text, to check: ${folder.found.map((f) => `${f.package} (${f.file})`).join(', ') || 'none'}`);
    }
    step('licences');

    const dirs = { core: path.join(out, 'core-data', 'data'), extra: path.join(out, 'extra-data', 'data'), stage: path.join(out, 'stage') };
    Object.values(dirs).forEach((d) => mkdirSync(d, { recursive: true }));
    const assetsDir = arg('--engine-assets', path.join(root, '..', 'engine_assets', readJson(path.join(root, 'engine', 'pins.json')).sources.find((s) => s.id === 'texlyre-busytex').folder));
    let formats = new Map();
    if (!skipEngine) {
      const { buildFormats, patternCost, startEngines } = await import('./lib/bundle-engine.mjs');
      writeImage(dirs.stage, 'stage1', coreImageFiles(filesOf.core, generated.files, engineFiles), { compress: false, strictNames: false });
      const [builder] = await startEngines(root, engineAssets(assetsDir, path.join(dirs.stage, 'stage1.data'), path.join(dirs.stage, 'stage1.index.json')), 1);
      try {
        ({ formats } = await buildFormats(builder, generated.formats));
        report.patterns = await patternCost(builder, generated.formats, filesOf.core.get('tex/generic/config/language.us').toString('utf8'));
      } finally {
        await builder.stop();
      }
      step('formats');
    }

    const abi = readJson(path.join(root, 'engine', 'pins.json')).sources.find((s) => s.id === 'texlyre-busytex').files.find((f) => f.name === 'busytex.wasm').sha256;
    const coreTree = coreImageFiles(filesOf.core, generated.files, engineFiles, formats);
    const extraTree = extraImageFiles(filesOf.extra);
    // The core's Type 1 fonts packed with t1c (font packing: decided by the maintainer, 2026-10-22), decided per font
    // by its own header (the licence step's classifyFonts; the t1c gate, T1S-01): a font is packed only when its
    // terms are the LPPL, the GUST Font License, the GPL or DejaVu's, and none of the packages core-data's
    // "t1cSkip" names is packed.
    const t1cSkip = sets['core-data'].t1cSkip ?? {};
    Object.keys(t1cSkip).filter((n) => !chosen.core.has(n)).forEach((n) => fail(`core-data's t1cSkip names ${n}, which core-data does not hold`));
    const relOf = (p) => p.replace(/^\//, '').slice(`${CORE_ROOT}/`.length);
    const corePacked = packType1(coreTree, (p) => Object.hasOwn(t1cSkip, ownerOf.get(relOf(p)) ?? '') || fontClasses.core.get(relOf(p))?.pack !== true);
    // The engine host's own unpacking must give every original back too (src/engine-host/engine/t1c.ts, compiled
    // to out/ by npm run compile): the builder's check alone would not catch a difference between the two.
    const hostT1c = path.join(root, 'out', 'src', 'engine-host', 'engine', 't1c.js');
    if (!existsSync(hostT1c)) {
      fail("the engine host's unpacking is not compiled (out/src/engine-host/engine/t1c.js): run npm run compile first");
    } else {
      const { t1cUnpack: hostUnpack } = createRequire(import.meta.url)(hostT1c);
      for (const [name, sha] of Object.entries(corePacked.packed)) {
        if (sha256(hostUnpack(corePacked.files.get(name.slice(1)))) !== sha) {
          fail(`${name}: the engine host's unpacking does not give the original back`);
        }
      }
    }
    // Each packed font's terms, for LICENSE.txt and CHANGES-GPL: the packages by the terms of the fonts packed, and the
    // fonts stored as they are by their own headers, with the reason.
    const packedFonts = Object.keys(corePacked.packed).map((name) => ({ name, owner: ownerOf.get(relOf(name)), font: fontClasses.core.get(relOf(name)) }));
    packedFonts.filter((f) => f.owner === undefined || !f.font?.pack).forEach((f) => fail(`core-data: ${f.name} was packed, but no package holds it or its own terms do not allow it`));
    const byClass = (c) => [...new Set(packedFonts.filter((f) => f.font?.class === c).map((f) => f.owner))].sort();
    const unpacked = {};
    for (const [rel, f] of [...fontClasses.core].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!f.pack && !Object.hasOwn(t1cSkip, f.package)) {
        const list = (unpacked[f.package] ??= []);
        let entry = list.find((e) => e.reason === f.reason);
        if (!entry) {
          entry = { reason: f.reason, files: [] };
          list.push(entry);
        }
        entry.files.push(rel);
      }
    }
    const coreFonts = packedFonts.length > 0 ? { lppl: byClass('lppl'), vera: byClass('vera'), gpl: byClass('gpl'), kept: t1cSkip, unpacked } : undefined;
    const coreImage = writeImage(dirs.core, 'core', corePacked.files, { compress: true, strictNames: false }, corePacked.packed);
    report.packed = {
      method: 't1c',
      files: Object.keys(corePacked.packed).length,
      kept: Object.keys(t1cSkip),
      byClass: { lppl: byClass('lppl'), vera: byClass('vera'), gpl: byClass('gpl') },
      unpacked: Object.fromEntries(Object.entries(unpacked).map(([p, list]) => [p, list.map((e) => ({ reason: e.reason, files: e.files.length }))])),
    };
    // The GPL's notice of changes for every packed font under the GPL, by the font's own terms (GPL fonts kept packed,
    // with a notice per file: decided by the maintainer, 2026-10-26). A packed GPL font it does not list stops the build.
    const gplPacked = packedFonts.filter((f) => f.font?.class === 'gpl').map((f) => ({ path: f.name, package: f.owner, sha256: corePacked.packed[f.name] }));
    if (gplPacked.length > 0) {
      const changesFile = path.join(out, 'core-data', 'LICENSES', 'CHANGES-GPL');
      mkdirSync(path.dirname(changesFile), { recursive: true });
      writeFileSync(changesFile, gplChanges('core-data', gplPacked, report.started.slice(0, 10)));
      const listed = gplChangesPaths(readFileSync(changesFile, 'utf8'));
      gplPacked.filter((f) => !listed.has(f.path)).forEach((f) => fail(`core-data: ${f.path} (${f.package}, under the GPL) is packed, but LICENSES/CHANGES-GPL does not list it`));
    }
    report.packed.gplChanges = gplPacked.length;
    if (coreFonts) {
      coreFonts.gplChanges = gplPacked.length > 0;
    }
    const extraImage = writeImage(dirs.extra, 'extra', extraTree, { compress: true, strictNames: false });
    const indexOf = (files) => buildPackageIndex([...files.keys()], (rel) => files.get(rel).toString('latin1'));
    const coreIndex = indexOf(filesOf.core);
    const extraIndex = indexOf(filesOf.extra);
    const licences = (names) => Object.fromEntries([...names].sort().map((n) => [n, { licence: licenceOf(db.get(n), sets.licenceReviews), ctan: db.get(n).ctan || null, revision: db.get(n).revision }]));
    const coreManifest = {
      format: 1,
      set: 'core-data',
      texLive: pins.texLive,
      abi,
      version,
      snapshot: pins.snapshot,
      image: coreImage,
      index: coreIndex,
      core: {
        root: `/${CORE_ROOT}`,
        formats: Object.fromEntries([...formats].map(([rel, b]) => [path.posix.basename(rel, '.fmt'), { path: `/${CORE_ROOT}/${rel}`, sha256: sha256(b) }])),
      },
      elsewhere: { 'livemd2tex-extra-data': { set: 'extra-data', files: extraIndex.files, requires: Object.fromEntries(Object.entries(extraIndex.packages).map(([n, p]) => [n, p.requires])) } },
      outsideProgram: Object.fromEntries(Object.entries(sets.outsideProgram ?? {}).filter(([k]) => k !== 'about')),
    };
    const extraManifest = { format: 1, set: 'extra-data', texLive: pins.texLive, abi, version, snapshot: pins.snapshot, image: extraImage, index: extraIndex };
    writeFileSync(path.join(dirs.core, 'manifest.json'), `${JSON.stringify(coreManifest)}\n`);
    writeFileSync(path.join(dirs.extra, 'manifest.json'), `${JSON.stringify(extraManifest)}\n`);
    writeFileSync(path.join(dirs.core, 'licences.json'), `${JSON.stringify(licences(chosen.core), null, 1)}\n`);
    writeFileSync(path.join(dirs.extra, 'licences.json'), `${JSON.stringify(licences(chosen.extra), null, 1)}\n`);
    // What the closure stage loads: each package's targets, or why it has none.
    const { loadTargets } = await import('./lib/bundle-engine.mjs');
    const targets = [];
    const untestable = [];
    for (const [set, name] of all) {
      const t = loadTargets(name, db.get(name).runfiles.map(texmfPath).filter((p) => p !== null));
      if (t.length === 0) {
        untestable.push({ set, package: name, reason: 'no .cls, and no .sty in its own tex/latex folder (fonts, BibTeX styles, generic TeX)' });
      } else {
        targets.push({ set, package: name, targets: t });
      }
    }
    writeFileSync(path.join(out, 'closure-targets.json'), `${JSON.stringify({ targets, untestable }, null, 1)}\n`);
    // Every package of each set, for the reference install: tlmgr installs the same packages (GB1E-07).
    writeFileSync(path.join(out, 'selection.json'), `${JSON.stringify({ snapshot: pins.snapshot, core: [...chosen.core].sort(), extra: [...chosen.extra].sort() }, null, 1)}\n`);
    report.closureTargets = { packages: targets.length, files: targets.reduce((n, t) => n + t.targets.length, 0), untestable: untestable.length };
    const total = (m) => [...m.values()].reduce((n, b) => n + b.length, 0);
    const sizes = { core: sizeTable(db, chosen.core, filesOf.core), extra: sizeTable(db, chosen.extra, filesOf.extra) };
    report.sizes = {
      core: { files: filesOf.core.size, bytes: total(filesOf.core), image: coreImage.bytes, top: sizes.core.slice(0, 40), ...sizeBreakdown(coreTree) },
      extra: { files: filesOf.extra.size, bytes: total(filesOf.extra), image: extraImage.bytes, top: sizes.extra.slice(0, 40), ...sizeBreakdown(extraTree) },
    };
    step('images');
    if (!argv.includes('--no-package')) {
      const { packageDataSet } = await import('./lib/bundle-package.mjs');
      for (const [set, dir] of [['core-data', path.join(out, 'core-data')], ['extra-data', path.join(out, 'extra-data')]]) {
        const vsix = await packageDataSet(root, dir, set, version, path.join(out, `livemd2tex-${set}-${version}.vsix`), set === 'core-data' ? coreFonts : undefined);
        report.sizes[set === 'core-data' ? 'core' : 'extra'].vsix = vsix.bytes;
        report.sizes[set === 'core-data' ? 'core' : 'extra'].vsixSha256 = sha256(readFileSync(vsix.file));
        if (vsix.bytes >= MAX_PACKAGE) {
          fail(`${set}: the package is ${vsix.bytes} bytes, over the store's ${MAX_PACKAGE}`);
        }
      }
      step('packages');
    }
    say(`core-data: ${chosen.core.size} packages, ${filesOf.core.size} files, ${human(report.sizes.core.bytes)}; image ${human(coreImage.bytes)}${report.sizes.core.vsix ? `; package ${human(report.sizes.core.vsix)}` : ''}`);
    say(`extra-data: ${chosen.extra.size} packages, ${filesOf.extra.size} files, ${human(report.sizes.extra.bytes)}; image ${human(extraImage.bytes)}${report.sizes.extra.vsix ? `; package ${human(report.sizes.extra.vsix)}` : ''}`);
    say(`core-data: ${report.packed.files} Type 1 fonts packed with t1c (each unpacks to its original's SHA-256); stored as they are: the fonts of ${report.packed.kept.join(', ') || 'no package'}, and by their own headers ${Object.entries(report.packed.unpacked).map(([p, list]) => `${p} ${list.reduce((n, e) => n + e.files, 0)}`).join(', ') || 'none'}; ${report.packed.gplChanges} under the GPL, each in LICENSES/CHANGES-GPL`);
    // Where the bytes go (the files before compression): by kind, then the largest packages and files.
    for (const [set, s] of [['core-data', report.sizes.core], ['extra-data', report.sizes.extra]]) {
      say(`${set} by kind: ${Object.entries(s.byKind).map(([k, b]) => `${k} ${human(b)}`).join('; ')}`);
      say(`${set}, largest packages: ${s.top.slice(0, 25).map((p) => `${p.name} ${human(p.bytes)}`).join(', ')}`);
      say(`${set}, largest files: ${s.topFiles.map((f) => `${f.name.replace(/^texlive\/texmf-dist\//, '')} ${human(f.bytes)}`).join(', ')}`);
    }
    say(report.patterns ? `hyphenation patterns in pdflatex.fmt: ${human(report.patterns.patterns)} (${human(report.patterns.withAll)} with all languages, ${human(report.patterns.usOnly)} with US English only)` : 'formats: not built (--skip-engine)');
    say(`closure targets: ${report.closureTargets.files} files of ${report.closureTargets.packages} packages; ${report.closureTargets.untestable} packages have none`);
    say(`left out (licence, or on purpose): ${chosen.dropped.length}; map conflicts: ${generated.mapProblems.conflicts.length}; files in two packages: ${report.notes.filter((n) => n.includes(' in ')).length}`);
    return report.problems.length === 0 ? 0 : 1;
  }

  async function closure() {
    // The core by default: a first run judges the core before it spends minutes on the add-on (GB1E-03).
    const scope = arg('--closure', 'core');
    const [shard, shards] = (arg('--shard', '0/1')).split('/').map(Number);
    const { closureTest, judgeClosure, pool, startEngines } = await import('./lib/bundle-engine.mjs');
    // What a file needs first (setup), and the failures that are expected, with their reasons.
    const rules = readJson(arg('--closure-rules', path.join(root, 'engine', 'bundle-closure.json')));
    const { targets } = readJson(path.join(out, 'closure-targets.json'));
    const chosenTargets = targets.filter((t) => scope === 'all' || t.set === scope).filter((_, i) => i % shards === shard);
    const coreDir = path.join(out, 'core-data', 'data');
    const extraDir = path.join(out, 'extra-data', 'data');
    const core = readJson(path.join(coreDir, 'manifest.json'));
    const extra = readJson(path.join(extraDir, 'manifest.json'));
    const assetsDir = arg('--engine-assets', path.join(root, '..', 'engine_assets', readJson(path.join(root, 'engine', 'pins.json')).sources.find((s) => s.id === 'texlyre-busytex').folder));
    const hosts = await startEngines(root, engineAssets(assetsDir, path.join(coreDir, core.image.file), path.join(coreDir, core.image.index)), Number(arg('--hosts', String(Math.max(1, Math.min(4, os.cpus().length - 1))))));
    step('engines');
    try {
      const extraRef = { id: 'livemd2tex-extra-data', version: extra.version, sha256: extra.image.sha256, data: path.join(extraDir, extra.image.file), index: path.join(extraDir, extra.image.index) };
      const setup = rules.setup ?? {};
      const tasks = chosenTargets.flatMap((t) =>
        t.targets.map((target) => async (host) => ({ set: t.set, package: t.package, file: target.file, ...(await closureTest(host, target, t.set === 'extra' ? [extraRef] : [], setup[target.file]?.preamble ?? '')) })),
      );
      const results = await pool(hosts, tasks);
      const failed = results.filter((r) => !r.ok);
      const verdict = judgeClosure(results, rules, extra.index?.files ?? {});
      report.closure = { scope, shard: `${shard}/${shards}`, packages: chosenTargets.length, files: results.length, failed, expected: verdict.expected, stale: verdict.stale };
      verdict.problems.forEach(fail);
      verdict.stale.forEach((f) => report.notes.push(`closure test: ${f} loads now; take it out of engine/bundle-closure.json's expected failures`));
      report.memory = await Promise.all(hosts.map((h) => h.memory()));
      say(`closure test (${scope}, shard ${shard}/${shards}): ${results.length - failed.length} of ${results.length} files of ${chosenTargets.length} packages load alone; ${verdict.expected.length} expected failure(s), ${verdict.problems.length} unexpected, ${verdict.stale.length} stale`);
      for (const e of verdict.expected) {
        say(`  expected: ${e.file}: ${e.reason}${e.inExtra.length ? ` (extra-data holds ${e.inExtra.join(', ')})` : ''}`);
      }
      say(`engine host peak memory: ${report.memory.map((m) => human(m.maxRss)).join(', ')}`);
      writeFileSync(path.join(out, `closure-${scope}-${shard}-of-${shards}.json`), `${JSON.stringify(report.closure, null, 1)}\n`);
    } finally {
      await Promise.all(hosts.map((h) => h.stop()));
    }
    return report.problems.length === 0 ? 0 : 1;
  }
}

/** The engine assets for the engine host, with the given core image. */
function engineAssets(assetsDir, data, loader) {
  return {
    glue: path.join(root, '..', 'engine_assets', 'derived', 'busytex.patched.js'),
    wasm: path.join(assetsDir, 'busytex.wasm'),
    data,
    loader,
    cnfOverride: path.join(root, 'engine', 'texmf-override.cnf'),
    fontsConf: path.join(root, 'engine', 'fonts.conf'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    ({ status }) => {
      process.exitCode = status;
    },
    (err) => {
      console.error(err instanceof Error ? err.stack : err);
      process.exitCode = 1;
    },
  );
}
