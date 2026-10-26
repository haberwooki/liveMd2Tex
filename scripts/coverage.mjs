#!/usr/bin/env node
// M5, the coverage measurement (docs/coverage-method.md; docs/DESIGN.md#engine-and-data, #testing). On CI only: it
// downloads arXiv papers and CTAN templates and starts TeX Live's programs. Its folders (--dir, --templates, --work,
// --results, --out) must lie outside the repository, so no source is ever committed; the workflow keeps the sources
// in the Actions cache.
//
//   node scripts/coverage.mjs --stage sample     --dir D   the harvest (OAI-PMH) and the frame: frame.json, candidates.json
//                                                          (harvest.json keeps a harvest's progress until it ends)
//   node scripts/coverage.mjs --stage fetch      --dir D   the sources, stratum by stratum, until each quota of LaTeX
//                                                          sources is met: sources/<id>, papers.json
//   node scripts/coverage.mjs --stage templates  --templates T [--pin]   the pinned CTAN templates (--pin: download
//                                                          and print the entries to commit)
//   node scripts/coverage.mjs --stage prepare    --dir D --templates T --shard 0/8 --work W   this shard's documents,
//                                                          unpacked: W/shard.json
//   node scripts/coverage.mjs --stage reference  --work W [--minutes 60]   each document on the installed TeX Live,
//                                                          without network: W/reference.json
//   node scripts/coverage.mjs --stage report     --dir D --results R --out O --shards N   the shares:
//                                                          O/coverage-report.{json,md}
//   node scripts/coverage.mjs --stage profile    --texdir T   prints the install-tl profile of the reference (scheme-full)
//   node scripts/coverage.mjs --stage rehearse   --dir D   the rehearsal's sample, with no arXiv request: the public
//                                                          corpus (test/corpus) and the probes, as sources/ and papers.json
//
// Our own compiles run between prepare and reference: node --require ./test/stubs/register-unit.cjs
// out/test/engine/coverageRun.js (the extension's route, with the stubs loaded).
//
// Network: curl, one request at a time, each at least three seconds after the previous one started (arXiv's API
// terms), with a User-Agent that names the project, its version and the repository's address; a 503 or 429 with
// Retry-After is waited out. Only arXiv's programmatic endpoints are asked (arxivEndpoint: oaipmh.arxiv.org/oai and
// export.arxiv.org/src/<id>), and no redirect is followed. The workflow runs sample and fetch in one job, in a
// concurrency group, so no two machines ever fetch at once.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  allocate,
  arxivEndpoint,
  assemble,
  buildReport,
  chooseMain,
  drawOrder,
  eligible,
  fatalInLog,
  filesProblem,
  formatShare,
  inWindow,
  isTar,
  notFoundInLog,
  Pacer,
  parseOaiPage,
  referenceProfile,
  rehearsalChecks,
  rehearsalProbes,
  retryAfterSeconds,
  sampleDocuments,
  shippedBbl,
  sourceKind,
  sourceVersion,
  stratumOf,
  tarOf,
  userAgent,
} from './lib/coverage.mjs';
import { isOutside } from './lib/paths.mjs';
import { readTar, safePath } from './lib/tar.mjs';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
/** Written whole or not at all: a step stopped half-way keeps the previous copy. */
const writeJsonAtomic = (f, v) => {
  writeJson(`${f}.part`, v);
  renameSync(`${f}.part`, f);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The User-Agent: the project, the extension's version and the repository's address (engine/coverage-frame.json). */
const agent = (frame) => userAgent(frame.harvest.userAgent, readJson(path.join(root, 'package.json')).version);
const message = (err) => (err instanceof Error ? err.message : String(err));

// ---- Downloads ----------------------------------------------------------------------------------------------------

const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
/** curl's exit code when an answer is larger than --max-filesize. */
const TOO_LARGE = 63;

/**
 * curl, once: { status, body (Buffer), headers, error, exit }. No retries of its own: the pacer decides. It follows
 * no redirect unless asked (`follow`, for the CTAN mirrors): a redirect from arXiv is an answer, not a new request.
 */
function curl(url, userAgent, { compressed = false, maxBytes, follow = false } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-curl-'));
  try {
    const body = path.join(tmp, 'body');
    const headers = path.join(tmp, 'headers');
    const args = [
      '-sS',
      ...(follow ? ['-L'] : []),
      '--max-time',
      '300',
      '-A',
      userAgent,
      '-D',
      headers,
      '-o',
      body,
      '-w',
      '%{http_code}',
      ...(compressed ? ['--compressed'] : []),
      ...(maxBytes ? ['--max-filesize', String(maxBytes)] : []),
      url,
    ];
    const r = spawnSync('curl', args, { encoding: 'utf8' });
    return {
      status: Number(r.stdout?.trim() || 0),
      body: r.status === 0 && existsSync(body) ? readFileSync(body) : Buffer.alloc(0),
      headers: existsSync(headers) ? readFileSync(headers, 'latin1') : '',
      error: r.status === 0 ? null : (r.stderr || `curl exited ${r.status}`).trim(),
      exit: r.status,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A paced GET to arXiv: only to the endpoints the method allows (arxivEndpoint), retried (up to 5 times) on a
 * network error, 429 or 5xx, waiting out Retry-After; never for size.
 */
async function paced(pacer, url, userAgent, options) {
  if (!arxivEndpoint(url)) {
    throw new Error(`not an endpoint the method allows: ${url}`);
  }
  for (let attempt = 1; ; attempt++) {
    const r = await pacer.run(() => curl(url, userAgent, options));
    const again = (r.error && r.exit !== TOO_LARGE) || r.status === 429 || r.status >= 500;
    if (!again || attempt >= 5) {
      return r;
    }
    const wait = retryAfterSeconds(r.headers) ?? 10 * attempt;
    console.log(`  ${r.status || r.error}: waiting ${wait} s before asking again`);
    await pacer.hold(wait * 1000);
  }
}

// ---- Stage: sample --------------------------------------------------------------------------------------------------

async function sample(dir, frame) {
  const pacer = new Pacer(frame.harvest.secondsBetweenRequests, clock);
  const checkpoint = path.join(dir, 'harvest.json');
  const tokenUrl = (token) => `${frame.harvest.oai}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;
  // A harvest that a step's time limit stopped goes on from its last saved page (arXiv's tokens expire daily).
  const state = existsSync(checkpoint) ? readJson(checkpoint) : { began: new Date().toISOString(), pages: 0, token: null, window: {}, pool: {}, seen: [] };
  if (state.token) {
    console.log(`  the harvest begun ${state.began} goes on at page ${state.pages + 1}`);
  }
  const { window, pool } = state;
  const seen = new Set(state.seen);
  let pages = state.pages;
  let url = state.token ? tokenUrl(state.token) : `${frame.harvest.oai}?verb=ListRecords&metadataPrefix=arXiv&from=${frame.window.from}`;
  const started = Date.now();
  const save = (token) => writeJsonAtomic(checkpoint, { began: state.began, pages, token, window, pool, seen: [...seen] });
  while (url) {
    const r = await paced(pacer, url, agent(frame), { compressed: true });
    if (r.status !== 200) {
      throw new Error(`OAI-PMH answered ${r.status || r.error} on page ${pages + 1}`);
    }
    const page = parseOaiPage(r.body.toString('utf8'));
    if (page.error?.code === 'badResumptionToken') {
      rmSync(checkpoint, { force: true });
      throw new Error(
        `arXiv's resumption token for page ${pages + 1} has expired (its tokens expire daily). Start a new run: the harvest starts again from page 1.`,
      );
    }
    if (page.error && page.error.code !== 'noRecordsMatch') {
      throw new Error(`OAI-PMH error ${page.error.code}: ${page.error.message}`);
    }
    pages++;
    for (const rec of page.records) {
      if (seen.has(rec.id) || !inWindow(rec, frame.window)) {
        continue;
      }
      seen.add(rec.id);
      const s = stratumOf(rec.categories, frame.strata);
      if (!s) {
        continue;
      }
      window[s] = (window[s] ?? 0) + 1;
      if (eligible(rec, frame)) {
        (pool[s] ??= []).push(rec.id);
      }
    }
    if (pages === state.pages + 1 && page.listSize) {
      const left = Math.ceil((page.listSize - (page.cursor ?? 0)) / Math.max(1, page.records.length));
      console.log(`  ${page.records.length} records a page, ${page.listSize} in the list: about ${left} page(s) to go`);
    }
    if (pages % 20 === 0) {
      const minutes = ((Date.now() - started) / 60000).toFixed(1);
      const where = page.listSize && page.cursor !== null ? `; ${page.cursor + page.records.length} of ${page.listSize} records` : '';
      console.log(`  ${pages} page(s), ${minutes} min in this step, ${seen.size} papers in the window so far${where}`);
      save(page.token);
    }
    url = page.token ? tokenUrl(page.token) : '';
  }
  const eligibleCounts = Object.fromEntries(Object.entries(pool).map(([s, ids]) => [s, ids.length]));
  const quotas = allocate(eligibleCounts, frame.sampleSize);
  const strata = {};
  for (const s of frame.strata.map((x) => x.id)) {
    strata[s] = { window: window[s] ?? 0, eligible: eligibleCounts[s] ?? 0, quota: quotas[s] ?? 0 };
  }
  // Only the ids in draw order, per stratum: the frame's metadata stays with arXiv.
  const candidates = Object.fromEntries(Object.entries(pool).map(([s, ids]) => [s, drawOrder(frame.seed, ids)]));
  writeJson(path.join(dir, 'frame.json'), { harvested: state.began, finished: new Date().toISOString(), pages, window: frame.window, seed: frame.seed, strata });
  writeJson(path.join(dir, 'candidates.json'), candidates);
  rmSync(checkpoint, { force: true });
  console.log(`sample: ${pages} page(s); ${seen.size} papers in the window; quotas ${JSON.stringify(quotas)}`);
}

// ---- Stage: fetch ---------------------------------------------------------------------------------------------------

/**
 * A source's files ("/"-paths to bytes), or { skip }: a gzipped tar, a lone gzipped file, or neither. A source that
 * unpacks to more than `maxBytes`, or whose files cannot share one folder, is an unreadable archive.
 */
export function sourceFiles(bytes, id, maxBytes = 2 ** 30) {
  let data = bytes;
  const kind = sourceKind(bytes);
  if (kind === 'pdf') {
    return { skip: 'a PDF submission' };
  }
  if (kind === 'gzip') {
    try {
      data = gunzipSync(bytes, { maxOutputLength: maxBytes });
    } catch (err) {
      return { skip: err?.code === 'ERR_BUFFER_TOO_LARGE' ? `an unreadable archive (more than ${maxBytes} bytes unpacked)` : 'an unreadable archive' };
    }
  }
  const files = new Map();
  if (isTar(data)) {
    try {
      for (const e of readTar(data)) {
        if (e.type === 'file') {
          files.set(e.path, e.data);
        }
      }
    } catch (err) {
      return { skip: `an unreadable archive (${message(err)})` };
    }
  } else if (kind === 'gzip') {
    if (sourceKind(data) === 'pdf') {
      return { skip: 'a PDF submission' };
    }
    files.set(`${id.replace(/[^\w.-]/g, '_')}.tex`, data);
  } else {
    return { skip: 'not a TeX source' };
  }
  const problem = filesProblem(files, maxBytes);
  return problem === null ? { files } : { skip: `an unreadable archive (${problem})` };
}

async function fetchSources(dir, frame) {
  const sources = path.join(dir, 'sources');
  mkdirSync(sources, { recursive: true });
  const candidates = readJson(path.join(dir, 'candidates.json'));
  const strata = readJson(path.join(dir, 'frame.json')).strata;
  const maxBytes = frame.source.maxBytes;
  const pacer = new Pacer(frame.harvest.secondsBetweenRequests, clock);
  // The harvest's last request may have been a moment ago, from another process.
  pacer.mark();
  const papers = [];
  const skipped = [];
  const quotas = Object.fromEntries(Object.entries(strata).map(([s, x]) => [s, x.quota ?? 0]));
  // Written as the fetch goes, so a fetch stopped half-way leaves a sample the report can call incomplete.
  const save = (complete) => writeJsonAtomic(path.join(dir, 'papers.json'), { complete, quotas, papers, skipped });
  for (const [stratum, ids] of Object.entries(candidates)) {
    const quota = quotas[stratum] ?? 0;
    let taken = 0;
    for (const id of ids) {
      if (taken >= quota) {
        break;
      }
      const file = path.join(sources, id.replace(/\//g, '_'));
      const about = `${file}.json`;
      try {
        if (!existsSync(file)) {
          const r = await paced(pacer, frame.harvest.source.replace('{id}', id), agent(frame), { maxBytes });
          if (r.exit === TOO_LARGE) {
            skipped.push({ id, stratum, why: `an unreadable archive (more than ${maxBytes} bytes)` });
            continue;
          }
          if (r.error || r.status !== 200) {
            skipped.push({ id, stratum, why: `no source (${r.status || r.error})` });
            continue;
          }
          writeFileSync(file, r.body);
          writeJson(about, { ...sourceVersion(r.headers), fetched: new Date().toISOString() });
        }
        const bytes = readFileSync(file);
        const meta = existsSync(about) ? readJson(about) : { version: null, etag: null, fetched: null };
        const src = sourceFiles(bytes, id, maxBytes);
        const chosen = 'files' in src ? chooseMain(src.files) : src;
        if ('skip' in chosen) {
          skipped.push({ id, stratum, why: chosen.skip });
          continue;
        }
        papers.push({
          key: id,
          kind: 'paper',
          stratum,
          source: path.basename(file),
          version: meta.version,
          etag: meta.etag,
          sha256: sha256(bytes),
          fetched: meta.fetched,
          main: chosen.main,
          engine: chosen.engine,
          how: chosen.how,
        });
        taken++;
      } catch (err) {
        // One odd source (too big to read, say) is skipped and counted; it never stops the fetch.
        skipped.push({ id, stratum, why: `an unreadable archive (${message(err).slice(0, 200)})` });
      } finally {
        if ((papers.length + skipped.length) % 25 === 0) {
          save(false);
        }
      }
    }
    console.log(`  ${stratum}: ${taken} of ${quota}`);
    save(false);
  }
  save(true);
  console.log(`fetch: ${papers.length} papers with LaTeX sources; ${skipped.length} skipped`);
}

// ---- Stage: templates -----------------------------------------------------------------------------------------------

async function templates(out, pin, frame) {
  const list = readJson(path.join(root, 'engine', 'coverage-templates.json'));
  mkdirSync(out, { recursive: true });
  const pinned = [];
  const index = [];
  for (const t of list.templates) {
    if (!pin && !t.sha256) {
      console.log(`  ${t.id}: not pinned; not measured`);
      index.push({ id: t.id, sha256: null, downloaded: false });
      continue;
    }
    const file = path.join(out, `${t.id}.zip`);
    let bytes = existsSync(file) ? readFileSync(file) : null;
    for (const mirror of bytes ? [] : list.mirrors) {
      const r = curl(`${mirror}${t.ctan}.zip`, agent(frame), { follow: true });
      if (r.status === 200 && r.body.length > 0) {
        bytes = r.body;
        break;
      }
    }
    if (!bytes) {
      console.log(`  ${t.id}: not downloaded`);
      index.push({ id: t.id, sha256: t.sha256, downloaded: false });
      continue;
    }
    const sha = sha256(bytes);
    if (!pin && sha !== t.sha256) {
      throw new Error(`${t.id}: the zip's SHA-256 is ${sha}, not the pinned ${t.sha256}`);
    }
    writeFileSync(file, bytes);
    index.push({ id: t.id, sha256: sha, downloaded: true });
    if (pin) {
      const files = readZip(bytes);
      const mains = [...files.keys()].filter((p) => /\.tex$/i.test(p) && chooseMain(new Map([[path.posix.basename(p), files.get(p)]])).main);
      pinned.push({ ...t, sha256: sha, mains: mains.sort() });
    }
  }
  // Also keeps the folder from being empty, which the cache would refuse.
  writeJson(path.join(out, 'index.json'), { templates: index });
  if (pin) {
    console.log('The entries to commit into engine/coverage-templates.json (keep the mains that are templates):');
    console.log(JSON.stringify(pinned, null, 2));
  }
}

// ---- Stage: prepare -------------------------------------------------------------------------------------------------

/** Writes a document's files under `folder`, refusing a path that would leave it. */
function writeFiles(folder, files) {
  for (const [p, data] of files) {
    const safe = safePath(p);
    if (safe === null) {
      throw new Error(`a path outside the document: ${p}`);
    }
    const target = path.join(folder, ...safe.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function prepare(dir, templatesDir, shard, work, frame) {
  const [index, count] = shard.split('/').map(Number);
  const { papers, rehearsal } = readJson(path.join(dir, 'papers.json'));
  const list = readJson(path.join(root, 'engine', 'coverage-templates.json'));
  const mine = sampleDocuments(papers, rehearsal ? [] : list.templates, frame.seed, count).filter((d) => d.shard === index);
  mkdirSync(work, { recursive: true });
  const prepared = [];
  const unreadable = [];
  for (const d of mine) {
    const folder = path.join(work, 'docs', d.key.replace(/[^\w.-]/g, '_'));
    // Each document on its own: one that cannot be unpacked (a full disk, say) is counted, and the next goes on.
    try {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      let main = d.main;
      let files;
      if (d.kind === 'paper') {
        const src = sourceFiles(readFileSync(path.join(dir, 'sources', d.source)), d.key, frame.source.maxBytes);
        if (!('files' in src)) {
          throw new Error(src.skip);
        }
        files = src.files;
      } else {
        // A template: its folder of the zip, so its own files sit beside the main file.
        const zip = readZip(readFileSync(path.join(templatesDir, `${d.template}.zip`)));
        const base = path.posix.dirname(d.main);
        files = new Map([...zip].filter(([p]) => base === '.' || p.startsWith(`${base}/`)).map(([p, b]) => [base === '.' ? p : p.slice(base.length + 1), b]));
        main = path.posix.basename(d.main);
        const problem = filesProblem(files, frame.source.maxBytes);
        if (problem !== null) {
          throw new Error(problem);
        }
      }
      writeFiles(folder, files);
      const engine = d.kind === 'paper' ? d.engine : (chooseMain(new Map([[main, files.get(main)]])).engine ?? null);
      prepared.push({ key: d.key, kind: d.kind, stratum: d.stratum ?? null, folder, main, engine, bbl: shippedBbl(files, main) !== null });
    } catch (err) {
      rmSync(folder, { recursive: true, force: true });
      unreadable.push({ key: d.key, why: message(err).slice(0, 200) });
      console.log(`  ${d.key}: could not be unpacked (${message(err)})`);
    }
  }
  writeJson(path.join(work, 'shard.json'), { shard, commit: process.env.GITHUB_SHA ?? null, documents: prepared, unreadable });
  console.log(`prepare: shard ${shard}, ${prepared.length} documents, ${unreadable.length} could not be unpacked`);
}

// ---- Stage: reference -----------------------------------------------------------------------------------------------

/** True when this process can reach a network: an interface other than the loopback has an address. */
function online() {
  return Object.values(os.networkInterfaces()).some((addresses) => (addresses ?? []).some((a) => !a.internal));
}

async function reference(work, minutes) {
  if (process.env.CI === 'true' && online()) {
    throw new Error('the reference runs without network (the workflow starts it in a network namespace of its own), but this process has one');
  }
  const { PDFDocument } = await import('pdf-lib');
  const { documents } = readJson(path.join(work, 'shard.json'));
  const ours = existsSync(path.join(work, 'ours.json')) ? readJson(path.join(work, 'ours.json')).documents : {};
  const frame = readJson(path.join(root, 'engine', 'coverage-frame.json'));
  const limit = frame.compile.secondsPerCompile * 1000;
  const results = {};
  // TeX Live's programs get a small environment of their own: TeX may read and write only below the document's
  // folder (no absolute paths, no "..", no dot files), and its shell escape runs only TeX Live's restricted list.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.tmpdir(), LANG: 'C.UTF-8', openin_any: 'p', openout_any: 'p', shell_escape: 'p' };
  const firstLine = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env }).stdout?.split('\n')[0]?.trim() ?? '';
  const versions = { texLive: firstLine('pdflatex', ['--version']), ghostscript: firstLine('gs', ['--version']) };
  let stopped = null;
  const unmeasured = {};
  // Written after every document, so a shard that runs out of time keeps what it measured.
  const save = () => writeJson(path.join(work, 'reference.json'), { ...versions, offline: !online(), stopped, documents: results, unmeasured });
  const began = Date.now();
  for (const d of documents) {
    if (Date.now() - began > minutes * 60000) {
      stopped = `its ${minutes} minutes on TeX Live ran out`;
      console.log(`  the shard's time is up: ${documents.length - Object.keys(results).length} document(s) not measured on TeX Live`);
      break;
    }
    // The engine the paper asks for ('latex' is the DVI route), else the one the extension chose (its rule reads
    // the preamble). TeX writes its files where it runs, in the document's top folder, under the main file's name.
    const program = d.engine ?? ours[d.key]?.engine ?? 'pdflatex';
    const base = path.posix.basename(d.main).replace(/\.tex$/i, '');
    const copy = mkdtempSync(path.join(os.tmpdir(), 'coverage-ref-'));
    const cwd = path.join(copy, 'doc');
    const at = (ext) => path.join(cwd, `${base}.${ext}`);
    const started = Date.now();
    let timedOut = false;
    const run = (cmd, args) => {
      const left = limit - (Date.now() - started);
      if (left <= 0) {
        timedOut = true;
        return null;
      }
      const r = spawnSync(cmd, args, { cwd, env, encoding: 'latin1', timeout: left, maxBuffer: 64 * 1024 * 1024 });
      if (r.error && r.error.code === 'ETIMEDOUT') {
        timedOut = true;
      }
      return r;
    };
    try {
      cpSync(d.folder, cwd, { recursive: true });
      const log = () => (existsSync(at('log')) ? readFileSync(at('log'), 'latin1') : '');
      const tex = () => run(program, ['-interaction=nonstopmode', '-file-line-error', d.main]);
      tex();
      if (!d.bbl && !timedOut) {
        if (existsSync(at('bcf')) && /biber/i.test(log())) {
          run('biber', [base]);
        } else if (existsSync(at('aux')) && /\\bibdata\{/.test(readFileSync(at('aux'), 'latin1'))) {
          run('bibtex', [base]);
        }
      }
      for (let i = 0; i < 3 && !timedOut; i++) {
        tex();
        if (!/Rerun to get|Label\(s\) may have changed|Please rerun|rerun LaTeX/i.test(log())) {
          break;
        }
      }
      // The DVI route: dvips (no shell commands in \special), then Ghostscript's ps2pdf.
      if (program === 'latex' && !timedOut && existsSync(at('dvi'))) {
        run('dvips', ['-q', '-o', `${base}.ps`, `${base}.dvi`]);
        if (!timedOut && existsSync(at('ps'))) {
          run('ps2pdf', [`${base}.ps`, `${base}.pdf`]);
        }
      }
      let pages = null;
      if (existsSync(at('pdf')) && statSync(at('pdf')).size > 0) {
        try {
          pages = (await PDFDocument.load(readFileSync(at('pdf')), { ignoreEncryption: true, updateMetadata: false })).getPageCount();
        } catch {
          pages = null;
        }
      }
      const text = log();
      results[d.key] = { engine: program, pdf: pages !== null, pages, fatal: fatalInLog(text), timedOut, missing: notFoundInLog(text), seconds: Math.round((Date.now() - started) / 1000) };
    } catch (err) {
      // Not TeX's failure (the copy failed on a full disk, say): the document is not measured, and says why.
      unmeasured[d.key] = message(err).slice(0, 200);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    const r = results[d.key];
    console.log(r ? `  ${d.key}: ${r.pages ?? 'no'} page(s) on TeX Live (${program}${r.timedOut ? ', timed out' : ''})` : `  ${d.key}: not run on TeX Live (${unmeasured[d.key]})`);
    save();
  }
  save();
}

// ---- Stage: rehearse ------------------------------------------------------------------------------------------------

/** A one-page PDF with a curve and two axes, drawn in code: the stand-in for a corpus figure. */
async function drawnFigure() {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 180]);
  let last = null;
  for (let i = 0; i <= 200; i++) {
    const w = 0.5 + i / 100;
    const p = { x: 20 + i * 1.3, y: 20 + Math.min(1 / Math.sqrt((1 - w * w) ** 2 + (w / 8) ** 2), 9) * 16 };
    if (last) {
      page.drawLine({ start: last, end: p, thickness: 1.5, color: rgb(0.1, 0.2, 0.7) });
    }
    last = p;
  }
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 290, y: 20 }, thickness: 1 });
  page.drawLine({ start: { x: 20, y: 20 }, end: { x: 20, y: 170 }, thickness: 1 });
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)));
  return Buffer.from(await doc.save());
}

/** Every file under `folder`, as "/"-paths to bytes. */
function filesUnder(folder, prefix = '') {
  const files = new Map();
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [p, b] of filesUnder(path.join(folder, entry.name), rel)) {
        files.set(p, b);
      }
    } else if (entry.isFile()) {
      files.set(rel, readFileSync(path.join(folder, entry.name)));
    }
  }
  return files;
}

/**
 * The rehearsal's sample, with no arXiv request: each folder of the public corpus (test/corpus, CC0) and each probe
 * (rehearsalProbes), packed as arXiv packs a source (a gzipped tar), so prepare, both compiles and the report run
 * exactly as they do on papers. papers.json says `rehearsal: true`; the report then checks the probes.
 */
export async function rehearse(dir) {
  const sources = path.join(dir, 'sources');
  mkdirSync(sources, { recursive: true });
  const corpus = path.join(root, 'test', 'corpus');
  const docs = [
    ...readdirSync(corpus, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ key: `corpus-${e.name}`, stratum: 'corpus', files: filesUnder(path.join(corpus, e.name)) })),
    ...rehearsalProbes().map((p) => ({ key: p.key, stratum: 'probe', files: new Map(Object.entries(p.files).map(([n, s]) => [n, Buffer.from(s)])) })),
  ];
  // P1 shows a figure that the tests draw from code (test/corpus/P1/paper.tex); it is drawn here too, so that P1 is
  // complete on TeX Live.
  const p1 = docs.find((d) => d.key === 'corpus-P1');
  if (p1 && !p1.files.has('fig-response.pdf')) {
    p1.files.set('fig-response.pdf', await drawnFigure());
  }
  const papers = [];
  for (const d of docs) {
    const bytes = gzipSync(tarOf(d.files));
    writeFileSync(path.join(sources, d.key), bytes);
    const chosen = chooseMain(d.files);
    if ('skip' in chosen) {
      throw new Error(`${d.key}: ${chosen.skip}`);
    }
    papers.push({ key: d.key, kind: 'paper', stratum: d.stratum, source: d.key, version: null, etag: null, sha256: sha256(bytes), fetched: null, main: chosen.main, engine: chosen.engine, how: chosen.how });
  }
  const count = (s) => papers.filter((p) => p.stratum === s).length;
  const quotas = { corpus: count('corpus'), probe: count('probe') };
  writeJson(path.join(dir, 'papers.json'), { complete: true, rehearsal: true, quotas, papers, skipped: [] });
  writeJson(path.join(dir, 'frame.json'), {
    rehearsal: true,
    strata: Object.fromEntries(Object.entries(quotas).map(([s, n]) => [s, { window: null, eligible: n, quota: n }])),
  });
  console.log(`rehearse: ${quotas.corpus} corpus documents and ${quotas.probe} probes; no arXiv request`);
}

// ---- Stage: report --------------------------------------------------------------------------------------------------

/** A skip reason without its details, to count reasons ("no source (404)" -> "no source"). */
const reasonOf = (why) => why.replace(/\s*\(.*$/, '');

/**
 * The report stage (exported for its test): every sampled document, from papers.json and the pinned templates.
 * Returns { complete, checks }: in a rehearsal, a check that fails makes the stage fail.
 */
export function report(dir, results, out, shardsArg) {
  const frame = existsSync(path.join(dir, 'frame.json')) ? readJson(path.join(dir, 'frame.json')) : { strata: {} };
  const papersFile = existsSync(path.join(dir, 'papers.json')) ? readJson(path.join(dir, 'papers.json')) : null;
  const rules = readJson(path.join(root, 'engine', 'coverage-frame.json'));
  const list = readJson(path.join(root, 'engine', 'coverage-templates.json'));
  const found = [];
  for (const folder of existsSync(results) ? readdirSync(results).map((f) => path.join(results, f)) : []) {
    if (existsSync(path.join(folder, 'shard.json'))) {
      const shard = readJson(path.join(folder, 'shard.json'));
      const [index, count] = String(shard.shard).split('/').map(Number);
      const optional = (f) => (existsSync(path.join(folder, f)) ? readJson(path.join(folder, f)) : null);
      found.push({ index, count, shard, ours: optional('ours.json'), reference: optional('reference.json') });
    }
  }
  const shards = Number(shardsArg) || Math.max(1, ...found.map((f) => f.count));
  const byShard = {};
  const notes = [];
  for (const f of found) {
    if (f.count !== shards) {
      notes.push(`Shard ${f.shard.shard} was cut for ${f.count} shards, not ${shards}; it is not counted.`);
    } else {
      byShard[f.index] = f;
    }
  }
  const rehearsal = papersFile?.rehearsal === true;
  const sample = sampleDocuments(papersFile?.papers ?? [], rehearsal ? [] : list.templates, rules.seed, shards);
  const { documents, missingShards } = assemble(sample, shards, byShard);
  const result = buildReport(documents, frame, rules.compile.pageTolerance);

  // What the report cannot vouch for comes first.
  if (!papersFile) {
    notes.unshift('There is no papers.json: the sample is unknown, and no paper is counted.');
  } else if (papersFile.complete !== true) {
    notes.unshift(`The fetch stopped before every quota was met: ${papersFile.papers.length} of ${rules.sampleSize} papers were sampled.`);
  }
  if (missingShards.length > 0) {
    const lost = documents.filter((d) => missingShards.includes(d.shard)).length;
    notes.unshift(`Shard(s) ${missingShards.join(', ')} of ${shards} returned no results: their ${lost} document(s) are counted as not measured.`);
  }
  const short = Object.entries(papersFile?.quotas ?? {})
    .map(([s, q]) => [s, q, (papersFile?.papers ?? []).filter((p) => p.stratum === s).length])
    .filter(([, q, n]) => n < q);
  if (papersFile?.complete === true && short.length > 0) {
    notes.push(`Stratum ${short.map(([s, q, n]) => `${s} has ${n} of its ${q}`).join(', ')} (it ran out of eligible papers with LaTeX sources).`);
  }
  const commit = process.env.GITHUB_SHA ?? null;
  const commits = [...new Set(found.map((f) => f.shard.commit ?? null))];
  if (commit && commits.some((c) => c !== commit)) {
    notes.push(`The shards ran on commit(s) ${commits.join(', ')}, the report on ${commit}.`);
  }
  const fileHash = (rel) => sha256(readFileSync(path.join(root, rel)));
  const references = found.map((f) => f.reference).filter(Boolean);
  const versions = (key) => [...new Set(references.map((r) => r[key] ?? ''))].filter(Boolean);
  const packages = [...new Set(found.flatMap((f) => f.ours?.packages ?? []))].sort();
  const stubs = found.map((f) => ({ shard: f.index, ...(f.ours?.stubs ?? { checked: false }) }));
  const skipped = papersFile?.skipped ?? [];
  const full = {
    measured: new Date().toISOString(),
    complete: notes.length === 0,
    notes,
    // What the results are bound to: the commit and the method as it ran.
    commit,
    method: { 'docs/coverage-method.md': fileHash('docs/coverage-method.md'), 'engine/coverage-frame.json': fileHash('engine/coverage-frame.json'), 'engine/coverage-templates.json': fileHash('engine/coverage-templates.json') },
    frame: { ...frame, rules },
    shards,
    texLive: versions('texLive'),
    ghostscript: versions('ghostscript'),
    referenceOffline: references.every((r) => r.offline === true),
    dataPackages: packages,
    stubs,
    skipped,
    ...result,
  };
  const checks = rehearsal ? rehearsalChecks(documents, { offline: references.length > 0 && full.referenceOffline, ghostscript: full.ghostscript }) : null;
  if (checks) {
    full.rehearsal = checks;
  }
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'coverage-report.json'), full);

  const counts = (items) => Object.entries(items.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join('; ');
  const left = result.papers.leftOut;
  const allDocs = result.documents;
  const failed = (checks ?? []).filter((c) => !c.ok);
  const lines = [
    ...(checks
      ? [
          failed.length === 0
            ? `**Rehearsal: all ${checks.length} checks pass.** No arXiv paper was fetched; the shares below are not a measurement.`
            : `**Rehearsal: ${failed.length} of ${checks.length} checks fail** (${failed.map((c) => c.key).join(', ')}). No arXiv paper was fetched.`,
          '',
          '| Check | What it proves | Result | Got |',
          '|---|---|---|---|',
          ...checks.map((c) => `| ${c.key} | ${c.what} | ${c.ok ? 'pass' : 'FAIL'} | ${c.got} |`),
          '',
        ]
      : []),
    full.complete ? `**Complete.** Every one of the ${allDocs.length} sampled documents has an outcome.` : `**Incomplete.** ${notes.join(' ')}`,
    '',
    '# Coverage measurement (M5)',
    '',
    `Method: docs/coverage-method.md (SHA-256 ${full.method['docs/coverage-method.md'].slice(0, 12)}), commit ${commit ?? 'unknown'}. ` +
      `Reference: ${full.texLive.join(', ') || 'unknown'}, Ghostscript ${full.ghostscript.join(', ') || 'unknown'}, ${full.referenceOffline ? 'without network' : 'NOT shown to be without network'}. ` +
      `Data packages: ${packages.join(', ') || 'unknown'}.`,
    '',
    '| Documents | Core alone | Core with extra |',
    '|---|---|---|',
    `| arXiv papers | ${formatShare(result.papers.core)} | ${formatShare(result.papers.extra)} |`,
    `| Thesis templates | ${formatShare(result.thesis.core)} | ${formatShare(result.thesis.extra)} |`,
    `| Beamer templates | ${formatShare(result.beamer.core)} | ${formatShare(result.beamer.extra)} |`,
    '',
    `Papers left out of the shares: ${left['not measured']} not measured, ${left['broken as submitted']} broken as submitted (a file missing on TeX Live too), ` +
      `${left['fails on TeX Live']} that do not compile on TeX Live either. Skipped before each quota was met: ${skipped.length}` +
      `${skipped.length ? ` (${counts(skipped.map((s) => reasonOf(s.why)))})` : ''}.`,
    '',
    `Engines: ${Object.entries(result.engines).map(([e, x]) => `${e === 'latex' ? 'latex (the DVI route)' : e} ${x.papers} (${x.leftOut} left out)`).join(', ') || 'none'}.`,
    '',
    `Sensitivity figure, not for the README: reweighted to all papers of the window, assuming that within a stratum CC BY and CC0 papers compile as often as the rest: ` +
      `core ${result.papers.reweighted.core === null ? 'n/a' : `${(100 * result.papers.reweighted.core).toFixed(1)} %`}, ` +
      `core with extra ${result.papers.reweighted.extra === null ? 'n/a' : `${(100 * result.papers.reweighted.extra).toFixed(1)} %`}.`,
    '',
    '| Stratum | Papers in the window | CC BY or CC0 | Sampled | Not measured | Left out (TeX Live) | Core alone | Core with extra |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(result.strata).map(
      ([id, s]) =>
        `| ${id} | ${s.window ?? ''} | ${s.eligible ?? ''} | ${s.sampled} | ${s.leftOut['not measured']} | ${s.leftOut['broken as submitted'] + s.leftOut['fails on TeX Live']} | ${formatShare(s.core)} | ${formatShare(s.extra)} |`,
    ),
    '',
    '## Missing packages (papers that fail with core alone)',
    '',
    '| Package | Papers | Where |',
    '|---|---|---|',
    ...result.missingPackages.slice(0, 40).map((m) => `| ${m.package} | ${m.documents} | ${m.where} |`),
    '',
    `Blocked attempts to start a program or open a connection on the extension's side: ${result.blocked.length} document(s)` +
      `, ${stubs.reduce((n, s) => n + (s.blocked?.length ?? 0), 0)} in the runner itself` +
      `; compiles whose worker sent no stubs record: ${stubs.reduce((n, s) => n + (s.workers?.withoutRecord ?? 0), 0)}` +
      `${stubs.some((s) => s.checked === false) ? `; the stubs were not shown loaded in shard(s) ${stubs.filter((s) => s.checked === false).map((s) => s.shard).join(', ')}` : ''}.`,
    '',
    '## Left out',
    '',
    '| Document | Shard | Why |',
    '|---|---|---|',
    ...result.excluded.map((e) => `| ${e.key} | ${allDocs.find((d) => d.key === e.key)?.shard ?? ''} | ${e.why} |`),
    '',
    `<details><summary>Every document (${allDocs.length})</summary>`,
    '',
    '| Document | Kind | Stratum | Shard | Engine | Core alone | Core with extra |',
    '|---|---|---|---|---|---|---|',
    ...allDocs.map((d) => `| ${d.key} | ${d.kind} | ${d.stratum ?? ''} | ${d.shard ?? ''} | ${d.engine ?? ''} | ${d.core} | ${d.extra} |`),
    '',
    '</details>',
    '',
  ];
  writeFileSync(path.join(out, 'coverage-report.md'), lines.join('\n'));
  console.log(lines.slice(0, lines.indexOf('## Left out')).join('\n'));
  return { complete: full.complete, checks };
}

// ---- Main -----------------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const stage = arg('--stage');
  const dir = path.resolve(arg('--dir') ?? path.join(root, '..', 'coverage-work'));
  const templatesDir = path.resolve(arg('--templates') ?? path.join(dir, 'templates'));
  for (const p of [dir, templatesDir, arg('--work'), arg('--out'), arg('--results'), arg('--texdir')].filter(Boolean)) {
    if (!isOutside(root, path.resolve(p))) {
      console.error(`coverage.mjs keeps its files outside the repository: ${p} is inside it.`);
      process.exit(2);
    }
  }
  if (process.env.CI !== 'true' && stage !== 'report' && stage !== 'rehearse') {
    console.error('coverage.mjs fetches and compiles on CI only (docs/coverage-method.md).');
    process.exit(2);
  }
  const frame = readJson(path.join(root, 'engine', 'coverage-frame.json'));
  try {
    if (stage === 'sample') {
      mkdirSync(dir, { recursive: true });
      await sample(dir, frame);
    } else if (stage === 'fetch') {
      await fetchSources(dir, frame);
    } else if (stage === 'templates') {
      await templates(templatesDir, process.argv.includes('--pin'), frame);
    } else if (stage === 'prepare') {
      prepare(dir, templatesDir, arg('--shard') ?? '0/1', path.resolve(arg('--work') ?? path.join(dir, 'work')), frame);
    } else if (stage === 'reference') {
      await reference(path.resolve(arg('--work') ?? path.join(dir, 'work')), Number(arg('--minutes') ?? 60));
    } else if (stage === 'profile') {
      process.stdout.write(referenceProfile(path.resolve(arg('--texdir') ?? '')));
    } else if (stage === 'report') {
      const { checks } = report(dir, path.resolve(arg('--results') ?? path.join(dir, 'results')), path.resolve(arg('--out') ?? path.join(dir, 'report')), arg('--shards'));
      if (checks && checks.some((c) => !c.ok)) {
        process.exitCode = 1;
      }
    } else if (stage === 'rehearse') {
      mkdirSync(dir, { recursive: true });
      await rehearse(dir);
    } else {
      console.error('--stage sample | fetch | templates | prepare | reference | profile | report | rehearse');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`coverage ${stage}: ${message(err)}`);
    process.exitCode = 1;
  }
}
