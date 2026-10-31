#!/usr/bin/env node
// Compares two builds of the engine, which must match byte for byte (docs/DEVELOPING.md, "The TeX engine: our own
// build"): the CI build's
// artifacts and an independent build under WSL from the same public commit. Each takes a folder that holds
// engine.wasm, engine.js, engine-build.json and, optionally, generated-sources/ (the generated C and headers).
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/engine-compare.mjs A_DIR B_DIR [--json FILE]
//
// It prints "match" and exits 0 when engine.wasm and engine.js have the same SHA-256 on both sides and the two
// manifests differ only in the fields IGNORABLE lists (those that name the machine). Otherwise it prints what
// differs, to find the cause: for the wasm each section's size and hash, the data segments
// that differ and the strings found in one side's data only (a path means a missed -ffile-prefix-map, a date a
// missed SOURCE_DATE_EPOCH); for the glue the first lines that differ; the manifests' fields that differ; and the
// generated sources that differ, which name the host tool that wrote them. The report holds no path of either
// machine: home folders are written as /home/<user>.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWasm } from '../engine/build/tools/wasm-inspect.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The manifest fields a comparison may ignore: they describe the machine, not the build. Each is a dotted path;
 * "*" stands for any key. The scripts' commit counts: both builds are of the same public commit.
 */
export const IGNORABLE = [
  { field: 'toolchain.machine', why: 'the build machine: OS name, kernel, CPUs, memory' },
  { field: 'toolchain.runnerImage', why: "GitHub's runner image; null under WSL" },
  { field: 'toolchain.host.*', why: 'the host tools that touch the build (awk, sed, make, bash, tar, coreutils, gcc, python), each with its version' },
  { field: 'toolchain.nativeCompiler', why: "the build machine's GCC (also under toolchain.host)" },
  { field: 'toolchain.python', why: "the build machine's Python (also under toolchain.host)" },
];

function ignorable(field) {
  for (const rule of IGNORABLE) {
    const re = new RegExp(`^${rule.field.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}(\\.|$)`);
    if (!re.test(field)) continue;
    return rule;
  }
  return null;
}

/** Every leaf that differs between two JSON values, by dotted path. */
export function jsonDifferences(a, b, at = '') {
  const isObj = (x) => x !== null && typeof x === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ field: at, a, b }];
  }
  if (Array.isArray(a) && a.length !== b.length) return [{ field: at, a: `${a.length} entries`, b: `${b.length} entries` }];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((k) => jsonDifferences(a[k], b[k], at ? `${at}.${k}` : k));
}

/** The manifests' differences, split into those that count and those IGNORABLE allows. */
export function manifestDifferences(a, b) {
  const counted = [];
  const ignored = [];
  for (const d of jsonDifferences(a, b)) {
    const rule = ignorable(d.field);
    (rule ? ignored : counted).push(rule ? { ...d, why: rule.why } : d);
  }
  return { counted, ignored };
}

const redact = (s) =>
  String(s)
    .replace(/\/home\/[^/\s"']+/g, '/home/<user>')
    .replace(/\/Users\/[^/\s"']+/g, '/Users/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'C:\\Users\\<user>');

/** Printable strings of at least 6 characters, with their counts. */
function strings(bytes) {
  const out = new Map();
  for (const m of Buffer.from(bytes).toString('latin1').matchAll(/[\x20-\x7e]{6,}/g)) out.set(m[0], (out.get(m[0]) ?? 0) + 1);
  return out;
}

/** The wasm files compared section by section, and the data section's strings that one side holds only. */
export function wasmDifferences(aBytes, bBytes) {
  const a = readWasm(aBytes);
  const b = readWasm(bBytes);
  const sec = (w, bytes) => w.sections.map((s) => ({ kind: s.kind, name: s.name, size: s.size, sha256: sha256(bytes.subarray(s.offset, s.offset + s.size)) }));
  const sa = sec(a, aBytes);
  const sb = sec(b, bBytes);
  const sections = [];
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (!x || !y || x.kind !== y.kind || x.sha256 !== y.sha256) sections.push({ kind: x?.kind ?? y?.kind, name: x?.name ?? y?.name, sizeA: x?.size ?? null, sizeB: y?.size ?? null, same: false });
  }
  const dataOf = (w, bytes) => {
    const s = w.sections.find((x) => x.kind === 'data');
    return s ? bytes.subarray(s.offset, s.offset + s.size) : Buffer.alloc(0);
  };
  const stA = strings(dataOf(a, aBytes));
  const stB = strings(dataOf(b, bBytes));
  const onlyA = [...stA.keys()].filter((s) => !stB.has(s));
  const onlyB = [...stB.keys()].filter((s) => !stA.has(s));
  const looksLike = (s) => (/\/(home|Users|mnt|tmp|runner|src)\//.test(s) ? 'path' : /\b(19|20)\d\d[-/]\d\d[-/]\d\d|\d\d:\d\d:\d\d|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d/.test(s) ? 'date' : 'other');
  const show = (list) => list.slice(0, 40).map((s) => ({ kind: looksLike(s), text: redact(s).slice(0, 200) }));
  return { sections, dataStringsOnlyA: show(onlyA), dataStringsOnlyB: show(onlyB), counts: { onlyA: onlyA.length, onlyB: onlyB.length } };
}

function glueDifferences(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const lines = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && lines.length < 20; i++) {
    if (la[i] !== lb[i]) lines.push({ line: i + 1, a: redact(la[i] ?? '(none)').slice(0, 200), b: redact(lb[i] ?? '(none)').slice(0, 200) });
  }
  return { linesA: la.length, linesB: lb.length, first: lines };
}

function treeFiles(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else out.set(r, sha256(readFileSync(path.join(dir, r))));
    }
  };
  walk('');
  return out;
}

export function compareBuilds(aDir, bDir) {
  const read = (d, f) => readFileSync(path.join(d, f));
  const files = {};
  for (const f of ['engine.wasm', 'engine.js', 'engine-build.json']) {
    const x = sha256(read(aDir, f));
    const y = sha256(read(bDir, f));
    files[f] = { a: x, b: y, same: x === y };
  }
  const report = { files };
  if (!files['engine.wasm'].same) report.wasm = wasmDifferences(read(aDir, 'engine.wasm'), read(bDir, 'engine.wasm'));
  if (!files['engine.js'].same) report.glue = glueDifferences(read(aDir, 'engine.js').toString('utf8'), read(bDir, 'engine.js').toString('utf8'));
  report.manifest = manifestDifferences(JSON.parse(read(aDir, 'engine-build.json')), JSON.parse(read(bDir, 'engine-build.json')));
  for (const d of [...report.manifest.counted, ...report.manifest.ignored]) {
    d.a = redact(JSON.stringify(d.a)).slice(0, 300);
    d.b = redact(JSON.stringify(d.b)).slice(0, 300);
  }
  const ga = treeFiles(path.join(aDir, 'generated-sources'));
  const gb = treeFiles(path.join(bDir, 'generated-sources'));
  if (ga.size > 0 && gb.size > 0) {
    const names = [...new Set([...ga.keys(), ...gb.keys()])].sort();
    report.generatedSources = { files: names.length, differ: names.filter((n) => ga.get(n) !== gb.get(n)) };
  } else if (ga.size > 0 || gb.size > 0) {
    report.generatedSources = { files: Math.max(ga.size, gb.size), differ: [], onlyOn: ga.size > 0 ? 'A' : 'B' };
  }
  report.match = files['engine.wasm'].same && files['engine.js'].same && report.manifest.counted.length === 0;
  return report;
}

function main(argv) {
  const [a, b] = argv.filter((x, i) => !x.startsWith('--') && argv[i - 1] !== '--json');
  const j = argv.indexOf('--json');
  if (!a || !b) {
    console.error('usage: engine-compare.mjs A_DIR B_DIR [--json FILE]');
    return 2;
  }
  const r = compareBuilds(a, b);
  if (j >= 0) writeFileSync(argv[j + 1], `${JSON.stringify(r, null, 1)}\n`);
  for (const [f, x] of Object.entries(r.files)) console.log(`${x.same ? 'same  ' : 'DIFFER'} ${f} ${x.a}${x.same ? '' : ` / ${x.b}`}`);
  if (r.wasm) {
    for (const s of r.wasm.sections) console.log(`  wasm section ${s.kind}${s.name ? ` (${s.name})` : ''}: ${s.sizeA} / ${s.sizeB} bytes, contents differ`);
    console.log(`  data strings in A only: ${r.wasm.counts.onlyA}; in B only: ${r.wasm.counts.onlyB}`);
    for (const s of [...r.wasm.dataStringsOnlyA.map((x) => ({ ...x, side: 'A' })), ...r.wasm.dataStringsOnlyB.map((x) => ({ ...x, side: 'B' }))].slice(0, 30)) console.log(`    ${s.side} ${s.kind}: ${s.text}`);
  }
  if (r.glue) for (const l of r.glue.first) console.log(`  glue line ${l.line}: ${l.a} / ${l.b}`);
  for (const d of r.manifest.counted) console.log(`  manifest ${d.field}: ${d.a} / ${d.b}`);
  for (const d of r.manifest.ignored) console.log(`  (ignored: ${d.why}) manifest ${d.field}: ${d.a} / ${d.b}`);
  if (r.generatedSources?.onlyOn) console.log(`  generated sources: only ${r.generatedSources.onlyOn} has them`);
  else if (r.generatedSources) console.log(`  generated sources: ${r.generatedSources.files} files, ${r.generatedSources.differ.length} differ${r.generatedSources.differ.length ? `: ${r.generatedSources.differ.join(', ')}` : ''}`);
  console.log(r.match ? 'match' : 'differ');
  return r.match ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
