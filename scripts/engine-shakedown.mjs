#!/usr/bin/env node
// The LaTeX shake-down of an engine build, and the paired measure of two builds (another optimisation level against
// -Oz). It runs real LaTeX through the extension's
// own engine host (dist/engine-host.js, with the client compiled to out/ by tsc, as scripts/lib/bundle-engine.mjs
// does) on a data set's core image:
//   1. for each engine build given as a folder (engine.js, engine.wasm): pdflatex.fmt and xelatex.fmt made by that
//      engine from the image's own fmtutil.cnf lines (scripts/lib/bundle-engine.mjs, buildFormats), and a copy of
//      the image with those two formats in place of the image's own (the worker loads the formats from the image);
//   2. each document compiled through the extension's route (the worker's own steps: -recorder, -synctex=1,
//      -file-line-error, bibtex8 when the .aux asks for it, the extra passes, xdvipdfmx after XeLaTeX), on A and B
//      in turn, compile by compile, the order alternating from one round to the next;
//   3. for each compile: the page count, the error lines, the fonts embedded (FontFile, FontFile2, FontFile3 in the
//      PDF), whether SyncTeX was written, the steps' exit codes, times and peak memory; whether A's and B's PDFs are
//      the same bytes, and the same once dates, IDs and subset tags are set aside;
//   4. the corpus documents' page counts against the data build's (corpus-bundle.json, today's engine) and TeX
//      Live's (corpus-reference.json), when given.
// A is "busytex" (today's engine, engine/pins.json's build, with the image as it is) or another engine folder; B is
// an engine folder. Without --a only B runs.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/engine-shakedown.mjs --b ENGINE_DIR [--a busytex|ENGINE_DIR] --images DIR --work DIR
//        [--corpus DIR] [--reference FILE] [--rounds N] [--only ID,ID]
//
//   --images DIR     the data packages (livemd2tex-core-data-*.vsix, and livemd2tex-extra-data-*.vsix, mounted as
//                    the extension mounts the add-on)
//   --corpus DIR     a materialized corpus (the bundle workflow's bundle-corpus artifact: corpus-bundle.json and
//                    corpus/<id>/...); its documents are compiled as the data build compiled them
//   --reference FILE TeX Live's page counts (the bundle workflow's corpus-reference.json)
//   --no-extra       leave the add-on image out (it is mounted by default, as the data build's corpus run mounts it)
//   --rounds N       compiles of each document on each side (default 1; a speed comparison uses more)
//   --work DIR       the unpacked images, the images with each build's formats, the cases and the report
//                    (shakedown.json); outside the repository
//
// The cases the harness adds (in <work>/cases): a XeLaTeX document with OpenType fonts by file name, mathematics and
// a bibliography (bibtex8 and xdvipdfmx), and two pdfLaTeX documents with shell escape forced on, one with \write18
// and one with \input|, whose commands must reach the engine's stubs and run nothing.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const MARKER = 'livemd2tex-shakedown-shell-escape-ran';

function options(argv) {
  const o = { rounds: 1 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (['a', 'b', 'images', 'work', 'corpus', 'reference', 'rounds', 'only'].includes(k)) o[k] = argv[++i];
    else if (k === 'no-extra') o.noExtra = true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  for (const k of ['b', 'images', 'work']) if (!o[k]) throw new Error(`--${k} is required`);
  o.rounds = Number(o.rounds);
  return o;
}

/** The core and extra images, unpacked once from the data packages into <work>/images. */
async function unpackImages(o) {
  const { readZip } = await import('./lib/zip.mjs');
  const dir = path.join(o.work, 'images');
  mkdirSync(dir, { recursive: true });
  for (const vsix of readdirSync(o.images).filter((f) => f.endsWith('.vsix')).sort()) {
    const set = /core-data/.test(vsix) ? 'core' : /extra-data/.test(vsix) ? 'extra' : null;
    if (!set || existsSync(path.join(dir, `${set}.index.json`))) continue;
    for (const [n, bytes] of readZip(readFileSync(path.join(o.images, vsix)))) {
      if (n === `extension/data/${set}.data` || n === `extension/data/${set}.index.json`) writeFileSync(path.join(dir, n.slice('extension/data/'.length)), bytes);
      if (n === 'extension/package.json') writeFileSync(path.join(dir, `${set}.package.json`), bytes);
    }
  }
  if (!existsSync(path.join(dir, 'core.index.json'))) throw new Error(`no core-data package in ${o.images}`);
  return dir;
}

/** The image's files (path without the leading "/" -> bytes) and its index. */
async function readImage(dataPath, indexPath) {
  const { openImage } = await import('./lib/image-files.mjs');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const img = openImage(dataPath, index.compressed);
  return { index, files: new Map(index.metadata.files.map((f) => [f.filename.replace(/^\//, ''), img.read(f.start, f.end)])) };
}

/** fmtutil.cnf's lines for pdflatex and xelatex: { name, engine, options, mode }. */
function fmtutilFormats(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (!m || line.trim().startsWith('#')) continue;
    out.push({ name: m[1], engine: m[2], patterns: m[3], options: m[4].trim(), mode: true });
  }
  return out;
}

/** The engine host's assets for one side. */
function assetsFor(side, images, imageDir) {
  const engineDir = path.join(root, 'engine');
  const common = { cnfOverride: path.join(engineDir, 'texmf-override.cnf'), fontsConf: path.join(engineDir, 'fonts.conf') };
  if (side.busytex) {
    const pins = JSON.parse(readFileSync(path.join(engineDir, 'pins.json'), 'utf8'));
    const tl = pins.sources.find((s) => s.files?.some((f) => f.name === 'busytex.wasm'));
    const assets = path.resolve(root, '..', 'engine_assets');
    return { ...common, glue: path.join(assets, 'derived', tl.patchedGlue.sha256.slice(0, 16), 'busytex.patched.js'), wasm: path.join(assets, tl.folder, 'busytex.wasm'), data: path.join(images, 'core.data'), loader: path.join(images, 'core.index.json') };
  }
  return { ...common, glue: path.join(side.dir, 'engine.js'), wasm: path.join(side.dir, 'engine.wasm'), data: path.join(imageDir ?? images, 'core.data'), loader: path.join(imageDir ?? images, 'core.index.json') };
}

async function startHost(assets) {
  const { EngineHost } = require(path.join(root, 'out', 'src', 'extension', 'engineHostClient.js'));
  const host = new EngineHost({ modulePath: path.join(root, 'dist', 'engine-host.js'), requestTimeoutMs: 3600000 });
  await host.start();
  await host.init(assets, 600000);
  return host;
}

/**
 * The formats of one engine build, and the image with them in place (<work>/<label>/core.data). Kept from an earlier
 * run when the engine's SHA-256 is the same.
 */
async function imageWithFormats(side, images, work) {
  const dir = path.join(work, side.label);
  mkdirSync(dir, { recursive: true });
  const engineSha = sha256(readFileSync(path.join(side.dir, 'engine.wasm')));
  const stamp = path.join(dir, 'formats.json');
  if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).engineSha256 === engineSha) return { dir, ...JSON.parse(readFileSync(stamp, 'utf8')) };
  const original = await readImage(path.join(images, 'core.data'), path.join(images, 'core.index.json'));
  const fmtutil = original.files.get('texlive/texmf-dist/web2c/fmtutil.cnf');
  if (!fmtutil) throw new Error('the core image has no texmf-dist/web2c/fmtutil.cnf');
  const host = await startHost({ ...assetsFor(side, images, null), data: path.join(images, 'core.data'), loader: path.join(images, 'core.index.json') });
  const t0 = performance.now();
  let made;
  try {
    const { buildFormats } = await import('./lib/bundle-engine.mjs');
    made = await buildFormats(host, fmtutilFormats(fmtutil.toString('utf8')));
  } finally {
    await host.stop?.();
  }
  const ms = Math.round(performance.now() - t0);
  const files = new Map(original.files);
  const record = { engineSha256: engineSha, ms, formats: {} };
  for (const [rel, bytes] of made.formats) {
    const key = `texlive/texmf-dist/${rel}`;
    if (!files.has(key)) throw new Error(`the image has no ${key} to replace`);
    files.set(key, bytes);
    record.formats[path.basename(rel)] = { bytes: bytes.length, sha256: sha256(bytes), log: made.logs[path.basename(rel, '.fmt')]?.split('\n').filter((l) => /^(Beginning to dump|Hyphenation trie|.*strings of total length|.*words of font info|\d+ hyphenation exception)/.test(l)) };
  }
  const { buildDataImage } = await import('./lib/data-image.mjs');
  const built = buildDataImage(files, { compress: true, strictNames: false });
  if (original.index.metadata.packed) built.index.metadata.packed = original.index.metadata.packed;
  writeFileSync(path.join(dir, 'core.data'), built.data);
  writeFileSync(path.join(dir, 'core.index.json'), JSON.stringify(built.index));
  writeFileSync(stamp, `${JSON.stringify(record, null, 1)}\n`);
  return { dir, ...record };
}

// ---- the documents ----

function walkFiles(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(path.join(dir, r)).isDirectory()) out.push(...walkFiles(dir, r));
    else if (!/\.(bundle\.log|log|aux|pdf\.out|synctex(\.gz)?|fls|bbl|blg|xdv)$/i.test(name) || /^fig/.test(name)) out.push(r);
  }
  return out;
}

const CASES = {
  X1: {
    engine: 'xelatex',
    main: 'xe.tex',
    files: {
      'xe.tex': [
        '\\documentclass{article}',
        '\\usepackage{fontspec}',
        '\\setmainfont{texgyrepagella-regular.otf}[BoldFont=texgyrepagella-bold.otf, ItalicFont=texgyrepagella-italic.otf]',
        '\\setsansfont{texgyreheros-regular.otf}',
        '\\setmonofont{lmmono10-regular.otf}',
        '\\begin{document}',
        '\\section{XeLaTeX on the new engine}',
        'Text in \\textbf{TeX Gyre Pagella}, \\textit{its italic}, \\textsf{TeX Gyre Heros} and \\texttt{Latin Modern Mono}; accents: äöü ß é ł ő ř.',
        'Mathematics: $\\int_0^1 x^2\\,dx = \\frac{1}{3}$ and $\\sum_{k=1}^n k = \\frac{n(n+1)}{2}$, as \\cite{knuth84} sets it.',
        '\\bibliographystyle{plain}',
        '\\bibliography{refs}',
        '\\end{document}',
        '',
      ].join('\n'),
      'refs.bib': '@book{knuth84, author = {Donald E. Knuth}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}\n',
    },
  },
  X2: {
    engine: 'pdflatex',
    main: 'shell.tex',
    shellEscape: true,
    files: { 'shell.tex': ['\\documentclass{article}', '\\begin{document}', `\\immediate\\write18{touch ${MARKER}}`, 'Shell escape forced on: \\verb|\\write18| reaches the engine\'s stub.', '\\end{document}', ''].join('\n') },
  },
  X3: {
    engine: 'pdflatex',
    main: 'pipe.tex',
    shellEscape: true,
    files: { 'pipe.tex': ['\\documentclass{article}', '\\begin{document}', 'Before.', `\\input|"touch ${MARKER}"`, 'After.', '\\end{document}', ''].join('\n') },
  },
};

/** The data build's log of a corpus document (<main>.bundle.log, today's engine), whose error lines B is compared with when A is not run. */
function bundleLog(folder, main) {
  const f = path.join(folder, main.replace(/\.tex$/i, '.bundle.log'));
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

function documents(o) {
  const docs = [];
  if (o.corpus) {
    const bundle = JSON.parse(readFileSync(path.join(o.corpus, 'corpus-bundle.json'), 'utf8'));
    for (const [id, d] of Object.entries(bundle.documents)) {
      const folder = path.join(o.corpus, d.folder);
      docs.push({ id, engine: d.engine, main: d.main, folder, files: walkFiles(folder).map((rel) => ({ path: rel, data: readFileSync(path.join(folder, rel)) })), bundlePages: d.pages, bundleLog: bundleLog(folder, d.main) });
    }
  }
  for (const [id, c] of Object.entries(CASES)) {
    docs.push({ id, engine: c.engine, main: c.main, shellEscape: c.shellEscape === true, files: Object.entries(c.files).map(([p, text]) => ({ path: p, data: Buffer.from(text, 'utf8') })) });
  }
  return o.only ? docs.filter((d) => o.only.split(',').includes(d.id)) : docs;
}

// ---- one compile and what it shows ----

async function pdfFacts(pdf) {
  if (!pdf) return { pages: null, fonts: null };
  const { PDFDocument, PDFDict, PDFName } = require('pdf-lib');
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const fonts = { FontFile: 0, FontFile2: 0, FontFile3: 0 };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') {
      for (const k of Object.keys(fonts)) if (obj.get(PDFName.of(k))) fonts[k]++;
    }
  }
  return { pages: doc.getPageCount(), fonts };
}

/** The PDF without what changes from run to run (dates, ID, subset tags, lengths), its streams inflated. */
function normalized(pdf) {
  const text = Buffer.from(pdf).toString('latin1');
  const inflated = text.replace(/(\/FlateDecode[^]*?stream\r?\n)([^]*?)(\r?\nendstream)/g, (all, head, body, tail) => {
    try {
      return `${head}${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}${tail}`;
    } catch {
      return all;
    }
  });
  return inflated
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '')
    .replace(/\/ID\s*\[\s*<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\]/g, '')
    .replace(/\/Length \d+/g, '')
    .replace(/\b[A-Z]{6}\+/g, '');
}

const errorLines = (log) => [...new Set((log ?? '').split('\n').filter((l) => /^! /.test(l) || /^[^\s:]+\.(tex|sty|cls|bib|aux|bbl):\d+: /.test(l)).map((l) => l.trim()))];

let nextId = 1;
async function compileOn(host, doc, extra) {
  const t0 = performance.now();
  const result = await host.compile({
    id: nextId++,
    main: doc.main,
    files: doc.files.map((f) => ({ path: f.path, data: new Uint8Array(f.data) })),
    engine: doc.engine,
    bibtex: 'auto',
    maxPasses: 4,
    synctex: true,
    ...(doc.shellEscape ? { forceShellEscape: true } : {}),
    ...(extra ? { dataImages: [extra], knownImages: [`${extra.id}@${extra.version}#${extra.sha256}`] } : {}),
    // The client's default limit is 10 minutes; a loaded machine needs more.
  }, 4 * 3600 * 1000);
  const ms = Math.round(performance.now() - t0);
  const facts = await pdfFacts(result.pdf);
  return {
    ok: Boolean(result.ok),
    error: result.error ?? null,
    ms,
    pages: facts.pages,
    fonts: facts.fonts,
    synctexBytes: result.synctex ? result.synctex.length : 0,
    passes: result.passes,
    // The worker's own times: boot, instantiate, mount, the tools' runs, and whether a standby worker took the job.
    timings: result.timings ?? null,
    bibtexRan: result.bibtexRan,
    steps: (result.steps ?? []).map((s) => ({ program: s.argv[0], exit: s.exitCode, ms: s.ms, heapMiB: Math.round(s.heapBytes / 2 ** 20) })),
    errors: errorLines(result.log),
    pdf: result.pdf ? { sha256: sha256(result.pdf), normalized: sha256(Buffer.from(normalized(result.pdf), 'latin1')) } : null,
  };
}

async function main() {
  const o = options(process.argv.slice(2));
  mkdirSync(o.work, { recursive: true });
  const images = await unpackImages(o);
  const extra = !o.noExtra && existsSync(path.join(images, 'extra.index.json'))
    ? { id: 'livemd2tex-extra-data', version: 'shakedown', sha256: sha256(readFileSync(path.join(images, 'extra.data'))), data: path.join(images, 'extra.data'), index: path.join(images, 'extra.index.json') }
    : null;
  const sides = [];
  if (o.a) sides.push(o.a === 'busytex' ? { label: 'A', busytex: true, name: 'busytex (engine/pins.json)' } : { label: 'A', dir: path.resolve(o.a), name: path.basename(path.resolve(o.a)) });
  sides.push({ label: 'B', dir: path.resolve(o.b), name: path.basename(path.resolve(o.b)) });
  for (const side of sides) {
    if (side.busytex) continue;
    side.engine = { wasmSha256: sha256(readFileSync(path.join(side.dir, 'engine.wasm'))), glueSha256: sha256(readFileSync(path.join(side.dir, 'engine.js'))) };
    const f = await imageWithFormats(side, images, o.work);
    side.imageDir = f.dir;
    side.formats = { ms: f.ms, files: f.formats };
    console.log(`${side.label}: formats made in ${f.ms} ms: ${Object.entries(f.formats).map(([n, x]) => `${n} ${x.bytes} bytes`).join(', ')}`);
  }
  for (const side of sides) side.host = await startHost(assetsFor(side, images, side.imageDir));
  const docs = documents(o);
  const reference = o.reference ? JSON.parse(readFileSync(o.reference, 'utf8')).documents : {};
  const marker = path.resolve(process.cwd(), MARKER);
  const results = {};
  try {
    for (let round = 0; round < o.rounds; round++) {
      for (const doc of docs) {
        const order = round % 2 === 0 ? sides : [...sides].reverse();
        for (const side of order) {
          rmSync(marker, { force: true });
          const r = await compileOn(side.host, doc, extra);
          r.shellCommandRan = existsSync(marker);
          rmSync(marker, { force: true });
          ((results[doc.id] ??= {})[side.label] ??= []).push(r);
          // Kept after every compile, so a run cut short keeps what it measured.
          writeFileSync(path.join(o.work, 'shakedown.partial.json'), `${JSON.stringify(results, null, 1)}\n`);
          console.log(`round ${round + 1} ${doc.id} ${side.label}: ${r.ok ? 'ok' : 'FAILED'} ${r.pages ?? 'no'} page(s), ${r.ms} ms, steps ${r.steps.map((s) => `${s.program}:${s.exit}`).join(' ')}${r.errors.length ? `, ${r.errors.length} error line(s)` : ''}`);
        }
      }
    }
  } finally {
    for (const side of sides) await side.host?.stop?.();
  }

  // The verdicts. B is the build under test; A, when given, is what it is compared with.
  const problems = [];
  const summary = [];
  for (const doc of docs) {
    const b = results[doc.id].B;
    const a = results[doc.id].A ?? null;
    const first = b[0];
    const line = { id: doc.id, engine: doc.engine, pagesB: first.pages, pagesA: a ? a[0].pages : undefined, bundlePages: doc.bundlePages, referencePages: reference[doc.id]?.pages, fontsB: first.fonts, synctexB: first.synctexBytes > 0, errorsB: first.errors, errorsOnlyB: a ? first.errors.filter((e) => !a[0].errors.includes(e)) : doc.bundleLog !== null && doc.bundleLog !== undefined ? first.errors.filter((e) => !errorLines(doc.bundleLog).includes(e)) : undefined };
    if (doc.id === 'X3') {
      if (!first.errors.some((e) => /not found|can't find file/i.test(e))) problems.push(`${doc.id}: \\input| did not fail on B`);
    } else {
      if (!first.ok || first.pages === null) problems.push(`${doc.id}: no PDF on B (${first.error ?? 'no message'})`);
      if (first.synctexBytes === 0) problems.push(`${doc.id}: no SyncTeX on B`);
      if (first.fonts && first.fonts.FontFile + first.fonts.FontFile2 + first.fonts.FontFile3 === 0) problems.push(`${doc.id}: no embedded font on B`);
    }
    if (b.some((r) => r.shellCommandRan) || (a && a.some((r) => r.shellCommandRan && !doc.shellEscape))) problems.push(`${doc.id}: a shell command ran`);
    if (doc.bundlePages !== undefined && first.pages !== doc.bundlePages) problems.push(`${doc.id}: ${first.pages} page(s) on B, ${doc.bundlePages} in the data build's corpus run`);
    if (reference[doc.id] && first.pages !== reference[doc.id].pages) problems.push(`${doc.id}: ${first.pages} page(s) on B, ${reference[doc.id].pages} on TeX Live`);
    if (a && a[0].pages !== first.pages && doc.id !== 'X3') problems.push(`${doc.id}: ${a[0].pages} page(s) on A, ${first.pages} on B`);
    if (line.errorsOnlyB?.length) problems.push(`${doc.id}: error lines on B only: ${line.errorsOnlyB.join(' | ')}`);
    if (doc.id === 'X1' && first.fonts && first.fonts.FontFile3 + first.fonts.FontFile2 === 0) problems.push('X1: xdvipdfmx embedded no OpenType font');
    if (a) {
      const same = (k) => b.every((r) => r.pdf && a.every((x) => x.pdf && x.pdf[k] === r.pdf[k]));
      line.pdfSameBytes = same('sha256');
      line.pdfSameNormalized = same('normalized');
    }
    const med = (xs) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    line.msB = med(b.map((r) => r.ms));
    if (a) line.msA = med(a.map((r) => r.ms));
    line.peakMiBB = Math.max(...b.flatMap((r) => r.steps.map((s) => s.heapMiB)));
    if (a) line.peakMiBA = Math.max(...a.flatMap((r) => r.steps.map((s) => s.heapMiB)));
    summary.push(line);
  }
  const report = {
    about: 'scripts/engine-shakedown.mjs: real LaTeX through the extension\'s engine host on a data set\'s core image (docs/DEVELOPING.md, "The TeX engine: our own build").',
    sides: sides.map((s) => ({ label: s.label, name: s.name, busytex: s.busytex === true, engine: s.engine, formats: s.formats })),
    rounds: o.rounds,
    documents: summary,
    runs: results,
    problems,
    pass: problems.length === 0,
  };
  writeFileSync(path.join(o.work, 'shakedown.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const l of summary) {
    console.log(`${l.id} (${l.engine}): B ${l.pagesB ?? 'no'} page(s)${l.pagesA !== undefined ? `, A ${l.pagesA ?? 'no'}` : ''}${l.bundlePages !== undefined ? `, data build ${l.bundlePages}` : ''}${l.referencePages !== undefined ? `, TeX Live ${l.referencePages}` : ''}; fonts ${JSON.stringify(l.fontsB)}; SyncTeX ${l.synctexB ? 'yes' : 'no'}; ${l.msB} ms${l.msA !== undefined ? ` (A ${l.msA} ms)` : ''}; peak ${l.peakMiBB} MiB${l.peakMiBA !== undefined ? ` (A ${l.peakMiBA})` : ''}${l.pdfSameBytes !== undefined ? `; PDF ${l.pdfSameBytes ? 'same bytes' : l.pdfSameNormalized ? 'same once dates and IDs are set aside' : 'differs'}` : ''}`);
  }
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(problems.length === 0 ? 'engine-shakedown: every check passed' : `engine-shakedown: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  }
}
