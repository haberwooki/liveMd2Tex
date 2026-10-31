#!/usr/bin/env node
// engine/build/tools/rename-list.mjs: the rename and shared lists of the four programs in one WebAssembly file
// (docs/DEVELOPING.md, "The TeX engine: our own build").
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
// Input: a folder of llvm-nm listings that build.sh writes (llvm-nm -A --extern-only):
//   prog.<program>.defined.txt   the defined names of each program's own objects (--defined-only)
//   lib.<library>.defined.txt    the defined names of each library archive
//   lib.<library>.undefined.txt  the names each library member uses but does not define (--undefined-only)
//   trace.txt                    (phase "lists" only) the trial link's -Wl,--trace-symbol lines
//
//   node rename-list.mjs candidates DIR   writes DIR/candidates.json: every clash, and the data clashes that some
//                                          library member reads (the names the trial link traces)
//   node rename-list.mjs lists DIR OUTDIR writes OUTDIR/rename-<program>.h, OUTDIR/rename-lists.json
//   node rename-list.mjs verify DIR LISTS checks the recompiled programs against the lists
//
// The rules: a clash is a name defined by two programs, or by a program and a library; weak
// definitions (C++ inline functions and templates) never clash. A program's copy is renamed (#define name
// <program>_name in a header the program's objects are compiled with), never a library's; XeTeX keeps its names.
// A shared name is a data symbol (llvm-nm type B, D, C, R or S) defined by two programs and read by a library
// member the link pulls in (from the trial link's trace); it is never renamed, and every program but one declares
// it extern. A function that a pulled-in library member calls and two programs define stops the build. On wasm
// objects llvm-nm reports only D, T and W, so "data" means "not a function" there; that a shared name is
// zero-initialised (.bss) is checked from the link map (link-report.mjs map).
//   node rename-list.mjs verify DIR LISTS also writes library-clashes.json beside LISTS: strong names that two
//                                          libraries define, with the defining members (the map check says which
//                                          member the link loaded, and fails if it loaded two)

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAMS = ['pdftex', 'xetex', 'xdvipdfmx', 'bibtex8'];
const KEEPS_NAMES = 'xetex';
const DATA_TYPES = new Set(['B', 'D', 'C', 'R', 'S', 'b', 'd', 'r', 's']);
const WEAK_TYPES = new Set(['W', 'w', 'V', 'v']);

/** Parses llvm-nm -A output: "file[:member]: [address] TYPE name" lines. */
export function parseNm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(.*?): +(?:[0-9a-f]+ +)?([A-Za-z]) (\S+)$/.exec(line.trimEnd());
    if (m) out.push({ file: m[1], type: m[2], name: m[3] });
  }
  return out;
}

/** The listings, parsed: { progs: {program: nm text}, libsDef: {library: nm text}, libsUndef: {library: nm text} }. */
export function fromTexts({ progs = {}, libsDef = {}, libsUndef = {} }) {
  const parse = (o) => Object.fromEntries(Object.entries(o).map(([k, t]) => [k, parseNm(t)]));
  const data = { progs: parse(progs), libsDef: parse(libsDef), libsUndef: parse(libsUndef) };
  for (const p of PROGRAMS) if (!data.progs[p]) throw new Error(`no listing for ${p}`);
  return data;
}

function load(dir) {
  const texts = { progs: {}, libsDef: {}, libsUndef: {} };
  for (const f of readdirSync(dir).sort()) {
    let m;
    if ((m = /^prog\.(.+)\.defined\.txt$/.exec(f))) texts.progs[m[1]] = readFileSync(path.join(dir, f), 'utf8');
    else if ((m = /^lib\.(.+)\.defined\.txt$/.exec(f))) texts.libsDef[m[1]] = readFileSync(path.join(dir, f), 'utf8');
    else if ((m = /^lib\.(.+)\.undefined\.txt$/.exec(f))) texts.libsUndef[m[1]] = readFileSync(path.join(dir, f), 'utf8');
  }
  return fromTexts(texts);
}

/** name -> { programs: {prog: type}, libraries: [lib] } for every strong definition. */
export function definitions({ progs, libsDef }) {
  const defs = new Map();
  const entry = (n) => {
    if (!defs.has(n)) defs.set(n, { programs: {}, libraries: [] });
    return defs.get(n);
  };
  for (const [p, list] of Object.entries(progs)) {
    for (const s of list) if (!WEAK_TYPES.has(s.type)) entry(s.name).programs[p] ??= s.type;
  }
  for (const [l, list] of Object.entries(libsDef)) {
    for (const s of list) if (!WEAK_TYPES.has(s.type)) {
      const e = entry(s.name);
      if (!e.libraries.includes(l)) e.libraries.push(l);
    }
  }
  return defs;
}

export function clashes(defs) {
  const out = [];
  for (const [name, e] of defs) {
    const nProg = Object.keys(e.programs).length;
    if (nProg >= 2 || (nProg >= 1 && e.libraries.length >= 1)) {
      out.push({ name, programs: e.programs, libraries: e.libraries.slice().sort() });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Which library members use each name (whole archives; the trace narrows this to the members linked). */
function libraryUsers({ libsUndef }) {
  const users = new Map();
  for (const [l, list] of Object.entries(libsUndef)) {
    for (const s of list) {
      if (!users.has(s.name)) users.set(s.name, []);
      users.get(s.name).push(`${l}:${path.basename(s.file)}`);
    }
  }
  return users;
}

/** Every clash, and the names the trial link must trace. */
export function computeCandidates(data) {
  const all = clashes(definitions(data));
  const users = libraryUsers(data);
  // Names two programs define that a library member uses: the trial link traces each to see whether a member
  // that is actually linked uses it.
  // Names XeTeX and a library both define: the trace shows whether that library member is linked at all.
  const traced = all
    .filter((c) => (Object.keys(c.programs).length >= 2 && users.has(c.name)) || (KEEPS_NAMES in c.programs && c.libraries.length > 0))
    .map((c) => c.name);
  return { clashes: all, traced };
}

function candidates(dir) {
  const r = computeCandidates(load(dir));
  writeFileSync(path.join(dir, 'candidates.json'), `${JSON.stringify(r, null, 1)}\n`);
  console.log(`rename-list: ${r.clashes.length} clashes; ${r.traced.length} used by a library member: ${r.traced.join(' ')}`);
}

/**
 * The library members the trial link loaded that reference, or define, each traced name (wasm-ld --trace-symbol
 * lines: "<archive>(<member>): reference to <name>", "...: definition of <name>"; a member that is not loaded
 * shows only as "lazy definition").
 */
export function tracedUsers(traceText, libraryFiles) {
  const users = new Map();
  const definers = new Map();
  let lines = 0;
  for (const line of traceText.split('\n')) {
    const m = /^(.*?): (reference to|definition of) (\S+)$/.exec(line.trim());
    if (!m) continue;
    lines++;
    const file = m[1];
    const isLib = libraryFiles.some((l) => file.startsWith(l) || file.includes(`${path.basename(l)}(`));
    if (!isLib) continue;
    const map = m[2] === 'reference to' ? users : definers;
    if (!map.has(m[3])) map.set(m[3], []);
    map.get(m[3]).push(file);
  }
  return { users, definers, lines };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The shared and rename lists from the listings, the traced names and the trial link's trace. Returns the stops
 * (each needs a decision; no list is written then), or the result and each program's header text.
 */
export function computeLists(data, traced, libraryFiles, trace) {
  const all = clashes(definitions(data));
  const { users: pulled, definers, lines } = tracedUsers(trace, libraryFiles);
  if (traced.length > 0 && lines === 0) {
    return { stops: ['the trial link printed no --trace-symbol line; it must reach symbol resolution (see trace.txt)'] };
  }
  const shared = [];
  const stops = [];
  const xetexKeeps = [];
  for (const name of traced) {
    const users = pulled.get(name);
    const c = all.find((x) => x.name === name);
    if (!c || !users || Object.keys(c.programs).length < 2) continue;
    const types = Object.values(c.programs);
    if (types.every((t) => DATA_TYPES.has(t))) shared.push({ name, programs: c.programs, readBy: [...new Set(users)].sort() });
    else stops.push(`${name}: a function (${JSON.stringify(c.programs)}) that the linked library members ${[...new Set(users)].join(', ')} call; two programs define it`);
  }
  const sharedNames = new Set(shared.map((s) => s.name));
  const renamed = Object.fromEntries(PROGRAMS.map((p) => [p, []]));
  for (const c of all) {
    if (sharedNames.has(c.name)) continue;
    const progs = Object.keys(c.programs);
    if (progs.includes(KEEPS_NAMES) && c.libraries.length > 0) {
      // XeTeX keeps its names: a library member that defines the same name must not be linked at all.
      const linked = definers.get(c.name);
      if (linked) {
        stops.push(`${c.name}: XeTeX and the linked library members ${[...new Set(linked)].join(', ')} both define it; XeTeX keeps its names`);
        continue;
      }
      xetexKeeps.push({ name: c.name, libraries: c.libraries, linked: false });
    }
    for (const p of progs) if (p !== KEEPS_NAMES) renamed[p].push(c.name);
  }
  for (const s of shared) {
    const holders = Object.keys(s.programs);
    if (!holders.includes(KEEPS_NAMES)) stops.push(`${s.name}: shared, but XeTeX does not define it`);
    for (const p of holders) if (p !== KEEPS_NAMES && p !== 'pdftex') stops.push(`${s.name}: shared in ${p}, which has no web2c header to make it extern`);
  }
  if (stops.length > 0) return { stops };
  const headers = {};
  const headerTexts = {};
  for (const p of PROGRAMS) {
    if (p === KEEPS_NAMES) continue;
    const names = renamed[p].slice().sort();
    const text = [
      `/* rename-${p}.h: generated by engine/build/tools/rename-list.mjs; do not edit. Every name ${p} defines that`,
      ` * another program or a library also defines, renamed to ${p}_<name>. */`,
      ...names.map((n) => `#define ${n} ${p}_${n}`),
      '',
    ].join('\n');
    headerTexts[p] = text;
    headers[p] = { names: names.length, sha256: sha256(text) };
  }
  const renameText = JSON.stringify(Object.fromEntries(Object.entries(renamed).map(([p, n]) => [p, n.slice().sort()])));
  const sharedText = JSON.stringify(shared.map((s) => s.name).sort());
  const result = {
    about: 'The rename and shared lists of this build (engine/build/tools/rename-list.mjs), computed from the objects.',
    shared: shared.sort((a, b) => (a.name < b.name ? -1 : 1)),
    xetexKeepsUnlinked: xetexKeeps,
    sharedSha256: sha256(sharedText),
    renamed: JSON.parse(renameText),
    renamedSha256: sha256(renameText),
    headers,
    clashes: all.length,
  };
  return { stops: [], result, headerTexts };
}

function lists(dir, outDir) {
  const { traced } = JSON.parse(readFileSync(path.join(dir, 'candidates.json'), 'utf8'));
  const libraryFiles = JSON.parse(readFileSync(path.join(dir, 'libraries.json'), 'utf8'));
  const trace = existsSync(path.join(dir, 'trace.txt')) ? readFileSync(path.join(dir, 'trace.txt'), 'utf8') : '';
  const r = computeLists(load(dir), traced, libraryFiles, trace);
  if (r.stops.length > 0) {
    for (const s of r.stops) console.error(`rename-list: STOP ${s}`);
    console.error('rename-list: these need a decision: a function cannot be shared, and XeTeX keeps its own names');
    process.exitCode = 3;
    return;
  }
  for (const [p, text] of Object.entries(r.headerTexts)) writeFileSync(path.join(outDir, `rename-${p}.h`), text);
  writeFileSync(path.join(outDir, 'rename-lists.json'), `${JSON.stringify(r.result, null, 1)}\n`);
  console.log(`rename-list: shared ${r.result.shared.map((s) => s.name).join(' ') || '(none)'}; renamed ${PROGRAMS.map((p) => `${p} ${r.result.renamed[p].length}`).join(', ')}`);
}

/**
 * Strong names that two libraries define, each with its defining members ({archive, member}; the archive path as
 * llvm-nm -A gives it). Weak definitions never clash.
 */
export function libraryClashes({ libsDef }) {
  const byName = new Map();
  for (const [lib, list] of Object.entries(libsDef)) {
    for (const s of list) {
      if (WEAK_TYPES.has(s.type)) continue;
      const i = s.file.lastIndexOf(':');
      const member = { library: lib, archive: i > 0 ? s.file.slice(0, i) : s.file, member: i > 0 ? s.file.slice(i + 1) : '' };
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(member);
    }
  }
  const out = [];
  for (const [name, members] of byName) {
    if (new Set(members.map((m) => m.library)).size >= 2) out.push({ name, members: members.map(({ archive, member }) => ({ archive, member })) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The check after the recompile: the failures, and the library clashes for the map check. */
export function computeVerify(data, result) {
  const sharedNames = new Set(result.shared.map((s) => s.name));
  // A name XeTeX keeps whose library copy the trial link did not load (xetexKeepsUnlinked) is no clash.
  const unlinked = new Set((result.xetexKeepsUnlinked ?? []).map((x) => x.name));
  const left = clashes(definitions(data)).filter((c) => !sharedNames.has(c.name) && !(unlinked.has(c.name) && Object.keys(c.programs).join() === KEEPS_NAMES));
  const failures = left.map((c) => `${c.name} is still defined by ${[...Object.keys(c.programs), ...c.libraries].join(', ')}`);
  // A shared name keeps exactly one definition, in XeTeX.
  const defs = definitions(data);
  for (const n of sharedNames) {
    const e = defs.get(n);
    const holders = e ? Object.keys(e.programs) : [];
    if (holders.length !== 1 || holders[0] !== KEEPS_NAMES) failures.push(`shared ${n} is defined by ${holders.join(', ') || 'no program'}`);
  }
  return { failures, libraryClashes: libraryClashes(data) };
}

function verify(dir, listsPath) {
  const r = computeVerify(load(dir), JSON.parse(readFileSync(listsPath, 'utf8')));
  writeFileSync(
    path.join(path.dirname(listsPath), 'library-clashes.json'),
    `${JSON.stringify({ about: 'Strong names that two libraries define (rename-list.mjs verify); link-report.mjs map says which member the link loaded.', clashes: r.libraryClashes }, null, 1)}\n`,
  );
  for (const c of r.libraryClashes) console.log(`rename-list: library clash ${c.name}: ${c.members.map((m) => `${path.basename(m.archive)}(${m.member})`).join(', ')}`);
  for (const f of r.failures) console.error(`rename-list: FAIL ${f}`);
  console.log(r.failures.length === 0 ? 'rename-list: no clash is left outside the shared list' : `rename-list: ${r.failures.length} failures`);
  process.exitCode = r.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, a, b] = process.argv.slice(2);
  if (phase === 'candidates') candidates(a);
  else if (phase === 'lists') lists(a, b ?? a);
  else if (phase === 'verify') verify(a, b);
  else {
    console.error('usage: rename-list.mjs candidates DIR | lists DIR [OUTDIR] | verify DIR LISTS');
    process.exitCode = 2;
  }
}
