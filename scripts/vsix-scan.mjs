#!/usr/bin/env node
// VSIX-wide scan (docs/DESIGN.md#rules, #confinement-and-trust). Builds the extension, packages it with
// @vscode/vsce, reads the VSIX back into memory and checks every file in it:
//   - every .js, .mjs and .cjs file, not only dist/: no watched module (child_process, ws, net, tls, http,
//     https, dgram, http2, undici, dns, inspector, cluster), no watched name (fetch, WebSocket, XMLHttpRequest,
//     EventSource, RTCPeerConnection, WebTransport, sendBeacon) and no code built from text (eval, Function,
//     a Worker with eval, process.binding; build gate 1, G1S-07), except child_process in extension/dist/fork.js
//     (the one fork file, by rule) and the hits on security/vsix-scan-allowlist.json (file, line, text, reason);
//   - every package: the licence texts (missingNotices; G1S-04); with the starting documents (templates/) or the
//     example presets (examples/presets/), their CC0 notices and the CC0 legal text, and an SPDX CC0-1.0 line in
//     each of their files that has a comment form (cc0Headers; docs/DESIGN.md#store-and-packaging);
//   - every file: no native program or library, no shell script, no source map, no node_modules folder;
//   - every file: no private marker (scripts/marker-scan.mjs), so no build path from this laptop ships. A file
//     over 16 MB whose SHA-256 equals a file pinned in engine/pins.json (TeXlyre's image, the engine WASM) is a
//     byte-identical third-party download and is listed as such instead of being read as text.
//
//   node scripts/vsix-scan.mjs                 build (production), package to out/vsix/, scan
//   node scripts/vsix-scan.mjs --with-engine   the same, with the patched engine glue, its WASM and our engine
//                                              config in dist/engine/ (scripts/stage-engine.mjs)
//   node scripts/vsix-scan.mjs --test-copy     version 0's test copy: the engine plus TeXlyre's image, unchanged,
//                                              in dist/data/ (stage-engine.mjs --data); about 360 MB. For a
//                                              throwaway VS Code profile only, never for the stores.
//   node scripts/vsix-scan.mjs --vsix FILE     scan an existing VSIX
//   node scripts/vsix-scan.mjs --vsix FILE --data   a data package (no code at all: any JavaScript fails it)
// Exit code 0 when clean; 1 with a report otherwise. A JSON report is written next to the VSIX.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lineText, scanJavaScript } from './lib/js-scan.mjs';
import { readZip } from './lib/zip.mjs';
import { loadMarkers, loadMarkerValues, scanEncoded, scanPath, scanText } from './marker-scan.mjs';
import { stageEngine } from './stage-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FORK_FILE = 'extension/dist/fork.js';
const NATIVE_OR_SHELL = /\.(node|exe|dll|so|dylib|bat|cmd|sh|ps1|com|msi)$/i;

const LARGE = 16 * 1024 * 1024;
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
 * The licence texts every package must carry (build gate 1, G1S-04): the notices and the licence folder, and in
 * a test copy the licences of the TeX image and the DejaVu fonts.
 */
export function missingNotices(entries) {
  const required = [];
  if (entries.has('extension/dist/extension.js')) {
    required.push(
      'extension/LICENSE.txt',
      'extension/THIRD_PARTY_NOTICES.md',
      'extension/dist/licenses/INDEX.txt',
      'extension/dist/licenses/GPL-3.0.txt',
      'extension/dist/licenses/AGPL-3.0.txt',
      'extension/dist/licenses/LGPL-3.0.txt',
      'extension/dist/licenses/Apache-2.0.txt',
      'extension/dist/licenses/LPPL-1.3c.txt',
    );
  }
  // ICU and MakeIndex are built into the engine (THIRD_PARTY_NOTICES.md).
  if (entries.has('extension/dist/engine/busytex.wasm')) {
    required.push('extension/dist/licenses/ICU.txt', 'extension/dist/licenses/MakeIndex.txt');
  }
  for (const folder of ['templates', 'examples/presets']) {
    if ([...entries.keys()].some((n) => n.startsWith(`extension/${folder}/`))) {
      required.push(`extension/${folder}/LICENSE.md`, 'extension/dist/licenses/CC0-1.0.txt');
    }
  }
  if (entries.has('extension/dist/data/texlive-extra.data')) {
    required.push('extension/dist/data/licenses/TeX-Live-LICENSE.TL.txt', 'extension/dist/data/licenses/TeX-Live-LICENSE.CTAN.txt', 'extension/dist/data/licenses/lppl.tex');
  }
  if ([...entries.keys()].some((n) => /^extension\/dist\/data\/fonts\/.*\.ttf$/.test(n))) {
    required.push('extension/dist/data/fonts/LICENSE');
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

/**
 * The engine glue in a package must be the patched glue pinned in engine/pins.json (G1S-08): a glue without one
 * of the patches (no shell, no remote fetch) changes no watched name, so only its hash shows it.
 */
export function unpinnedGlue(entries, file = path.join(root, 'engine', 'pins.json')) {
  const glue = entries.get('extension/dist/engine/busytex.js');
  if (!glue) {
    return [];
  }
  const pins = JSON.parse(readFileSync(file, 'utf8'));
  const want = pins.sources.find((s) => s.id === 'texlyre-busytex')?.patchedGlue?.sha256;
  const have = createHash('sha256').update(glue).digest('hex');
  return want === have ? [] : [`extension/dist/engine/busytex.js: SHA-256 ${have} is not the pinned patched glue (${want ?? 'none pinned'})`];
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
  const used = new Set();

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
  return { files: entries.size, jsFiles, wasmFiles, pinnedFiles, hits, failures };
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
      console.log(stageEngine({ data: testCopy }).join('\n'));
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
  result.failures.push(...missingNotices(entries), ...cc0Headers(entries), ...unpinnedGlue(entries));
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
    console.log(`Pinned third-party file, byte-identical: ${p.name} = ${p.pinned} (${p.bytes} B)`);
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
