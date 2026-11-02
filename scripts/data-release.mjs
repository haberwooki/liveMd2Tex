#!/usr/bin/env node
// Release tool, run by .github/workflows/bundle.yml's release job (docs/DEVELOPING.md, "The data sets"): the two data
// packages of one build, each made into a draft release of its own, with the sources of what it ships. core-data's
// tag is core-data-<engine short hash>-<n> and extra-data's extra-data-<engine short hash>-<n>: the engine's short
// hash is the first 7 hex digits of the SHA-256 of the engine.wasm both packages are built for (their manifests'
// abi), and n is the candidate number, the same for the two packages of one build. Each package is its own store
// item with its own pin in engine/pins.json, licences and sources, so each gets a release of its own; the shared
// hash and number name the pair that was built together (the core's manifest lists the add-on's files, so the two
// are only used together).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/data-release.mjs plan --packages DIR --candidate N --out DIR
//        checks the build's two packages (DIR holds livemd2tex-core-data-*.vsix and livemd2tex-extra-data-*.vsix)
//        against the pinned engine and each other, and writes DIR/releases.tsv: set, tag, package path per line
//   node scripts/data-release.mjs notes --set SET --tag TAG --vsix FILE --sources DIR --commit SHA --repository URL
//        --out FILE
//        checks that the package's data/licences.json lists every source its release must carry (licenceGaps,
//        against the pinned tlpdb in DIR/meta/), then writes the release notes, from the package and its checked
//        sources (DIR/sources.json of scripts/release-sources.mjs)
// The tool opens no connection and starts no program: the workflow's curl downloads the sources,
// scripts/release-sources.mjs checks them, and gh makes the drafts.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGplFamily, snapshotArchives } from './lib/bundle.mjs';
import { parseTlpdb } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** The two data sets, by the name their package.json gives after livemd2tex-. */
export const SETS = ['core-data', 'extra-data'];
/** A data release's tag: <set>-<engine short hash>-<candidate>. */
export const TAG = /^(core-data|extra-data)-[0-9a-f]{7}-[1-9][0-9]*$/;

/** A data release's tag. */
export function dataTag(set, abi, candidate) {
  if (!SETS.includes(set)) throw new Error(`not a data set: ${set}`);
  if (!/^[0-9a-f]{64}$/.test(abi ?? '')) throw new Error(`not an engine SHA-256: ${abi}`);
  if (!/^[1-9][0-9]*$/.test(String(candidate))) throw new Error(`candidate must be a number from 1, not ${candidate}`);
  return `${set}-${abi.slice(0, 7)}-${candidate}`;
}

/**
 * The releases of one build: for each package (VSIX file name -> its entries), its set, manifest and tag. Problems
 * (any one stops the release): not exactly one package of each set; a package built for another engine than the one
 * engine/pins.json pins; the two packages from different snapshots, TeX Live years or versions.
 * @param {Map<string, Map<string, Buffer>>} packages
 * @param {string} pinnedWasm the pinned engine.wasm's SHA-256
 * @param {string|number} candidate
 */
export function planReleases(packages, pinnedWasm, candidate) {
  const problems = [];
  const releases = [];
  for (const [file, entries] of packages) {
    const identity = JSON.parse(entries.get('extension/package.json')?.toString('utf8') ?? '{}');
    const manifest = JSON.parse(entries.get('extension/data/manifest.json')?.toString('utf8') ?? 'null');
    const set = String(identity.name ?? '').replace(/^livemd2tex-/, '');
    if (!SETS.includes(set) || !manifest) {
      problems.push(`${file}: not a data package (its package.json names ${identity.name ?? 'nothing'}, and it ${manifest ? 'has' : 'lacks'} data/manifest.json)`);
      continue;
    }
    if (manifest.set !== set) problems.push(`${file}: its manifest says ${manifest.set}, its package.json ${set}`);
    if (manifest.abi !== pinnedWasm) problems.push(`${file}: built for the engine ${manifest.abi}, not the pinned ${pinnedWasm}`);
    releases.push({ set, file, manifest });
  }
  for (const set of SETS) {
    const n = releases.filter((r) => r.set === set).length;
    if (n !== 1) problems.push(`the build holds ${n} ${set} packages, not one`);
  }
  for (const key of ['snapshot', 'texLive', 'version', 'abi']) {
    if (new Set(releases.map((r) => JSON.stringify(r.manifest[key]))).size > 1) problems.push(`the two packages differ in ${key}: one build makes both`);
  }
  if (problems.length > 0) return { problems, releases: [] };
  return { problems, releases: releases.sort((a, b) => SETS.indexOf(a.set) - SETS.indexOf(b.set)).map((r) => ({ ...r, tag: dataTag(r.set, r.manifest.abi, candidate) })) };
}

/**
 * What a data package's data/licences.json lacks for its release's sources, checked again against the pinned tlpdb,
 * so that a short list stops the release instead of shrinking it. The rule is the builder's (scripts/build-bundle.mjs):
 * each package under the GPL, LGPL or AGPL, and each package that LICENSES/CHANGES-GPL names (a packed font under the
 * GPL), lists every archive the tlpdb gives it (run, source and doc), with the tlpdb's SHA-512. LICENSES/INDEX must be
 * there too.
 * @param {Map<string, Buffer>} entries the package's entries (extension/...)
 * @param {Map<string, import('./lib/tlpdb.mjs').TlPackage>} db the pinned tlpdb, parsed
 * @param {string} snapshotUrl the snapshot's tlnet address, ending in /
 * @returns {string[]} the problems: none when the list is complete
 */
export function licenceGaps(entries, db, snapshotUrl) {
  const licences = JSON.parse(entries.get('extension/data/licences.json')?.toString('utf8') ?? 'null');
  if (!licences) return ['data/licences.json is missing'];
  const problems = [];
  if (!entries.has('extension/LICENSES/INDEX')) problems.push('LICENSES/INDEX is missing');
  const changes = entries.get('extension/LICENSES/CHANGES-GPL')?.toString('utf8') ?? '';
  const rows = changes.split('\n').filter((l) => l && !l.startsWith('#'));
  const fontOwners = new Set(rows.map((l) => l.split('\t')[1]).filter(Boolean));
  for (const owner of fontOwners) {
    if (!licences[owner]) problems.push(`${owner}: LICENSES/CHANGES-GPL names it, data/licences.json does not`);
  }
  for (const [name, l] of Object.entries(licences)) {
    const gpl = (l.licence ?? []).filter(isGplFamily);
    if (gpl.length === 0 && !fontOwners.has(name)) continue;
    const why = gpl.length > 0 ? gpl.join(', ') : 'a packed font under the GPL';
    const pkg = db.get(name);
    if (!pkg) {
      problems.push(`${name} (${why}): not in the pinned tlpdb`);
      continue;
    }
    const key = (a) => `${a.kind} ${a.url.split('/').pop()} ${a.sha512}`;
    const listed = new Set((l.archives ?? []).map(key));
    const wanted = snapshotArchives(name, pkg, snapshotUrl);
    if (!wanted.some((a) => a.kind === 'run')) problems.push(`${name} (${why}): the pinned tlpdb gives no run archive`);
    for (const a of wanted) {
      if (!listed.has(key(a))) problems.push(`${name} (${why}): data/licences.json lacks its ${a.kind} archive ${a.url.split('/').pop()} with the tlpdb's SHA-512`);
    }
  }
  return problems;
}

/**
 * The release notes of one data package. `packedGplFonts`: whether the package holds packed fonts under the GPL (its
 * LICENSES/CHANGES-GPL), whose packages' archives its sources then carry too.
 */
export function releaseNotes({ set, tag, vsixName, vsixBytes, manifest, sources, engine, commit, repository, snapshotUrl, tlpdbSha256, packedGplFonts = false }) {
  const archives = Object.values(sources.groups ?? {}).flat();
  const label = set === 'core-data' ? "liveMd2Tex's core TeX data" : "liveMd2Tex's Extra Packages add-on";
  return [
    `# ${tag}`,
    '',
    `${label}: TeX Live ${manifest.texLive}'s packages from the snapshot of ${manifest.snapshot} (${snapshotUrl}), as one data image for liveMd2Tex's engine. Built by \`scripts/build-bundle.mjs\` (\`.github/workflows/bundle.yml\`) at commit ${commit} of ${repository}.`,
    '',
    `- \`${vsixName}\`: ${vsixBytes.length} bytes, SHA-256 \`${sha256(vsixBytes)}\`, version ${manifest.version}`,
    `- For the engine whose \`engine.wasm\` has SHA-256 \`${manifest.abi}\` (the package's \`abi\`)${engine?.tag ? `: the engine release ${engine.tag}` : ''}. The extension uses no data package built for another engine.`,
    '',
    '## The sources',
    '',
    `- \`${tag}-sources.tar\`: the snapshot's archives of each package under the GNU GPL, LGPL or AGPL${packedGplFonts ? ', and of each package with a packed font under the GPL' : ''}, as \`data/licences.json\` lists them (${archives.length} archives). Each one was checked against the SHA-512 that the pinned package database gives for it, and the list against the database: it holds every archive the database gives such a package. \`sources.json\` lists them with their addresses.`,
    `- \`texlive.tlpdb.xz\`: TeX Live's package database of the snapshot, SHA-256 \`${tlpdbSha256}\`. TeX Live signs the SHA-512 of the unpacked database, and \`engine/bundle-pins.json\` records it (\`signedSha512\`): \`xz -dc texlive.tlpdb.xz | sha512sum\` gives it.`,
    `- Every package's archives stay in the snapshot itself: ${snapshotUrl}archive/<package>.tar.xz, with its .source.tar.xz and .doc.tar.xz where it has them.`,
    '',
    '## Licences',
    '',
    `Each package is under its own licence. \`${tag}-LICENSES.tar\` is the package's \`LICENSES/\` folder: the licence texts its packages need, and \`INDEX\`, which names each package's. The package's \`LICENSE.txt\` gives the terms and says where the sources are. The rest of the package (\`package.json\`, \`README.md\`, \`LICENSE.txt\`, \`data/manifest.json\`) is GPL-3.0-or-later, as liveMd2Tex.`,
    '',
    `A candidate that fails a later check stays as a release of its own; \`engine/pins.json\` in ${repository} records which data packages the extension's tests use.`,
    '',
  ].join('\n');
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The command line, for the workflow and the tests: returns the exit code; a refusal throws. */
export function main(argv) {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'));
  const engine = pins.sources.find((s) => s.id === 'livemd2tex-engine');
  const bundlePins = JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-pins.json'), 'utf8'));
  const snapshotUrl = bundlePins.mirrors[0].replace('{snapshot}', bundlePins.snapshot);
  if (argv[0] === 'plan') {
    const dir = arg(argv, '--packages');
    const out = arg(argv, '--out');
    const candidate = arg(argv, '--candidate');
    if (!dir || !out || !candidate) throw new Error('plan needs --packages DIR --candidate N --out DIR');
    const files = readdirSync(dir).filter((n) => /\.vsix$/.test(n)).map((n) => path.join(dir, n));
    const packages = new Map(files.map((f) => [path.basename(f), readZip(readFileSync(f))]));
    const pinnedWasm = engine?.files.find((f) => f.name === 'engine.wasm')?.sha256;
    const { problems, releases } = planReleases(packages, pinnedWasm, candidate);
    if (problems.length > 0) {
      problems.forEach((p) => console.error(p));
      return 1;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'releases.tsv'), releases.map((r) => `${r.set}\t${r.tag}\t${path.join(dir, r.file)}\n`).join(''));
    for (const r of releases) console.log(`${r.set}: ${r.tag} (${r.file}, ${statSync(path.join(dir, r.file)).size} bytes)`);
    return 0;
  }
  if (argv[0] === 'notes') {
    const [set, tag, vsix, sourcesDir, commit, repository, out] = ['--set', '--tag', '--vsix', '--sources', '--commit', '--repository', '--out'].map((n) => arg(argv, n));
    if (!set || !tag || !vsix || !sourcesDir || !commit || !repository || !out) throw new Error('notes needs --set --tag --vsix --sources --commit --repository --out');
    if (!TAG.test(tag) || !tag.startsWith(`${set}-`)) throw new Error(`${tag} is not a ${set} release tag`);
    const vsixBytes = readFileSync(vsix);
    const entries = readZip(vsixBytes);
    const manifest = JSON.parse(entries.get('extension/data/manifest.json').toString('utf8'));
    if (dataTag(set, manifest.abi, tag.split('-').pop()) !== tag) throw new Error(`${tag} does not name the engine the package is built for (${manifest.abi})`);
    const sources = JSON.parse(readFileSync(path.join(sourcesDir, 'sources.json'), 'utf8'));
    const tlpdbBytes = readFileSync(path.join(sourcesDir, 'meta', 'texlive.tlpdb.xz'));
    const tlpdbSha256 = sha256(tlpdbBytes);
    if (tlpdbSha256 !== bundlePins.tlpdb.sha256) throw new Error(`the tlpdb is not the pinned one (${bundlePins.tlpdb.sha256})`);
    const gaps = licenceGaps(entries, parseTlpdb(unxz(tlpdbBytes).toString('utf8')), snapshotUrl);
    if (gaps.length > 0) throw new Error(`${tag}: the list of sources is not complete:\n${gaps.join('\n')}`);
    const packedGplFonts = entries.has('extension/LICENSES/CHANGES-GPL');
    writeFileSync(out, releaseNotes({ set, tag, vsixName: path.basename(vsix), vsixBytes, manifest, sources, engine, commit, repository, snapshotUrl, tlpdbSha256, packedGplFonts }));
    console.log(`${out}: the notes of ${tag}; data/licences.json lists every source its release must carry`);
    return 0;
  }
  console.error('usage: data-release.mjs plan --packages DIR --candidate N --out DIR | notes --set SET --tag TAG --vsix FILE --sources DIR --commit SHA --repository URL --out FILE');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
