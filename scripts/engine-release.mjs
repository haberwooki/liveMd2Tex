#!/usr/bin/env node
// The engine release (docs/DEVELOPING.md, "The TeX engine: our own build"), assembled by .github/workflows/
// engine.yml's release job from the build job's artifacts, before the draft release is made. The draft holds
// everything the release will ever hold, because immutable releases cannot change once published:
//   - engine.wasm, engine.js, engine-build.json and the build's logs, checked against the manifest;
//   - the licence texts and notice files of every part (engine/engine-notices.next.json until it replaces
//     engine/engine-notices.json), each checked against its pinned SHA-256; a file the manifest marks "release" is
//     taken from a source archive (musl's COPYRIGHT of Emscripten 6.0.13, whose text differs from the 5.0.4 copy in
//     LICENSES/engine that today's engine ships);
//   - a generated NOTICE (scripts/lib/engine-notices.mjs, releaseNotice);
//   - TeX Live's and Emscripten's source archives, each checked against its commit's tree (release-sources.mjs,
//     treeDifferences) and attached: the engine's corresponding source, with our scripts at the public commit;
//   - release notes with the source directions.
// The tool starts no program and opens no connection: `list` writes a curl config and the commits for git, the
// workflow's curl and git fetch, and `assemble` checks everything and writes the release folder.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/engine-release.mjs list --dir DIR
//        writes DIR/sources.json, DIR/sources.curl (the archives into DIR/files/engine/), DIR/git.tsv
//   node scripts/engine-release.mjs assemble --dir DIR --artifacts DIR --tag TAG --commit SHA
//        --expect-wasm SHA256 --expect-glue SHA256 --scripts-archive FILE [--repository URL]
//        checks the archives (DIR/files/engine/, DIR/trees/), the artifacts (against the hashes the comparison
//        matched, given as --expect-wasm and --expect-glue) and the archive of our build scripts at the commit
//        (git archive of engine/build, engine/engine-build-pins.json and LICENSE, whose files must give the
//        manifest's tree hash), and writes DIR/assets/ (every file of the release), DIR/notes.md and DIR/assets.txt

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { checkSources, curlConfig, gitList } from './release-sources.mjs';
import { readTar } from './lib/tar.mjs';
import { releaseAssetName, releaseNotice } from './lib/engine-notices.mjs';
import { inScriptsTree, scriptsTree, treeOfFiles } from '../engine/build/tools/scripts-tree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/haberwooki/liveMd2Tex';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** A release tag: engine-<TeX Live's short commit>-<candidate>; a candidate that fails a later check stays as it is. */
export const TAG = /^engine-[0-9a-f]{7}-[1-9][0-9]*$/;

export function loadNext(file = path.join(root, 'engine', 'engine-notices.next.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The engine's source archives as release-sources.mjs lists a group: the sources with an address (the third
 * source, our scripts, is the public commit itself, named in the release notes).
 */
export function engineGroups(next) {
  return { engine: next.sources.filter((s) => s.url).map((s) => ({ name: s.name, url: s.mirror ?? s.url, sha256: s.sha256, commit: s.commit, repository: s.repository, for: ["the engine's corresponding source"] })) };
}

/** A file inside a commit archive (.tar.gz), below its one top folder. */
function fromArchive(archiveBytes, rel) {
  const entry = readTar(gunzipSync(archiveBytes)).find((e) => e.type === 'file' && e.path.slice(e.path.indexOf('/') + 1) === rel);
  return entry ? Buffer.from(entry.data) : null;
}

/**
 * The checks of the artifacts against the manifest, the pins and the checkout. Returns the problems.
 * @param {object} manifest engine-build.json
 * @param {{ wasm: Buffer, glue: Buffer }} outputs
 */
export function artifactProblems(manifest, outputs, next, pins, commit, treeSha256) {
  const problems = [];
  if (manifest.outputs?.wasm?.sha256 !== sha256(outputs.wasm)) problems.push("engine.wasm is not the file engine-build.json records");
  if (manifest.outputs?.glue?.sha256 !== sha256(outputs.glue)) problems.push("engine.js is not the file engine-build.json records");
  if (manifest.inputs?.texLive?.commit !== pins.texLive.commit || next.build.texLive.commit !== pins.texLive.commit) problems.push("TeX Live's commit differs between engine-build.json, engine-build-pins.json and engine-notices.next.json");
  if (manifest.inputs?.emscripten?.commit !== pins.emscripten.commit || next.build.emscripten.commit !== pins.emscripten.commit) problems.push("Emscripten's commit differs between engine-build.json, engine-build-pins.json and engine-notices.next.json");
  for (const [key, want] of [['texLive', pins.texLive.commit], ['emscripten', pins.emscripten.commit]]) {
    const s = next.sources.find((x) => x.commit === want);
    if (!s) problems.push(`engine-notices.next.json lists no source archive of ${key}'s commit ${want}`);
  }
  if (manifest.build?.scripts?.commit !== commit) problems.push(`engine-build.json names the scripts' commit ${manifest.build?.scripts?.commit}, not this run's ${commit}`);
  if (manifest.build?.scripts?.treeSha256 !== treeSha256) problems.push("the scripts' tree hash in engine-build.json is not this checkout's (engine/build/ changed after the build)");
  if (manifest.layout?.staticEndBelowHeader !== true || manifest.linkMap?.pass !== true || manifest.muslNotices?.pass !== true) problems.push('engine-build.json does not record a passing layout, link map and musl notice check');
  return problems;
}

/**
 * The archive of our build scripts (git archive of engine/build, engine/engine-build-pins.json and LICENSE below
 * one top folder): the problems, if its scripts do not give the manifest's tree hash or it lacks LICENSE.
 */
export function scriptsArchiveProblems(archiveBytes, treeSha256) {
  let entries;
  try {
    entries = readTar(gunzipSync(archiveBytes));
  } catch (e) {
    return [`the scripts' archive cannot be read: ${e instanceof Error ? e.message : e}`];
  }
  const files = entries.filter((e) => e.type === 'file').map((e) => [e.path.slice(e.path.indexOf('/') + 1), Buffer.from(e.data)]);
  const problems = [];
  const tree = treeOfFiles(files.filter(([rel]) => inScriptsTree(rel)));
  if (tree.treeSha256 !== treeSha256) problems.push(`the scripts' archive gives the tree hash ${tree.treeSha256}, not the manifest's ${treeSha256}`);
  if (!files.some(([rel]) => rel === 'LICENSE')) problems.push("the scripts' archive holds no LICENSE");
  const other = files.filter(([rel]) => !inScriptsTree(rel) && rel !== 'LICENSE').map(([rel]) => rel);
  if (other.length > 0) problems.push(`the scripts' archive holds other files: ${other.slice(0, 5).join(', ')}`);
  return problems;
}

/** The release notes: what the release holds and where its source is. */
export function releaseNotes({ tag, commit, repository, manifest, next, attached, scriptsArchive }) {
  const tl = next.sources.find((s) => s.commit === manifest.inputs.texLive.commit);
  const em = next.sources.find((s) => s.commit === manifest.inputs.emscripten.commit);
  const lines = [
    `# ${tag}`,
    '',
    "liveMd2Tex's TeX engine: pdfTeX, XeTeX, xdvipdfmx and bibtex8 with kpathsea, in one WebAssembly file, built by",
    `\`engine/build/build.sh\` at commit ${commit} of ${repository}.`,
    '',
    `- \`engine.wasm\`: ${manifest.outputs.wasm.size} bytes, SHA-256 \`${manifest.outputs.wasm.sha256}\``,
    `- \`engine.js\`: ${manifest.outputs.glue.size} bytes, SHA-256 \`${manifest.outputs.glue.sha256}\``,
    '- `engine-build.json`: the record of the build (inputs, toolchain, every flag, the rename and shared lists, the imports and exports, the layout, the link map by part)',
    '',
    '## The corresponding source',
    '',
    `- TeX Live's source at commit \`${tl.commit}\` (${tl.repository}): \`${tl.name}\`, attached here, SHA-256 \`${attached[tl.name]}\`; first fetched from ${tl.url}. Its files are the commit's tree, checked file by file before attaching.`,
    `- Emscripten ${manifest.inputs.emscripten.release} at commit \`${em.commit}\` (${em.repository}): \`${em.name}\`, attached here, SHA-256 \`${attached[em.name]}\`. Its system libraries (musl, libc++, libc++abi, compiler-rt) are compiled into \`engine.wasm\`, and \`engine.js\` is its runtime, output by \`emcc\` with the flags in \`engine-build.json\`.`,
    `- Our build scripts, stubs, dispatcher and font stand-in: \`engine/build/\` and \`engine/engine-build-pins.json\` at commit ${commit} of ${repository}, with our \`LICENSE\`: \`${scriptsArchive.name}\`, attached here, SHA-256 \`${scriptsArchive.sha256}\`. Their tree hash is \`${manifest.build.scripts.treeSha256}\` (${manifest.build.scripts.method}), as \`engine-build.json\` records it.`,
    `- The toolchain: ${manifest.toolchain.emcc}; emsdk ${manifest.inputs.emsdk.commit}, with its pinned archives (engine-build-pins.json).`,
    '',
    `To build it again: Ubuntu 26.04 (the build that made these bytes ran on ${manifest.toolchain.machine?.os ?? 'it'}; another release of the compiler or the tools may give other bytes), with the host tools \`engine-build-pins.json\` lists under \`hostTools.build\` (gawk among them):`,
    '',
    '```',
    `git clone ${repository} && cd liveMd2Tex && git checkout ${commit}`,
    'bash engine/build/build.sh --fetch --root ../engine-build --out ../engine-out',
    '```',
    '',
    '## Licences',
    '',
    'Our own code is GPL-3.0-or-later. The engine as a whole can be passed on under GPL-3.0, and each part keeps its own terms. `NOTICE` lists every part with its licence and the files of this release that hold its notices; each of those files is attached.',
    '',
    `A candidate that fails a later check stays as a release of its own; \`engine/pins.json\` in ${repository} records which engine the extension ships.`,
    '',
  ];
  return lines.join('\n');
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const dir = arg(argv, '--dir');
  if (!dir || !['list', 'assemble'].includes(argv[0])) {
    console.error('usage: engine-release.mjs list --dir DIR | assemble --dir DIR --artifacts DIR --tag TAG --commit SHA [--repository URL]');
    return 2;
  }
  const next = loadNext();
  const groups = engineGroups(next);
  if (argv[0] === 'list') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'sources.json'), `${JSON.stringify({ groups }, null, 1)}\n`);
    writeFileSync(path.join(dir, 'sources.curl'), curlConfig(groups, dir, null));
    writeFileSync(path.join(dir, 'git.tsv'), gitList(groups));
    console.log(`engine: ${groups.engine.length} archives`);
    return 0;
  }
  const artifacts = arg(argv, '--artifacts');
  const tag = arg(argv, '--tag');
  const commit = arg(argv, '--commit');
  const repository = arg(argv, '--repository') ?? REPOSITORY;
  const expectWasm = arg(argv, '--expect-wasm');
  const expectGlue = arg(argv, '--expect-glue');
  const scriptsArchiveFile = arg(argv, '--scripts-archive');
  if (!artifacts || !tag || !commit || !expectWasm || !expectGlue || !scriptsArchiveFile) {
    console.error('assemble needs --artifacts, --tag, --commit, --expect-wasm, --expect-glue and --scripts-archive');
    return 2;
  }
  const problems = [];
  if (!TAG.test(tag)) problems.push(`the tag ${tag} is not engine-<TeX Live short commit>-<candidate>`);
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'engine-build-pins.json'), 'utf8'));
  if (!tag.startsWith(`engine-${pins.texLive.commit.slice(0, 7)}-`)) problems.push(`the tag ${tag} does not name TeX Live's commit ${pins.texLive.commit.slice(0, 7)}`);

  // The archives, against their pins and their commits' trees.
  const checked = checkSources(groups, dir, {});
  problems.push(...checked.problems);
  for (const n of checked.notes) console.log(`note: ${n}`);

  // The artifacts.
  const read = (f) => readFileSync(path.join(artifacts, f));
  const manifest = JSON.parse(read('engine-build.json'));
  problems.push(...artifactProblems(manifest, { wasm: read('engine.wasm'), glue: read('engine.js') }, next, pins, commit, scriptsTree(root).treeSha256));
  // The bytes the comparison matched, and no other (a release run builds again).
  if (sha256(read('engine.wasm')) !== expectWasm) problems.push(`engine.wasm is ${sha256(read('engine.wasm'))}, not the compared ${expectWasm}`);
  if (sha256(read('engine.js')) !== expectGlue) problems.push(`engine.js is ${sha256(read('engine.js'))}, not the compared ${expectGlue}`);
  // Our scripts at the commit, attached: the release holds everything needed to build it again.
  const scriptsBytes = readFileSync(scriptsArchiveFile);
  problems.push(...scriptsArchiveProblems(scriptsBytes, manifest.build?.scripts?.treeSha256));
  const scriptsArchive = { name: `engine-build-scripts-${commit.slice(0, 7)}.tar.gz`, sha256: sha256(scriptsBytes) };

  // The release folder.
  const assets = path.join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  const names = new Map();
  const put = (name, bytes, from) => {
    if (names.has(name)) problems.push(`two files of the release are named ${name}: ${names.get(name)} and ${from}`);
    names.set(name, from);
    writeFileSync(path.join(assets, name), bytes);
  };
  for (const f of ['engine.wasm', 'engine.js', 'engine-build.json', 'build.log', 'engine-logs.tar.gz']) {
    if (existsSync(path.join(artifacts, f))) put(f, read(f), `the build's ${f}`);
    else problems.push(`the build's artifacts lack ${f}`);
  }
  const archiveBytes = new Map();
  for (const s of groups.engine) {
    const file = path.join(dir, 'files', 'engine', s.name);
    if (!existsSync(file)) continue;
    archiveBytes.set(s.name, readFileSync(file));
    copyFileSync(file, path.join(assets, s.name));
    names.set(s.name, 'source archive');
  }
  for (const [file, f] of Object.entries(next.files)) {
    let bytes;
    if (f.release) {
      const archive = archiveBytes.get(f.release.archive);
      bytes = archive ? fromArchive(archive, f.release.path) : null;
      if (!bytes) {
        problems.push(`${file}: ${f.release.path} not found in ${f.release.archive}`);
        continue;
      }
    } else bytes = readFileSync(path.join(root, file));
    if (sha256(bytes) !== f.sha256) {
      problems.push(`${file}: SHA-256 ${sha256(bytes)} is not the pinned ${f.sha256}`);
      continue;
    }
    put(releaseAssetName(file), bytes, file);
  }
  // The licence texts the components name (GPL-2.0, GPL-3.0, LGPL-2.1, ICU, Apache-2.0, MIT): the repository's
  // copies, pinned in engine/bundle-licences.json's texts.
  const texts = Object.values(JSON.parse(readFileSync(path.join(root, 'engine', 'bundle-licences.json'), 'utf8')).texts);
  for (const n of [...new Set(next.components.flatMap((c) => c.notices))].filter((x) => !(x in next.files)).sort()) {
    const t = texts.find((x) => x.file === n);
    if (!t) {
      problems.push(`${n}: neither engine-notices.next.json nor engine/bundle-licences.json pins it`);
      continue;
    }
    const bytes = readFileSync(path.join(root, n));
    if (sha256(bytes) !== t.sha256) problems.push(`${n}: SHA-256 ${sha256(bytes)} is not the pinned ${t.sha256}`);
    else put(releaseAssetName(n), bytes, n);
  }
  put('NOTICE', Buffer.from(releaseNotice(next)), 'scripts/lib/engine-notices.mjs');
  put(scriptsArchive.name, scriptsBytes, "our build scripts' archive");
  // Completeness, since a published release cannot change: every component's notice files are attached, and NOTICE names every component.
  const notice = readFileSync(path.join(assets, 'NOTICE'), 'utf8');
  for (const c of next.components) {
    for (const n of c.notices) if (!names.has(releaseAssetName(n))) problems.push(`${c.id}: its notice ${n} is not attached`);
    if (!notice.includes(c.name)) problems.push(`NOTICE does not name ${c.name}`);
  }
  const attached = Object.fromEntries([...archiveBytes].map(([n, b]) => [n, sha256(b)]));
  writeFileSync(path.join(dir, 'notes.md'), releaseNotes({ tag, commit, repository, manifest, next, attached, scriptsArchive }));
  writeFileSync(path.join(dir, 'assets.txt'), `${[...names.keys()].sort().map((n) => path.join(assets, n)).join('\n')}\n`);
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `the release ${tag} is complete: ${names.size} files` : `${problems.length} problem(s); no release`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
