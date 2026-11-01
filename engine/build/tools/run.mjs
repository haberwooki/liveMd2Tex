#!/usr/bin/env node
// engine/build/tools/run.mjs: the smoke test of a freshly built engine (docs/DEVELOPING.md, "The TeX engine: our own
// build").
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node run.mjs OUT [--fonts DIR] [--thai-font FILE]
//     OUT holds engine.js and engine.wasm; DIR holds DejaVuSans.ttf (default: the pinned CTAN DejaVu set,
//     ../engine_assets/ctan-dejavu/truetype); FILE is a font with Thai glyphs (Loma.otf of TeX Live's fonts-tlwg),
//     for the ICU line-break case, which is left out without it
//
// The cases include \write18 and \input| with shell escape forced, which must reach our stubs and run
// nothing; an error run followed by a normal run in the same instance; ICU's Thai line breaking and one ICU
// converter (\XeTeXinputencoding); and TeX's own recursion limit in a worker thread with the stack the engine host
// gives its workers (stackSizeMb 16), with the default stack recorded beside it.
//
// Everything runs in one Emscripten instance, as the engine host does (src/engine-host/engine/worker.ts): the
// first 64 MiB of memory are saved after start-up, and after every program run the whole memory is cleared and
// those 64 MiB are written back (BusyTeX's one-instance pattern, as worker.ts:495-517 does it). Every case must
// exit 0 and print its expected text; the run fails otherwise.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const HEADER_BYTES = 2 ** 26;
const here = path.dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = { dir: null, fonts: path.resolve(here, '../../../../engine_assets/ctan-dejavu/truetype'), thai: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fonts') out.fonts = argv[++i];
    else if (argv[i] === '--thai-font') out.thai = argv[++i];
    else out.dir = argv[i];
  }
  return out;
}

const TEXMF_CNF = [
  '% A minimal texmf.cnf for the smoke test: the project folder only, no shell escape, no mktex*.',
  'TEXMFCNF = /engine/cnf',
  'TEXINPUTS = .',
  'TEXFONTS = .',
  'OPENTYPEFONTS = /fonts',
  'TTFONTS = /fonts',
  'shell_escape = f',
  'openout_any = p',
  'openin_any = a',
  '',
].join('\n');

// One line of the stand-in's list (engine/build/fontlist/fontlist.c): path, index, families, styles, full names,
// PostScript name, weight, width, slant.
const DEJAVU_LINE = ['/fonts/DejaVuSans.ttf', '0', 'DejaVu Sans', 'Book', 'DejaVu Sans', 'DejaVuSans', '80', '100', '0'].join('\t');

// TeX's recursion limit (expand_depth, 10,000 by default: pdftex.ch, setup_bound_var) in a worker thread, as the
// engine host runs the engine: V8's machine stack, set per worker, bounds the depth WebAssembly can reach, not
// Emscripten's STACK_SIZE. With enough stack TeX stops the macro itself.
const RECURSION_TEX = ['\\catcode`\\{=1 \\catcode`\\}=2', '\\def\\a{\\romannumeral\\a}\\a', '\\end', ''].join('\n');

async function recursionInWorker(dir, stackSizeMb) {
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { recursion: true, dir }, ...(stackSizeMb ? { resourceLimits: { stackSizeMb } } : {}) });
  return new Promise((resolve) => {
    worker.once('message', (m) => {
      worker.terminate();
      resolve(m);
    });
    worker.once('error', (e) => resolve({ code: null, text: `(worker error: ${e})` }));
  });
}

async function recursionWorkerMain({ dir }) {
  const gluePath = path.resolve(dir, 'engine.js');
  const module = await WebAssembly.compile(readFileSync(path.resolve(dir, 'engine.wasm')));
  const lines = [];
  const M = await createRequire(gluePath)(gluePath)({
    thisProgram: '/bin/engine',
    noInitialRun: true,
    print: (l) => lines.push(l),
    printErr: (l) => lines.push(l),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(done);
      return {};
    },
    preRun: [(Mod) => Object.assign(Mod.ENV, { TEXMFCNF: '/engine/cnf', MKTEXTFM: '0', MKTEXFMT: '0', HOME: '/home/web_user' })],
  });
  M.FS.mkdirTree('/engine/cnf');
  M.FS.writeFile('/engine/cnf/texmf.cnf', TEXMF_CNF);
  M.FS.mkdirTree('/bin');
  M.FS.writeFile('/bin/engine', '');
  M.FS.mkdirTree('/project');
  M.FS.chdir('/project');
  M.FS.writeFile('/project/rec.tex', RECURSION_TEX);
  let code;
  try {
    code = M.callMain(['pdftex', '-ini', '-interaction=nonstopmode', 'rec.tex']);
  } catch (e) {
    lines.push(`(stopped: ${e})`);
    code = null;
  }
  parentPort.postMessage({ code, text: lines.join('\n') });
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.dir) {
    console.error('usage: run.mjs OUT [--fonts DIR]');
    return 2;
  }
  const gluePath = path.resolve(o.dir, 'engine.js');
  const wasmPath = path.resolve(o.dir, 'engine.wasm');
  const fontFile = path.join(o.fonts, 'DejaVuSans.ttf');
  if (!existsSync(fontFile)) {
    console.error(`run.mjs: ${fontFile} is missing`);
    return 2;
  }
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  const factory = createRequire(gluePath)(gluePath);
  let transcript = [];
  const print = (line) => transcript.push(line);
  const M = await factory({
    thisProgram: '/bin/engine',
    noInitialRun: true,
    print,
    printErr: print,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(done, (e) => print(`instantiate failed: ${e}`));
      return {};
    },
    preRun: [
      (Mod) => {
        Object.assign(Mod.ENV, {
          TEXMFCNF: '/engine/cnf',
          TEXMFLOG: '/tmp/texmf.log',
          MKTEXPK: '0',
          MKTEXTFM: '0',
          MKTEXMF: '0',
          MKTEXFMT: '0',
          MKTEXTEX: '0',
          shell_escape: 'f',
          HOME: '/home/web_user',
          // The stand-in reads this file at each XeTeX run; the cases below change the file, not the variable.
          LIVEMD2TEX_FONT_LIST: '/engine/fonts.list',
        });
      },
    ],
  });
  const FS = M.FS;
  FS.mkdirTree('/engine/cnf');
  FS.writeFile('/engine/cnf/texmf.cnf', TEXMF_CNF);
  FS.mkdirTree('/bin');
  FS.writeFile('/bin/engine', '');
  // Every font file of the set (the pinned CTAN DejaVu set has 12) and the stand-in's list of all their faces,
  // written by the data builder's list writer.
  FS.mkdirTree('/fonts');
  const { describeFile, listLine, orderFaces } = await import(new URL('../../../scripts/lib/font-list.mjs', import.meta.url).href);
  const faces = [];
  for (const name of readdirSync(o.fonts).filter((n) => /\.(otf|ttf|ttc)$/i.test(n)).sort()) {
    const bytes = readFileSync(path.join(o.fonts, name));
    FS.writeFile(`/fonts/${name}`, bytes);
    faces.push(...describeFile(bytes, `/fonts/${name}`).faces);
  }
  const fullList = `${orderFaces(faces).faces.map((f) => listLine(f)).join('\n')}\n`;
  // The font files each run opens (the speed planner's question: fontconfig made every XeTeX pass read every font
  // file of the image). Emscripten's open syscall goes through FS.open.
  const opened = new Set();
  const realOpen = FS.open;
  FS.open = function (p, ...rest) {
    const name = typeof p === 'string' ? p : String(p?.path ?? p);
    if (/\.(otf|ttf|ttc|pfb|woff2?)$/i.test(name)) opened.add(name);
    return realOpen.call(this, p, ...rest);
  };
  FS.mkdirTree('/project');
  FS.chdir('/project');
  FS.writeFile('/project/second.tex', '\\count1=42 \\message{[second file read]}\\relax\n');
  FS.writeFile(
    '/project/plain.tex',
    [
      '\\catcode`\\{=1 \\catcode`\\}=2 \\catcode`\\#=6',
      '\\input second',
      '\\immediate\\write16{[count1=\\the\\count1]}',
      '\\shipout\\hbox{\\vrule width 10pt height 10pt}',
      '\\end',
      '',
    ].join('\n'),
  );
  FS.writeFile(
    '/project/pdf.tex',
    ['\\catcode`\\{=1 \\catcode`\\}=2', '\\pdfoutput=1 \\pdfcompresslevel=0', '\\input second', '\\shipout\\hbox{\\vrule width 10pt height 10pt}', '\\end', ''].join('\n'),
  );
  FS.writeFile(
    '/project/big.tex',
    ['\\catcode`\\{=1 \\catcode`\\}=2', '\\immediate\\write16{[big memory run]}', '\\end', ''].join('\n'),
  );
  // Shell escape forced on (-shell-escape): \write18 reaches runsystem() and our system() stub, and \input| reaches
  // our popen() stub; neither may run anything. The command would create a file in the host's own folder, which
  // the case checks for afterwards.
  const markerName = 'livemd2tex-smoke-shell-escape-ran';
  const marker = path.resolve(process.cwd(), markerName);
  rmSync(marker, { force: true });
  FS.writeFile('/project/shell.tex', ['\\catcode`\\{=1 \\catcode`\\}=2', `\\immediate\\write18{touch ${markerName}}`, '\\immediate\\write16{[after write18]}', '\\end', ''].join('\n'));
  FS.writeFile('/project/pipe.tex', ['\\catcode`\\{=1 \\catcode`\\}=2', `\\input|"touch ${markerName}"`, '\\end', ''].join('\n'));
  // ICU: a converter from its data (windows-1253: byte 0xE1 is U+03B1, 945), and Thai line breaking, which needs
  // ICU's break rules and its Thai dictionary; with \XeTeXlinebreakskip fixed at 1pt each break ICU finds adds 1pt.
  // \XeTeXinputencoding takes effect from the next line read, so the byte is on the second line.
  FS.writeFile('/project/conv.tex', Buffer.concat([Buffer.from('\\catcode`\\{=1 \\catcode`\\}=2 \\XeTeXinputencoding "windows-1253"\n\\count1=`', 'latin1'), Buffer.from([0xe1]), Buffer.from('\\relax \\immediate\\write16{[code=\\the\\count1]}\n\\end\n', 'latin1')]));
  // XeTeX inserts its break glue in paragraphs only, so the case counts the lines of a narrow paragraph: Thai has no
  // spaces, and without ICU's break points the text cannot break at all.
  const THAI = 'ภาษาไทยเป็นภาษาที่ไม่มีการเว้นวรรคระหว่างคำ';
  const thaiBody = (locale) => `\\font\\t="[/fonts/thai.otf]" at 10pt \\XeTeXlinebreakskip=0pt plus 1pt \\hsize=30pt \\parindent=0pt ${locale ? '\\XeTeXlinebreaklocale "th"' : ''} \\setbox0\\vbox{\\t ${THAI}\\par \\xdef\\lines{\\the\\prevgraf}}\\immediate\\write16{[thai lines=\\lines]}`;
  if (o.thai) FS.writeFile('/fonts/thai.otf', readFileSync(o.thai));
  const xefont = (name, body) =>
    FS.writeFile(
      `/project/${name}.tex`,
      ['\\catcode`\\{=1 \\catcode`\\}=2', '\\XeTeXtracingfonts=1 \\suppressfontnotfounderror=1', body, '\\end', ''].join('\n'),
    );
  xefont(
    'xefile',
    '\\font\\x="[/fonts/DejaVuSans.ttf]" at 10pt \\immediate\\write16{[file: \\fontname\\x]}\\shipout\\hbox{\\x A}',
  );
  xefont(
    'xename',
    '\\font\\y="DejaVu Sans" at 10pt \\ifx\\y\\nullfont\\immediate\\write16{[name: none]}\\else\\immediate\\write16{[name: \\fontname\\y]}\\fi\\shipout\\hbox{\\y A}',
  );
  xefont('thai', thaiBody(true));
  xefont('thainone', thaiBody(false));
  xefont(
    'xenone',
    '\\font\\z="DejaVu Sans" at 10pt \\ifx\\z\\nullfont\\immediate\\write16{[name: none]}\\else\\immediate\\write16{[name: \\fontname\\z]}\\fi',
  );

  if (M.HEAPU8.length !== HEADER_BYTES) {
    console.error(`run.mjs: memory grew to ${M.HEAPU8.length} bytes during start-up; the 64 MiB header does not hold it`);
    return 1;
  }
  const header = M.HEAPU8.slice(0, HEADER_BYTES);

  const results = [];
  // Emscripten copies ENV into the C environment once, at start-up, inside the saved header; so, as in the
  // engine host, the environment is the same for every run, and a case changes files only (before()).
  const fontOpens = [];
  const step = (label, argv, before, expect, expectCode = 0) => {
    const program = argv[0];
    transcript = [];
    opened.clear();
    if (before) before();
    let code;
    const t = performance.now();
    try {
      code = M.callMain([...argv]);
    } catch (e) {
      transcript.push(`(stopped: ${e})`);
      code = -1;
    }
    M._flush_streams();
    const heap = M.HEAPU8.length;
    M.HEAPU8.fill(0);
    M.HEAPU8.set(header);
    const text = transcript.join('\n');
    const missing = expect.filter((e) => (e instanceof RegExp ? !e.test(text) : !text.includes(e)));
    const ok = code === expectCode && missing.length === 0;
    results.push({ label, ok, code, missing, heap, ms: Math.round(performance.now() - t) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} (exit ${code}, ${Math.round(performance.now() - t)} ms, memory ${(heap / 2 ** 20).toFixed(0)} MiB)`);
    if (program === 'xetex' && argv.length > 2) fontOpens.push({ label, files: [...opened].sort() });
    if (!ok) {
      for (const m of missing) console.log(`     missing: ${m}`);
      console.log(text.split('\n').map((l) => `     | ${l}`).join('\n'));
    }
    return { text, heap };
  };
  const exists = (p) => {
    try {
      FS.stat(p);
      return true;
    } catch {
      return false;
    }
  };

  const fontList = (text) => () => {
    if (text === null) {
      if (exists('/engine/fonts.list')) FS.unlink('/engine/fonts.list');
    } else FS.writeFile('/engine/fonts.list', text);
  };
  const cnf = (extra) => () => FS.writeFile('/engine/cnf/texmf.cnf', `${TEXMF_CNF}${extra}`);

  step('pdftex --version', ['pdftex', '--version'], null, [/pdfTeX 3\.\d+-[\d.]+-1\.40\.\d+ \(TeX Live 2026\/liveMd2Tex\)/]);
  step('xetex --version', ['xetex', '--version'], null, [/XeTeX 3\.\d+-[\d.]+-0\.\d+ \(TeX Live 2026\/liveMd2Tex\)/, 'fontconfig version 0.0.0']);
  step('xdvipdfmx --version', ['xdvipdfmx', '--version'], null, [/xdvipdfmx Version \d{8}/]);
  step('bibtex8 --version', ['bibtex8', '--version'], null, [/This is 8-bit Big BibTeX version 0\.99d/]);
  step('an unknown program exits 64', ['nosuch'], null, ['the first argument names the program'], 64);

  step('pdftex -ini, \\input, DVI', ['pdftex', '-ini', '-interaction=nonstopmode', 'plain.tex'], null, ['[second file read]', '[count1=42]', 'Output written on plain.dvi']);
  const logOk = exists('/project/plain.log') && FS.readFile('/project/plain.log', { encoding: 'utf8' }).includes('[second file read]');
  results.push({ label: 'pdftex wrote its log', ok: logOk });
  console.log(`${logOk ? 'ok  ' : 'FAIL'} pdftex wrote plain.log with the second file's message`);
  step('pdftex -ini, PDF', ['pdftex', '-ini', '-interaction=nonstopmode', 'pdf.tex'], null, ['[second file read]', 'Output written on pdf.pdf']);
  // Every run so far fits the 64 MiB header; memory never shrinks, so this run comes before the first XeTeX one,
  // which grows it for ICU's tables. pdfTeX with 12 million words of main memory must grow it, and the next run
  // must still work after the restore.
  const before = M.HEAPU8.length;
  const big = step('pdftex -ini with 12M words of main memory', ['pdftex', '-ini', '-interaction=nonstopmode', 'big.tex'], cnf('main_memory = 12000000\n'), ['[big memory run]']);
  const grew = before === HEADER_BYTES && big.heap > HEADER_BYTES;
  results.push({ label: 'memory grew past 64 MiB', ok: grew });
  console.log(`${grew ? 'ok  ' : 'FAIL'} the run grew memory from ${(before / 2 ** 20).toFixed(0)} MiB past 64 MiB (${(big.heap / 2 ** 20).toFixed(0)} MiB)`);
  step('pdftex -ini after the restore', ['pdftex', '-ini', '-interaction=nonstopmode', 'plain.tex'], cnf(''), ['[second file read]', '[count1=42]']);

  step('xetex -ini, \\input, XDV', ['xetex', '-ini', '-interaction=nonstopmode', '-no-pdf', 'plain.tex'], null, ['[second file read]', '[count1=42]', 'Output written on plain.xdv']);
  step('xdvipdfmx', ['xdvipdfmx', '-o', 'plain.pdf', 'plain.xdv'], null, ['plain.xdv -> plain.pdf']);
  const pdfHead = exists('/project/plain.pdf') ? Buffer.from(FS.readFile('/project/plain.pdf').subarray(0, 5)).toString('latin1') : '';
  results.push({ label: 'xdvipdfmx wrote a PDF', ok: pdfHead === '%PDF-' });
  console.log(`${pdfHead === '%PDF-' ? 'ok  ' : 'FAIL'} xdvipdfmx wrote plain.pdf (${pdfHead})`);

  const xe = (file) => ['xetex', '-ini', '-etex', '-interaction=nonstopmode', '-no-pdf', file];
  step('xetex, font by file name', xe('xefile.tex'), fontList(null), ['[file: "[/fonts/DejaVuSans.ttf]"']);
  step('xetex, font by family name, one-line list', xe('xename.tex'), fontList(`${DEJAVU_LINE}\n`), ['[name: "DejaVu Sans"']);
  step('xetex, family name, no list file', xe('xenone.tex'), fontList(null), ['[name: none]']);
  step('xetex, family name, empty list', xe('xenone.tex'), fontList(''), ['[name: none]']);
  step('xetex, family name, list after the empty one', xe('xename.tex'), fontList(`${DEJAVU_LINE}\n`), ['[name: "DejaVu Sans"']);
  step(`xetex, font by family name, the list of all ${faces.length} faces`, xe('xename.tex'), fontList(fullList), ['[name: "DejaVu Sans"']);
  step(`xetex, font by file name, the list of all ${faces.length} faces`, xe('xefile.tex'), fontList(fullList), ['[file: "[/fonts/DejaVuSans.ttf]"']);
  step(`xetex, no native font, the list of all ${faces.length} faces`, ['xetex', '-ini', '-interaction=nonstopmode', '-no-pdf', 'plain.tex'], fontList(fullList), ['Output written on plain.xdv']);

  // Shell escape forced through the stubs, an error run, then a normal run in the same instance.
  step('pdftex -shell-escape, \\write18 reaches the system() stub', ['pdftex', '-ini', '-shell-escape', '-interaction=nonstopmode', 'shell.tex'], null, ['[after write18]']);
  // TeX writes the runsystem line to the log only.
  const shellLog = exists('/project/shell.log') ? FS.readFile('/project/shell.log', { encoding: 'utf8' }) : '';
  const called = /runsystem\(touch [^)]*\)\.\.\.executed/.test(shellLog);
  results.push({ label: 'runsystem called system()', ok: called });
  console.log(`${called ? 'ok  ' : 'FAIL'} shell.log shows runsystem(...)...executed: the call reached system(), which is our stub`);
  step('pdftex -shell-escape, \\input| reaches the popen() stub and fails', ['pdftex', '-ini', '-shell-escape', '-interaction=nonstopmode', 'pipe.tex'], null, [/I can't find file|Emergency stop/], 1);
  const ran = existsSync(marker);
  rmSync(marker, { force: true });
  results.push({ label: 'no shell command ran', ok: !ran });
  console.log(`${ran ? 'FAIL' : 'ok  '} no shell command ran (the marker file ${ran ? 'exists' : 'is absent'})`);
  step('pdftex after an error run in the same instance', ['pdftex', '-ini', '-interaction=nonstopmode', 'plain.tex'], null, ['[second file read]', '[count1=42]']);
  step('xetex, an ICU converter (\\XeTeXinputencoding "windows-1253")', xe('conv.tex'), null, ['[code=945]']);
  if (o.thai) {
    const withBreaks = step('xetex, ICU Thai line breaking (\\XeTeXlinebreaklocale "th")', xe('thai.tex'), fontList(null), [/\[thai lines=([2-9]|\d\d+)\]/]);
    step('xetex, the same Thai text without the locale stays one line', xe('thainone.tex'), fontList(null), ['[thai lines=1]']);
    console.log(`     Thai: ${/\[thai lines=(\d+)\]/.exec(withBreaks.text)?.[1] ?? '?'} lines at 30pt with the locale, 1 without`);
  } else console.log('note: no --thai-font, so the ICU Thai line-break case is left out');

  // TeX's own recursion limit in a worker thread: with the engine host's stack it ends with TeX's message; with
  // Node's default stack, at -Oz, pdfTeX's V8 stack runs out first (recorded; another level may differ).
  const deep = await recursionInWorker(o.dir, 16);
  const deepOk = /TeX capacity exceeded, sorry \[expansion depth=10000\]/.test(deep.text) && !/RangeError/.test(deep.text);
  results.push({ label: 'recursion in a worker with a 16 MB stack ends with TeX\'s message', ok: deepOk });
  console.log(`${deepOk ? 'ok  ' : 'FAIL'} recursion in a worker (stackSizeMb 16): exit ${deep.code}, ${deepOk ? "TeX's capacity message" : deep.text.split('\n').slice(-3).join(' | ')}`);
  const shallow = await recursionInWorker(o.dir, null);
  console.log(`note recursion in a worker with Node's default stack: ${/RangeError|Maximum call stack/.test(shallow.text) ? 'V8 stack exhausted (RangeError)' : /capacity exceeded/.test(shallow.text) ? "TeX's capacity message" : `exit ${shallow.code}`}`);

  console.log(`font files opened by each XeTeX run (${faces.length} faces in /fonts):`);
  for (const f of fontOpens) console.log(`     ${String(f.files.length).padStart(2)}  ${f.label}${f.files.length ? `: ${f.files.join(' ')}` : ''}`);

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `run.mjs: all ${results.length} cases passed` : `run.mjs: ${failed.length} of ${results.length} cases failed`);
  return failed.length === 0 ? 0 : 1;
}

if (!isMainThread && workerData?.recursion) await recursionWorkerMain(workerData);
else process.exitCode = await main();
