// The steps of B1's builder that need the engine (docs/DESIGN.md#engine-and-data): the formats, made by the engine
// itself in initex mode from the new core tree; their cost in hyphenation patterns; and the closure test, in which
// every bundled LaTeX package loads alone in a minimal document. They run in the extension's own engine host
// (dist/engine-host.js, with the client compiled to out/ by tsc), so the builder starts no program but that one
// Node process (scripts/build-bundle.mjs refuses python and perl from its start).

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Starts `count` engine hosts on the given engine assets (the new core image as `data` and `loader`). */
export async function startEngines(root, assets, count) {
  const { EngineHost } = require(path.join(root, 'out', 'src', 'extension', 'engineHostClient.js'));
  const hosts = [];
  for (let i = 0; i < count; i++) {
    const host = new EngineHost({ modulePath: path.join(root, 'dist', 'engine-host.js'), requestTimeoutMs: 600000 });
    await host.start();
    await host.init(assets);
    hosts.push(host);
  }
  return hosts;
}

let nextJob = 1;
const enc = new TextEncoder();

/** One explicit run in a fresh project: returns the result (log, newFiles, error). */
async function run(host, steps, files = [], extra = {}) {
  return host.compile({
    id: nextJob++,
    main: 'job.tex',
    files: [{ path: 'job.tex', data: enc.encode('\\relax\n') }, ...files],
    engine: 'pdflatex',
    bibtex: 'never',
    maxPasses: 1,
    synctex: false,
    steps,
    returnNewFiles: true,
    ...extra,
  });
}

/**
 * The formats of the core: each AddFormat line wanted (pdflatex and xelatex; the worker's ENGINE_FORMATS), run as
 * fmtutil runs it: `<engine> -ini -jobname=<name> -progname=<name> <options>`, under the program name the engine
 * build uses for it. Returns texmf-var/web2c/<engine>/<name>.fmt -> bytes, and each run's log.
 */
export async function buildFormats(host, formats, wanted = ['pdflatex', 'xelatex'], files = []) {
  const out = new Map();
  const logs = {};
  for (const name of wanted) {
    const f = formats.find((x) => x.name === name && x.mode);
    if (!f) {
      throw new Error(`no enabled AddFormat line for ${name}`);
    }
    const options = f.options.split(/\s+/).filter(Boolean);
    const program = f.engine === 'pdftex' ? 'pdflatex' : f.engine === 'xetex' ? 'xelatex' : f.engine;
    // The run's own log comes back through readBack: returnNewFiles leaves logs out.
    const r = await run(host, [[program, '-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${name}`, `-progname=${name}`, ...options]], files, { readBack: [`${name}.log`] });
    logs[name] = r.readBack?.[`${name}.log`] ?? r.log;
    const fmt = (r.newFiles ?? []).find((x) => x.path === `${name}.fmt`);
    if (!fmt) {
      throw new Error(`${name}.fmt was not made: ${(r.error ?? '').split('\n')[0]}\n${logs[name].slice(-2000)}`);
    }
    out.set(`texmf-var/web2c/${f.engine}/${name}.fmt`, Buffer.from(fmt.data));
  }
  return { formats: out, logs };
}

/**
 * What the hyphenation patterns cost: pdflatex.fmt made again with a language.dat that holds US English only (the
 * template), against the full one. Returns both sizes in bytes.
 */
export async function patternCost(host, formats, usOnlyLanguageDat) {
  const full = await buildFormats(host, formats, ['pdflatex']);
  const us = await buildFormats(host, formats, ['pdflatex'], [{ path: 'language.dat', data: enc.encode(usOnlyLanguageDat) }]);
  const size = (m) => [...m.formats.values()][0].length;
  return { withAll: size(full), usOnly: size(us), patterns: size(full) - size(us) };
}

/**
 * The files a package's closure test loads (build gate B1, GB1E-04): every class (.cls) it has, and every .sty in its
 * own tex/latex/<folder>/ (not in subfolders, where helpers live). The main ones, whose name is the package's
 * (without case), must also give a PDF; a helper may stop with an error of its own, but may not miss a file.
 * Returns [] for a package with no .sty or .cls (fonts, BibTeX styles, plain TeX), which the report lists as untested.
 */
export function loadTargets(name, runfiles) {
  const base = (r) => path.posix.basename(r);
  const own = (r) => base(r).replace(/\.(sty|cls)$/i, '').toLowerCase() === name.toLowerCase();
  const classes = runfiles.filter((r) => r.startsWith('tex/') && /\.cls$/i.test(r));
  const styles = runfiles.filter((r) => /^tex\/latex\/[^/]+\/[^/]+\.sty$/i.test(r));
  const targets = [...classes, ...styles].sort().map((file) => ({
    kind: /\.cls$/i.test(file) ? 'class' : 'package',
    name: base(file).replace(/\.(sty|cls)$/i, ''),
    file,
    main: own(file) || /\.cls$/i.test(file),
  }));
  // A package whose files all have other names (revtex: revtex4-2.cls): its classes are its main files already.
  return targets;
}

/** The first of a package's targets, for a quick check (the test of the engine steps uses it). */
export function loadTarget(name, runfiles) {
  const targets = loadTargets(name, runfiles);
  return targets.find((t) => t.main) ?? targets[0] ?? null;
}

const NOT_FOUND = [
  /! LaTeX Error: File `([^']+)' not found/g,
  /! I can't find file `([^']+)'/g,
  /Metric \(TFM\) file not found/g,
  /! Font [^\n]* not loadable: Metric \(TFM\) file[^\n]*not found/g,
  // A font whose outline or map entry is missing (pdfTeX and xdvipdfmx).
  /!pdfTeX error:[^\n]*/g,
  /cannot open Type 1 font file[^\n]*/g,
  /! Font [^\n]* not found/g,
  /xdvipdfmx:fatal:[^\n]*/g,
  /Could not locate a virtual\/physical font[^\n]*/g,
];
// (fontspec's own message is split over lines with "(fontspec)" in between, so its message name is matched too.)
const NEEDS_UNICODE_ENGINE = /requires (either )?(XeTeX|XeLaTeX|LuaTeX)|cannot-use-pdftex|only works with (XeLaTeX|XeTeX|LuaLaTeX)/i;

/** A log with TeX's line wrapping (at 79 characters) undone, so a message split across lines is found whole. */
const unwrap = (log) => log.replace(/\r?\n/g, '');

/** The "not found" lines of a log. */
export function notFound(raw) {
  const log = unwrap(raw);
  const out = [];
  for (const re of NOT_FOUND) {
    for (const m of log.matchAll(re)) {
      out.push(m[0].replace(/\s+/g, ' '));
    }
  }
  return out;
}

/**
 * The closure test of one file: a minimal document that loads it, on pdfTeX, and on XeTeX when the package says
 * it needs a Unicode engine. Passes when the log names no file or font that was not found, and, for a main file,
 * when a PDF came out.
 */
/**
 * The closure test's document for one file: the class alone, or the package alone in an article. `preamble` comes
 * first, for a package that works only on top of another (engine/bundle-closure.json, "setup").
 */
export function closureDocument(target, preamble = '') {
  const before = preamble ? `${preamble}\n` : '';
  return target.kind === 'class'
    ? `\\documentclass{${target.name}}\n${before}\\begin{document}\nx\n\\end{document}\n`
    : `\\documentclass{article}\n${before}\\usepackage{${target.name}}\n\\begin{document}\nx\n\\end{document}\n`;
}

/**
 * The closure test's verdict over its results, with engine/bundle-closure.json's "expected" failures (file: reason):
 * a failure listed there is reported as expected, with the missing files and which of them extra-data holds (so
 * the add-on supplies them); any other failure is a problem; a listed file that now loads is reported as stale.
 */
export function judgeClosure(results, rules = {}, extraFiles = {}) {
  const expectedRules = rules.expected ?? {};
  const problems = [];
  const expected = [];
  const stale = [];
  for (const r of results) {
    const reason = expectedRules[r.file];
    if (r.ok) {
      if (reason !== undefined) {
        stale.push(r.file);
      }
      continue;
    }
    if (reason === undefined) {
      problems.push(`closure test: ${r.package} (${r.set}, ${r.file}, ${r.engine}): ${r.missing.join('; ')}`);
      continue;
    }
    const names = r.missing.flatMap((m) => [...m.matchAll(/File `([^']+)' not found/g)].map((x) => x[1]));
    expected.push({ file: r.file, package: r.package, reason, missing: r.missing, inExtra: names.filter((n) => n in extraFiles) });
  }
  return { problems, expected, stale };
}

export async function closureTest(host, target, dataImages = [], preamble = '') {
  const doc = closureDocument(target, preamble);
  const job = (engine) =>
    host.compile({
      id: nextJob++,
      main: 'closure.tex',
      files: [{ path: 'closure.tex', data: enc.encode(doc) }],
      engine,
      bibtex: 'never',
      maxPasses: 1,
      synctex: false,
      dataImages,
      knownImages: dataImages.map((d) => `${d.id}@${d.version}#${d.sha256}`),
    });
  let engine = 'pdflatex';
  let r = await job(engine);
  if (NEEDS_UNICODE_ENGINE.test(unwrap(r.log))) {
    engine = 'xelatex';
    r = await job(engine);
  }
  const missing = notFound(r.log);
  if (target.main && !r.pdf) {
    missing.push(`no PDF (${(r.error ?? 'see the log').split('\n')[0]})`);
  }
  return { engine, ok: missing.length === 0, missing, error: r.error ?? null };
}

/** Runs `tasks` over the hosts, one at a time per host. */
export async function pool(hosts, tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    hosts.map(async (host) => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i](host);
      }
    }),
  );
  return results;
}
