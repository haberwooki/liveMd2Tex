#!/usr/bin/env node
// engine/build/tools/font-check.mjs: the font check of the fontconfig stand-in (docs/DEVELOPING.md, "The TeX engine:
// our own build"). It decides whether the fontconfig stand-in (engine/build/fontlist) finds every font by name as the
// earlier engine (TeXlyre's build, with fontconfig) does.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node font-check.mjs --work DIR (--images DIR | --fonts-dir DIR --mount PATH) [--new OUT]
//                       [--fc-scan PATH] [--old-host DIR | --old-results FILE] [--rules FILE]
//                       [--only list|names] [--batch N] [--batches I,J]
//
//   --new OUT        the new engine (engine.js, engine.wasm): side B; without it side B is not run
//   --old-results F  side A's results of an earlier run (DIR/side-a.json), instead of running side A again
//   --rules FILE     fontOrder rules, [{ "name", "first" }]: the face whose file is "first" comes before every
//                    other face of its data set that shares "name" (XeTeX keeps the first face it meets for a
//                    name, so the order decides a collision). Each set's list is ordered with its own rules and the lists are joined in
//                    mount order, core first, as the host joins them; a rule that does not hold, a rule that
//                    decides nothing, and a name two sets share fail the run (no rule of one set can decide it)
//   --evidence       with --rules, side A and --new: side B again once per rule with that rule left out, so each
//                    proposed rule names the requests that differ without it (one side B run per
//                    rule, about 30 s each with a core and an add-on image)
//   --batch N        requests per fixture (default 200: one XeTeX run must not load more fonts than 576 MiB hold)
//   --batches I,J    run only these fixtures, for debugging
//   --images DIR     the data packages (livemd2tex-core-data-*.vsix, livemd2tex-extra-data-*.vsix): their font
//                    files under fonts/opentype/ and fonts/truetype/, mounted where the extension's host mounts them (the
//                    core at its index's paths, /texlive/...; an add-on under /texmf-extra)
//   --fonts-dir DIR  instead, a plain folder of font files, mounted at --mount
//   --fc-scan PATH   fontconfig 2.13.96's fc-scan, built natively (check 1's reference; never shipped)
//   --old-host DIR   a worktree of main at a commit that still pins the earlier engine (TeXlyre's build), with
//                    its dist/ and out/ built: side A, that engine under its own host. Without it, check 2
//                    records side B only.
//   --work DIR       extracted fonts, the fixtures and the reports (outside the repository): fonts.list,
//                    font-check.json (both checks), font-check-rows.json (every request on both sides),
//                    side-a.json, and font-order-proposed.json (a rule for every colliding name)
//
// Check 1 (the list check): for every font file, the list writer's faces (scripts/lib/font-list.mjs) against
// fc-scan's: the number of faces, each face's family, style, full and PostScript names, the first of each, and
// weight, width and slant.
// Check 2 (the end-to-end check): every family, "Family Style", "Family-Style", full name and PostScript name of
// every face, from both the writer and fc-scan, asked plain and with /B, /I and /BI, each family also at 5 pt and
// 17 pt, each in a \font line under \XeTeXtracingfonts=1 with one glyph shipped out on a page of its own; the file
// and face index XeTeX chose are read from the .xdv's define_native_font records (xdv.mjs), never from the .fls.
// Pass: for every name the same (file, index) on both sides, and the same names resolving to none.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chosenFonts } from './xdv.mjs';

const { describeFile, listLine, joinSets, isListedFontPath } = await import(new URL('../../../scripts/lib/font-list.mjs', import.meta.url).href);

function options(argv) {
  const o = { batch: 200, only: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (['new', 'work', 'images', 'fonts-dir', 'mount', 'fc-scan', 'old-host', 'old-results', 'old-images', 'only', 'batch', 'rules', 'batches'].includes(k)) o[k] = argv[++i];
    else if (k === 'evidence') o.evidence = true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (!o.work) throw new Error('--work is required');
  if (!o.images && !o['fonts-dir']) throw new Error('--images or --fonts-dir is required');
  o.batch = Number(o.batch);
  return o;
}

// ---------- the font files ----------

/** Every listed font file of the data set: [{ mounted, bytes, set }]. */
async function gatherFonts(o) {
  const out = [];
  if (o['fonts-dir']) {
    const mount = (o.mount ?? '/fonts').replace(/\/$/, '');
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
        else out.push({ mounted: `${mount}/${rel}${name}`, bytes: readFileSync(full), set: 'dir' });
      }
    };
    walk(o['fonts-dir'], '');
    return out;
  }
  // The images, unpacked once into <work>/images (side A mounts the same files): <set>.data and <set>.index.json,
  // the index being { compressed: { offsets, sizes, successes }, metadata: { files: [{ filename, start, end }] } }.
  const { readZip } = await import(new URL('../../../scripts/lib/zip.mjs', import.meta.url).href);
  const { openImage } = await import(new URL('../../../scripts/lib/image-files.mjs', import.meta.url).href);
  const images = path.join(o.work, 'images');
  mkdirSync(images, { recursive: true });
  for (const vsix of readdirSync(o.images).filter((f) => f.endsWith('.vsix')).sort()) {
    const set = /core-data/.test(vsix) ? 'core' : /extra-data/.test(vsix) ? 'extra' : null;
    if (!set || existsSync(path.join(images, `${set}.index.json`))) continue;
    const entries = readZip(readFileSync(path.join(o.images, vsix)));
    for (const [n, bytes] of entries) {
      if (n === `extension/data/${set}.data` || n === `extension/data/${set}.index.json`) writeFileSync(path.join(images, n.slice('extension/data/'.length)), bytes);
      if (n === 'extension/data/manifest.json') writeFileSync(path.join(images, `${set}.manifest.json`), bytes);
    }
  }
  for (const set of ['core', 'extra']) {
    const indexPath = path.join(images, `${set}.index.json`);
    if (!existsSync(indexPath)) continue;
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const img = openImage(path.join(images, `${set}.data`), index.compressed);
    const root = set === 'core' ? '' : '/texmf-extra';
    for (const f of index.metadata.files) {
      if (!isListedFontPath(f.filename)) continue;
      out.push({ mounted: `${root}${f.filename}`, bytes: img.read(f.start, f.end), set });
    }
  }
  return out;
}

// ---------- check 1: the writer against fc-scan ----------

const FC_FORMAT = '@@FACE\\t%{file}\\t%{index}\\t%{weight}\\t%{width}\\t%{slant}\\t%{variable}\\t%{outline}\\t%{postscriptname}\\n%{[]family{F\\t%{family}\\n}}%{[]style{S\\t%{style}\\n}}%{[]fullname{N\\t%{fullname}\\n}}';

function fcScan(fcScanPath, file) {
  let text;
  try {
    text = execFileSync(fcScanPath, ['--format', FC_FORMAT, file], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    text = e.stdout ?? '';
  }
  const faces = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@FACE\t')) {
      const [, f, index, weight, width, slant, variable, outline, ps] = line.split('\t');
      // A variable face's weight or width is a range ("[100 900]"), which the list writes as empty (null).
      const num = (v) => (v === '' || v.startsWith('[') ? null : Math.trunc(Number(v)));
      cur = { file: f, index: Number(index), weight: num(weight), width: num(width), slant: slant === '' ? null : Number(slant), variable: variable === 'True', outline: outline === 'True', postscript: ps === '' ? null : ps, family: [], style: [], full: [] };
      faces.push(cur);
    } else if (cur && line.length > 2 && line[1] === '\t') {
      const v = line.slice(2);
      if (line[0] === 'F') cur.family.push(v);
      else if (line[0] === 'S') cur.style.push(v);
      else if (line[0] === 'N') cur.full.push(v);
    }
  }
  // XeTeX lists only ":outline=true" faces.
  return faces.filter((f) => f.outline);
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function compareFaces(ours, ref) {
  const diffs = [];
  const key = (f) => `${f.index}${f.variable ? ' (variable)' : ''}`;
  const ourBy = new Map(ours.map((f) => [`${f.index}|${f.weight === null || f.style.length === 0 ? 1 : 0}`, f]));
  if (ours.length !== ref.length) diffs.push({ what: 'face count', ours: ours.length, ref: ref.length });
  for (const r of ref) {
    const o = ourBy.get(`${r.index}|${r.variable ? 1 : 0}`) ?? ours.find((x) => x.index === r.index);
    if (!o) {
      diffs.push({ what: 'face missing from the list', face: key(r) });
      continue;
    }
    for (const field of ['family', 'style', 'full']) {
      if (!sameList(o[field], r[field])) diffs.push({ what: field, face: key(r), ours: o[field], ref: r[field] });
    }
    if ((o.postscript ?? null) !== (r.postscript ?? null) && !r.variable) diffs.push({ what: 'postscript', face: key(r), ours: o.postscript, ref: r.postscript });
    for (const field of ['weight', 'width', 'slant']) {
      if ((o[field] ?? null) !== (r[field] ?? null)) diffs.push({ what: field, face: key(r), ours: o[field], ref: r[field] });
    }
  }
  for (const o of ours) {
    if (!ref.some((r) => r.index === o.index)) diffs.push({ what: 'face only in the list', face: `${o.index}` });
  }
  return diffs;
}

// ---------- check 2: the fixture ----------

const SUFFIXES = ['', '/B', '/I', '/BI'];

/** Every name to ask, each with its size: [{ name, size }] (sizes in pt). */
function requests(facesBySource, collisions) {
  const set = new Map();
  const add = (name, size = 10) => {
    if (!name || name.includes('"') || name.includes('\\') || / {2}/.test(name) || /^\s|\s$/.test(name)) return;
    const k = `${name}\u0000${size}`;
    if (!set.has(k)) set.set(k, { name, size });
  };
  for (const faces of facesBySource) {
    for (const f of faces) {
      const names = new Set();
      for (const fam of f.family) {
        names.add(fam);
        for (const st of f.style) {
          names.add(`${fam} ${st}`);
          names.add(`${fam}-${st}`);
        }
        add(fam, 5);
        add(fam, 17);
      }
      for (const n of f.full) names.add(n);
      if (f.postscript) names.add(f.postscript);
      for (const n of names) for (const s of SUFFIXES) add(`${n}${s}`);
    }
  }
  for (const c of collisions) for (const s of SUFFIXES) add(`${c.name}${s}`);
  return [...set.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.size - b.size));
}

/** One fixture: page i (\count0 = i) holds one glyph of request i, or no page if the name resolves to none. */
function fixture(reqs, first) {
  const lines = [
    '\\catcode`\\{=1 \\catcode`\\}=2 \\catcode`\\#=6',
    '\\let\\bgroup={ \\let\\egroup=}',
    '\\XeTeXtracingfonts=1 \\suppressfontnotfounderror=1',
    '\\catcode`\\{=12 \\catcode`\\}=12 \\catcode`\\$=12 \\catcode`\\&=12 \\catcode`\\#=12 \\catcode`\\^=12 \\catcode`\\_=12 \\catcode`\\~=12 \\catcode`\\%=12',
  ];
  reqs.forEach((r, i) => {
    lines.push(`\\count0=${first + i}\\relax\\font\\f="${r.name}" at ${r.size}pt \\ifx\\f\\nullfont\\else\\shipout\\hbox\\bgroup\\f\\XeTeXglyph0\\egroup\\fi`);
  });
  lines.push('\\end', '');
  return lines.join('\n');
}

// ---------- side B: the new engine with the stand-in's list ----------

async function sideB(o, fonts, listText, batches) {
  const gluePath = path.resolve(o.new, 'engine.js');
  const module = await WebAssembly.compile(readFileSync(path.resolve(o.new, 'engine.wasm')));
  const factory = createRequire(gluePath)(gluePath);
  let transcript = [];
  const M = await factory({
    thisProgram: '/bin/engine',
    noInitialRun: true,
    print: (l) => transcript.push(l),
    printErr: (l) => transcript.push(l),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(done);
      return {};
    },
    preRun: [(Mod) => Object.assign(Mod.ENV, { TEXMFCNF: '/engine/cnf', TEXINPUTS: '.', TEXFONTS: '.', MKTEXTFM: '0', MKTEXPK: '0', MKTEXMF: '0', MKTEXTEX: '0', MKTEXFMT: '0', shell_escape: 'f', font_max: '9000', LIVEMD2TEX_FONT_LIST: '/engine/fonts.list', LIVEMD2TEX_FONT_LIST_CHECK: '1', HOME: '/home/web_user' })],
  });
  const FS = M.FS;
  FS.mkdirTree('/engine/cnf');
  FS.writeFile('/engine/cnf/texmf.cnf', 'TEXINPUTS = .\nshell_escape = f\n');
  FS.mkdirTree('/bin');
  FS.writeFile('/bin/engine', '');
  for (const f of fonts) {
    FS.mkdirTree(path.posix.dirname(f.mounted));
    FS.writeFile(f.mounted, f.bytes);
  }
  FS.writeFile('/engine/fonts.list', listText);
  FS.mkdirTree('/project');
  FS.chdir('/project');
  const header = M.HEAPU8.slice(0, 2 ** 26);
  const chosen = new Map();
  const logs = [];
  for (const [b, batch] of batches.entries()) {
    FS.writeFile(`/project/b${b}.tex`, batch.text);
    transcript = [];
    let code;
    try {
      code = M.callMain(['xetex', '-ini', '-etex', '-interaction=nonstopmode', '-no-pdf', `b${b}.tex`]);
    } catch (e) {
      code = `stopped: ${e}`;
    }
    M._flush_streams();
    M.HEAPU8.fill(0);
    M.HEAPU8.set(header);
    let xdv;
    try {
      xdv = FS.readFile(`/project/b${b}.xdv`);
    } catch {
      xdv = null;
    }
    const pages = xdv ? chosenFonts(xdv) : new Map();
    batch.reqs.forEach((r, i) => chosen.set(batch.first + i, pages.get(batch.first + i) ?? null));
    logs.push({ batch: b, exit: code, pages: pages.size, collisions: transcript.filter((l) => l.startsWith('fonts.list:')).length });
    if (b === 0) logs[0].collisionLines = transcript.filter((l) => l.startsWith('fonts.list:')).slice(0, 200);
    console.log(`side B batch ${b}: exit ${code}, ${pages.size} pages of ${batch.reqs.length} requests`);
  }
  // The font files one XeTeX pass opens with the whole list mounted (the speed planner's question: the earlier
  // engine's fontconfig read every font file of the image on every pass). Emscripten's open syscall goes through FS.open.
  const opened = new Set();
  const realOpen = FS.open;
  FS.open = function (p, ...rest) {
    const name = typeof p === 'string' ? p : String(p?.path ?? p);
    if (/\.(otf|ttf|ttc|pfb|woff2?)$/i.test(name)) opened.add(name);
    return realOpen.call(this, p, ...rest);
  };
  const pagella = fonts.find((f) => /texgyrepagella-regular\.otf$/.test(f.mounted));
  const opens = [];
  const probes = [
    ['no native font', ''],
    ['TeX Gyre Pagella by family name', '\\font\\x="TeX Gyre Pagella" at 10pt \\shipout\\hbox{\\x A}'],
    ...(pagella ? [['texgyrepagella-regular.otf by file name', `\\font\\x="[${pagella.mounted}]" at 10pt \\shipout\\hbox{\\x A}`]] : []),
  ];
  for (const [label, body] of probes) {
    FS.writeFile('/project/opens.tex', `\\catcode\`\\{=1 \\catcode\`\\}=2 ${body}\\shipout\\hbox{}\\end\n`);
    opened.clear();
    try {
      M.callMain(['xetex', '-ini', '-etex', '-interaction=nonstopmode', '-no-pdf', 'opens.tex']);
    } catch {
      // recorded below by the count alone
    }
    M._flush_streams();
    M.HEAPU8.fill(0);
    M.HEAPU8.set(header);
    opens.push({ label, count: opened.size, files: [...opened].sort() });
    console.log(`side B, font files one XeTeX pass opens, ${label}: ${opened.size}`);
  }
  FS.open = realOpen;
  logs.push({ fontFilesOpened: opens, fontFilesMounted: fonts.length });
  return { chosen, logs };
}

// ---------- side A: the earlier engine (TeXlyre's build) under its own host ----------

async function sideA(o, batches) {
  const { runOldHost } = await import(new URL('./font-check-old-host.mjs', import.meta.url).href);
  return runOldHost(o, batches);
}

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.work, { recursive: true });
  const fonts = await gatherFonts(o);
  console.log(`font files: ${fonts.length}`);
  const rules = o.rules ? JSON.parse(readFileSync(o.rules, 'utf8')) : [];

  // The list (writer), per file.
  const skipped = [];
  for (const f of fonts) {
    const r = describeFile(f.bytes, f.mounted);
    if (r.skipped) skipped.push({ file: f.mounted, why: r.skipped });
    f.faces = r.faces;
  }
  // Each set's list on its own, joined in mount order: core-data, then the add-on, as the host mounts them.
  const setOrder = ['core', 'extra', 'dir'];
  const sets = setOrder.map((name) => ({ name, faces: fonts.filter((f) => f.set === name).flatMap((f) => f.faces) })).filter((x) => x.faces.length > 0);
  const ordered = joinSets(sets, rules);
  const listText = `${ordered.faces.map((f) => listLine(f)).join('\n')}\n`;
  writeFileSync(path.join(o.work, 'fonts.list'), listText);
  const report = {
    fonts: fonts.length,
    faces: ordered.faces.length,
    sets: sets.map((x) => ({ name: x.name, faces: x.faces.length })),
    skipped,
    rules: rules.length,
    collisions: ordered.collisions,
    crossSet: ordered.crossSet,
    unmetRules: ordered.unmetRules,
    staleRules: ordered.staleRules,
    check1: null,
    check2: null,
  };
  console.log(`list: ${ordered.faces.length} faces in ${sets.length} sets; ${skipped.length} files left out; ${ordered.collisions.length} collisions (${ordered.collisions.filter((c) => !c.rule).length} without a rule); ${ordered.crossSet.length} across sets; rules: ${ordered.unmetRules.length} unmet, ${ordered.staleRules.length} stale`);
  for (const c of ordered.crossSet) console.log(`FAIL cross-set collision: ${c.kind} "${c.name}" in ${c.firstSet} (${c.first}) and ${c.otherSet} (${c.other})`);
  for (const r of ordered.unmetRules) console.log(`FAIL rule "${r.name}" -> ${r.first} does not hold: ${r.firstNow} comes first`);
  for (const r of ordered.staleRules) console.log(`FAIL rule "${r.name}" -> ${r.first} decides nothing: ${r.why}`);
  const listFailures = ordered.crossSet.length + ordered.unmetRules.length + ordered.staleRules.length;

  // Check 1.
  const refFaces = [];
  if (o['fc-scan'] && o.only !== 'names') {
    const extracted = path.join(o.work, 'files');
    const diffs = [];
    let refCount = 0;
    for (const f of fonts) {
      const local = path.join(extracted, f.mounted);
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, f.bytes);
      const ref = fcScan(o['fc-scan'], local).map((x) => ({ ...x, file: f.mounted }));
      refCount += ref.length;
      refFaces.push(...ref);
      const d = compareFaces(f.faces, ref);
      if (d.length > 0) diffs.push({ file: f.mounted, diffs: d });
    }
    report.check1 = { referenceFaces: refCount, filesWithDifferences: diffs.length, differences: diffs };
    console.log(`check 1: fc-scan ${refCount} faces, the list ${ordered.faces.length}; ${diffs.length} files differ`);
  }
  if (o.only === 'list') {
    writeFileSync(path.join(o.work, 'font-check.json'), `${JSON.stringify(report, null, 1)}\n`);
    return (report.check1 && report.check1.filesWithDifferences > 0) || listFailures > 0 ? 1 : 0;
  }

  // Check 2.
  const reqs = requests([ordered.faces, refFaces], ordered.collisions);
  const batches = [];
  for (let i = 0; i < reqs.length; i += o.batch) {
    const slice = reqs.slice(i, i + o.batch);
    batches.push({ first: i + 1, reqs: slice, text: fixture(slice, i + 1) });
  }
  batches.forEach((b, k) => writeFileSync(path.join(o.work, `b${k}.tex`), b.text));
  if (o.batches) {
    // A debugging run of some fixtures only (--batches 0,5); its side A results are not kept.
    const keep = new Set(o.batches.split(',').map(Number));
    for (let k = batches.length - 1; k >= 0; k--) if (!keep.has(k)) batches.splice(k, 1);
  }
  console.log(`check 2: ${reqs.length} requests in ${batches.length} fixtures`);
  // Side A's results are kept by request (name and size), so a later run of side B alone can be compared with
  // them (--old-results), as long as the request set is the same.
  const keyOf = (r) => `${r.name}\u0000${r.size}`;
  let a = null;
  if (o['old-results']) {
    const saved = JSON.parse(readFileSync(o['old-results'], 'utf8'));
    const byKey = new Map(saved.rows.map((r) => [keyOf(r), r.chosen]));
    const missing = reqs.filter((r) => !byKey.has(keyOf(r)));
    if (missing.length > 0) throw new Error(`--old-results lacks ${missing.length} of this run's requests (first: ${missing[0].name})`);
    a = { chosen: new Map(reqs.map((r, i) => [i + 1, byKey.get(keyOf(r))])), logs: saved.logs };
  } else if (o['old-host']) {
    a = await sideA(o, batches);
    const rows = reqs.map((r, i) => ({ name: r.name, size: r.size, chosen: a.chosen.get(i + 1) ?? null }));
    writeFileSync(path.join(o.work, 'side-a.json'), `${JSON.stringify({ logs: a.logs, rows })}\n`);
  }
  const b = o.new ? await sideB(o, fonts, listText, batches) : { chosen: new Map(), logs: 'not run (no --new)' };
  const rows = reqs.map((r, i) => ({ name: r.name, size: r.size, b: b.chosen.get(i + 1) ?? null, a: a ? a.chosen.get(i + 1) ?? null : undefined }));
  const fmt = (x) => (x ? `${x.file}#${x.index}` : 'none');
  const differences = a && o.new ? rows.filter((r) => fmt(r.a) !== fmt(r.b)) : [];
  report.check2 = {
    requests: reqs.length,
    resolvedB: rows.filter((r) => r.b).length,
    noneB: rows.filter((r) => !r.b).length,
    resolvedA: a ? rows.filter((r) => r.a).length : null,
    sideA: a ? a.logs : 'not run (no --old-host)',
    sideB: b.logs,
    differences: differences.map((r) => ({ name: r.name, size: r.size, old: fmt(r.a), new: fmt(r.b) })),
  };
  if (a) {
    // Leave each rule out once: the requests whose result then differs from side A's are that rule's evidence.
    let evidence = null;
    if (o.evidence && o.new && rules.length > 0) {
      evidence = new Map();
      for (const rule of rules) {
        const without = joinSets(sets, rules.filter((r) => r !== rule));
        const bw = await sideB(o, fonts, `${without.faces.map((f) => listLine(f)).join('\n')}\n`, batches);
        const differ = reqs.map((r, i) => ({ r, old: fmt(a.chosen.get(i + 1)), now: fmt(bw.chosen.get(i + 1)) })).filter((x) => x.old !== x.now);
        evidence.set(rule.name, differ.map((x) => `${x.r.name} at ${x.r.size} pt: ${x.now} without the rule, ${x.old} on the earlier engine`));
        console.log(`evidence: without "${rule.name}", ${differ.length} requests differ`);
      }
      // Rules that put the same file first can each stand in for the other, so leaving one out changes nothing:
      // such a group is left out together once, and each member records the group's evidence.
      const groups = new Map();
      for (const rule of rules) groups.set(rule.first, [...(groups.get(rule.first) ?? []), rule]);
      for (const [first, group] of groups) {
        if (group.length < 2 || group.some((r) => evidence.get(r.name).length > 0)) continue;
        const without = joinSets(sets, rules.filter((r) => !group.includes(r)));
        const bw = await sideB(o, fonts, `${without.faces.map((f) => listLine(f)).join('\n')}\n`, batches);
        const differ = reqs.map((r, i) => ({ r, old: fmt(a.chosen.get(i + 1)), now: fmt(bw.chosen.get(i + 1)) })).filter((x) => x.old !== x.now);
        const names = group.map((r) => r.name);
        for (const r of group) {
          evidence.set(r.name, { group: names, lines: differ.map((x) => `${x.r.name} at ${x.r.size} pt: ${x.now} without these rules, ${x.old} on the earlier engine`) });
        }
        console.log(`evidence: without the ${group.length} rules that put ${first} first, ${differ.length} requests differ`);
      }
    }
    writeFileSync(path.join(o.work, 'font-order-proposed.json'), `${JSON.stringify(proposeRules(ordered, rows, evidence), null, 1)}\n`);
  }
  writeFileSync(path.join(o.work, 'font-check-rows.json'), `${JSON.stringify(rows.map((r) => ({ name: r.name, size: r.size, new: fmt(r.b), old: r.a === undefined ? null : fmt(r.a) })), null, 0)}\n`);
  writeFileSync(path.join(o.work, 'font-check.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(`check 2: ${reqs.length} requests; side A ${a ? `resolved ${report.check2.resolvedA}` : 'not run'}; side B ${o.new ? `resolved ${report.check2.resolvedB}` : 'not run'}${a && o.new ? `; ${differences.length} differences` : ''}`);
  return (a && o.new && differences.length > 0) || listFailures > 0 ? 1 : 0;
}


/**
 * A fontOrder rule for every colliding name, each with its reason and its evidence:
 * - the face the earlier engine (side A, TeXlyre's build) chose for the name at 10 pt;
 * - where that engine resolves the name to none, the face whose own family and subfamily (name IDs 1 and 2)
 *   make the name, else the list's first, and the reason says which;
 * - with --evidence, the requests whose result differs from side A's when side B runs without that rule; a rule
 *   without one says so (it records the order where nothing depends on it).
 */
function proposeRules(ordered, rows, evidence) {
  const chosenBy = new Map(rows.filter((r) => r.size === 10).map((r) => [r.name, r.a]));
  const facesByFile = new Map();
  for (const f of ordered.faces) {
    if (!facesByFile.has(f.file)) facesByFile.set(f.file, []);
    facesByFile.get(f.file).push(f);
  }
  const proposed = [];
  for (const c of ordered.collisions) {
    if (proposed.some((p) => p.name === c.name)) continue;
    const today = chosenBy.get(c.name);
    let first;
    let why;
    if (today) {
      first = today.file;
      why = "the earlier engine (TeXlyre's build) chose it";
    } else {
      const candidates = [c.first, ...ordered.collisions.filter((x) => x.name === c.name).map((x) => x.other)];
      const own = candidates.find((file) => (facesByFile.get(file) ?? []).some((f) => f.legacy === c.name));
      first = own ?? c.first;
      why = own
        ? "the earlier engine (TeXlyre's build) resolves the name to none; the face whose own family and subfamily (name IDs 1 and 2) make the name"
        : "the earlier engine (TeXlyre's build) resolves the name to none, and no face's own family and subfamily make it; the list's first";
    }
    const entry = { name: c.name, kind: c.kind, set: c.set, first, why };
    if (evidence && evidence.has(c.name)) {
      const e = evidence.get(c.name);
      if (Array.isArray(e)) entry.differWithout = e.length > 0 ? e : 'none: without the rule no request differs; it records the order';
      else {
        entry.sameFileAs = e.group.filter((n) => n !== c.name);
        entry.differWithout = e.lines.length > 0 ? e.lines : 'none: without these rules no request differs; they record the order';
      }
    }
    proposed.push(entry);
  }
  return proposed;
}

process.exitCode = await main();
