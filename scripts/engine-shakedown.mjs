#!/usr/bin/env node
// The LaTeX shake-down of an engine build, and the paired measure of two builds (for example another optimisation
// level against the shipped one). It runs real LaTeX through the extension's own route: each job is prepared by the extension's compile
// pipeline (out/src/extension/compile/pipeline.js, prepareCompile, with the core and add-on data sets installed),
// and run by its engine host (dist/engine-host.js, with the client compiled to out/ by tsc, as
// scripts/lib/bundle-engine.mjs does), on a data set's core image:
//   1. for each engine build given as a folder (engine.js, engine.wasm): pdflatex.fmt and xelatex.fmt made by that
//      engine from the image's own fmtutil.cnf lines (scripts/lib/bundle-engine.mjs, buildFormats), and a copy of
//      the image with those two formats in place of the image's own (the worker loads the formats from the image);
//   2. each document compiled as the extension compiles it: the worker's own steps (-recorder, -synctex=1,
//      -file-line-error, bibtex8 when the .aux asks for it, the extra passes, xdvipdfmx after XeLaTeX), the add-on
//      image mounted only when the preamble scan needs one of its packages, and once more after a "not found" names
//      one of its files (imagesForNotFound), as the extension does (that second compile starts without the first's
//      state, and the document's time covers both); on A and B in turn, compile by compile, the order alternating
//      from one round to the next;
//   3. for each compile: the page count, the error lines and the font warnings (missing characters, undefined font
//      shapes), the fonts embedded (FontFile, FontFile2, FontFile3 in the PDF), whether SyncTeX was written, the
//      steps' exit codes and times, and the WebAssembly memory size after each step; whether A's and B's PDFs are
//      the same bytes, and the same once dates, IDs and subset tags are set aside;
//   4. the corpus documents' page counts against the data build's (corpus-bundle.json, today's engine) and TeX
//      Live's (corpus-reference.json), when given.
// A and B are each "busytex" (today's engine, engine/pins.json's build, with the image as it is) or an engine
// folder. Without --a only B runs.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/engine-shakedown.mjs --b busytex|ENGINE_DIR [--a busytex|ENGINE_DIR] --images DIR --work DIR
//        [--corpus DIR] [--reference FILE] [--rounds N] [--only ID,ID] [--extra auto|always|never] [--host DIR]
//
//   --images DIR     the data packages (livemd2tex-core-data-*.vsix, and livemd2tex-extra-data-*.vsix, which is
//                    installed as the add-on)
//   --corpus DIR     a materialized corpus (the bundle workflow's bundle-corpus artifact: corpus-bundle.json and
//                    corpus/<id>/...)
//   --reference FILE TeX Live's page counts (the bundle workflow's corpus-reference.json)
//   --extra MODE     auto (default): the add-on is mounted when the extension would mount it; always: for every
//                    compile (to measure the add-on's own cost); never: the add-on is not installed
//   --host DIR       the repository whose engine host, compiled pipeline and texmf.cnf run the jobs (default this
//                    one; its dist/ and out/ must be built)
//   --rounds N       compiles of each document on each side (default 1; a speed comparison uses more)
//   --work DIR       the unpacked images, the images with each build's formats, the cases and the report
//                    (shakedown.json); outside the repository
//
// The cases the harness adds (in <work>/cases): a XeLaTeX document with OpenType fonts by file name, mathematics and
// a bibliography (bibtex8 and xdvipdfmx), and two pdfLaTeX documents with shell escape forced on, one with \write18
// and one with \input|, whose commands must reach the engine's stubs and run nothing. For \write18 (X2) the log must
// show runsystem(...)...executed, which TeX prints whenever it calls system(), and the file the command would make
// must not appear, and on B the transcript must show "system returned with code -1": \write18 reached system(),
// which ran nothing and refused the command, as our stub does. Today's engine's system() answers the same, so this
// does not tell the two apart: that our stub is the system() linked is shown by the build's import checks.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The repository whose host and pipeline run the jobs (--host). */
let hostRoot = root;
const require = createRequire(import.meta.url);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const MARKER = 'livemd2tex-shakedown-shell-escape-ran';

function options(argv) {
  const o = { rounds: 1, extra: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (['a', 'b', 'images', 'work', 'corpus', 'reference', 'rounds', 'only', 'extra', 'host'].includes(k)) o[k] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  for (const k of ['b', 'images', 'work']) if (!o[k]) throw new Error(`--${k} is required`);
  if (!['auto', 'always', 'never'].includes(o.extra)) throw new Error('--extra is auto, always or never');
  o.rounds = Number(o.rounds);
  return o;
}

/**
 * The data packages' data folders, unpacked once into <work>/images/<set>/data (core, extra): the image, its index,
 * the manifest and the package index, as the extension reads them.
 */
async function unpackImages(o) {
  const { readZip } = await import('./lib/zip.mjs');
  const dir = path.join(o.work, 'images');
  for (const vsix of readdirSync(o.images).filter((f) => f.endsWith('.vsix')).sort()) {
    const set = /core-data/.test(vsix) ? 'core' : /extra-data/.test(vsix) ? 'extra' : null;
    if (!set || existsSync(path.join(dir, set, 'data', 'manifest.json'))) continue;
    for (const [n, bytes] of readZip(readFileSync(path.join(o.images, vsix)))) {
      if (!n.startsWith('extension/data/') || n.endsWith('/')) continue;
      const out = path.join(dir, set, 'data', ...n.slice('extension/data/'.length).split('/'));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }
  }
  if (!existsSync(path.join(dir, 'core', 'data', 'manifest.json'))) throw new Error(`no core-data package in ${o.images}`);
  return dir;
}

/** The core image's two files: the data and its index, as the core's manifest names them. */
function coreImage(images) {
  const m = JSON.parse(readFileSync(path.join(images, 'core', 'data', 'manifest.json'), 'utf8'));
  return { data: path.join(images, 'core', 'data', m.image.file), index: path.join(images, 'core', 'data', m.image.index) };
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
  const engineDir = path.join(hostRoot, 'engine');
  const common = { cnfOverride: path.join(engineDir, 'texmf-override.cnf'), fontsConf: path.join(engineDir, 'fonts.conf') };
  const core = coreImage(images);
  if (side.busytex) {
    const pins = JSON.parse(readFileSync(path.join(engineDir, 'pins.json'), 'utf8'));
    const tl = pins.sources.find((x) => x.files?.some((f) => f.name === 'busytex.wasm'));
    const assets = path.resolve(hostRoot, '..', 'engine_assets');
    return { ...common, glue: path.join(assets, 'derived', tl.patchedGlue.sha256.slice(0, 16), 'busytex.patched.js'), wasm: path.join(assets, tl.folder, 'busytex.wasm'), data: core.data, loader: core.index };
  }
  const data = imageDir ? path.join(imageDir, 'core.data') : core.data;
  const loader = imageDir ? path.join(imageDir, 'core.index.json') : core.index;
  return { ...common, glue: path.join(side.dir, 'engine.js'), wasm: path.join(side.dir, 'engine.wasm'), data, loader };
}

async function startHost(assets) {
  const { EngineHost } = require(path.join(hostRoot, 'out', 'src', 'extension', 'engineHostClient.js'));
  const host = new EngineHost({ modulePath: path.join(hostRoot, 'dist', 'engine-host.js'), requestTimeoutMs: 3600000 });
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
  const core = coreImage(images);
  const original = await readImage(core.data, core.index);
  const fmtutil = original.files.get('texlive/texmf-dist/web2c/fmtutil.cnf');
  if (!fmtutil) throw new Error('the core image has no texmf-dist/web2c/fmtutil.cnf');
  const host = await startHost(assetsFor(side, images, null));
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

/** The data build's log of a corpus document (<main>.bundle.log, today's engine), which B is compared with when A is not run. */
function bundleLog(folder, main) {
  const f = path.join(folder, main.replace(/\.tex$/i, '.bundle.log'));
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** The documents, each a folder the pipeline reads as a project: the corpus's, and the cases written into <work>/cases. */
function documents(o) {
  const docs = [];
  if (o.corpus) {
    const bundle = JSON.parse(readFileSync(path.join(o.corpus, 'corpus-bundle.json'), 'utf8'));
    for (const [id, d] of Object.entries(bundle.documents)) {
      const folder = path.join(o.corpus, d.folder);
      docs.push({ id, engine: d.engine, main: d.main, folder, bundlePages: d.pages, bundleLog: bundleLog(folder, d.main) });
    }
  }
  for (const [id, c] of Object.entries(CASES)) {
    const folder = path.join(o.work, 'cases', id);
    for (const [name, text] of Object.entries(c.files)) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, name), text);
    }
    docs.push({ id, engine: c.engine, main: c.main, folder, shellEscape: c.shellEscape === true });
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
/** Font warnings: a character the font lacks, a font shape LaTeX had to replace. */
const warningLines = (log) => [...new Set((log ?? '').split('\n').filter((l) => /Missing character: There is no|Font shape .* undefined/.test(l)).map((l) => l.trim()))];

let nextId = 1;
let pipeline = null;

/** The extension's compile pipeline and data sets, from the host repository's out/ (tsc's output). */
function loadPipeline(images, mode) {
  const p = require(path.join(hostRoot, 'out', 'src', 'extension', 'compile', 'pipeline.js'));
  const d = require(path.join(hostRoot, 'out', 'src', 'extension', 'engine', 'dataSets.js'));
  const { nodeFs } = require(path.join(hostRoot, 'out', 'test', 'support', 'nodeFs.js'));
  const { EXTRA_DATA_NAME } = require(path.join(hostRoot, 'out', 'src', 'shared', 'identity.js'));
  return { p, d, nodeFs, EXTRA_DATA_NAME, images, mode };
}

async function packagesOf(pl) {
  const core = await pl.d.readCoreData(path.join(pl.images, 'core', 'data'));
  if (!core) throw new Error('the core data cannot be read');
  let installed = [];
  if (pl.mode !== 'never' && existsSync(path.join(pl.images, 'extra', 'data', 'manifest.json'))) {
    const extra = await pl.d.readDataExtension(path.join(pl.images, 'extra'), pl.EXTRA_DATA_NAME, { texLive: core.manifest.texLive, abi: core.manifest.abi, snapshot: core.manifest.snapshot });
    if ('problem' in extra) throw new Error(extra.problem);
    installed = [extra];
  }
  return pl.d.packageContext({ index: core.index, elsewhere: core.elsewhere }, installed);
}

/** One document as the extension compiles it: prepared by the pipeline, the add-on mounted when it would be. */
async function compileOn(host, doc, packages) {
  const prepare = (mountSets) => pipeline.p.prepareCompile({ fs: pipeline.nodeFs(doc.folder), mainRel: doc.main, engineSetting: doc.engine, packages, ...(mountSets ? { mountSets } : {}) });
  const run = async (prepared) => {
    const job = { ...prepared.job, id: nextId++, ...(doc.shellEscape ? { forceShellEscape: true } : {}) };
    if (pipeline.mode === 'always') {
      job.dataImages = packages.installed.flatMap((i) => ('image' in i ? [i.image] : []));
    }
    // The client's default limit is 10 minutes; a loaded machine needs more.
    return host.compile(job, 4 * 3600 * 1000);
  };
  const t0 = performance.now();
  let prepared = await prepare(null);
  let result = await run(prepared);
  let mountedAfterNotFound = [];
  if (pipeline.mode === 'auto') {
    const more = pipeline.p.imagesForNotFound(result, prepared);
    if (more.length > 0) {
      mountedAfterNotFound = more;
      prepared = await prepare(new Set(more));
      result = await run(prepared);
    }
  }
  const ms = Math.round(performance.now() - t0);
  const facts = await pdfFacts(result.pdf);
  return {
    ok: Boolean(result.ok),
    error: result.error ?? null,
    ms,
    engine: prepared.job.engine,
    addOnMounted: pipeline.mode === 'always' || (prepared.job.dataImages ?? []).length > 0,
    mountedAfterNotFound,
    pages: facts.pages,
    fonts: facts.fonts,
    synctexBytes: result.synctex ? result.synctex.length : 0,
    passes: result.passes,
    // The worker's own times: boot, instantiate, mount, the tools' runs, and whether a standby worker took the job.
    timings: result.timings ?? null,
    bibtexRan: result.bibtexRan,
    // memMiB: the WebAssembly memory's size after each step (the engine's memory, not the process's).
    steps: (result.steps ?? []).map((st) => ({ program: st.argv[0], exit: st.exitCode, ms: st.ms, memMiB: Math.round(st.heapBytes / 2 ** 20) })),
    errors: errorLines(result.log),
    warnings: warningLines(result.log),
    runsystem: ((result.log ?? '').match(/runsystem\([^\n]*?\)\.\.\.[a-z ]+/g) ?? []).slice(0, 5),
    // What system() returned, as TeX prints it on stderr (the worker's transcript).
    systemReturned: ((result.transcript ?? '').match(/system returned with code -?\d+/g) ?? []).slice(0, 5),
    pdf: result.pdf ? { sha256: sha256(result.pdf), normalized: sha256(Buffer.from(normalized(result.pdf), 'latin1')) } : null,
  };
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o.host) hostRoot = path.resolve(o.host);
  mkdirSync(o.work, { recursive: true });
  const images = await unpackImages(o);
  pipeline = loadPipeline(images, o.extra);
  const packages = await packagesOf(pipeline);
  const sideOf = (label, v) => (v === 'busytex' ? { label, busytex: true, name: 'busytex (engine/pins.json)' } : { label, dir: path.resolve(v), name: path.basename(path.resolve(v)) });
  const sides = [];
  if (o.a) sides.push(sideOf('A', o.a));
  sides.push(sideOf('B', o.b));
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
          const r = await compileOn(side.host, doc, packages);
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
    const line = { id: doc.id, engine: first.engine, addOnMounted: first.addOnMounted, mountedAfterNotFound: first.mountedAfterNotFound, pagesB: first.pages, pagesA: a ? a[0].pages : undefined, bundlePages: doc.bundlePages, referencePages: reference[doc.id]?.pages, fontsB: first.fonts, synctexB: first.synctexBytes > 0, errorsB: first.errors, errorsOnlyB: a ? first.errors.filter((e) => !a[0].errors.includes(e)) : doc.bundleLog !== null && doc.bundleLog !== undefined ? first.errors.filter((e) => !errorLines(doc.bundleLog).includes(e)) : undefined, warningsB: first.warnings, warningsOnlyB: a ? first.warnings.filter((w) => !a[0].warnings.includes(w)) : doc.bundleLog !== null && doc.bundleLog !== undefined ? first.warnings.filter((w) => !warningLines(doc.bundleLog).includes(w)) : undefined };
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
    if (line.warningsOnlyB?.length) problems.push(`${doc.id}: font warnings on B only: ${line.warningsOnlyB.join(' | ')}`);
    // The positive control of the stubs: with shell escape on, \write18 reached system() (TeX's "executed"), which
    // ran nothing (no marker, checked above) and answered -1, as our stub does.
    if (doc.id === 'X2' && !first.runsystem.some((r) => /^runsystem\(touch [^)]*\)\.\.\.executed/.test(r))) problems.push('X2: the log shows no runsystem(touch ...)...executed: \\write18 did not reach system()');
    if (doc.id === 'X2' && !first.systemReturned.includes('system returned with code -1')) problems.push(`X2: the transcript does not show "system returned with code -1" (${first.systemReturned.join(' | ') || 'nothing'}): system() did not refuse the command`);
    if (doc.id === 'X1' && first.fonts && first.fonts.FontFile3 + first.fonts.FontFile2 === 0) problems.push('X1: xdvipdfmx embedded no OpenType font');
    if (a) {
      const same = (k) => b.every((r) => r.pdf && a.every((x) => x.pdf && x.pdf[k] === r.pdf[k]));
      line.pdfSameBytes = same('sha256');
      line.pdfSameNormalized = same('normalized');
    }
    const med = (xs) => xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    line.msB = med(b.map((r) => r.ms));
    if (a) line.msA = med(a.map((r) => r.ms));
    line.memMiBB = Math.max(...b.flatMap((r) => r.steps.map((st) => st.memMiB)));
    if (a) line.memMiBA = Math.max(...a.flatMap((r) => r.steps.map((st) => st.memMiB)));
    summary.push(line);
  }
  const report = {
    about: 'scripts/engine-shakedown.mjs: real LaTeX through the extension\'s engine host on a data set\'s core image (docs/DEVELOPING.md, "The TeX engine: our own build").',
    sides: sides.map((x) => ({ label: x.label, name: x.name, busytex: x.busytex === true, engine: x.engine, formats: x.formats })),
    rounds: o.rounds,
    extra: o.extra,
    documents: summary,
    runs: results,
    problems,
    pass: problems.length === 0,
  };
  writeFileSync(path.join(o.work, 'shakedown.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const l of summary) {
    console.log(`${l.id} (${l.engine}): B ${l.pagesB ?? 'no'} page(s)${l.pagesA !== undefined ? `, A ${l.pagesA ?? 'no'}` : ''}${l.bundlePages !== undefined ? `, data build ${l.bundlePages}` : ''}${l.referencePages !== undefined ? `, TeX Live ${l.referencePages}` : ''}; fonts ${JSON.stringify(l.fontsB)}; SyncTeX ${l.synctexB ? 'yes' : 'no'}; ${l.msB} ms${l.msA !== undefined ? ` (A ${l.msA} ms)` : ''}; wasm memory ${l.memMiBB} MiB${l.memMiBA !== undefined ? ` (A ${l.memMiBA})` : ''}${l.addOnMounted ? '; add-on mounted' : ''}${l.pdfSameBytes !== undefined ? `; PDF ${l.pdfSameBytes ? 'same bytes' : l.pdfSameNormalized ? 'same once dates and IDs are set aside' : 'differs'}` : ''}`);
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
