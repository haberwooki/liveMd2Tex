#!/usr/bin/env node
// VSIX-wide scan (docs/DESIGN.md#rules, #confinement-and-trust). Builds the extension, packages it with
// @vscode/vsce, reads the VSIX back into memory and checks every file in it:
//   - every .js, .mjs and .cjs file, not only dist/: no watched module (child_process, ws, net, tls, http,
//     https, dgram, http2, undici, dns, inspector, cluster), no watched name (fetch, WebSocket, XMLHttpRequest,
//     EventSource, RTCPeerConnection, WebTransport, sendBeacon) and no code built from text (eval, Function,
//     a Worker with eval, process.binding; build gate 1, G1S-07), except child_process in extension/dist/fork.js
//     (the one fork file, by rule) and the hits on security/vsix-scan-allowlist.json (file, line, text, reason);
//     and no speed probe (the text LIVEMD2TEX_SPEED_; docs/DEVELOPING.md, "Measuring speed");
//   - every package: the licence texts (missingNotices; G1S-04), each at its pinned bytes (wrongNotices), and with
//     the engine the notice of every part linked into it (engine/engine-notices.json); with the starting documents
//     (templates/) or the example presets (examples/presets/), their CC0 notices and the CC0 legal text, and an SPDX
//     CC0-1.0 line in each of their files that has a comment form (cc0Headers; docs/DESIGN.md#store-and-packaging);
//   - with the engine (extension/dist/engine/engine.wasm and engine.js; docs/DEVELOPING.md, "The rules the checks
//     enforce"): the pinned engine (pinnedEngine); no libpaper, MakeIndex, LuaTeX or luaffi, and no remote-fetch
//     code (engineStrings, the build's own string list); no shell, socket, network or dynamic loading among the
//     wasm's imports, each resolved through the glue and on the build record's list, and none of the glue's watched
//     names outside its reviewed comments (engineImports); the memory header (engineHeader);
//   - every file: no native program or library, no shell script, no source map, no node_modules folder, nothing of
//     engine/build/ (the build's own scripts and sources never ship);
//   - every file: no private marker (scripts/marker-scan.mjs), so no build path from this laptop ships. A file
//     over 16 MB whose SHA-256 equals a file pinned in engine/pins.json (the engine WASM) is a byte-identical pinned
//     file and is listed as such instead of being read as text. A data image (the .data a data manifest names) is
//     read file by file through its index (scanImage): text files as text, binary ones for path-like markers; the
//     name-like markers are left out of TeX Live's own files, which hold people's names by coincidence.
//
//   node scripts/vsix-scan.mjs                 build (production), package to out/vsix/, scan
//   node scripts/vsix-scan.mjs --with-engine   the same, with engine.js, engine.wasm and our engine config in
//                                              dist/engine/ (scripts/stage-engine.mjs)
//   node scripts/vsix-scan.mjs --test-copy [--data-package PATH]
//                                              a test copy: the engine plus a core-data package's data in
//                                              dist/data/ (stage-engine.mjs --data; PATH a .vsix or its unpacked
//                                              folder, by default LIVEMD2TEX_CORE_DATA); for a throwaway VS Code
//                                              profile only, never for the stores.
//   node scripts/vsix-scan.mjs --vsix FILE     scan an existing VSIX
//   node scripts/vsix-scan.mjs --vsix FILE --data   a data package (no code at all: any JavaScript fails it)
// Exit code 0 when clean; 1 with a report otherwise. A JSON report is written next to the VSIX.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, inflateSync } from 'node:zlib';
import { glueAcorn, loadAcorn, resolveGlue } from '../engine/build/tools/glue-imports.mjs';
import { deniedImport, glueAllow, glueChecks, layout, readWasm, requiredStrings, stringChecks } from '../engine/build/tools/wasm-inspect.mjs';
import { openImageBytes } from './lib/image-files.mjs';
import { lineText, scanJavaScript } from './lib/js-scan.mjs';
import { readZip } from './lib/zip.mjs';
import { loadMarkers, loadMarkerValues, scanEncoded, scanPath, scanText } from './marker-scan.mjs';
import { stageEngine } from './stage-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FORK_FILE = 'extension/dist/fork.js';
const NATIVE_OR_SHELL = /\.(node|exe|dll|so|dylib|bat|cmd|sh|ps1|com|msi)$/i;

const LARGE = 16 * 1024 * 1024;
const WASM = 'extension/dist/engine/engine.wasm';
const GLUE = 'extension/dist/engine/engine.js';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const TEXT_FILE = /\.(m?js|cjs|json|md|txt|css|html|xml|cnf|conf|tex|sty|cls|bst|vsixmanifest)$/i;

/** SHA-256 -> "source/name" for every file pinned in engine/pins.json. */
export function loadPinnedHashes(file = path.join(root, 'engine', 'pins.json')) {
  const pins = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map();
  for (const s of pins.sources) {
    for (const f of s.files ?? []) {
      out.set(f.sha256, `${s.id}/${f.name}`);
    }
  }
  return out;
}

/**
 * The package paths of the engine's notice files: each component's in engine/engine-notices.json, where the build
 * copies them (LICENSE as dist/licenses/GPL-3.0.txt, LICENSES/x as dist/licenses/x).
 */
export function engineNoticeFiles(file = path.join(root, 'engine', 'engine-notices.json')) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const inPackage = (p) => (p === 'LICENSE' ? 'extension/dist/licenses/GPL-3.0.txt' : `extension/dist/licenses/${p.replace(/^LICENSES\//, '')}`);
  return [...new Set(manifest.components.flatMap((c) => c.notices).map(inPackage))].sort();
}

/**
 * Each licence text and notice in a package must be the pinned one, not only present (the licence gate, L2-05):
 * the engine's notices at their SHA-256 in engine/engine-notices.json, the texts from LICENSES/ at theirs in
 * engine/bundle-licences.json, and LICENSE (as LICENSE.txt and dist/licenses/GPL-3.0.txt) at the GPL-3.0's. A file
 * that is missing is for missingNotices to report.
 */
export function wrongNotices(entries, manifestFile = path.join(root, 'engine', 'engine-notices.json'), rulesFile = path.join(root, 'engine', 'bundle-licences.json')) {
  // The extension's own package only: a data package's LICENSE.txt is its own text.
  if (!entries.has('extension/dist/extension.js')) {
    return [];
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const rules = JSON.parse(readFileSync(rulesFile, 'utf8'));
  const want = new Map();
  for (const t of Object.values(rules.texts)) {
    if (t.file === 'LICENSE') {
      want.set('extension/LICENSE.txt', t.sha256);
      want.set('extension/LICENSE', t.sha256);
      want.set('extension/dist/licenses/GPL-3.0.txt', t.sha256);
    } else if (t.file?.startsWith('LICENSES/')) {
      want.set(`extension/dist/licenses/${t.file.slice('LICENSES/'.length)}`, t.sha256);
    }
  }
  for (const [file, { sha256 }] of Object.entries(manifest.files)) {
    want.set(`extension/dist/licenses/${file.replace(/^LICENSES\//, '')}`, sha256);
  }
  const failures = [];
  for (const [name, sha256] of want) {
    const data = entries.get(name);
    if (data && createHash('sha256').update(data).digest('hex') !== sha256) {
      failures.push(`${name}: not the pinned text (SHA-256 ${sha256})`);
    }
  }
  return failures;
}

/** The engine release pinned in engine/pins.json (livemd2tex-engine) and its build record. */
function pinnedEngineRecord(pinsFile = path.join(root, 'engine', 'pins.json'), recordFile = path.join(root, 'engine', 'engine-build.json')) {
  const pin = JSON.parse(readFileSync(pinsFile, 'utf8')).sources.find((x) => x.id === 'livemd2tex-engine');
  return { pin, record: JSON.parse(readFileSync(recordFile, 'utf8')) };
}

/**
 * Check 1, the engine is the pinned one: the wasm's and the glue's SHA-256 are engine/pins.json's livemd2tex-engine
 * entries, and the wasm's is engine/engine-build.json's output hash. The glue is Emscripten's own, so its hash is
 * what vouches for every line the allow-list reviews.
 */
export function pinnedEngine(entries, pinsFile, recordFile) {
  const wasm = entries.get(WASM);
  const glue = entries.get(GLUE);
  if (!wasm && !glue) {
    return [];
  }
  if (!wasm || !glue) {
    return [`the package holds ${wasm ? WASM : GLUE} without ${wasm ? GLUE : WASM}`];
  }
  const { pin, record } = pinnedEngineRecord(pinsFile, recordFile);
  if (!pin) {
    return ['engine/pins.json pins no livemd2tex-engine source'];
  }
  const failures = [];
  for (const [name, bytes, file] of [[WASM, wasm, 'engine.wasm'], [GLUE, glue, 'engine.js']]) {
    const want = pin.files.find((f) => f.name === file)?.sha256;
    if (sha256(bytes) !== want) {
      failures.push(`${name}: SHA-256 ${sha256(bytes)} is not the pinned ${file} (${want ?? 'none pinned'})`);
    }
  }
  if (record.outputs?.wasm?.sha256 !== sha256(wasm)) {
    failures.push(`${WASM}: not the engine engine/engine-build.json records (${record.outputs?.wasm?.sha256})`);
  }
  return failures;
}

/**
 * Checks 2, 4, 5 and 6, on the wasm read as latin1 and on the glue: no libpaper (GPL-2.0-only, which does not
 * combine with the extension's GPL-3.0-or-later code: its paper table, PAPERSIZE, PAPERCONF and /etc/papersize
 * absent, and dvipdfmx's own paper table present), no MakeIndex, no LuaTeX or luaffi, no remote-fetch code. The
 * strings are the build's own list (engine/build/tools/wasm-inspect.mjs), so the build and the scan check the same.
 */
export function engineStrings(entries) {
  const wasm = entries.get(WASM);
  if (!wasm) {
    return [];
  }
  const glue = entries.get(GLUE)?.toString('utf8') ?? null;
  const failures = [];
  for (const c of stringChecks(wasm, glue)) {
    if (c.inWasm) failures.push(`${WASM}: holds "${c.text}" (${c.part}; ${c.check})`);
    if (c.inGlue) failures.push(`${GLUE}: holds "${c.text}" (${c.part}; ${c.check})`);
  }
  for (const c of requiredStrings(wasm)) {
    if (!c.inWasm) failures.push(`${WASM}: lacks "${c.text}" (${c.part}): dvipdfmx was built with libpaper`);
  }
  return failures;
}

/**
 * Check 3, no shell, no socket, no network, no dynamic loading: every import of the wasm, resolved through the
 * glue's wasmImports, is on engine/engine-build.json's list and none is denied, whatever the list says; the build
 * record shows NODERAWSOCKETS, NODERAWFS and NODEFS off; and the glue's watched names (SOCKFS, createSocket,
 * spawnSync, child_process) appear only in the comments engine/build/glue-allow.json reviews for this glue.
 */
export async function engineImports(entries, recordFile) {
  const wasm = entries.get(WASM);
  const glue = entries.get(GLUE);
  if (!wasm || !glue) {
    return [];
  }
  await loadAcorn();
  glueAcorn();
  const { record } = pinnedEngineRecord(undefined, recordFile);
  const failures = [];
  const text = glue.toString('utf8');
  const resolved = resolveGlue(text, readWasm(wasm));
  const recorded = new Set((record.imports ?? []).map((i) => i.resolved));
  for (const imp of resolved.imports) {
    if (imp.resolved === null) failures.push(`${WASM}: import ${imp.module}.${imp.name} does not resolve through the glue`);
    else if (deniedImport(imp.resolved)) failures.push(`${WASM}: import ${imp.name} resolves to ${imp.resolved}, which is denied`);
    else if (!recorded.has(imp.resolved)) failures.push(`${WASM}: import ${imp.resolved} is not on engine/engine-build.json's list`);
  }
  for (const [setting, value] of Object.entries(record.emscriptenSettingsOff ?? {})) {
    if (value !== false && value !== 0) failures.push(`engine/engine-build.json: Emscripten setting ${setting} is on`);
  }
  for (const setting of ['NODERAWSOCKETS', 'NODERAWFS', 'NODEFS']) {
    if (!(setting in (record.emscriptenSettingsOff ?? {}))) failures.push(`engine/engine-build.json records no ${setting}`);
  }
  failures.push(...glueChecks(text, glueAllow()).failures.map((f) => `${GLUE}: ${f}`));
  return failures;
}

/** The WebAssembly files a package may hold: the engine (pinnedEngine checks it) and pdf.js's three decoders. */
export const KNOWN_WASM = new Set([WASM, 'extension/dist/viewer/pdfjs/wasm/jbig2.wasm', 'extension/dist/viewer/pdfjs/wasm/openjpeg.wasm', 'extension/dist/viewer/pdfjs/wasm/qcms_bg.wasm']);

/** The engine's build files by name: the build's own C files and lists, wherever they are in a package. */
const BUILD_FILES = /(^|\/)(engine\/build\/|dispatcher\.c$|stubs\.c$|fontlist\.c$|glue-allow\.json$|engine-build-pins\.json$|configure-check\.mjs$|link-report\.mjs$|wasm-inspect\.mjs$)/;

/**
 * The engine by its content, not only its two names: every file that is WebAssembly (its first bytes are "\0asm",
 * whatever its name) must be one of KNOWN_WASM; every script that is Emscripten's glue (it builds wasmImports and
 * has Emscripten's file system) must be the engine's engine.js; and nothing of the engine's build ships, under
 * engine/build/ or by one of its own file names anywhere. A stale engine, or one under a new name, fails here
 * instead of passing the checks that look at the two names.
 */
export function engineByContent(entries) {
  const failures = [];
  for (const [name, data] of entries) {
    if (data.length >= 4 && data[0] === 0 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d && !KNOWN_WASM.has(name)) {
      failures.push(`${name}: WebAssembly that is neither the pinned engine nor one of pdf.js's decoders`);
    }
    if (name !== GLUE && /\.(m|c)?js$/i.test(name)) {
      const text = data.toString('latin1');
      if (/\bwasmImports\b/.test(text) && /\bcreateLazyFile\b/.test(text)) failures.push(`${name}: Emscripten's glue under a name that is not the engine's engine.js`);
    }
    if (BUILD_FILES.test(name.replace(/^extension\//, ''))) {
      failures.push(`${name}: the engine's build scripts and sources (engine/build/) in the VSIX`);
    }
  }
  return failures;
}

/**
 * The engine's notices describe the shipped engine: engine/engine-notices.json's build commits are the ones
 * engine/engine-build.json records, so a package does not carry another engine's notices.
 */
export function noticesForEngine(entries, noticesFile = path.join(root, 'engine', 'engine-notices.json'), recordFile = path.join(root, 'engine', 'engine-build.json')) {
  if (!entries.has(WASM)) {
    return [];
  }
  const notices = JSON.parse(readFileSync(noticesFile, 'utf8'));
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  const failures = [];
  for (const [what, a, b] of [
    ["TeX Live's commit", notices.build?.texLive?.commit, record.inputs?.texLive?.commit],
    ["Emscripten's commit", notices.build?.emscripten?.commit, record.inputs?.emscripten?.commit],
    ["the build scripts' commit", notices.build?.scripts?.commit, record.build?.scripts?.commit],
    ["the build scripts' tree hash", notices.build?.scripts?.treeSha256, record.build?.scripts?.treeSha256],
  ]) {
    if (!a || a !== b) failures.push(`engine/engine-notices.json names ${what} ${a ?? '(none)'}, engine/engine-build.json ${b ?? '(none)'}: the notices describe another engine`);
  }
  return failures;
}

/**
 * Check 8, the memory header: the build record's layout has the 64 MiB initial memory the worker restores after
 * each program (HEADER_BYTES), the stack first and 8 MiB, and its data and static end below the header; the
 * shipped wasm's own memory says the same.
 */
export function engineHeader(entries, recordFile) {
  const wasm = entries.get(WASM);
  if (!wasm) {
    return [];
  }
  const { record } = pinnedEngineRecord(undefined, recordFile);
  const mib = 2 ** 20;
  const l = record.layout ?? {};
  const failures = [];
  if (l.initialMemory !== 64 * mib) failures.push(`engine/engine-build.json: initial memory ${l.initialMemory}, not 64 MiB (the worker's header)`);
  if (l.stackFirst !== true) failures.push('engine/engine-build.json: the stack does not come first');
  if (l.stackSize !== 8 * mib) failures.push(`engine/engine-build.json: stack ${l.stackSize}, not 8 MiB`);
  if (!(l.dataEnd < l.initialMemory) || !(l.staticEnd < l.initialMemory)) failures.push(`engine/engine-build.json: data (${l.dataEnd}) or static data (${l.staticEnd}) ends past the header`);
  const own = layout(readWasm(wasm));
  if (own.memoryImported) failures.push(`${WASM}: its memory is imported, so its size is not the wasm's own`);
  else if (own.initialMemory !== 64 * mib) failures.push(`${WASM}: initial memory ${own.initialMemory}, not 64 MiB`);
  return failures;
}

/** Texts only the data packages ship, for some of their TeX packages (scripts/build.mjs leaves them out). */
export const DATA_ONLY_TEXTS = ['AGPL-3.0.txt', 'MakeIndex.txt'];

/** The extension's own package holds none of the texts only the data packages ship: nothing in it is under them. */
export function dataOnlyTexts(entries) {
  if (!entries.has('extension/dist/extension.js')) {
    return [];
  }
  return DATA_ONLY_TEXTS.map((t) => `extension/dist/licenses/${t}`)
    .filter((n) => entries.has(n))
    .map((n) => `${n}: a licence text only the data packages ship; nothing in the extension is under it`);
}

/**
 * The licence texts every package must carry (build gate 1, G1S-04): the notices and the licence folder; with the
 * engine, the notice of every part linked into it (engineNoticeFiles); in a test copy, its core data's licence
 * folder.
 */
export function missingNotices(entries) {
  const required = [];
  if (entries.has('extension/dist/extension.js')) {
    required.push(
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      'extension/dist/licenses/INDEX.txt',
      'extension/dist/licenses/GPL-3.0.txt',
      'extension/dist/licenses/LGPL-3.0.txt',
      'extension/dist/licenses/Apache-2.0.txt',
      'extension/dist/licenses/LPPL-1.3c.txt',
    );
  }
  // The engine: the notices of every part linked into it (engine/engine-notices.json; the licence gate, L-01 and M2).
  if (entries.has(WASM)) {
    required.push(...engineNoticeFiles());
  }
  for (const folder of ['templates', 'examples/presets']) {
    if ([...entries.keys()].some((n) => n.startsWith(`extension/${folder}/`))) {
      required.push(`extension/${folder}/LICENSE.md`, 'extension/dist/licenses/CC0-1.0.txt');
    }
  }
  // A test copy's core data: the licence folder of the core-data package it came from (stage-engine.mjs --data).
  if (entries.has('extension/dist/data/manifest.json')) {
    required.push('extension/dist/data/LICENSES/INDEX');
  }
  return [...new Set(required)]
    .filter((n) => !entries.has(n) && !(n === 'extension/LICENSE.txt' && entries.has('extension/LICENSE')))
    .map((n) => `${n}: licence file missing from the package`);
}

/**
 * The starting documents and the example presets are CC0 (they are copied into users' folders): each of their
 * files that has a comment form (.tex, .bib, .md) carries the line "SPDX-License-Identifier: CC0-1.0", and none
 * names the GPL. JSON has no comments; the preset's description says CC0 instead.
 */
export function cc0Headers(entries) {
  const failures = [];
  for (const [name, data] of entries) {
    if (!/^extension\/(templates|examples\/presets)\//.test(name) || /\/LICENSE\.md$/.test(name)) {
      continue;
    }
    const text = data.toString('utf8');
    if (/\.(tex|bib|md)$/i.test(name) && !text.includes('SPDX-License-Identifier: CC0-1.0')) {
      failures.push(`${name}: no SPDX-License-Identifier: CC0-1.0 line`);
    }
    if (/\bGPL\b|GNU General Public/.test(text)) {
      failures.push(`${name}: names the GPL, but files copied into users' folders are CC0`);
    }
  }
  return failures;
}

export function loadAllowlist(file = path.join(root, 'security', 'vsix-scan-allowlist.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).entries;
}

/**
 * Scans the entries of a VSIX (or any name -> bytes map).
 * @param {Map<string, Buffer>} entries
 * @param {{file: string, line: number, match: string, text: string, reason: string}[]} allowlist
 * @param {ReturnType<typeof loadMarkers>} markers
 * @param {Map<string, string>} [pinned] SHA-256 -> pinned file, for large third-party files
 */
export function scanEntries(entries, allowlist, markers, pinned = new Map(), { dataOnly = false, markerValues = [] } = {}) {
  const failures = [];
  const hits = [];
  const jsFiles = [];
  const wasmFiles = [];
  const pinnedFiles = [];
  const imageFiles = [];
  const used = new Set();
  const images = dataImages(entries);

  for (const entry of allowlist) {
    if (entry.match === 'child_process') {
      failures.push(`allow-list entry ${entry.file}:${entry.line} tries to allow child_process; only ${FORK_FILE} may use it`);
    }
  }

  for (const [name, data] of entries) {
    if (NATIVE_OR_SHELL.test(name)) {
      failures.push(`${name}: native program, library or shell script in the VSIX`);
    }
    if (/\.map$/i.test(name)) {
      failures.push(`${name}: source map in the VSIX`);
    }
    if (/(^|\/)node_modules\//.test(name)) {
      failures.push(`${name}: node_modules in the VSIX (dependencies must be bundled)`);
    }
    if (/\.wasm$/i.test(name)) {
      wasmFiles.push({ name, bytes: data.length });
    }
    // A data image: its files, one by one through its index, not its compressed bytes (scanImage).
    if (images.has(name)) {
      try {
        const { index, manifest } = images.get(name);
        const image = scanImage(name, data, entries.get(index), markers, markerValues, packageFiles(manifest));
        imageFiles.push({ name, files: image.files, packageFiles: image.packageFiles });
        for (const f of image.findings) {
          failures.push(`${f.file}:${f.line}:${f.column}: private marker (${f.marker})`);
        }
      } catch (err) {
        failures.push(`${name}: the data image cannot be read through its index (${err instanceof Error ? err.message : err})`);
      }
      continue;
    }
    const pin = data.length > LARGE ? pinned.get(createHash('sha256').update(data).digest('hex')) : undefined;
    if (pin) {
      pinnedFiles.push({ name, bytes: data.length, pinned: pin });
    }
    const text = pin ? '' : data.toString('latin1');
    // Text files are also searched for each marker in base64, hex and percent encoding (build gate 2, G2S-01);
    // binary files are not, because six random base64 characters turn up in megabytes of binary by chance.
    const encoded = TEXT_FILE.test(name) ? scanEncoded(text, name, markerValues, []) : [];
    for (const f of [...scanPath(name, markers), ...scanText(text, name, markers, []), ...encoded]) {
      failures.push(`${f.file}:${f.line}:${f.column}: private marker (${f.marker})`);
    }
    if (!/\.(m|c)?js$/i.test(name)) {
      continue;
    }
    const source = data.toString('utf8');
    jsFiles.push(name);
    // The speed probe is measuring code and never ships (docs/DEVELOPING.md, "Measuring speed"): its variables'
    // prefix in a packaged script means a --speed-probe build got into the package.
    if (source.includes('LIVEMD2TEX_SPEED_')) {
      failures.push(`${name}: holds the speed probe (LIVEMD2TEX_SPEED_); package a build made without --speed-probe`);
    }
    let fileHits;
    try {
      fileHits = scanJavaScript(source, name);
    } catch (err) {
      failures.push(err.message);
      continue;
    }
    for (const hit of fileHits) {
      const text = lineText(source, hit.line);
      let status;
      if (hit.match === 'child_process') {
        status = name === FORK_FILE ? 'fork file' : 'FAIL';
      } else {
        const index = allowlist.findIndex(
          (e) => e.file === name && e.line === hit.line && e.match === hit.match && e.text === text,
        );
        status = index >= 0 ? 'allow-listed' : 'FAIL';
        if (index >= 0) {
          used.add(index);
        }
      }
      hits.push({ ...hit, text, status });
      if (status === 'FAIL') {
        failures.push(`${name}:${hit.line}:${hit.column}: ${hit.kind} "${hit.match}" not allowed: ${text}`);
      }
    }
  }

  if (dataOnly) {
    for (const name of jsFiles) {
      failures.push(`${name}: JavaScript in a data package (a data package has no code)`);
    }
  } else if (!entries.has(FORK_FILE)) {
    failures.push(`${FORK_FILE} is missing from the VSIX`);
  }
  allowlist.forEach((e, i) => {
    // An entry for a file that is not in this package (for example the engine glue before V0) is not checked.
    if (!used.has(i) && e.match !== 'child_process' && entries.has(e.file)) {
      failures.push(`stale allow-list entry ${e.file}:${e.line} (${e.match}): no such hit any more; review the file again`);
    }
  });
  return { files: entries.size, jsFiles, wasmFiles, pinnedFiles, imageFiles, hits, failures };
}

/**
 * The data images of a package: each image a data manifest names (data/manifest.json in a data package,
 * dist/data/manifest.json in a test copy), as image entry -> { index: its index's entry, manifest: the manifest }.
 */
export function dataImages(entries) {
  const out = new Map();
  for (const [name, bytes] of entries) {
    if (!/(^|\/)data\/manifest\.json$/.test(name)) continue;
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    const image = manifest?.image;
    if (typeof image?.file !== 'string' || typeof image?.index !== 'string') continue;
    const dir = name.slice(0, name.length - 'manifest.json'.length);
    const data = `${dir}${path.posix.basename(image.file)}`;
    const index = `${dir}${path.posix.basename(image.index)}`;
    if (entries.has(data) && entries.has(index)) out.set(data, { index, manifest });
  }
  return out;
}

/**
 * The image paths of TeX Live's own files in a data set: the files its manifest's package index lists for each
 * package of the pinned snapshot (index.packages.*.files), under the image's root (the core's texmf tree, an
 * add-on's top). The files the data builder wrote itself (ls-R, the font list, the formats, the language and map
 * files) are not among them.
 */
export function packageFiles(manifest) {
  const root = manifest?.core?.root ?? '';
  const out = new Set();
  for (const p of Object.values(manifest?.index?.packages ?? {})) {
    for (const rel of p?.files ?? []) out.add(`${root}/${rel}`);
  }
  return out;
}

/** Kinds inside a data image that are not text: fonts, TeX's binary metrics and formats, pictures, archives. */
const IMAGE_BINARY = /\.(pfb|pfm|otf|ttf|ttc|otc|woff2?|eot|cff|tfm|ofm|vf|ovf|pk|\d+pk|gf|fmt|png|jpe?g|gif|bmp|tiff?|pdf|zip|gz|xz|bz2|dvi|xdv|bin)$/i;

/** A format's bytes after TeX's gzip compression is undone (the bytes as they are when they are not compressed). */
function unpackedFormat(bytes) {
  for (const unpack of [gunzipSync, inflateSync]) {
    try {
      return unpack(bytes);
    } catch {
      // not this kind
    }
  }
  return bytes;
}

/**
 * A data image's files, scanned for private markers one by one through the image's index instead of as compressed
 * bytes, in which a marker can turn up by chance and a real one can be split by LZ4's back-references. Every file's
 * path is scanned. A text file is scanned as a packaged text file is, and in the encoded forms too when its kind is
 * one TEXT_FILE names. A binary file (a font, a format, a picture, an archive: by its kind, or a NUL byte in its first
 * 4 KB) is scanned for path-like markers only (the laptop's user path, which a build could leave in any file), since
 * a short text marker turns up in megabytes of binary by chance; a format is scanned after its gzip compression is
 * undone. In TeX Live's own files (`packageFiles`: the files of the pinned snapshot's packages) the markers of kind
 * "word" are left out: they are people's names, which TeX packages hold by coincidence, and a list of the files where
 * they occur would narrow down the names. Every other marker is still searched there, and every marker in every file
 * the index does not list, the files the data builder wrote among them. Returns the number of files, of TeX Live's own files, and the findings, each file named
 * "<image entry>!<path in the image>".
 */
export function scanImage(name, data, indexBytes, markers, markerValues = [], ownFiles = new Set()) {
  const index = JSON.parse(indexBytes.toString('utf8'));
  const reader = openImageBytes(data, index.compressed);
  const pathMarkers = markers.filter((m) => m.kind === 'user-path');
  const notWords = markers.filter((m) => m.kind !== 'word');
  const valuesNotWords = markerValues.filter((m) => m.kind !== 'word');
  const files = index.metadata?.files ?? [];
  const findings = [];
  let ofPackages = 0;
  for (const f of files) {
    const file = `${name}!${f.filename}`;
    const own = ownFiles.has(f.filename);
    if (own) ofPackages++;
    const bytes = reader.read(f.start, f.end);
    findings.push(...scanPath(file, own ? notWords : markers));
    if (IMAGE_BINARY.test(f.filename) || bytes.subarray(0, 4096).includes(0)) {
      const plain = /\.fmt$/i.test(f.filename) ? unpackedFormat(bytes) : bytes;
      findings.push(...scanText(plain.toString('latin1'), file, pathMarkers, []));
      continue;
    }
    const text = bytes.toString('latin1');
    findings.push(...scanText(text, file, own ? notWords : markers, []));
    if (TEXT_FILE.test(f.filename)) findings.push(...scanEncoded(text, file, own ? valuesNotWords : markerValues, []));
  }
  return { files: files.length, packageFiles: ofPackages, findings };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (exit ${r.status})`);
  }
}

async function main(argv) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const vsixArg = argv.indexOf('--vsix');
  let vsixPath;
  if (vsixArg >= 0) {
    vsixPath = path.resolve(argv[vsixArg + 1]);
  } else {
    run(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--production']);
    const testCopy = argv.includes('--test-copy');
    const withEngine = testCopy || argv.includes('--with-engine');
    // build.mjs empties dist/, so the plain package never holds the engine or the image.
    rmSync(path.join(root, 'dist', 'engine'), { recursive: true, force: true });
    rmSync(path.join(root, 'dist', 'data'), { recursive: true, force: true });
    if (pkg.extensionDependencies?.length && testCopy) {
      throw new Error('the test copy is built without extensionDependencies (docs/DESIGN.md#testing, V0)');
    }
    if (withEngine) {
      const at = argv.indexOf('--data-package');
      console.log(stageEngine({ data: testCopy, dataPackage: at >= 0 ? path.resolve(argv[at + 1]) : process.env.LIVEMD2TEX_CORE_DATA || null }).join('\n'));
    }
    mkdirSync(path.join(root, 'out', 'vsix'), { recursive: true });
    const suffix = testCopy ? '-testcopy' : withEngine ? '-engine' : '';
    vsixPath = path.join(root, 'out', 'vsix', `${pkg.name}-${pkg.version}${suffix}.vsix`);
    const vsce = await import('@vscode/vsce');
    await vsce.createVSIX({ cwd: root, packagePath: vsixPath, dependencies: false, allowMissingRepository: true });
  }

  const zip = readFileSync(vsixPath);
  const entries = readZip(zip);
  const dataOnly = argv.includes('--data');
  const markerValues = loadMarkerValues();
  const result = scanEntries(entries, loadAllowlist(), loadMarkers(), loadPinnedHashes(), { dataOnly, markerValues });
  result.failures.push(...missingNotices(entries), ...cc0Headers(entries), ...dataOnlyTexts(entries), ...pinnedEngine(entries), ...engineByContent(entries), ...noticesForEngine(entries), ...engineStrings(entries), ...(await engineImports(entries)), ...engineHeader(entries), ...wrongNotices(entries));
  const unpacked = [...entries.values()].reduce((n, b) => n + b.length, 0);
  const report = {
    vsix: path.basename(vsixPath),
    vsixBytes: statSync(vsixPath).size,
    unpackedBytes: unpacked,
    ...result,
  };
  writeFileSync(vsixPath.replace(/\.vsix$/i, '.scan.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`VSIX ${report.vsix}: ${(report.vsixBytes / 1048576).toFixed(2)} MB packed, ` +
    `${(unpacked / 1048576).toFixed(2)} MB unpacked, ${result.files} files, ${result.jsFiles.length} JavaScript files scanned.`);
  console.log(`WASM files: ${result.wasmFiles.map((w) => `${w.name} (${w.bytes} B)`).join(', ') || 'none'}`);
  for (const p of result.pinnedFiles) {
    console.log(`Pinned file, byte-identical: ${p.name} = ${p.pinned} (${p.bytes} B)`);
  }
  for (const i of result.imageFiles) {
    console.log(`Data image, scanned file by file through its index: ${i.name} (${i.files} files, ${i.packageFiles} of them TeX Live's own)`);
  }
  for (const h of result.hits) {
    console.log(`  ${h.status.padEnd(12)} ${h.file}:${h.line}  ${h.kind} ${h.match}`);
  }
  if (result.failures.length > 0) {
    console.error(`VSIX scan FAILED (${result.failures.length}):`);
    for (const f of result.failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  if (dataOnly) {
    console.log('VSIX scan passed (data package): no JavaScript, no native code, no source maps, no private markers.');
    return 0;
  }
  console.log(`VSIX scan passed: child_process only in ${FORK_FILE}; ${result.hits.filter((h) => h.status === 'allow-listed').length} reviewed hits; no native code, no source maps, no private markers.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
