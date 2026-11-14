#!/usr/bin/env node
// Compares two builds of the extension's TeX engine on the same documents (the comparison before an engine switch; kept for every
// later engine change). Each side is a worktree of this repository with its own dist/ (the engine, its worker, its
// glue and its data staged by scripts/stage-engine.mjs) and its own compiled out/ (npm run compile). The tool starts
// each side's engine host through that side's own EngineService, compiles every document with the same job (the
// side's own pipeline decides the engine, the package scan and the passes; bibtex 'auto'; SOURCE_DATE_EPOCH=1700000000
// and FORCE_SOURCE_DATE=1 in the worker's environment), and compares what comes back.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/engine-diff.mjs --old-host DIR --new-host DIR --docs LIST[,LIST] --out DIR [--old-extra DIR --new-extra DIR]
//                                [--only ID,ID] [--quiet-timing N]
//   node scripts/engine-diff.mjs --new-host DIR --make-docs DIR [--private-docs FILE --presets DIR] --out DIR
//   node scripts/engine-diff.mjs --old-host DIR --new-host DIR --banners --out DIR
//   node scripts/engine-diff.mjs --old-host DIR --new-host DIR --formats --out DIR
//
// --old-extra, --new-extra: a side's Extra Packages add-on as an unpacked package folder (the one with data/); each
//   side reads it as the extension reads an installed add-on. Without one, a side has the core data alone.
// --docs: JSON files, each a list of documents { id, kind: 'tex' | 'md', folder, main, private?, options?, note? }.
//   A document with "private": true is compared by numbers and SHA-256 hashes only: its record holds no file name,
//   no log line and no text, and its files are never written to --out. "note" marks an expected difference (its
//   reason is printed beside the difference). An md document may carry "mode", "overrides", "appendix" and
//   "presetDir" (the converter's preset); "forceShellEscape" and "readBack" go into the job as they are.
// --make-docs: writes the public corpus (P1 to P8, the Markdown corpus, the multi-root pair, the safety fixtures
//   and the error fixtures) as project folders under DIR, with a list file, using --new-host's engine for docstrip.
//   --private-docs FILE makes the private list from .private-fixtures.json (T1 to T8b) at FILE, outside any
//   repository; it holds paths and so is never printed or committed.
// --formats: the -ini runs of pdflatex.fmt and xelatex.fmt on both sides (fmtutil's own command lines, from each
//   side's core image) and the counts each dump prints.
// --banners: the --version output of pdftex, xetex, xdvipdfmx and bibtex8 on both sides.
// --quiet-timing N [--heap 1] [--rows R,R]: check 9 (and, with --heap, check 10's heapBytes) on both sides, A and B
//   alternating, N samples each (at least 9), with an A/A run in the same window and an idle-CPU check. --docs must
//   hold the public list and the private one (T1, T4). Run it only when the machine is otherwise idle.
//
// The report (report.md, report.json in --out) names both commits. It holds no path of either machine and, for a
// private document, no text: counts and hashes. Exit 0 when nothing differs that is not marked expected.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = fileURLToPath(import.meta.url);
const FIXED_ENV = { SOURCE_DATE_EPOCH: '1700000000', FORCE_SOURCE_DATE: '1' };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function args(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags.add(a.slice(2));
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function git(dir, ...a) {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '(unknown)';
}

// ---------------------------------------------------------------------------------------------------------------
// The driver: runs inside one worktree (cwd = the worktree, the unit-test stubs loaded) and writes its records.
// ---------------------------------------------------------------------------------------------------------------

const MASKS = [
  [/\/Producer\s*(\((?:\\.|[^)\\])*\)|<[0-9a-fA-F\s]*>)/g, '/Producer (-)'],
  [/\/Creator\s*(\((?:\\.|[^)\\])*\)|<[0-9a-fA-F\s]*>)/g, '/Creator (-)'],
  [/\/PTEX\.Fullbanner\s*(\((?:\\.|[^)\\])*\)|<[0-9a-fA-F\s]*>)/g, '/PTEX.Fullbanner (-)'],
  [/\/(CreationDate|ModDate)\s*(\((?:\\.|[^)\\])*\)|<[0-9a-fA-F\s]*>)/g, '/$1 (-)'],
  [/\/ID\s*\[[^\]]*\]/g, '/ID [-]'],
  [/<(xmp|pdf|xmpMM|pdfx):(CreateDate|ModifyDate|MetadataDate|Producer|CreatorTool|DocumentID|InstanceID)>[^<]*</g, '<$1:$2>-<'],
  [/(xmpMM:(?:DocumentID|InstanceID)=")[^"]*"/g, '$1-"'],
];
const mask = (text) => MASKS.reduce((t, [re, to]) => t.replace(re, to), text);

async function pdfFeatures(driverRequire, hostRoot, bytes) {
  const lib = driverRequire('pdf-lib');
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFNumber, decodePDFRawStream } = lib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const ctx = doc.context;
  const decoded = (stream) => {
    try {
      return Buffer.from(decodePDFRawStream(stream).decode());
    } catch {
      return Buffer.from(stream.getContents());
    }
  };
  // Normalised hash: every indirect object by number, strings and dates that name the producer masked; object and
  // cross-reference streams left out (their members are listed as objects of their own).
  const h = createHash('sha256');
  const objects = [...ctx.enumerateIndirectObjects()].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  for (const [ref, obj] of objects) {
    let text;
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) continue;
      const body = decoded(obj);
      const asText = type === PDFName.of('Metadata') ? mask(body.toString('latin1')) : null;
      text = `${mask(obj.dict.toString())}\nstream ${asText === null ? sha(body) : sha(asText)}`;
    } else {
      text = mask(obj.toString());
    }
    h.update(`${ref.objectNumber} ${text}\n`);
  }
  const normalised = h.digest('hex');
  const num = (x) => (x instanceof PDFNumber ? x.asNumber() : null);
  const rect = (arr) => (arr instanceof PDFArray ? arr.asArray().map((x) => num(ctx.lookup(x))) : null);
  const pages = [];
  for (const page of doc.getPages()) {
    const fonts = new Set();
    const images = new Set();
    const seen = new Set();
    const walkResources = (res) => {
      if (!(res instanceof PDFDict)) return;
      const fdict = ctx.lookupMaybe(res.get(PDFName.of('Font')), PDFDict);
      if (fdict) {
        for (const [key, value] of fdict.entries()) {
          const font = ctx.lookupMaybe(value, PDFDict);
          if (!font) continue;
          const base = String(font.get(PDFName.of('BaseFont')) ?? '');
          const desc = ctx.lookupMaybe(font.get(PDFName.of('DescendantFonts')), PDFArray);
          const inner = desc ? ctx.lookupMaybe(desc.get(0), PDFDict) : font;
          const fd = inner ? ctx.lookupMaybe(inner.get(PDFName.of('FontDescriptor')), PDFDict) : undefined;
          let fileHash = 'none';
          for (const k of ['FontFile', 'FontFile2', 'FontFile3']) {
            const s = fd ? ctx.lookup(fd.get(PDFName.of(k))) : undefined;
            if (s instanceof PDFRawStream) fileHash = sha(decoded(s));
          }
          fonts.add(`${String(key)}|${base}|${fileHash}`);
        }
      }
      const xdict = ctx.lookupMaybe(res.get(PDFName.of('XObject')), PDFDict);
      if (xdict) {
        for (const [, value] of xdict.entries()) {
          const key = value instanceof PDFRef ? value.objectNumber : -1;
          const xo = ctx.lookup(value);
          if (!(xo instanceof PDFRawStream) || seen.has(key)) continue;
          seen.add(key);
          const sub = String(xo.dict.get(PDFName.of('Subtype')) ?? '');
          if (sub === '/Image') images.add(`${num(xo.dict.get(PDFName.of('Width')))}x${num(xo.dict.get(PDFName.of('Height')))}|${sha(Buffer.from(xo.getContents()))}`);
          else if (sub === '/Form') walkResources(ctx.lookupMaybe(xo.dict.get(PDFName.of('Resources')), PDFDict));
        }
      }
    };
    walkResources(page.node.Resources() ?? page.node.Parent()?.Resources?.());
    const annots = [];
    const list = ctx.lookupMaybe(page.node.get(PDFName.of('Annots')), PDFArray);
    if (list) {
      for (const a of list.asArray()) {
        const d = ctx.lookupMaybe(a, PDFDict);
        if (d) annots.push(rect(ctx.lookup(d.get(PDFName.of('Rect')))));
      }
    }
    const box = (b) => [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 1000) / 1000);
    pages.push({ media: box(page.getMediaBox()), crop: box(page.getCropBox()), fonts: [...fonts].sort(), images: [...images].sort(), annots: annots.length, annotRects: sha(JSON.stringify(annots)) });
  }
  // The text layer, as the viewer's pdf.js reads it.
  const build = path.join(hostRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build');
  const pdfjs = await import(pathToFileURL(path.join(build, 'pdf.mjs')).href);
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(build, 'pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
  const pdf = await task.promise;
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    pages[p - 1].text = sha(content.items.map((i) => (typeof i.str === 'string' ? i.str + (i.hasEOL ? '\n' : '') : '')).join(''));
  }
  await task.destroy();
  return { normalised, pages };
}

/** The tool each step ran, and the warning and error lines of xdvipdfmx and bibtex8 in the transcript. */
function toolWarnings(transcript) {
  const out = [];
  let tool = '';
  for (const line of transcript.split('\n')) {
    if (line.startsWith('$ ')) {
      tool = line.slice(2).split(' ')[0];
      continue;
    }
    if ((tool === 'xdvipdfmx' || tool === 'bibtex8') && /warn|error|couldn't|^\*\*\*|^---/i.test(line)) out.push(`${tool}: ${line.trim()}`);
  }
  return out;
}

// The log without its banner line and without the two figures the banner text moves: the byte count of the output
// (the PDF's /Producer is the banner) and the string pool's characters (the banner is in the pool), and epstopdf's
// line with the wall-clock time of the in-memory file it converts.
const logBody = (log) =>
  log
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/^(\(epstopdf\) +date: ).*$/, '$1-').replace(/^( *)\d+ string characters out of \d+$/, '$1N string characters out of M').replace(/^(Output written on .*\(\d+ pages?), \d+ bytes\)\.$/, '$1, N bytes).'))
    .join('\n');
const hashOf = (xs) => sha(JSON.stringify(xs));

async function driver(a) {
  const host = path.resolve(a.host);
  process.chdir(host);
  const req = createRequire(path.join(host, 'package.json'));
  const mod = (rel) => req(path.join(host, 'out', rel));
  const { EngineService, bundledEngineAssets } = mod('src/extension/engine/engineService.js');
  const { prepareCompile } = mod('src/extension/compile/pipeline.js');
  const dataSets = mod('src/extension/engine/dataSets.js');
  const support = mod('test/engine/support.js');
  const { nodeFs } = mod('test/support/nodeFs.js');
  const route = mod('test/engine/markdownRoute.js');
  const mode = a.driver;

  process.env.LIVEMD2TEX_DIFF_ENV = JSON.stringify(FIXED_ENV);
  const assets = () => {
    const found = bundledEngineAssets(host);
    return found ? { ...found, env: FIXED_ENV } : null;
  };
  const makeService = () => {
    const service = new EngineService({ modulePath: path.join(host, 'dist', 'engine-host.js'), assets, idleMinutes: () => 0, log: () => undefined });
    service.execArgv = ['--require', path.join(host, 'test', 'stubs', 'register-engine-host.cjs')];
    const compile = service.compile.bind(service);
    service.compile = (job, project) => compile({ ...job, returnNewFiles: true }, project);
    return service;
  };
  const packages = async () => {
    const core = await dataSets.readCoreData(path.join(host, 'dist', 'data'));
    if (!core) return undefined;
    const installed = [];
    if (a.extra) {
      const { EXTRA_DATA_NAME } = mod('src/shared/identity.js');
      const extra = await dataSets.readDataExtension(path.resolve(a.extra), EXTRA_DATA_NAME, { texLive: core.manifest.texLive, abi: core.manifest.abi });
      if (!('image' in extra)) throw new Error(`the add-on: ${extra.problem}`);
      installed.push(extra);
    }
    return dataSets.packageContext(core, installed);
  };
  const docs = (a.docs ?? '').split(',').filter(Boolean).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
  const only = a.only ? new Set(a.only.split(',')) : null;

  const options = (d) => {
    if (!d.mode) return { appendix: d.appendix ? readFileSync(d.appendix, 'utf8') : undefined };
    const { presetFolder } = mod('test/converter/support.js');
    const { resolveMode } = mod('src/converter/preset/load.js');
    const { preset, files } = presetFolder(d.presetDir);
    const own = d.overrides ? JSON.parse(readFileSync(d.overrides, 'utf8')) : {};
    const resolved = resolveMode(preset, d.mode, files, { ...own, ...(d.extra ?? {}) });
    return { preset: resolved.mode, appendix: d.appendix ? readFileSync(d.appendix, 'utf8') : undefined };
  };

  if (mode === 'make-docs') {
    const target = path.resolve(a.out);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const service = makeService();
    try {
      const { docstripWith } = mod('test/support/prepareV0Workspace.js');
      const { materializeCorpus } = mod('test/support/corpusProjects.js');
      const projects = (await materializeCorpus(path.join(target, 'corpus'), docstripWith(service), { includePrivate: false })).map((p) => ({
        id: p.id,
        kind: p.main.endsWith('.md') ? 'md' : 'tex',
        folder: p.folder,
        main: p.main,
      }));
      const fixtures = path.join(host, 'test', 'engine', 'fixtures');
      for (const f of readdirSync(fixtures).filter((n) => n.endsWith('.tex'))) {
        const folder = path.join(target, 'fixtures', f.replace(/\.tex$/, ''));
        mkdirSync(folder, { recursive: true });
        cpSync(path.join(fixtures, f), path.join(folder, f));
        if (f === 'eps.tex') cpSync(path.join(fixtures, 'square.eps'), path.join(folder, 'square.eps'));
        const forced = /^(write18|input-pipe|output-pipe)$/.test(f.replace(/\.tex$/, ''));
        projects.push({ id: `fixture-${f.replace(/\.tex$/, '')}`, kind: 'tex', folder, main: f });
        if (forced) projects.push({ id: `fixture-${f.replace(/\.tex$/, '')}-forced`, kind: 'tex', folder, main: f, options: { forceShellEscape: true } });
      }
      const errors = path.join(host, 'test', 'fixtures', 'tex-errors');
      for (const base of [errors, path.join(errors, 'variants')]) {
        for (const f of readdirSync(base).filter((n) => n.endsWith('.tex'))) {
          const folder = path.join(target, 'tex-errors', f.replace(/\.tex$/, ''));
          mkdirSync(folder, { recursive: true });
          cpSync(path.join(base, f), path.join(folder, f));
          projects.push({ id: `error-${f.replace(/\.tex$/, '')}`, kind: 'tex', folder, main: f });
        }
      }
      writeFileSync(path.join(target, 'docs-public.json'), `${JSON.stringify(projects, null, 2)}\n`);
      console.log(`public list: ${projects.length} documents`);
      if (a['private-docs']) {
        const cfgFile = path.join(host, '.private-fixtures.json');
        const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
        const base = path.resolve(host, cfg.root);
        const list = [];
        for (const [id, f] of Object.entries(cfg.fixtures)) {
          const main = path.resolve(base, f.main);
          const entry = { id, kind: f.kind === 'md' ? 'md' : 'tex', private: true, folder: path.dirname(main), main: path.basename(main) };
          if (f.kind === 'md' && f.mode) {
            entry.mode = f.mode;
            entry.presetDir = path.resolve(a.presets);
            if (f.overrides) entry.overrides = path.resolve(base, f.overrides);
          }
          if (f.appendix) entry.appendix = path.resolve(base, f.appendix);
          if (id === 'T5') entry.only = path.basename(main);
          list.push(entry);
          if (id === 'T7') list.push({ ...entry, id: 'T7-notes-shown', extra: { notes: { show: true } } });
        }
        writeFileSync(a['private-docs'], `${JSON.stringify(list, null, 2)}\n`);
        console.log(`private list: ${list.length} documents`);
      }
    } finally {
      await service.stop();
    }
    return;
  }

  if (mode === 'banners') {
    const service = makeService();
    const outputs = {};
    try {
      for (const tool of ['pdftex', 'xetex', 'xdvipdfmx', 'bibtex8']) {
        const { result } = await service.compile({ id: 1, main: 'x.tex', files: [{ path: 'x.tex', data: new Uint8Array() }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false, steps: [[tool, '--version']] });
        outputs[tool] = { exitCode: result.steps[0]?.exitCode, text: result.transcript.split('\n').filter((l) => l && !l.startsWith('$ ')).join('\n') };
      }
    } finally {
      await service.stop();
    }
    writeFileSync(path.join(a.out, 'banners.json'), JSON.stringify(outputs, null, 2));
    return;
  }

  if (mode === 'formats') {
    // The -ini runs fmtutil makes (scripts/lib/bundle-engine.mjs, buildFormats), on this side's engine and the
    // fmtutil.cnf of this side's core image; the counts the format dump prints, in the order the log gives them.
    const { openImage } = await import(pathToFileURL(path.join(host, 'scripts', 'lib', 'image-files.mjs')).href);
    const ready = bundledEngineAssets(host);
    const index = JSON.parse(readFileSync(ready.index ?? ready.loader, 'utf8'));
    const entry = index.metadata.files.find((f) => f.filename.endsWith('/web2c/fmtutil.cnf'));
    const cnf = openImage(ready.data, index.compressed).read(entry.start, entry.end).toString('utf8');
    const service = makeService();
    const out = {};
    try {
      for (const name of ['pdflatex', 'xelatex']) {
        const line = cnf.split('\n').find((l) => l.startsWith(`${name} `));
        const [, engine, , ...options] = line.trim().split(/\s+/);
        const program = engine === 'pdftex' ? 'pdflatex' : engine === 'xetex' ? 'xelatex' : engine;
        const { result } = await service.compile({
          id: 1, main: 'job.tex', files: [{ path: 'job.tex', data: new TextEncoder().encode('\relax\n') }], engine: 'pdflatex', bibtex: 'never', maxPasses: 1, synctex: false,
          steps: [[program, '-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${name}`, `-progname=${name}`, ...options]], readBack: [`${name}.log`],
        });
        const log = result.readBack?.[`${name}.log`] ?? result.log;
        const at = log.split('\n').findIndex((l) => l.startsWith('Beginning to dump on file'));
        out[name] = { exitCode: result.steps[0]?.exitCode, line: line.trim(), dump: log.split('\n').slice(at).filter((l) => l.trim()), banner: log.split('\n')[0].replace(/\s+\d+ [A-Z]{3} \d{4} .*$/, '') };
      }
    } finally {
      await service.stop();
    }
    writeFileSync(path.join(a.out, 'formats.json'), JSON.stringify(out, null, 2));
    return;
  }

  const outDir = path.resolve(a.out);
  mkdirSync(outDir, { recursive: true });
  const scope = docs.filter((d) => !only || only.has(d.id));

  /** One document through this side's own route. */
  async function compileDoc(service, pkgs, d, extra = {}) {
    let fsx = nodeFs(d.folder);
    if (d.only) {
      // A document whose folder holds more than the document: the project is that one file.
      const whole = fsx;
      fsx = { ...whole, readDirectory: async (rel) => (await whole.readDirectory(rel)).filter(([name]) => rel !== '' || name === d.only) };
    }
    if (d.kind === 'md') {
      const text = readFileSync(path.join(d.folder, d.main), 'utf8');
      const t = await route.typesetMarkdown(service, fsx, d.main, text, { ...options(d), ...(d.options ?? {}) }, pkgs);
      return { prepared: t.prepared, result: t.result };
    }
    const prepared = await prepareCompile({ fs: fsx, mainRel: d.main, engineSetting: 'pdflatex', packages: pkgs, ...extra });
    const job = { ...prepared.job, ...(d.options ?? {}) };
    const { result } = await service.compile(job);
    return { prepared, result };
  }

  if (mode === 'sample') {
    // One sample of check 9's rows on a fresh host, and with --heap check 10's largest heapBytes per document.
    const pkgs = await packages();
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
    const rows = new Set((a.rows ?? 'hostStart,P1first,workerRestart,T1,T4,P6').split(','));
    const out = { rows: {}, t1: null, heapMB: {} };
    const service = makeService();
    try {
      const t0 = performance.now();
      await service.prepare();
      out.rows.hostStart = Math.round(performance.now() - t0);
      if (rows.has('P1first') || rows.has('workerRestart')) {
        const p1 = await compileDoc(service, pkgs, byId.P1);
        out.rows.P1first = p1.result.timings.totalMs;
        const p1b = await compileDoc(service, pkgs, byId.P1);
        out.rows.workerRestart = p1b.result.timings.totalMs;
      }
      if (rows.has('T1')) {
        // T1 needs nothing from the add-on, and side A (48d823e) searches a mounted add-on's folders on disk for every
        // lookup (the missing ls-R, fixed later): 25 s a pass instead of 1 s, with timings.warm true. So both sides run T1
        // on the core data alone.
        const core = await dataSets.readCoreData(path.join(host, 'dist', 'data'));
        const coreOnly = core ? dataSets.packageContext(core, []) : undefined;
        const full = await compileDoc(service, coreOnly, byId.T1);
        const quick = await prepareCompile({ fs: nodeFs(byId.T1.folder), mainRel: byId.T1.main, engineSetting: 'pdflatex', packages: coreOnly, pass: 'quick', previous: { aux: full.result.state, bibFingerprints: full.prepared.bibFingerprints } });
        const { result } = await service.compile(quick.job);
        out.rows.T1 = result.timings.totalMs;
        // Whether it was a warm pass, and where its time went (numbers only).
        out.t1 = { warm: result.timings.warm === true, timings: result.timings, steps: result.steps.map((st) => ({ tool: st.argv[0], ms: st.ms })), passes: result.passes, bibtexRan: result.bibtexRan, fullMs: full.result.timings.totalMs };
      }
      if (rows.has('T4')) out.rows.T4 = (await compileDoc(service, pkgs, byId.T4, { maxPasses: 3 })).result.timings.totalMs;
      if (rows.has('P6')) out.rows.P6 = (await compileDoc(service, pkgs, byId.P6)).result.timings.totalMs;
      if (a.heap) {
        for (const d of docs) {
          const r = await compileDoc(service, pkgs, d);
          out.heapMB[d.private ? `private:${sha(d.id).slice(0, 6)}` : d.id] = Math.round(Math.max(0, ...r.result.steps.map((st) => st.heapBytes)) / 1048576);
        }
      }
      const memory = await service.memory();
      out.maxRssMB = memory ? Math.round(memory.maxRss / 1048576) : null;
    } finally {
      await service.stop();
    }
    writeFileSync(path.join(outDir, 'sample.json'), JSON.stringify(out));
    return;
  }

  // mode === 'run'
  const pkgs = await packages();
  const service = makeService();
  const records = {};
  const t0 = performance.now();
  try {
    await service.prepare();
    const startMs = Math.round(performance.now() - t0);
    for (const d of scope) {
      let rec;
      try {
        const { prepared, result } = await compileDoc(service, pkgs, d);
        const analysis = support.analyse(result);
        const state = new Map(result.state.map((f) => [path.posix.basename(f.path), f.data]));
        const fresh = new Map((result.newFiles ?? []).map((f) => [path.posix.basename(f.path), f.data]));
        const file = (ext) => [...state, ...fresh].find(([n]) => n.endsWith(ext))?.[1];
        const synctex = result.synctex ? zlib.gunzipSync(Buffer.from(result.synctex)) : undefined;
        const hash = (b) => (b ? sha(Buffer.from(b)) : null);
        const errs = analysis.errors;
        const warns = toolWarnings(result.transcript);
        const missing = (prepared.packageScan?.missing ?? []).map((m) => m.file).sort();
        let pdf = null;
        if (result.pdf) pdf = await pdfFeatures(createRequire(path.join(host, 'package.json')), host, result.pdf);
        const memory = await service.memory();
        rec = {
          ok: result.ok,
          engine: prepared.job.engine,
          passes: result.passes,
          bibtexRan: result.bibtexRan,
          stepCodes: result.steps.map((s) => `${s.argv[0]}:${s.exitCode}`),
          pages: analysis.pages,
          pdfPages: pdf?.pages.length ?? null,
          missing: d.private ? { count: missing.length, hash: hashOf(missing) } : missing,
          errors: d.private ? { count: errs.length, hash: hashOf(errs) } : errs,
          fallbacks: d.private ? { count: analysis.fallbacks.length, hash: hashOf(analysis.fallbacks) } : analysis.fallbacks,
          undefinedRefs: analysis.undefinedRefs,
          mktex: analysis.mktex.length,
          toolWarnings: d.private ? { count: warns.length, hash: hashOf(warns) } : warns,
          stubsClean: !!result.stubs && result.stubs.blocked.length === 0 && result.stubs.allowedForks.length === 0,
          hashes: {
            aux: hash(file('.aux')),
            bbl: hash(file('.bbl')),
            xdv: hash(file('.xdv')),
            synctex: hash(synctex),
            log: sha(logBody(result.log)),
            pdfRaw: hash(result.pdf),
            pdfNormalised: pdf?.normalised ?? null,
          },
          sizes: { pdf: result.pdf?.length ?? 0, xdv: file('.xdv')?.length ?? 0, synctexRaw: synctex?.length ?? 0 },
          pageStructure: pdf ? pdf.pages : null,
          maxHeapMB: Math.round(Math.max(0, ...result.steps.map((s) => s.heapBytes)) / 1048576),
          rssMB: memory ? Math.round(memory.rss / 1048576) : null,
          maxRssMB: memory ? Math.round(memory.maxRss / 1048576) : null,
          totalMs: result.timings.totalMs,
          error: d.private ? undefined : result.error,
        };
        if (!d.private) {
          const dir = path.join(outDir, 'artifacts', d.id);
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, 'log.txt'), result.log);
          writeFileSync(path.join(dir, 'transcript.txt'), result.transcript);
          if (result.pdf) writeFileSync(path.join(dir, 'out.pdf'), result.pdf);
          for (const [n, data] of [...state, ...fresh]) if (/\.(aux|bbl|xdv)$/.test(n)) writeFileSync(path.join(dir, n), data);
          if (synctex) writeFileSync(path.join(dir, 'out.synctex'), synctex);
        }
      } catch (err) {
        rec = { ok: false, exception: d.private ? 'exception' : String(err instanceof Error ? err.message : err).slice(0, 400) };
      }
      records[d.id] = rec;
      process.stdout.write(`  ${d.private ? '(private)' : d.id}: ${rec.ok ? `${rec.pages} page(s)` : 'no PDF'}\n`);
    }
    writeFileSync(path.join(outDir, 'records.json'), JSON.stringify({ startMs, records }, null, 2));
  } finally {
    await service.stop();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The parent: starts a driver per side, compares, writes the report.
// ---------------------------------------------------------------------------------------------------------------

function runDriver(hostDir, mode, extra, addOn) {
  const argv = ['--require', path.join(hostDir, 'test', 'stubs', 'register-unit.cjs'), here, '--driver', mode, '--host', hostDir, ...extra, ...(addOn ? ['--extra', path.resolve(addOn)] : [])];
  const r = spawnSync(process.execPath, argv, { cwd: hostDir, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...FIXED_ENV }, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`the ${mode} driver for ${path.basename(hostDir)} exited with ${r.status}`);
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** The differences between two records of one document, grouped by the section-5 check they belong to. */
export function compareRecords(o, n) {
  const diffs = [];
  const add = (check, what, a, b) => diffs.push({ check, what, old: a, new: b });
  if (!o || !n) return [{ check: 4, what: 'record missing', old: !!o, new: !!n }];
  if (o.exception || n.exception) {
    if (!same(o.exception, n.exception)) add(4, 'exception', o.exception ?? null, n.exception ?? null);
    return diffs;
  }
  for (const k of ['ok', 'engine', 'passes', 'bibtexRan', 'stepCodes', 'pages', 'pdfPages', 'missing', 'errors', 'fallbacks', 'undefinedRefs', 'mktex', 'toolWarnings']) {
    if (!same(o[k], n[k])) add(4, k, o[k], n[k]);
  }
  for (const k of ['aux', 'bbl', 'xdv', 'synctex']) {
    if (o.hashes[k] !== n.hashes[k]) add(5, k, o.hashes[k], n.hashes[k]);
  }
  if (o.hashes.log !== n.hashes.log) add(5, 'log', o.hashes.log, n.hashes.log);
  if (o.hashes.pdfNormalised !== n.hashes.pdfNormalised) add(5, `pdf (${n.engine}), after normalising`, o.hashes.pdfNormalised, n.hashes.pdfNormalised);
  if (o.hashes.pdfNormalised !== n.hashes.pdfNormalised && o.pageStructure && n.pageStructure) {
    const pages = Math.max(o.pageStructure.length, n.pageStructure.length);
    for (let p = 0; p < pages; p++) {
      for (const k of ['media', 'crop', 'fonts', 'images', 'annots', 'annotRects', 'text']) {
        if (!same(o.pageStructure[p]?.[k], n.pageStructure[p]?.[k])) add(6, `page ${p + 1} ${k}`, o.pageStructure[p]?.[k] ?? null, n.pageStructure[p]?.[k] ?? null);
      }
    }
  }
  return diffs;
}

function renderReport(report) {
  const L = [];
  L.push('# Engine comparison', '');
  L.push(`Side A (old): ${report.old.commit} (${report.old.subject})${report.old.dirty ? ' + uncommitted changes' : ''}; branch ${report.old.branch}.`);
  L.push(`Side B (new): ${report.new.commit} (${report.new.subject})${report.new.dirty ? ' + uncommitted changes' : ''}; branch ${report.new.branch}.`);
  L.push(`Fixed dates: SOURCE_DATE_EPOCH=${FIXED_ENV.SOURCE_DATE_EPOCH}, FORCE_SOURCE_DATE=${FIXED_ENV.FORCE_SOURCE_DATE}. Documents: ${report.documents.length} (${report.documents.filter((d) => d.private).length} private: numbers and hashes only).`, '');
  L.push('| Document | Engine | Pages A / B | Differences | Unexplained |', '|---|---|---|---|---|');
  for (const d of report.documents) {
    const checks = [...new Set(d.diffs.map((x) => x.check))].sort().join(',');
    L.push(`| ${d.private ? `${d.id} (private)` : d.id} | ${d.engine ?? ''} | ${d.pagesOld ?? '-'} / ${d.pagesNew ?? '-'} | ${d.diffs.length === 0 ? 'none' : `${d.diffs.length} (checks ${checks})`} | ${d.diffs.length === 0 || d.note ? (d.note ? `expected: ${d.note}` : 'no') : 'yes'} |`);
  }
  L.push('', '## Differences', '');
  const withDiffs = report.documents.filter((d) => d.diffs.length > 0);
  if (withDiffs.length === 0) L.push('None.');
  for (const d of withDiffs) {
    L.push(`### ${d.private ? `${d.id} (private)` : d.id}${d.note ? ` (expected: ${d.note})` : ''}`, '');
    for (const x of d.diffs.slice(0, 40)) {
      const show = (v) => (d.private ? (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 12)}...` : typeof v === 'object' && v !== null && 'hash' in v ? `${v.count} item(s), ${v.hash.slice(0, 12)}...` : JSON.stringify(v)) : JSON.stringify(v)?.slice(0, 300));
      L.push(`- check ${x.check}, ${x.what}: A ${show(x.old)}; B ${show(x.new)}`);
    }
    if (d.diffs.length > 40) L.push(`- (${d.diffs.length - 40} more in report.json)`);
    L.push('');
  }
  L.push('## Summary', '', `Documents with a difference: ${withDiffs.length} of ${report.documents.length}; unexplained: ${report.unexplained}.`);
  return `${L.join('\n')}\n`;
}

function repoState(dir) {
  return { commit: git(dir, 'rev-parse', '--short=10', 'HEAD'), subject: git(dir, 'log', '-1', '--format=%s'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), dirty: git(dir, 'status', '--porcelain', '--', 'src', 'scripts', 'engine').length > 0 };
}

/** The mean idle share of the CPU over `seconds`, in percent (Windows' typeperf); null where it cannot be read. */
function idleShare(seconds) {
  const r = spawnSync('typeperf', ['\\Processor(_Total)\\% Idle Time', '-sc', String(seconds)], { encoding: 'utf8' });
  const values = (r.stdout ?? '').split('\n').map((l) => /^"[^"]*","([\d.]+)"/.exec(l.trim())?.[1]).filter(Boolean).map(Number);
  return values.length > 0 ? Math.round((values.reduce((x, y) => x + y, 0) / values.length) * 10) / 10 : null;
}

const spread = (xs) => (xs.length > 1 ? Math.round(((Math.max(...xs) - Math.min(...xs)) / median(xs)) * 1000) / 1000 : 0);
const ROWS = ['hostStart', 'P1first', 'workerRestart', 'T1', 'T4', 'P6'];

/**
 * Check 9 and the timed part of check 10, as the gate defines them: A and B alternate sample by sample (never all of
 * one side first), at least 9 samples each; an A/A run (A against a second copy of A's samples) in the same window
 * gives each row's noise band; every sample waits for an idle share of the CPU of at least 90 % (measured for 5 s
 * before it and after it) and is retaken, up to 3 times, if the machine was busy. Pass: B/A of the medians at most
 * 1.25 on every row. A sample of T1 whose timings.warm is false is not a T1 sample. With --heap the first sample of
 * each side also compiles every document for the largest heapBytes of any step (B within +10 % of A).
 */
function quietTiming(a, out, oldHost, newHost, docs) {
  const n = Math.max(9, Number(a['quiet-timing']));
  const sides = { A: oldHost, B: newHost, A2: oldHost };
  const extra = { A: a['old-extra'], B: a['new-extra'], A2: a['old-extra'] };
  const results = { A: [], B: [], A2: [] };
  const idle = [];
  const one = (side, index) => {
    const dir = path.join(out, 'samples', `${side}-${index}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      mkdirSync(dir, { recursive: true });
      const before = idleShare(5);
      runDriver(sides[side], 'sample', ['--docs', docs, '--out', dir, ...(a.heap && index === 0 ? ['--heap', '1'] : []), ...(a.rows ? ['--rows', a.rows] : [])], extra[side]);
      const after = idleShare(5);
      idle.push({ side, index, attempt, before, after });
      if ((before ?? 100) >= 90 && (after ?? 100) >= 90) return JSON.parse(readFileSync(path.join(dir, 'sample.json'), 'utf8'));
      console.log(`  sample ${side}-${index}: idle ${before}/${after} %, taken again`);
    }
    throw new Error(`the machine was not idle for ${side} sample ${index} in 3 tries`);
  };
  const startIdle = idleShare(30);
  for (let i = 0; i < n; i++) {
    // The order within a round turns each round: A, B, A2 and then A2, B, A.
    const round = i % 2 === 0 ? ['A', 'B', 'A2'] : ['A2', 'B', 'A'];
    for (const side of round) results[side].push(one(side, i));
    console.log(`round ${i + 1} of ${n} done`);
  }
  const rows = {};
  for (const row of a.rows ? a.rows.split(',') : ROWS) {
    const get = (side) => results[side].filter((r) => row !== 'T1' || r.t1?.warm).map((r) => r.rows[row]).filter((x) => x !== undefined);
    const A = get('A');
    const B = get('B');
    const A2 = get('A2');
    rows[row] = { samples: { A: A.length, B: B.length, A2: A2.length }, medianA: median(A), medianB: median(B), spreadA: spread(A), spreadB: spread(B), ratioBA: Math.round((median(B) / median(A)) * 1000) / 1000, ratioAA: Math.round((median(A2) / median(A)) * 1000) / 1000, spreadAA: spread([...A, ...A2]), A, B, A2 };
    rows[row].verdict = rows[row].ratioBA <= 1.25 ? 'pass' : rows[row].ratioBA - 1.25 <= rows[row].spreadAA ? 'rerun once (within the A/A spread)' : 'fail';
  }
  const t1 = (side) => results[side].map((r) => (r.t1 ? { warm: r.t1.warm, totalMs: r.t1.timings.totalMs, workerBootMs: r.t1.timings.workerBootMs, instantiateMs: r.t1.timings.instantiateMs, mountMs: r.t1.timings.mountMs, runMs: r.t1.timings.runMs, steps: r.t1.steps, fullMs: r.t1.fullMs } : null));
  const heap = {};
  const hA = results.A[0]?.heapMB ?? {};
  const hB = results.B[0]?.heapMB ?? {};
  for (const id of Object.keys(hA)) heap[id] = { A: hA[id], B: hB[id], ratio: hA[id] ? Math.round((hB[id] / hA[id]) * 1000) / 1000 : null, pass: hA[id] ? hB[id] / hA[id] <= 1.1 : true };
  const report = { old: repoState(oldHost), new: repoState(newHost), samples: n, startIdle, idle, rows, t1: { A: t1('A'), B: t1('B') }, heapMB: heap, maxRssMB: { A: Math.max(...results.A.map((r) => r.maxRssMB ?? 0)), B: Math.max(...results.B.map((r) => r.maxRssMB ?? 0)) } };
  writeFileSync(path.join(out, 'quiet-timing.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const [row, r] of Object.entries(rows)) console.log(`${row}: A ${r.medianA} ms, B ${r.medianB} ms, B/A ${r.ratioBA}, A/A ${r.ratioAA} (spread ${r.spreadAA}): ${r.verdict}`);
  const heapFail = Object.entries(heap).filter(([, h]) => !h.pass);
  console.log(`heap: ${Object.keys(heap).length} documents, ${heapFail.length} over +10 %`);
  process.exitCode = Object.values(rows).every((r) => r.verdict === 'pass') && heapFail.length === 0 ? 0 : 1;
  return undefined;
}

function main() {
  const a = args(process.argv.slice(2));
  if (a.driver) return driver(a);
  const out = path.resolve(a.out ?? '');
  if (!a.out) throw new Error('--out DIR is required');
  mkdirSync(out, { recursive: true });
  if (a['make-docs']) {
    const extra = ['--out', path.resolve(a['make-docs'])];
    if (a['private-docs']) extra.push('--private-docs', path.resolve(a['private-docs']), '--presets', path.resolve(a.presets));
    runDriver(path.resolve(a['new-host']), 'make-docs', extra);
    return undefined;
  }
  const oldHost = path.resolve(a['old-host']);
  const newHost = path.resolve(a['new-host']);
  if (a.flags.has('banners')) {
    for (const [side, host] of [['old', oldHost], ['new', newHost]]) {
      mkdirSync(path.join(out, side), { recursive: true });
      runDriver(host, 'banners', ['--out', path.join(out, side)]);
    }
    const b = Object.fromEntries(['old', 'new'].map((s) => [s, JSON.parse(readFileSync(path.join(out, s, 'banners.json'), 'utf8'))]));
    writeFileSync(path.join(out, 'banners.json'), JSON.stringify({ old: repoState(oldHost), new: repoState(newHost), banners: b }, null, 2));
    for (const tool of Object.keys(b.old)) console.log(`${tool}\n  A: ${b.old[tool].text.split('\n')[0]}\n  B: ${b.new[tool].text.split('\n')[0]}`);
    return undefined;
  }
  if (a.flags.has('formats')) {
    for (const [side, host] of [['old', oldHost], ['new', newHost]]) {
      mkdirSync(path.join(out, side), { recursive: true });
      runDriver(host, 'formats', ['--out', path.join(out, side)]);
    }
    const f = Object.fromEntries(['old', 'new'].map((s) => [s, JSON.parse(readFileSync(path.join(out, s, 'formats.json'), 'utf8'))]));
    const result = {};
    for (const name of Object.keys(f.old)) {
      const num = (x) => x.dump.map((l) => l.replace(/\d+(\.\d+)?/g, (n) => n));
      result[name] = { identical: same(num(f.old[name]), num(f.new[name])), old: f.old[name].dump, new: f.new[name].dump, oldBanner: f.old[name].banner, newBanner: f.new[name].banner };
    }
    writeFileSync(path.join(out, 'formats-report.json'), JSON.stringify({ old: repoState(oldHost), new: repoState(newHost), formats: result }, null, 2));
    for (const [name, r] of Object.entries(result)) {
      console.log(`${name}: dump lines identical: ${r.identical}`);
      r.old.forEach((l, i) => { if (l !== r.new[i]) console.log(`  A: ${l}\n  B: ${r.new[i]}`); });
    }
    return undefined;
  }
  const docs = String(a.docs ?? '').split(',').filter(Boolean).map((f) => path.resolve(f)).join(',');
  if (a['quiet-timing']) return quietTiming(a, out, oldHost, newHost, docs);
  for (const [side, host] of [['old', oldHost], ['new', newHost]]) {
    mkdirSync(path.join(out, side), { recursive: true });
    console.log(`side ${side}: ${path.basename(host)}`);
    runDriver(host, 'run', ['--docs', docs, '--out', path.join(out, side), ...(a.only ? ['--only', a.only] : [])], a[`${side}-extra`]);
  }
  const rec = Object.fromEntries(['old', 'new'].map((s) => [s, JSON.parse(readFileSync(path.join(out, s, 'records.json'), 'utf8'))]));
  const list = docs.split(',').filter(Boolean).flatMap((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((d) => !a.only || a.only.split(',').includes(d.id));
  const documents = list.map((d) => {
    const diffs = compareRecords(rec.old.records[d.id], rec.new.records[d.id]);
    return { id: d.id, private: !!d.private, note: d.note, engine: rec.new.records[d.id]?.engine, pagesOld: rec.old.records[d.id]?.pages, pagesNew: rec.new.records[d.id]?.pages, diffs };
  });
  const report = {
    old: repoState(oldHost),
    new: repoState(newHost),
    startMs: { old: rec.old.startMs, new: rec.new.startMs },
    documents,
    unexplained: documents.filter((d) => d.diffs.length > 0 && !d.note).length,
    memory: Object.fromEntries(['old', 'new'].map((s) => [s, { maxRssMB: Math.max(0, ...Object.values(rec[s].records).map((r) => r.maxRssMB ?? 0)), maxHeapMB: Object.fromEntries(Object.entries(rec[s].records).map(([k, r]) => [list.find((d) => d.id === k)?.private ? `private:${sha(k).slice(0, 6)}` : k, r.maxHeapMB ?? null])) }])),
  };
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(out, 'report.md'), renderReport(report));
  console.log(`report: ${documents.length} documents, ${documents.filter((d) => d.diffs.length).length} with a difference, ${report.unexplained} unexplained`);
  process.exitCode = report.unexplained === 0 ? 0 : 1;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve(main()).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
