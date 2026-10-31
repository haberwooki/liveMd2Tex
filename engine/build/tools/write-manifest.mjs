#!/usr/bin/env node
// engine/build/tools/write-manifest.mjs: writes engine-build.json, the record of one engine build
// (docs/DEVELOPING.md, "The TeX engine: our own build"). build.sh runs it last, under Linux.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node write-manifest.mjs --root ROOT --out OUT --pins PINS --repo REPO
//
// It records every input's hash, the toolchain, the full flag lists, the rename and shared lists and their hashes,
// the imports and exports in both forms (minified and resolved through the glue), the memory layout, each
// section's size, the custom sections, the string checks, the Emscripten settings that must be off, the scripts'
// commit and tree hash, and the output files' sizes and SHA-256. It holds no absolute path and no user name: every
// path under the build root is written as <root>, and the file is refused if anything of the build machine's home,
// user name or repository path is left in it.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, readWasm, stringChecks, deniedImport, GLUE_ABSENT } from './wasm-inspect.mjs';
import { loadAcorn, resolveGlue } from './glue-imports.mjs';
import { scriptsTree } from './scripts-tree.mjs';

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['root', 'out', 'pins', 'repo']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `${(e.stdout ?? '').trim()}${(e.stderr ?? '').trim()}`.trim() || null;
  }
}

/** A command's standard output and error together (emcc -v writes to standard error). */
function runBoth(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

function osName() {
  try {
    const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The first line of a tool's --version, and its Debian package's version (dpkg-query), for the tools that touch the build, so two machines' builds can be told apart. */
function hostTools() {
  const first = (cmd, args) => (run(cmd, args) ?? '').split('\n')[0] || null;
  const pkg = (name) => run('dpkg-query', ['-W', '-f=${Version}', name]);
  return {
    awk: { version: first('awk', ['--version']), package: pkg('gawk') },
    sed: { version: first('sed', ['--version']), package: pkg('sed') },
    make: { version: first('make', ['--version']), package: pkg('make') },
    bash: { version: first('bash', ['--version']), package: pkg('bash') },
    tar: { version: first('tar', ['--version']), package: pkg('tar') },
    coreutils: { version: first('sort', ['--version']), package: pkg('coreutils') },
    gcc: { version: first('gcc', ['--version']), package: pkg('gcc') },
    python: { version: run('python3', ['--version']), package: pkg('python3') },
  };
}

// The build's edits to files that TeX Live's configure or make generated, or to a product of its build; the source
// itself is not changed (inputs.patches is empty).
const SKIPPED = 'configure scripts of the folders the four programs do not need';
const GENERATED_EDITS = [
  { target: 'texk/dvipdfm-x/config.h', edit: '#define HAVE_LIBPAPER 1 becomes #undef HAVE_LIBPAPER', reason: 'dvipdfmx without libpaper (GPL-2.0-only); build.sh drop_libpaper' },
  { target: 'texk/dvipdfm-x/Makefile', edit: 'LIBPAPER_LIBS, LIBPAPER_DEPEND and LIBPAPER_INCLUDES emptied', reason: 'the same; build.sh drop_libpaper' },
  { target: 'texk/web2c/pdftexd.h', edit: 'EXTERN becomes extern for each shared name (lists.shared)', reason: "one definition of each shared name, XeTeX's; build.sh do_rename" },
  { target: 'libs/icu/icu-build/lib/libicudata.a', edit: "replaced by TeX Live's icudt78l.dat compiled whole (genccode, emcc)", reason: "ICU's own packaging gives a table ICU 78 rejects; build.sh build_icu_data" },
  { target: SKIPPED, edit: 'execute bit cleared, so TeX Live neither configures nor builds them', reason: 'some cannot configure for wasm32 (libs/luajit); build.sh skip_unused_packages' },
];

function skippedFolders(root) {
  try {
    const line = readFileSync(path.join(root, 'logs', 'unpack.log'), 'utf8').split('\n').find((l) => l.startsWith('not configured:'));
    return line ? line.slice('not configured:'.length).trim().split(/\s+/).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/** A folder's files as the scripts' tree hash takes them (the same method): count and SHA-256. */
function treeOf(dir) {
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk('');
  files.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0));
  const lines = files.map((f) => `${sha256(readFileSync(path.join(dir, f)))}  ${f}\n`).join('');
  return { files: files.length, treeSha256: sha256(lines) };
}

/**
 * What of the build machine a manifest's text would give away: the repository's path, the home folder, any
 * /home/, /mnt/ or C: path, and the user name as a whole element of a path (after "/" or "\", before the next
 * separator, a quote or the end). A user name elsewhere is no leak: on GitHub's runners the user is "runner", which
 * the key "runnerImage" holds.
 * @returns {{ what: string, at: number }[]}
 */
export function manifestLeaks(text, { repo, home, user }) {
  const out = [];
  const literal = (what, x) => {
    if (x && x.length >= 3 && text.includes(x)) out.push({ what, at: text.indexOf(x) });
  };
  literal('the repository path', repo);
  literal('the home folder', home);
  for (const x of ['/home/', '/mnt/', 'C:\\', 'C:/']) literal(`a path under ${x}`, x);
  if (user && user.length >= 2) {
    const esc = user.replace(/[.*+?^${}()|[\]\\]/g, '\\function emscriptenDefault(emsdk, setting) {');
    const m = new RegExp(`[\\\\/]${esc}(?=[\\\\/"]|$)`, 'm').exec(text);
    if (m) out.push({ what: 'the user name in a path', at: m.index });
  }
  return out;
}

function emscriptenDefault(emsdk, setting) {
  const text = readFileSync(path.join(emsdk, 'upstream/emscripten/src/settings.js'), 'utf8');
  const m = new RegExp(`^var ${setting} = ([^;]+);`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

async function main() {
  const o = opts(process.argv.slice(2));
  const root = o.root;
  const out = o.out;
  const pins = JSON.parse(readFileSync(o.pins, 'utf8'));
  const link = path.join(root, 'link');
  const emsdk = path.join(root, 'emsdk');
  const wasmBytes = readFileSync(path.join(out, 'engine.wasm'));
  const glueText = readFileSync(path.join(out, 'engine.js'), 'utf8');
  const w = readWasm(wasmBytes);
  await loadAcorn();
  const resolved = resolveGlue(glueText, w);
  const lists = JSON.parse(readFileSync(path.join(link, 'rename-lists.json'), 'utf8'));
  const flags = JSON.parse(readFileSync(path.join(link, 'flags.json'), 'utf8'));
  const g1 = existsSync(path.join(link, 'g1-compare.json')) ? JSON.parse(readFileSync(path.join(link, 'g1-compare.json'), 'utf8')) : null;
  const linkMap = existsSync(path.join(link, 'map-check.json')) ? JSON.parse(readFileSync(path.join(link, 'map-check.json'), 'utf8')) : null;

  const emccVersion = runBoth(path.join(emsdk, 'upstream/emscripten/emcc'), ['-v']);
  const clang = (emccVersion.split('\n').find((l) => l.startsWith('clang version')) ?? '').trim();
  const emcc = (emccVersion.split('\n').find((l) => l.startsWith('emcc ')) ?? '').trim();

  let commit = process.env.BUILD_SCRIPTS_COMMIT ?? null;
  if (!commit) {
    const c = run('git', ['-C', o.repo, 'rev-parse', 'HEAD']);
    commit = c && /^[0-9a-f]{40}$/.test(c) ? c : null;
  }

  // The positive controls of the import check: a small program that calls libc's
  // system(), linked without our stubs, once with the engine's own flags (-g1 included), where the glue names the
  // import and the deny list must catch __emscripten_system, and once without -g1, where the glue writes the
  // import in place and the unnamed-import rule must catch it.
  const control = (dir) => {
    if (!existsSync(path.join(dir, 'engine.wasm'))) return null;
    const cw = readWasm(readFileSync(path.join(dir, 'engine.wasm')));
    const controlGlue = readFileSync(path.join(dir, 'engine.js'), 'utf8');
    const cr = resolveGlue(controlGlue, cw);
    return {
      denied: cr.imports.filter((i) => i.resolved && deniedImport(i.resolved)).map((i) => ({ minified: i.name, resolved: i.resolved })),
      unnamed: cr.imports.filter((i) => i.resolved === null).map((i) => ({ minified: i.name, inlined: (i.inlined ?? '').slice(0, 160) })),
      glueHits: GLUE_ABSENT.filter((t) => controlGlue.includes(t)),
    };
  };
  const withG1 = control(path.join(link, 'control', 'g1'));
  const withoutG1 = control(path.join(link, 'control', 'nog1'));
  const importControl = {
    program: 'link/control/control.c: main calls system(); linked without stubs.c',
    withG1: withG1 && { flags: "the engine's link flags, -g1 included", ...withG1, caughtBy: withG1.denied.some((d) => d.resolved === '__emscripten_system') ? 'the deny list (__emscripten_system)' : null },
    withoutG1: withoutG1 && { flags: 'the same without -g1', ...withoutG1, caughtBy: withoutG1.unnamed.length > 0 ? 'the unnamed-import rule' : null },
  };
  const problems = [];
  if (!importControl.withG1?.caughtBy) problems.push('the -g1 control link does not show __emscripten_system as a denied import');
  if (!importControl.withoutG1?.caughtBy) problems.push('the control link without -g1 shows no unnamed import');
  for (const i of resolved.imports) {
    if (i.resolved === null) problems.push(`import ${i.name} does not resolve through the glue`);
    else if (deniedImport(i.resolved)) problems.push(`import ${i.name} resolves to ${i.resolved}, which is denied`);
  }
  const musl = existsSync(path.join(link, 'musl-notices.json')) ? JSON.parse(readFileSync(path.join(link, 'musl-notices.json'), 'utf8')) : null;
  const strings = stringChecks(wasmBytes, glueText).map((s) => ({ check: s.check, part: s.part, text: s.text, inWasm: s.inWasm, inGlue: s.inGlue }));
  const lay = layout(w);
  const mib = 2 ** 20;
  const manifest = {
    about: 'The record of one build of liveMd2Tex\'s TeX engine (docs/DEVELOPING.md, "The TeX engine: our own build"), written by engine/build/tools/write-manifest.mjs. Paths under the build root are written as <root>.',
    inputs: {
      texLive: { repository: pins.texLive.repository, commit: pins.texLive.commit, archive: pins.texLive.archive },
      emscripten: { release: pins.emscripten.release, commit: pins.emscripten.commit, releasesBuild: pins.emscripten.releasesBuild },
      emsdk: { commit: pins.emsdk.commit, archive: pins.emsdk.archive, wasmBinaries: pins.emsdk.wasmBinaries, node: pins.emsdk.node },
      patches: (existsSync(path.join(o.repo, 'engine/build/patches')) ? readdirSync(path.join(o.repo, 'engine/build/patches')) : []).filter((f) => f.endsWith('.patch')).sort().map((f) => ({ name: f, sha256: sha256(readFileSync(path.join(o.repo, 'engine/build/patches', f))) })),
    },
    build: {
      scripts: { commit, ...scriptsTree(o.repo) },
      sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH ?? 0),
    },
    toolchain: {
      emcc,
      clang,
      nativeCompiler: (run('gcc', ['--version']) ?? '').split('\n')[0],
      python: run('python3', ['--version']),
      node: process.version,
      host: hostTools(),
      machine: { os: osName(), kernel: os.release(), cpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
      // GitHub's runner image (the runner sets ImageOS and ImageVersion); null under WSL.
      runnerImage: process.env.ImageOS ? { os: process.env.ImageOS, version: process.env.ImageVersion ?? null } : null,
    },
    flags,
    lists: {
      shared: lists.shared.map((s) => s.name),
      sharedReadBy: Object.fromEntries(lists.shared.map((s) => [s.name, s.readBy])),
      sharedSha256: lists.sharedSha256,
      renamed: lists.renamed,
      renamedCount: Object.fromEntries(Object.entries(lists.renamed).map(([p, n]) => [p, n.length])),
      renamedSha256: lists.renamedSha256,
      headers: lists.headers,
      clashes: lists.clashes,
    },
    imports: resolved.imports.map((i) => ({ module: i.module, name: i.name, kind: i.kind, resolved: i.resolved })),
    importsDenied: resolved.imports.filter((i) => i.resolved && deniedImport(i.resolved)).map((i) => i.resolved),
    importControl,
    exports: resolved.exports.map((e) => ({ key: e.key, kind: e.kind, name: e.name, glue: e.names })),
    layout: {
      ...lay,
      initialMemory: lay.initialMemory,
      stackFirst: lay.stackPointer !== null && lay.dataStart !== null && lay.stackPointer <= lay.dataStart,
      stackSize: lay.stackPointer,
      // The end of static data, .bss included, from the link map (the data segments end below it).
      staticEnd: linkMap?.staticEnd ?? null,
      headerBytes: 64 * mib,
      dataEndBelowHeader: lay.dataEnd < 64 * mib,
      staticEndBelowHeader: typeof linkMap?.staticEnd === 'number' && linkMap.staticEnd < 64 * mib,
    },
    sections: w.sections.map((s) => ({ kind: s.kind, ...(s.name !== undefined ? { name: s.name } : {}), size: s.size })),
    customSections: w.customs,
    functions: { defined: w.functionCount, imported: w.importedFunctionCount },
    strings,
    glueAbsent: Object.fromEntries(GLUE_ABSENT.map((t) => [t, !glueText.includes(t)])),
    // Each is off when no link flag sets it and Emscripten 6.0.13's default (src/settings.js) is off; NODEFS and
    // SOCKFS besides must not be defined in the glue (their names alone appear in the comments of the FS code).
    emscriptenSettingsOff: {
      NODERAWFS: !(!flags.link.some((f) => /NODERAWFS/.test(f)) && emscriptenDefault(emsdk, 'NODERAWFS') === 'false'),
      NODERAWSOCKETS: !(!flags.link.some((f) => /NODERAWSOCKETS/.test(f)) && emscriptenDefault(emsdk, 'NODERAWSOCKETS') !== 'true' && !/\bvar SOCKFS\s*=/.test(glueText)),
      NODEFS: !(!flags.link.some((f) => /NODEFS|lnodefs/.test(f)) && !/\bvar NODEFS\s*=/.test(glueText)),
    },
    g1: g1,
    linkMap: linkMap && { inputs: linkMap.inputs, parts: linkMap.parts, unmapped: linkMap.unmapped, droppedParts: linkMap.droppedParts, shared: linkMap.shared, libraryClashes: linkMap.libraryClashes, pass: linkMap.pass },
    muslNotices: musl && { libcMembers: musl.members, notices: musl.notices.map((n) => ({ files: n.files, held: n.held })), file: 'LICENSES/engine/musl-file-notices.txt', pass: musl.pass },
    generatedEdits: GENERATED_EDITS.map((e) => (e.target === SKIPPED ? { ...e, folders: skippedFolders(root) } : e)),
    generatedSources: existsSync(path.join(out, 'generated-sources')) ? treeOf(path.join(out, 'generated-sources')) : null,
    outputs: {
      wasm: { name: 'engine.wasm', size: wasmBytes.length, sha256: sha256(wasmBytes) },
      glue: { name: 'engine.js', size: Buffer.byteLength(glueText), sha256: sha256(Buffer.from(glueText)) },
    },
  };
  if (problems.length > 0) {
    for (const p of problems) console.error(`write-manifest: FAIL ${p}`);
    process.exitCode = 1;
    return;
  }
  let text = `${JSON.stringify(manifest, null, 1)}\n`;
  text = text.split(root).join('<root>');
  const leaks = manifestLeaks(text, { repo: o.repo, home: os.homedir(), user: os.userInfo().username });
  if (leaks.length > 0) {
    console.error(`write-manifest: the manifest would hold a path or name of the build machine (${leaks.length} kinds); not written`);
    for (const l of leaks) console.error(`  ${l.what}, near: ${text.slice(Math.max(0, l.at - 60), l.at).split(String.fromCharCode(10)).join(' ')}<...>`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(path.join(out, 'engine-build.json'), text);
  console.log(`write-manifest: ${path.join(out, 'engine-build.json')}: wasm ${manifest.outputs.wasm.size} bytes ${manifest.outputs.wasm.sha256}; glue ${manifest.outputs.glue.size} bytes ${manifest.outputs.glue.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
