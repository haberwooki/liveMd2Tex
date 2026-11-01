#!/usr/bin/env node
// engine/build/tools/wasm-inspect.mjs: reads a WebAssembly file's sections (the binary format of the WebAssembly
// 2.0 specification, chapter 5: LEB128 numbers, the section layout, the import, export, memory, global, data and
// custom sections) and runs the engine's safety checks on it (docs/DEVELOPING.md, "The TeX engine: our own build").
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node wasm-inspect.mjs FILE.wasm                  the layout as JSON
//   node wasm-inspect.mjs OUT --check [MANIFEST]     the checks on OUT/engine.wasm and OUT/engine.js against
//                                                    MANIFEST (default OUT/engine-build.json); exit 1 on a failure
//   node wasm-inspect.mjs FILE --strings             the string checks only, each "found" or "absent" (the
//                                                    positive control on the earlier engine's busytex.wasm and
//                                                    busytex.js, TeXlyre's build)
//
// The library functions are used by write-manifest.mjs.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { glueAcorn, loadAcorn, resolveGlue } from './glue-imports.mjs';

const SECTION_NAMES = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'datacount', 'tag'];
const KINDS = ['func', 'table', 'memory', 'global', 'tag'];

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.p = pos;
    this.end = end;
  }
  byte() {
    if (this.p >= this.end) throw new Error('read past the end of a section');
    return this.b[this.p++];
  }
  u32() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const x = this.byte();
      result += (x & 0x7f) * 2 ** shift;
      if ((x & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error('LEB128 too long');
    }
  }
  s64() {
    let result = 0n;
    let shift = 0n;
    let x;
    do {
      x = this.byte();
      result |= BigInt(x & 0x7f) << shift;
      shift += 7n;
    } while (x & 0x80);
    if (shift < 64n && x & 0x40) result |= -1n << shift;
    return result;
  }
  name() {
    const n = this.u32();
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  limits() {
    const flags = this.byte();
    const min = this.u32();
    const max = flags & 1 ? this.u32() : null;
    return { flags, min, max };
  }
  // A constant expression: i32.const, i64.const or global.get, then end.
  constExpr() {
    const op = this.byte();
    let value;
    if (op === 0x41) value = { i32: Number(BigInt.asIntN(32, this.s64())) };
    else if (op === 0x42) value = { i64: this.s64().toString() };
    else if (op === 0x23) value = { global: this.u32() };
    else if (op === 0x44) {
      this.p += 8;
      value = { f64: true };
    } else if (op === 0x43) {
      this.p += 4;
      value = { f32: true };
    } else throw new Error(`unsupported constant expression opcode 0x${op.toString(16)}`);
    if (this.byte() !== 0x0b) throw new Error('constant expression not ended');
    return value;
  }
  valtype() {
    return this.byte();
  }
}

/** Reads a WebAssembly file into its sections, imports, exports, memories, globals, data segments and customs. */
export function readWasm(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100) throw new Error('not a WebAssembly file');
  const version = bytes.readUInt32LE(4);
  const r = new Reader(bytes, 8);
  const sections = [];
  const out = { version, size: bytes.length, sections, imports: [], exports: [], memories: [], globals: [], data: [], customs: [], functionCount: 0, importedFunctionCount: 0 };
  while (r.p < bytes.length) {
    const id = r.byte();
    const size = r.u32();
    const start = r.p;
    const end = start + size;
    const s = new Reader(bytes, start, end);
    const entry = { id, kind: SECTION_NAMES[id] ?? `unknown-${id}`, offset: start, size };
    if (id === 0) {
      entry.name = s.name();
      out.customs.push({ name: entry.name, size });
    } else if (id === 2) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const module = s.name();
        const name = s.name();
        const k = s.byte();
        const imp = { module, name, kind: KINDS[k] };
        if (k === 0) {
          imp.type = s.u32();
          out.importedFunctionCount++;
        } else if (k === 1) {
          s.valtype();
          imp.limits = s.limits();
        } else if (k === 2) imp.limits = s.limits();
        else if (k === 3) {
          imp.valtype = s.valtype();
          imp.mutable = s.byte() === 1;
        } else if (k === 4) {
          s.byte();
          imp.type = s.u32();
        }
        out.imports.push(imp);
      }
    } else if (id === 3) {
      out.functionCount = s.u32();
    } else if (id === 5) {
      const n = s.u32();
      for (let i = 0; i < n; i++) out.memories.push(s.limits());
    } else if (id === 6) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const valtype = s.valtype();
        const mutable = s.byte() === 1;
        out.globals.push({ valtype, mutable, init: s.constExpr() });
      }
    } else if (id === 7) {
      const n = s.u32();
      for (let i = 0; i < n; i++) out.exports.push({ name: s.name(), kind: KINDS[s.byte()], index: s.u32() });
    } else if (id === 11) {
      const n = s.u32();
      for (let i = 0; i < n; i++) {
        const flags = s.u32();
        let seg;
        if (flags === 0) seg = { active: true, memory: 0, offset: s.constExpr() };
        else if (flags === 1) seg = { active: false };
        else if (flags === 2) seg = { active: true, memory: s.u32(), offset: s.constExpr() };
        else throw new Error(`unknown data segment flags ${flags}`);
        seg.size = s.u32();
        s.p += seg.size;
        out.data.push(seg);
      }
    }
    sections.push(entry);
    r.p = end;
  }
  return out;
}

/** The memory layout the engine host relies on (src/engine-host/engine/worker.ts: the 64 MiB header it restores). */
export function layout(w) {
  const imported = w.imports.find((i) => i.kind === 'memory');
  const memory = imported ? imported.limits : w.memories[0];
  const page = 65536;
  let dataStart = null;
  let dataEnd = 0;
  for (const seg of w.data) {
    if (seg.active && seg.offset && 'i32' in seg.offset) {
      const start = seg.offset.i32 >>> 0;
      dataStart = dataStart === null ? start : Math.min(dataStart, start);
      dataEnd = Math.max(dataEnd, start + seg.size);
    }
  }
  // __stack_pointer is the first mutable i32 global (wasm-ld puts it first); at -Oz it is not exported by name.
  const sp = w.globals.find((g) => g.mutable && g.valtype === 0x7f && g.init && 'i32' in g.init);
  return {
    memoryImported: Boolean(imported),
    initialMemory: memory ? memory.min * page : null,
    maximumMemory: memory && memory.max !== null ? memory.max * page : null,
    dataStart,
    dataEnd,
    stackPointer: sp ? sp.init.i32 >>> 0 : null,
    passiveSegments: w.data.filter((s) => !s.active).length,
  };
}

// Strings that must never be in the engine: those of the parts it leaves out, and of the earlier engine's remote
// features (TeXlyre's build). Each is searched in the wasm read as latin1;
// the remote-fetch and font-index ones in the glue as well. "whole": only as a whole string, with a zero byte on
// each side (a short name can sit inside a longer string).
export const STRING_CHECKS = [
  // libpaper (GPL-2.0-only; the engine leaves it out). TeX Live's libpaper (1.1.29 as TeX Live changed it) reads no
  // paper file (libs/libpaper/TLpatches/patch-02-TL), so PAPERCONF and /etc/papersize are never in it: they stay as
  // markers of an unmodified libpaper only, never as the proof. The proof is its paper table
  // (libs/libpaper/libpaper-src/lib/paperspecs.h: halfexecutive, csheet, dsheet, esheet and flse are in no table of
  // dvipdfmx, texk/dvipdfm-x/dpxconf.c:35-95) and its variable PAPERSIZE (PAPERSIZEVAR, read at paper.c:107), with
  // dvipdfmx's own table below (REQUIRED_STRINGS). The earlier engine's busytex.wasm (TeXlyre's build) fails both rules.
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'halfexecutive' },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'csheet' },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'dsheet' },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'esheet' },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'flse', whole: true },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'PAPERSIZE', whole: true },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: 'PAPERCONF' },
  { check: 'engineLinksLibpaper', part: 'libpaper', text: '/etc/papersize' },
  { check: 'engineLinksMakeindex', part: 'MakeIndex', text: 'encap_prefix' },
  { check: 'engineLinksMakeindex', part: 'MakeIndex', text: 'page_compositor' },
  { check: 'engineLinksMakeindex', part: 'MakeIndex', text: 'headings_flag' },
  { check: 'engineLinksLua', part: 'LuaTeX', text: 'luatexversion' },
  { check: 'engineLinksLua', part: 'LuaTeX', text: 'directlua' },
  { check: 'engineLinksLua', part: 'luaffi', text: 'dasm_link error' },
  { check: 'engineLinksLua', part: 'luaffi', text: 'unable to convert argument' },
  { check: 'engineLinksRemote', part: 'remote', text: 'TEXLIVE_REMOTE_ENDPOINT', glue: true },
  { check: 'engineLinksRemote', part: 'remote', text: 'busytexfontindex', glue: true },
  { check: 'engineLinksRemote', part: 'remote', text: 'kpse_remote', glue: true },
];

// Strings that must be in the engine, each as a whole string. dvipdfmx compiles its own paper table only without
// libpaper ("#ifndef HAVE_LIBPAPER", texk/dvipdfm-x/dpxconf.c:35), and isob3 to isob6 are only in that table, so
// their absence means HAVE_LIBPAPER, whatever a later libpaper's strings are.
export const REQUIRED_STRINGS = ['isob3', 'isob4', 'isob5', 'isob6'].map((text) => ({ check: 'engineLinksLibpaper', part: 'dvipdfmx paper table', text, whole: true }));

// Imports that must never be resolved, whatever the manifest says. Each is matched against
// the JavaScript function name an import resolves to, with and without leading underscores. The names are
// Emscripten 6.0.13's entry points for a shell, running code, dynamic loading, wget, fetch, WebSockets, sockets and
// name look-ups (src/lib/libcore.js, libdylink.js, libwget.js, libfetch.js,
// libwebsocket.js, libsockfs.js, libsyscall.js, libwasmfs_fetch.js). _emscripten_lookup_name is gone at 6.0.13
// (the look-up is internal to libcore.js); it stays on the list in case it comes back.
export const DENIED_IMPORTS = [
  '_emscripten_system', '_emscripten_run_script', '_emscripten_run_script_int', '_emscripten_run_script_string',
  '_emscripten_async_run_script', '_emscripten_async_load_script', '_dlopen_js', '_dlsym_js', '_dlsym_catchup_js',
  '_emscripten_dlopen_js', '_emscripten_wget', '_emscripten_wget_data', '_emscripten_start_fetch',
  '_wasmfs_create_fetch_backend_js', '__syscall_socket', '__syscall_connect', '__syscall_bind', '__syscall_listen',
  '__syscall_accept4', '__syscall_sendto', '__syscall_recvfrom', '__syscall_sendmsg', '__syscall_recvmsg',
  '__syscall_getsockopt', '__syscall_setsockopt', '__syscall_getpeername', '__syscall_getsockname',
  '__syscall_shutdown', '__syscall_socketpair', '_emscripten_lookup_name', '_getaddrinfo', '_getnameinfo',
];
// The same by pattern, so a renamed or new entry point of the same kind is denied too.
export const DENIED_IMPORT_PATTERNS = [
  /system/i,
  /run_script/i,
  /load_script/i,
  /dlopen/i,
  /dlsym/i,
  /wget/i,
  /fetch/i,
  /websocket/i,
  /^_*syscall_(socket|socketpair|connect|bind|listen|accept4?|sendto|recvfrom|sendmsg|recvmsg|getsockopt|setsockopt|getpeername|getsockname|shutdown)$/,
  /^_*(getaddrinfo|getnameinfo|gethostbyname|gethostbyaddr)$/,
];

/** Whether a resolved import name is denied (the glue adds one underscore to a C name, two to a syscall's). */
export function deniedImport(name) {
  const bare = name.replace(/^_+/, '');
  if (DENIED_IMPORTS.some((d) => d.replace(/^_+/, '') === bare)) return true;
  return DENIED_IMPORT_PATTERNS.some((p) => p.test(name));
}

/** Whether TEXT occurs in HAYSTACK (a latin1 string), anywhere or (whole) with a zero byte on each side. */
function holds(haystack, text, whole) {
  const nul = String.fromCharCode(0);
  return whole ? haystack.includes(`${nul}${text}${nul}`) : haystack.includes(text);
}

/** The string checks on a wasm (and optionally its glue): each string found or absent. */
export function stringChecks(wasmBytes, glueText = null) {
  const wasm = Buffer.from(wasmBytes).toString('latin1');
  return STRING_CHECKS.map((c) => ({
    ...c,
    inWasm: holds(wasm, c.text, c.whole),
    inGlue: glueText !== null && c.glue ? glueText.includes(c.text) : null,
  }));
}

/** The strings that must be in the wasm: each found or missing. */
export function requiredStrings(wasmBytes) {
  const wasm = Buffer.from(wasmBytes).toString('latin1');
  return REQUIRED_STRINGS.map((c) => ({ ...c, inWasm: holds(wasm, c.text, c.whole) }));
}

// Glue text that must be absent. The only exceptions are the reviewed entries of
// engine/build/glue-allow.json, each pinned to one glue's SHA-256, a line and a text, and each inside a comment.
export const GLUE_ABSENT = ['SOCKFS', 'createSocket', 'spawnSync', 'child_process'];

const here = path.dirname(fileURLToPath(import.meta.url));

/** The reviewed glue entries (engine/build/glue-allow.json). */
export function glueAllow(file = path.join(here, '..', 'glue-allow.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).entries;
}

/**
 * The glue's watched names, each failing unless it lies inside a comment and a reviewed entry names this glue's
 * SHA-256, its line and its text: one rule for every reviewed exception.
 * @returns {{ failures: string[], allowed: string[] }}
 */
export function glueChecks(glue, allow) {
  const glueSha = sha256(Buffer.from(glue));
  const failures = [];
  const allowed = [];
  for (const hit of glueNames(glue, GLUE_ABSENT)) {
    const entry = allow.find((e) => e.glueSha256 === glueSha && e.line === hit.line && e.text === hit.text);
    if (entry && hit.inComment) allowed.push(`the glue names "${hit.text}" in a comment, line ${hit.line} (glue-allow.json: ${entry.reason})`);
    else failures.push(`the glue holds "${hit.text}", line ${hit.line}${hit.inComment ? ', in a comment no entry of glue-allow.json names' : ''}`);
  }
  return { failures, allowed };
}

export function check(out, manifestPath, notes = []) {
  const wasmPath = path.join(out, 'engine.wasm');
  const gluePath = path.join(out, 'engine.js');
  const bytes = readFileSync(wasmPath);
  const glue = readFileSync(gluePath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath ?? path.join(out, 'engine-build.json'), 'utf8'));
  const w = readWasm(bytes);
  const failures = [];
  const resolved = resolveGlue(glue, w);
  for (const imp of resolved.imports) {
    if (imp.resolved === null) failures.push(`import ${imp.module}.${imp.name} does not resolve through the glue`);
    else if (deniedImport(imp.resolved)) failures.push(`import ${imp.name} resolves to ${imp.resolved}, which is denied`);
  }
  const recorded = new Set(manifest.imports.map((i) => i.resolved));
  for (const imp of resolved.imports) {
    if (imp.resolved !== null && !recorded.has(imp.resolved)) failures.push(`import ${imp.resolved} is not on the manifest's list`);
  }
  const recordedExports = new Set(manifest.exports.map((e) => e.name));
  for (const e of resolved.exports) {
    if (!recordedExports.has(e.name)) failures.push(`export ${e.name} is not on the manifest's list`);
  }
  for (const e of manifest.exports) {
    if (!resolved.exports.some((x) => x.name === e.name)) failures.push(`export ${e.name} of the manifest is missing`);
  }
  const lay = layout(w);
  const mib = 2 ** 20;
  if (lay.initialMemory !== 64 * mib) failures.push(`initial memory ${lay.initialMemory}, not 64 MiB`);
  if (lay.maximumMemory !== 576 * mib) failures.push(`maximum memory ${lay.maximumMemory}, not 576 MiB`);
  if (lay.stackPointer !== 8 * mib) failures.push(`initial __stack_pointer ${lay.stackPointer}, not 8 MiB (stack first, 8 MiB)`);
  if (lay.dataStart === null || lay.dataStart < 8 * mib) failures.push(`data starts at ${lay.dataStart}, inside the stack`);
  if (lay.dataEnd >= 64 * mib) failures.push(`data ends at ${lay.dataEnd}, past the 64 MiB header`);
  // The static end (.bss included) comes from the link map, through the manifest.
  const staticEnd = manifest.layout?.staticEnd;
  if (typeof staticEnd !== 'number') failures.push('the manifest records no static end (layout.staticEnd, from the link map)');
  else {
    if (staticEnd < lay.dataEnd) failures.push(`the static end ${staticEnd} lies below the data segments' end ${lay.dataEnd}`);
    if (staticEnd >= 64 * mib) failures.push(`static data ends at ${staticEnd}, past the 64 MiB header`);
  }
  const customs = w.customs.map((c) => c.name);
  const allowedCustoms = new Set(manifest.customSections ? manifest.customSections.map((c) => c.name) : []);
  for (const c of customs) if (!allowedCustoms.has(c)) failures.push(`custom section ${c} is not on the manifest's list`);
  for (const s of stringChecks(bytes, glue)) {
    if (s.inWasm) failures.push(`"${s.text}" (${s.part}) is in the wasm`);
    if (s.inGlue) failures.push(`"${s.text}" (${s.part}) is in the glue`);
  }
  for (const s of requiredStrings(bytes)) {
    if (!s.inWasm) failures.push(`"${s.text}" (${s.part}) is missing from the wasm: dvipdfmx was built with libpaper`);
  }
  const g = glueChecks(glue, glueAllow());
  failures.push(...g.failures);
  notes.push(...g.allowed);
  for (const [setting, value] of Object.entries(manifest.emscriptenSettingsOff ?? {})) {
    if (value !== false && value !== 0) failures.push(`Emscripten setting ${setting} is not off`);
  }
  const outputs = manifest.outputs ?? {};
  for (const [key, file] of [['wasm', 'engine.wasm'], ['glue', 'engine.js']]) {
    const got = sha256(readFileSync(path.join(out, file)));
    if (outputs[key]?.sha256 !== got) failures.push(`${file}'s SHA-256 ${got} differs from the manifest's`);
  }
  return failures;
}

/** Every occurrence of the names in the glue, each with its line and whether it lies inside a comment. */
export function glueNames(glue, names) {
  const comments = [];
  glueAcorn().parse(glue, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, onComment: (block, text, start, end) => comments.push([start, end]) });
  const hits = [];
  for (const text of names) {
    for (let i = glue.indexOf(text); i >= 0; i = glue.indexOf(text, i + 1)) {
      hits.push({ text, line: glue.slice(0, i).split(String.fromCharCode(10)).length, inComment: comments.some(([s, e]) => i >= s && i < e) });
    }
  }
  return hits;
}

function sha256(b) {
  return createHash('sha256').update(b).digest('hex');
}

async function main(argv) {
  const target = argv[0];
  if (!target) {
    console.error('usage: wasm-inspect.mjs FILE.wasm | OUT --check [MANIFEST] | FILE --strings [GLUE]');
    return 2;
  }
  if (argv[1] === '--check') {
    await loadAcorn();
    const notes = [];
    const failures = check(target, argv[2], notes);
    for (const n of notes) console.log(`note ${n}`);
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(failures.length === 0 ? 'wasm-inspect: every check passed' : `wasm-inspect: ${failures.length} failures`);
    return failures.length === 0 ? 0 : 1;
  }
  if (argv[1] === '--strings') {
    const wasmPath = statSync(target).isDirectory() ? path.join(target, 'engine.wasm') : target;
    const gluePath = argv[2] ?? null;
    const glue = gluePath && existsSync(gluePath) ? readFileSync(gluePath, 'utf8') : null;
    const bytes = readFileSync(wasmPath);
    for (const s of stringChecks(bytes, glue)) {
      console.log(`${s.inWasm ? 'found ' : 'absent'}  wasm  ${s.part.padEnd(9)} ${s.text}${s.whole ? ' (whole)' : ''}`);
      if (s.glue && glue !== null) console.log(`${s.inGlue ? 'found ' : 'absent'}  glue  ${s.part.padEnd(9)} ${s.text}`);
    }
    for (const s of requiredStrings(bytes)) console.log(`${s.inWasm ? 'found ' : 'absent'}  wasm  ${s.part} (must be found) ${s.text} (whole)`);
    if (glue !== null) for (const t of GLUE_ABSENT) console.log(`${glue.includes(t) ? 'found ' : 'absent'}  glue  -         ${t}`);
    return 0;
  }
  const w = readWasm(readFileSync(target));
  console.log(JSON.stringify({ ...w, layout: layout(w), imports: w.imports, exports: w.exports, data: w.data.map((d) => ({ ...d })) }, null, 1));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
