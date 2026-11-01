#!/usr/bin/env node
// engine/build/tools/link-report.mjs: the records and checks of build.sh's link step, read later by
// write-manifest.mjs.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node link-report.mjs g1 LINKDIR             g1-compare.json: the -g1 link against the link without it; fails
//                                               when the two wasm files differ
//   node link-report.mjs flags LINKDIR          flags.json: every compile, configure and link flag (from the
//                                               environment build.sh exports), paths under the root as <root>
//   node link-report.mjs map MAPFILE LINKDIR    map-check.json: every input of the link map mapped to its part of
//                                               the engine (LINK_PARTS), the static end (.bss included), the
//                                               shared names' sections and the library clashes' loaded members;
//                                               fails on an input no part claims, a dropped part, a shared name
//                                               outside .bss, or two loaded members that define one name
//   node link-report.mjs musl MAPFILE LINKDIR NOTICES
//                                               musl-notices.json: the notice headers of the linked libc members
//                                               (Emscripten's system/lib), each of which NOTICES
//                                               (LICENSES/engine/musl-file-notices.txt) must hold
//
// ROOT (the build root) comes from the environment.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const words = (s) => (s ?? '').split(/\s+/).filter(Boolean);

const SYSROOT = 'emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten';

/**
 * Every input the engine's link may take, by part (the ids are those of the engine notices manifest's
 * components, the parts THIRD_PARTY_NOTICES.md lists). Paths are relative to the build root; "*" stands for any
 * characters but "/". An archive is matched by its own path, whatever member the link takes from it.
 */
export const LINK_PARTS = {
  pdftex: ['wasm/texk/web2c/pdftex-*.o', 'wasm/texk/web2c/pdftexdir/pdftex-*.o', 'wasm/texk/web2c/libpdftex.a'],
  xetex: ['wasm/texk/web2c/xetex-*.o', 'wasm/texk/web2c/xetexdir/xetex-*.o', 'wasm/texk/web2c/libxetex.a'],
  web2c: ['wasm/texk/web2c/lib/lib.a'],
  libmd5: ['wasm/texk/web2c/libmd5.a'],
  synctex: ['wasm/texk/web2c/synctexdir/pdftex-synctex.o', 'wasm/texk/web2c/synctexdir/xetex-synctex.o'],
  bibtex8: ['wasm/texk/bibtex-x/bibtex8-*.o'],
  xdvipdfmx: ['wasm/texk/dvipdfm-x/*.o'],
  kpathsea: ['wasm/texk/kpathsea/.libs/libkpathsea.a'],
  harfbuzz: ['wasm/libs/harfbuzz/libharfbuzz.a'],
  graphite2: ['wasm/libs/graphite2/libgraphite2.a'],
  teckit: ['wasm/libs/teckit/libTECkit.a'],
  freetype: ['wasm/libs/freetype2/libfreetype.a'],
  libpng: ['wasm/libs/libpng/libpng.a'],
  zlib: ['wasm/libs/zlib/libz.a'],
  pplib: ['wasm/libs/pplib/libpplib.a'],
  xpdf: ['wasm/libs/xpdf/libxpdf.a'],
  icu: ['wasm/libs/icu/icu-build/lib/libicuuc.a', 'wasm/libs/icu/icu-build/lib/libicudata.a'],
  // libc.a holds musl and Emscripten's own C library code (system/lib/libc); both notices ship.
  musl: [`${SYSROOT}/libc.a`, `${SYSROOT}/libc_optz.a`],
  emscripten: [`${SYSROOT}/libdlmalloc.a`, `${SYSROOT}/libstubs.a`, `${SYSROOT}/libnoexit.a`],
  llvm: [`${SYSROOT}/libc++-noexcept.a`, `${SYSROOT}/libc++abi-noexcept.a`, `${SYSROOT}/libclang_rt.builtins.a`],
  livemd2tex: ['link/dispatcher.o', 'link/stubs.o', 'fontlist/lib/libfontconfig.a'],
};

/** Folders of parts the engine leaves out (LuaTeX and its libraries, MakeIndex, libpaper, fontconfig, expat): an input under one fails even if a part claims it. */
export const DROPPED = ['libs/libpaper', 'texk/makeindexk', 'luatexdir', 'libs/lua53', 'libs/zziplib', 'libs/luajit', 'mplibdir', 'libs/expat', 'fontconfig-src'];

const globRe = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
const PART_RES = Object.entries(LINK_PARTS).map(([part, globs]) => [part, globs.map(globRe)]);

/** The part an input belongs to (its path relative to the build root, an archive member's in parentheses), or null. */
export function partOf(rel) {
  const file = rel.replace(/\([^)]*\)$/, '');
  for (const [part, res] of PART_RES) if (res.some((re) => re.test(file))) return part;
  return null;
}

/** The link map's inputs: object files and archive members, as the map writes them (absolute paths). */
export function mapInputs(mapText) {
  const inputs = new Set();
  for (const line of mapText.split('\n')) {
    const m = /\s((?:\/|<)[^\s:]*?\.(?:o|a|obj)(?:\([^)]*\))?)(?::|\s|$)/.exec(line);
    if (m) inputs.add(m[1]);
  }
  return inputs;
}

/** The end of static data: the highest address plus size of the map's memory output sections (.rodata, .data, .bss, ...). */
export function staticEnd(mapText) {
  let end = 0;
  const sections = {};
  for (const line of mapText.split('\n')) {
    const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\.[A-Za-z_.]+)\s*$/.exec(line);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    const size = parseInt(m[3], 16);
    sections[m[4]] = { address: addr, size };
    end = Math.max(end, addr + size);
  }
  return { end, sections };
}

/** The input sections that define NAME, e.g. ".bss" for "<file>:(.bss.nameoffile)", each with its input file. */
export function definingSections(mapText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s(\\S+):\\((\\.[A-Za-z_]+)\\.${esc}\\)\\s*$`);
  const out = [];
  for (const line of mapText.split('\n')) {
    const m = re.exec(line);
    if (m) out.push({ file: m[1], section: m[2] });
  }
  return out;
}

/**
 * The map check. `lists`: rename-lists.json (shared names); `libraryClashes`: library-clashes.json from
 * rename-list.mjs verify (strong names two libraries define, with their defining members).
 */
export function mapCheck(mapText, root, lists = null, libraryClashes = []) {
  const rel = (f) => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f);
  const inputs = mapInputs(mapText);
  const parts = Object.fromEntries(Object.keys(LINK_PARTS).map((p) => [p, 0]));
  const unmapped = [];
  const dropped = [];
  for (const f of [...inputs].sort()) {
    const r = rel(f);
    if (DROPPED.some((d) => r.includes(d))) dropped.push(`<root>/${r}`);
    const part = r === f ? null : partOf(r);
    if (part) parts[part]++;
    else unmapped.push(r === f ? f : `<root>/${r}`);
  }
  const failures = [];
  for (const u of unmapped) failures.push(`${u}: no part of the engine claims it (LINK_PARTS)`);
  for (const d of dropped) failures.push(`${d}: belongs to a dropped part`);
  for (const [p, n] of Object.entries(parts)) if (n === 0) failures.push(`part ${p}: no input of the link map belongs to it`);
  // Shared names: the program that keeps the definition must have it zero-initialised (.bss): the extern edit
  // drops the other programs' definitions, so a value one of them set at start would be lost. The
  // other programs' lines in their generated headers have no initializer (build.sh's sed matches "name;" only).
  const shared = [];
  for (const s of lists?.shared ?? []) {
    const defs = definingSections(mapText, s.name).map((d) => ({ file: rel(d.file).split(root).join('<root>'), section: d.section }));
    shared.push({ name: s.name, definitions: defs });
    if (defs.length !== 1) failures.push(`shared ${s.name}: ${defs.length} definitions in the map, expected 1`);
    for (const d of defs) if (d.section !== '.bss') failures.push(`shared ${s.name}: defined in ${d.section} of ${d.file}, not in .bss`);
  }
  // Library clashes: two loaded members that define one name would fail the link; one loaded member decides
  // every call to the name, so the record says which.
  const clashes = libraryClashes.map((c) => {
    const loaded = c.members.filter((m) => inputs.has(`${m.archive}(${m.member})`));
    return { name: c.name, members: c.members.map((m) => `${rel(m.archive)}(${m.member})`), loaded: loaded.map((m) => `${rel(m.archive)}(${m.member})`) };
  });
  for (const c of clashes) if (c.loaded.length > 1) failures.push(`${c.name}: defined by the loaded members ${c.loaded.join(', ')}`);
  const se = staticEnd(mapText);
  return { inputs: inputs.size, parts, unmapped, droppedParts: dropped, staticEnd: se.end, sections: se.sections, shared, libraryClashes: clashes, failures, pass: failures.length === 0 };
}

// ---- musl's per-file notices: the files under terms of their own, whose notices binary copies must carry ----

const ARCH = /\/(i386|x86_64|x32|aarch64|arm|mips|mips64|mipsn32|powerpc|powerpc64|riscv32|riscv64|s390x|sh|microblaze|or1k|m68k|loongarch64)\//;

/**
 * Every C or assembly source of Emscripten's libc (system/lib/libc and system/lib/pthread, the folders
 * tools/system_libs.py builds libc.a from), by base name. Other folders hold files of the same names that libc.a
 * does not take (mimalloc's libc.c).
 */
function sourceIndex(dir) {
  const index = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(c|s|S)$/.test(name)) {
        const base = name.replace(/\.(c|s|S)$/, '');
        const rel = path.relative(dir, p).split(path.sep).join('/');
        if (ARCH.test(`/${rel}`)) continue;
        if (!index.has(base)) index.set(base, []);
        index.get(base).push(rel);
      }
    }
  };
  for (const sub of ['libc', 'pthread']) walk(path.join(dir, sub));
  return index;
}

/** Comment text without its markers, whitespace collapsed. */
export const normalizeNotice = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\*+(?=\s|$)/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A source's notice: its first comment block that names a copyright, from the line with "Copyright" to the block's
 * end (a description line above it differs from file to file), with its line numbers; null when it has none or when
 * it is The Emscripten Authors' own (Emscripten-LICENSE.txt covers those).
 */
export function fileNotice(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('/*')) continue;
    let j = i;
    while (j < lines.length && !lines[j].includes('*/')) j++;
    const block = lines.slice(i, j + 1);
    const k = block.findIndex((l) => /copyright/i.test(l));
    if (k >= 0) {
      const notice = block.slice(k).join('\n');
      if (/The Emscripten Authors/.test(notice)) return null;
      return { lines: [i + 1, j + 1], from: i + k + 1, text: normalizeNotice(notice) };
    }
    i = j;
  }
  return null;
}

export function muslNotices(mapText, systemLib, noticeText) {
  const members = new Set();
  for (const m of mapText.matchAll(/\/(libc|libc_optz)\.a\(([^)]+)\)/g)) members.add(m[2]);
  const index = sourceIndex(systemLib);
  const held = normalizeNotice(noticeText);
  const groups = new Map();
  const unknown = [];
  for (const member of [...members].sort()) {
    const base = member.replace(/\.o$/, '').replace(/__\d+$/, '');
    const sources = index.get(base) ?? [];
    if (sources.length === 0) unknown.push(member);
    for (const src of sources) {
      const n = fileNotice(readFileSync(path.join(systemLib, src), 'utf8'));
      if (!n) continue;
      const key = n.text;
      if (!groups.has(key)) groups.set(key, { notice: key, held: held.includes(key), files: [] });
      groups.get(key).files.push(`${src}:${n.from}-${n.lines[1]}`);
    }
  }
  const notices = [...groups.values()];
  const failures = notices.filter((g) => !g.held).map((g) => `a linked libc file's notice is not in musl-file-notices.txt: ${g.files.join(', ')}`);
  return { members: members.size, withoutSource: unknown, notices, failures, pass: failures.length === 0 };
}

function main(argv) {
  const [cmd, a, b, c] = argv;
  const root = process.env.ROOT;
  if (cmd === 'g1') {
    const one = (dir) => ({
      wasmSha256: sha256(path.join(a, dir, 'engine.wasm')),
      wasmSize: statSync(path.join(a, dir, 'engine.wasm')).size,
      glueSha256: sha256(path.join(a, dir, 'engine.js')),
      glueSize: statSync(path.join(a, dir, 'engine.js')).size,
    });
    const withG1 = one('g1');
    const withoutG1 = one('nog1');
    const r = { wasmSameBytes: withG1.wasmSha256 === withoutG1.wasmSha256, withG1, withoutG1, shipped: 'withG1' };
    writeFileSync(path.join(a, 'g1-compare.json'), `${JSON.stringify(r, null, 1)}\n`);
    console.log(JSON.stringify(r));
    if (!r.wasmSameBytes) console.error('link-report: -g1 changed the wasm; it must change the glue only');
    return r.wasmSameBytes ? 0 : 1;
  }
  if (cmd === 'flags') {
    const strip = (s) => (root ? s.split(root).join('<root>') : s);
    let configure;
    try {
      configure = words(strip(readFileSync(path.join(root, 'stamps', 'configure-line'), 'utf8')));
    } catch {
      configure = [];
    }
    const r = {
      opt: process.env.OPT,
      extraCflags: words(process.env.EXTRA_CFLAGS),
      extraLdflags: words(process.env.EXTRA_LDFLAGS),
      compile: words(strip(process.env.COMPILE_FLAGS ?? '')),
      configure,
      perProgram: Object.fromEntries(['pdftex', 'xetex', 'xdvipdfmx', 'bibtex8'].map((p) => [p, [`-Dmain=${p}_main`, ...(p === 'xetex' ? [] : ['-include', `rename-${p}.h`])]])),
      link: [process.env.OPT, ...words(process.env.LINK_FLAGS_BASE), ...words(process.env.SHIP_FLAGS), ...words(process.env.EXTRA_LDFLAGS)],
      environment: { LC_ALL: 'C', TZ: 'UTC', PYTHONHASHSEED: '0', SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH },
    };
    writeFileSync(path.join(a, 'flags.json'), `${JSON.stringify(r, null, 1)}\n`);
    return 0;
  }
  if (cmd === 'map') {
    const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
    const lists = read(path.join(b, 'rename-lists.json'));
    const clashes = read(path.join(b, 'library-clashes.json'))?.clashes ?? [];
    const r = mapCheck(readFileSync(a, 'utf8'), root, lists, clashes);
    writeFileSync(path.join(b, 'map-check.json'), `${JSON.stringify(r, null, 1)}\n`);
    console.log(`link map: ${r.inputs} inputs; ${Object.entries(r.parts).map(([p, n]) => `${p} ${n}`).join(', ')}; static end ${r.staticEnd}`);
    for (const f of r.failures) console.error(`link-report: FAIL ${f}`);
    return r.pass ? 0 : 1;
  }
  if (cmd === 'musl') {
    const systemLib = path.join(root, 'emsdk/upstream/emscripten/system/lib');
    const r = muslNotices(readFileSync(a, 'utf8'), systemLib, readFileSync(c, 'utf8'));
    writeFileSync(path.join(b, 'musl-notices.json'), `${JSON.stringify(r, null, 1)}\n`);
    console.log(`libc members: ${r.members}; notices of their own: ${r.notices.length}; without a source found: ${r.withoutSource.join(' ') || 'none'}`);
    for (const f of r.failures) console.error(`link-report: FAIL ${f}`);
    return r.pass ? 0 : 1;
  }
  console.error('usage: link-report.mjs g1 LINKDIR | flags LINKDIR | map MAPFILE LINKDIR | musl MAPFILE LINKDIR NOTICES');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
