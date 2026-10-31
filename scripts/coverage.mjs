#!/usr/bin/env node
// M5, the coverage measurement (docs/coverage-method.md; docs/DESIGN.md#engine-and-data, #testing). On CI only: it
// takes TeX Live's own example and template documents from the pinned snapshot (the frame without arXiv, the one
// measured), or the repository's corpus and probes (the rehearsal), and starts TeX Live's programs. Its folders
// (--dir, --templates, --work, --results, --out) must lie outside the repository, so no document is ever committed;
// the workflow keeps the documents in the Actions cache. The report and the rehearsal stages also run off CI.
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
//   node scripts/coverage.mjs --stage mirror-check           the snapshot's host gives the tlpdb's signed checksum to curl
//   node scripts/coverage.mjs --stage local      --dir D [--archives A]   the frame without arXiv: TeX Live's own example and template
//                                                          documents from the pinned snapshot, the corpus and the probes
//
// The arXiv stages (sample, fetch) refuse to run while engine/coverage-frame.json's harvest.enabled is false: the arXiv
// frame waits for arXiv's permission (docs/coverage-method.md).
//
// Our own compiles run between prepare and reference: node --require ./test/stubs/register-unit.cjs
// out/test/engine/coverageRun.js (the extension's route, with the stubs loaded).
//
// Network, for the frame without arXiv: the snapshot's host only (engine/bundle-pins.json), with curl and curl's own
// User-Agent, one request at a time, a second apart, a 429 or 503 waited out, every file checked against the pinned
// tlpdb. For the arXiv frame, once it may run: curl, one
// request at a time, each at least three seconds after the previous one started (arXiv's API terms), with a
// User-Agent that names the project, its version and the repository's address; a 503 or 429 with Retry-After is
// waited out. Only arXiv's programmatic endpoints are asked (arxivEndpoint: oaipmh.arxiv.org/oai and
// export.arxiv.org/src/<id>), and no redirect is followed. The workflow would run sample and fetch in one job, in a
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
  arxivEnabled,
  arxivEndpoint,
  assemble,
  buildReport,
  CANARY_DOCUMENTS,
  canaryChecks,
  chooseMain,
  docTreeEngine,
  drawOrder,
  eligible,
  exampleFiles,
  exampleFolder,
  exampleOrder,
  cnfSettings,
  errorsInLog,
  fatalInLog,
  LOG_LINE_SETTINGS,
  filesProblem,
  formatShare,
  frameDiffers,
  inWindow,
  isLatexMain,
  loadsPstricks,
  isTar,
  localFrame,
  measuredChecks,
  texLiveChecks,
  leftOutShardChecks,
  notFoundInLog,
  Pacer,
  parseOaiPage,
  referenceEngine,
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
import { archiveFile, sha512 } from './lib/bundle.mjs';
import { isOutside } from './lib/paths.mjs';
import { readTar, safePath } from './lib/tar.mjs';
import { parseTlpdb } from './lib/tlpdb.mjs';
import { unxz } from './lib/xz.mjs';
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
/**
 * curl's arguments for one request. With `userAgent` null, curl sends its own User-Agent: the snapshot's host lets
 * that through and answers a project User-Agent with its bot check's HTML page.
 */
export function curlArgs(url, userAgent, { compressed = false, maxBytes, follow = false, headers, body } = {}) {
  return [
    '-sS',
    ...(follow ? ['-L'] : []),
    '--max-time',
    '300',
    ...(userAgent ? ['-A', userAgent] : []),
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
}

function curl(url, userAgent, { compressed = false, maxBytes, follow = false } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-curl-'));
  try {
    const body = path.join(tmp, 'body');
    const headers = path.join(tmp, 'headers');
    const args = curlArgs(url, userAgent, { compressed, maxBytes, follow, headers, body });
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

function prepare(dir, templatesDir, shard, work, frame, { commit = null } = {}) {
  const [index, count] = shard.split('/').map(Number);
  const meta = readJson(path.join(dir, 'papers.json'));
  const list = readJson(path.join(root, 'engine', 'coverage-templates.json'));
  const mine = sampleDocuments(meta.papers, arxivFrame(meta) ? list.templates : [], meta.seed ?? frame.seed, count).filter((d) => d.shard === index);
  mkdirSync(work, { recursive: true });
  const prepared = [];
  const unreadable = [];
  for (const d of mine.filter((x) => !x.unavailable)) {
    const folder = path.join(work, 'docs', d.key.replace(/[^\w.-]/g, '_'));
    // Each document on its own: one that cannot be unpacked (a full disk, say) is counted, and the next goes on.
    try {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      let main = d.main;
      let files;
      if (!d.template) {
        const bytes = readFileSync(path.join(dir, 'sources', d.source));
        // The cache holds what the sample stage wrote; a source that changed since is not the sampled one.
        if (d.sha256 && sha256(bytes) !== d.sha256) {
          throw new Error(`its source is not the one sampled (SHA-256 ${sha256(bytes)}, not ${d.sha256})`);
        }
        const src = sourceFiles(bytes, d.key, frame.source.maxBytes);
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
      const engine = !d.template ? d.engine : (chooseMain(new Map([[main, files.get(main)]])).engine ?? null);
      prepared.push({ key: d.key, kind: d.kind, stratum: d.stratum ?? null, folder, main, engine, bbl: shippedBbl(files, main) !== null });
    } catch (err) {
      rmSync(folder, { recursive: true, force: true });
      unreadable.push({ key: d.key, why: message(err).slice(0, 200) });
      console.log(`  ${d.key}: could not be unpacked (${message(err)})`);
    }
  }
  writeJson(path.join(work, 'shard.json'), { shard, commit, documents: prepared, unreadable });
  console.log(`prepare: shard ${shard}, ${prepared.length} documents, ${unreadable.length} could not be unpacked`);
}

// ---- Stage: reference -----------------------------------------------------------------------------------------------

/** True when this process can reach a network: an interface other than the loopback has an address. */
function online() {
  return Object.values(os.networkInterfaces()).some((addresses) => (addresses ?? []).some((a) => !a.internal));
}

/**
 * TeX Live's environment on the reference: a small one of its own. TeX may write only below the document's folder
 * (no absolute paths, no "..", no dot files); since TeX Live 2026 it may read any file, whatever openin_any says, so
 * openin_any is not set (docs/coverage-method.md). Its shell escape runs only TeX Live's restricted list. The
 * log's line lengths are the extension's own (engine/texmf-override.cnf), so both sides write their logs the same
 * way: with TeX Live's default of 79 columns a long path would break an error's "file:line:" across lines, and
 * rule 4 would miss that error on the reference's side only (docs/coverage-method.md).
 */
export function referenceEnvironment(base = process.env) {
  const log = cnfSettings(readFileSync(path.join(root, 'engine', 'texmf-override.cnf'), 'utf8'), LOG_LINE_SETTINGS);
  return { PATH: base.PATH ?? '/usr/bin:/bin', HOME: base.HOME ?? os.tmpdir(), LANG: 'C.UTF-8', openout_any: 'p', shell_escape: 'p', ...log };
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
  const env = referenceEnvironment();
  const firstLine = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env }).stdout?.split('\n')[0]?.trim() ?? '';
  const versions = { texLive: firstLine('pdflatex', ['--version']), ghostscript: firstLine('gs', ['--version']) };
  let stopped = null;
  const unmeasured = {};
  // The shard's health on TeX Live: the canaries before its documents and after them (docs/coverage-method.md).
  const canary = { before: null, after: null };
  // Written after every document, so a shard that runs out of time keeps what it measured.
  const save = () => writeJson(path.join(work, 'reference.json'), { ...versions, offline: !online(), stopped, canary, documents: results, unmeasured });

  /**
   * One document on TeX Live, in a copy of its folder: { engine, pdf, pages, fatal, timedOut, missing, seconds }.
   * TeX writes its files where it runs, in the document's top folder, under the main file's name. Throws when the
   * copy itself fails (a full disk, say), which is not TeX's failure.
   */
  const onTexLive = async (d, program) => {
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
      return {
        engine: program,
        pdf: pages !== null,
        pages,
        fatal: fatalInLog(text),
        timedOut,
        missing: notFoundInLog(text),
        errors: errorsInLog(text),
        seconds: Math.round((Date.now() - started) / 1000),
      };
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  };

  /** The canaries on TeX Live: each known-good document; true when it gives a page, nothing missing, no error. */
  const canaries = async () => {
    const out = {};
    for (const [engine, text] of Object.entries(CANARY_DOCUMENTS)) {
      const folder = path.join(work, 'canary-tex-live', engine);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'main.tex'), text);
      try {
        const r = await onTexLive({ folder, main: 'main.tex', bbl: false }, engine);
        out[engine] = r.pdf && (r.pages ?? 0) >= 1 && !r.fatal && !r.timedOut && r.missing.length === 0;
      } catch {
        out[engine] = false;
      }
    }
    return out;
  };

  canary.before = await canaries();
  save();
  const began = Date.now();
  for (const d of documents) {
    if (Date.now() - began > minutes * 60000) {
      stopped = `its ${minutes} minutes on TeX Live ran out`;
      console.log(`  the shard's time is up: ${documents.length - Object.keys(results).length} document(s) not measured on TeX Live`);
      break;
    }
    // The engine the paper asks for ('latex' is the DVI route), else the one the extension chose (its rule reads
    // the preamble), from its record or its in-flight mark.
    const program = referenceEngine(d.engine, ours[d.key]);
    // Marked before it runs: a document during which this process stops is not measured (docs/coverage-method.md).
    results[d.key] = { started: new Date().toISOString(), engine: program };
    save();
    try {
      results[d.key] = await onTexLive(d, program);
    } catch (err) {
      // Not TeX's failure (the copy failed on a full disk, say): the document is not measured, and says why.
      delete results[d.key];
      unmeasured[d.key] = message(err).slice(0, 200);
    }
    const r = results[d.key];
    console.log(r ? `  ${d.key}: ${r.pages ?? 'no'} page(s) on TeX Live (${program}${r.timedOut ? ', timed out' : ''})` : `  ${d.key}: not run on TeX Live (${unmeasured[d.key]})`);
    save();
  }
  canary.after = await canaries();
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
 * The documents the repository holds for a run without arXiv: each folder of the public corpus (test/corpus, CC0)
 * and each probe (rehearsalProbes), with the main file and engine chooseMain finds. P1 shows a figure that the
 * tests draw from code (test/corpus/P1/paper.tex); it is drawn here too, so that P1 is complete on TeX Live.
 */
async function repositoryDocuments() {
  const corpus = path.join(root, 'test', 'corpus');
  const docs = [
    ...readdirSync(corpus, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ key: `corpus-${e.name}`, kind: 'corpus', stratum: 'corpus', files: filesUnder(path.join(corpus, e.name)) })),
    ...rehearsalProbes().map((p) => ({ key: p.key, kind: 'probe', stratum: 'probe', files: new Map(Object.entries(p.files).map(([n, s]) => [n, Buffer.from(s)])) })),
  ];
  const p1 = docs.find((d) => d.key === 'corpus-P1');
  if (p1 && !p1.files.has('fig-response.pdf')) {
    p1.files.set('fig-response.pdf', await drawnFigure());
  }
  return docs.map((d) => {
    const chosen = chooseMain(d.files);
    if ('skip' in chosen) {
      throw new Error(`${d.key}: ${chosen.skip}`);
    }
    return { ...d, main: chosen.main, engine: chosen.engine, how: chosen.how };
  });
}

/**
 * Writes a document as arXiv packs a source (a gzipped tar in sources/), so that prepare and both compiles read it
 * as they read a paper; returns its papers.json entry.
 */
function writeDocument(dir, d) {
  const bytes = gzipSync(tarOf(d.files));
  const source = d.key.replace(/[^\w.-]/g, '_');
  writeFileSync(path.join(dir, 'sources', source), bytes);
  const fromTexLive = d.package ? { package: d.package, file: d.file, archiveSha512: d.archiveSha512 } : {};
  return { key: d.key, kind: d.kind, stratum: d.stratum, source, sha256: sha256(bytes), ...fromTexLive, main: d.main, engine: d.engine, how: d.how, ...(d.pstricks ? { pstricks: true } : {}) };
}

/** Whether papers.json is the arXiv frame's: neither a rehearsal nor the frame without arXiv. */
function arxivFrame(meta) {
  return !meta?.rehearsal && meta?.frame !== 'local';
}

/**
 * The rehearsal's sample, with no request to anyone: the repository's corpus and probes (repositoryDocuments).
 * papers.json says `rehearsal: true`; the report then checks the probes.
 */
export async function rehearse(dir) {
  const spec = readJson(path.join(root, 'engine', 'coverage-local-frame.json'));
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  const papers = (await repositoryDocuments()).map((d) => writeDocument(dir, d));
  const count = (s) => papers.filter((p) => p.stratum === s).length;
  const quotas = { corpus: count('corpus'), probe: count('probe') };
  writeJson(path.join(dir, 'papers.json'), { frame: 'rehearsal', rehearsal: true, seed: spec.seed, complete: true, quotas, papers, skipped: [] });
  writeJson(path.join(dir, 'frame.json'), {
    frame: 'rehearsal',
    rehearsal: true,
    strata: Object.fromEntries(Object.entries(quotas).map(([s, n]) => [s, { window: null, eligible: n, quota: n }])),
  });
  console.log(`rehearse: ${quotas.corpus} corpus documents and ${quotas.probe} probes; no request to anyone`);
}

// ---- Stage: local ---------------------------------------------------------------------------------------------------

/** A documentation archive's regular files, texmf-relative ("texmf-dist/" dropped). */
function docArchive(xzBytes) {
  const files = new Map();
  for (const e of readTar(unxz(xzBytes))) {
    if (e.type === 'file') {
      files.set(e.path.replace(/^texmf-dist\//, ''), Buffer.from(e.data));
    }
  }
  return files;
}

/**
 * The local stage's download from the snapshot's host: curl with curl's own User-Agent, as B1 downloads (the host's
 * bot check decides by the User-Agent: it lets curl's through, and answers Node's fetch, and curl with a project
 * User-Agent, with an HTML page), once, following no redirect. Returns { status, body, type (the Content-Type),
 * retryAfter (seconds, from a 429 or 503), error }.
 */
export function downloadWithCurl(url, maxBytes) {
  const r = curl(url, null, { maxBytes });
  const last = r.headers.split(/\r?\n\r?\n/).filter(Boolean).pop() ?? '';
  const type = /^content-type:\s*([^;\r\n]+)/im.exec(last)?.[1]?.trim().toLowerCase() ?? '';
  return { status: r.status, body: r.body, type, retryAfter: retryAfterSeconds(last), error: r.error };
}

/**
 * The first request of a measurement, before any other work: the tlpdb's signed checksum from the snapshot's
 * host, which must come back as the file (not an HTML page) and name the SHA-512 the pins hold. Throws otherwise.
 */
export async function mirrorCheck({ pins = readJson(path.join(root, 'engine', 'bundle-pins.json')), download = (url) => downloadWithCurl(url, 1024 * 1024) } = {}) {
  const url = `${pins.mirrors[0].replace('{snapshot}', pins.snapshot)}${pins.tlpdb.file.replace(/\.xz$/, '')}.sha512`;
  const reply = await download(url);
  const bad = badReply(reply);
  if (bad !== null) {
    throw new Error(`the snapshot's host did not give ${url}: ${bad}`);
  }
  const hash = /^([0-9a-f]{128})\b/.exec(reply.body.toString('latin1').trim())?.[1];
  if (hash !== pins.tlpdb.signedSha512) {
    throw new Error(`${url} does not name the pinned SHA-512 (${hash ?? 'none'}, not ${pins.tlpdb.signedSha512})`);
  }
  return `${url}: the signed SHA-512 the pins name`;
}

/** Why a download is not the file asked for, or null: an error, an HTTP status, an HTML page, the wrong size. */
export function badReply(reply, size) {
  if (reply.error) {
    return reply.error.slice(0, 120);
  }
  if (reply.status !== 200) {
    return `HTTP ${reply.status}`;
  }
  const head = Buffer.from(reply.body.subarray(0, 256)).toString('latin1').trimStart().toLowerCase();
  if (/html/.test(reply.type) || head.startsWith('<!doctype') || head.startsWith('<html')) {
    return 'an HTML page instead of the file (a bot check?)';
  }
  if (size !== undefined && reply.body.length !== size) {
    return `${reply.body.length} bytes, not the tlpdb's ${size}`;
  }
  return null;
}

/**
 * The frame without arXiv (docs/coverage-method.md). The pinned tlpdb, checked against its pin; the frame from it,
 * checked against what is written down (engine/coverage-local-frame.json: the counts and the members); the package
 * examples drawn by stratum and every template, each from its package's documentation archive (kept in `archives`),
 * checked by size and by the tlpdb's SHA-512; then the repository's corpus and probes. Requests go to the snapshot's
 * mirrors only, with curl, one at a time, paced. Writes sources/, papers.json and frame.json as the arXiv stages do,
 * so every later stage is the same. `download` and the pins and frame serve the tests.
 */
export async function local(
  dir,
  {
    archives = path.join(dir, 'archives'),
    download = null,
    pins = readJson(path.join(root, 'engine', 'bundle-pins.json')),
    spec = readJson(path.join(root, 'engine', 'coverage-local-frame.json')),
  } = {},
) {
  const maxBytes = readJson(path.join(root, 'engine', 'coverage-frame.json')).source.maxBytes;
  // The downloader is curl, with its own User-Agent, unless a test passes its own (`download(url)`).
  const fetchOne = download ?? ((url) => downloadWithCurl(url, maxBytes));
  if (!pins.tlpdb?.sha256 || !pins.tlpdb?.signatureChecked) {
    throw new Error('the snapshot is not pinned: engine/bundle-pins.json has no signature-checked tlpdb');
  }
  const mirrors = pins.mirrors.map((m) => m.replace('{snapshot}', pins.snapshot));
  const pacer = new Pacer(spec.fetch.secondsBetweenRequests, clock);
  // One request at a time, paced; curl follows no redirect, so every request stays on the pinned mirrors. A 429 or
  // 503 is waited out (its Retry-After, else 30 seconds, at most 10 minutes) before the next request.
  const get = async (url) => {
    const reply = await pacer.run(() => fetchOne(url));
    if (reply.status === 429 || reply.status === 503) {
      await pacer.hold(Math.min(reply.retryAfter ?? spec.fetch.retrySeconds, 600) * 1000);
    }
    return reply;
  };
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  // An earlier run's sample (restored from the cache) is never this run's: removed before anything can stop the
  // stage, so a stage that stops early leaves no sample to be uploaded or reported as its own.
  for (const stale of ['papers.json', 'frame.json']) {
    rmSync(path.join(dir, stale), { force: true });
  }

  // The tlpdb: from an earlier run's cache or a mirror, and only with the pinned SHA-256; in rounds, as the
  // archives are, so one busy moment of the host does not stop the stage.
  const tlpdbFile = path.join(dir, 'texlive.tlpdb.xz');
  let xz = existsSync(tlpdbFile) ? readFileSync(tlpdbFile) : null;
  if (!xz || sha256(xz) !== pins.tlpdb.sha256) {
    xz = null;
    let problems = [];
    for (let attempt = 1; attempt <= spec.fetch.attempts && !xz; attempt++) {
      problems = [];
      for (const base of mirrors) {
        const reply = await get(`${base}${pins.tlpdb.file}`);
        const bad = badReply(reply);
        if (bad === null && sha256(reply.body) === pins.tlpdb.sha256) {
          xz = reply.body;
          break;
        }
        problems.push(`${base}: ${bad ?? 'the SHA-256 is not the pin'}`);
      }
      if (!xz && attempt < spec.fetch.attempts) {
        await pacer.hold(spec.fetch.retrySeconds * attempt * 1000);
      }
    }
    if (!xz) {
      throw new Error(`no mirror gave the pinned tlpdb (${pins.tlpdb.file}, SHA-256 ${pins.tlpdb.sha256}): ${problems.join('; ')}`);
    }
    writeFileSync(tlpdbFile, xz);
  }
  const db = parseTlpdb(unxz(xz).toString('utf8'));
  const frame = localFrame(db, spec);
  const differs = frameDiffers(frame, spec.expected);
  if (differs) {
    throw new Error(differs);
  }
  const quotas = allocate(frame.counts.examples, spec.examples.sampleSize);
  const papers = [];
  const skipped = [];
  const save = (complete, stopped = null) =>
    writeJsonAtomic(path.join(dir, 'papers.json'), {
      frame: 'local',
      seed: spec.seed,
      tlpdb: pins.tlpdb.sha256,
      complete,
      ...(stopped ? { stopped } : {}),
      quotas,
      census: { template: frame.counts.templates, beamer: frame.counts.beamer },
      papers,
      skipped,
    });

  /**
   * A package's documentation archive: from the cache when its SHA-512 is the tlpdb's, else from the mirrors in
   * order, in rounds, a wait between rounds. Every reply is checked: no error, status 200, no HTML page, the tlpdb's
   * size and SHA-512. Returns { bytes }, or { unavailable } with what each mirror gave in the last round. A failed
   * download never draws a replacement: the package stays in the sample as not measured.
   */
  const archiveOf = async (name, pkg) => {
    const { file, checksum } = archiveFile(name, pkg, 'doc');
    const cached = path.join(archives, file);
    if (existsSync(cached) && sha512(readFileSync(cached)) === checksum) {
      return { bytes: readFileSync(cached) };
    }
    let problems = [];
    for (let attempt = 1; attempt <= spec.fetch.attempts; attempt++) {
      problems = [];
      for (const base of mirrors) {
        const reply = await get(`${base}archive/${file}`);
        const bad = badReply(reply, pkg.docContainerSize || undefined) ?? (sha512(reply.body) === checksum ? null : "the SHA-512 is not the tlpdb's");
        if (bad === null) {
          mkdirSync(path.dirname(cached), { recursive: true });
          writeFileSync(cached, reply.body);
          return { bytes: reply.body };
        }
        problems.push(`${base}: ${bad}`);
      }
      if (attempt < spec.fetch.attempts) {
        await pacer.hold(spec.fetch.retrySeconds * attempt * 1000);
      }
    }
    return { unavailable: problems.join('; ').slice(0, 300) };
  };

  /**
   * A package's document (docs/coverage-method.md, "One document per package"): its first example file, in draw
   * order, that is a LaTeX main file, with that file's folder. The package is skipped only for what the snapshot
   * decides: no example file is a LaTeX main file, its checked archive cannot be read, or that file's folder cannot
   * be used. It is kept as "not measured" when its archive could not be downloaded, so the sample never depends on
   * the network.
   */
  const take = async (name, kind, stratum) => {
    const pkg = db.get(name);
    if (pkg.docContainerSize > maxBytes) {
      return { skip: `its documentation archive is larger than ${maxBytes} bytes` };
    }
    const got = await archiveOf(name, pkg);
    if (got.unavailable) {
      return { unavailable: got.unavailable };
    }
    let archive;
    try {
      archive = docArchive(got.bytes);
    } catch (err) {
      return { skip: `an unreadable documentation archive (${message(err).slice(0, 200)})` };
    }
    const file = exampleOrder(spec.seed, name, exampleFiles(pkg, spec.names)).find((p) => archive.has(p) && isLatexMain(archive.get(p).toString('utf8')));
    if (!file) {
      return { skip: 'no example file is a LaTeX main file' };
    }
    const files = exampleFolder(archive, file);
    const problem = filesProblem(files, maxBytes);
    if (problem !== null) {
      return { skip: `its example's folder cannot be used (${problem})` };
    }
    const bytes = archive.get(file);
    const main = file.slice(file.lastIndexOf('/') + 1);
    // A % !TEX program line (latex is the DVI route), else the engine its documentation tree names, else the
    // extension's rule decides.
    const engine = chooseMain(new Map([[main, bytes]])).engine ?? docTreeEngine(file);
    return {
      key: `${kind}:${name}`,
      kind,
      stratum,
      package: name,
      file,
      archiveSha512: pkg.docContainerChecksum,
      files,
      main,
      engine,
      pstricks: loadsPstricks(bytes.toString('utf8')),
      how: 'the first LaTeX main file among its example files, in draw order',
    };
  };
  // The host stopped answering: after so many packages in a row without a download, the stage fails with an error,
  // instead of spending its minutes on a run that the bound on "not measured" would fail anyway. Its sample is saved
  // as incomplete, with the reason, so no compile job runs on it and the report says why it has no shares.
  let unavailableInARow = 0;
  const add = async (name, kind, stratum) => {
    const d = await take(name, kind, stratum);
    if ('unavailable' in d) {
      // Kept in the sample and counted as not measured: never replaced by the next package.
      papers.push({ key: `${kind}:${name}`, kind, stratum, package: name, unavailable: d.unavailable });
      console.log(`  ${name}: its documentation archive could not be downloaded; counted as not measured`);
      unavailableInARow++;
      if (unavailableInARow >= spec.fetch.stopAfter) {
        const why = `the snapshot's host stopped answering: ${unavailableInARow} packages in a row could not be downloaded (the last: ${d.unavailable})`;
        save(false, why);
        throw new Error(why);
      }
      return true;
    }
    unavailableInARow = 0;
    if ('skip' in d) {
      skipped.push({ id: name, kind, stratum, why: d.skip });
      return false;
    }
    papers.push(writeDocument(dir, d));
    return true;
  };

  for (const [stratum, names] of Object.entries(frame.examples)) {
    let taken = 0;
    for (const name of names) {
      if (taken >= (quotas[stratum] ?? 0)) {
        break;
      }
      taken += (await add(name, 'example', stratum)) ? 1 : 0;
    }
    console.log(`  ${stratum}: ${taken} of ${quotas[stratum] ?? 0} package examples`);
    save(false);
  }
  for (const [kind, names] of [['template', frame.templates], ['beamer', frame.beamer]]) {
    let taken = 0;
    for (const name of names) {
      taken += (await add(name, kind, null)) ? 1 : 0;
    }
    console.log(`  ${kind}: ${taken} of ${names.length} packages`);
    save(false);
  }
  for (const d of await repositoryDocuments()) {
    papers.push(writeDocument(dir, d));
  }
  save(true);
  writeJson(path.join(dir, 'frame.json'), {
    frame: 'local',
    seed: spec.seed,
    snapshot: pins.snapshot,
    tlpdb: pins.tlpdb.sha256,
    strata: Object.fromEntries(Object.entries(frame.counts.examples).map(([s, n]) => [s, { window: null, eligible: n, quota: quotas[s] ?? 0 }])),
    census: { template: frame.counts.templates, beamer: frame.counts.beamer },
  });
  console.log(`local: ${papers.length} documents; ${skipped.length} packages skipped; no request to arXiv`);
}

// ---- Stage: report --------------------------------------------------------------------------------------------------

/** A skip reason without its details, to count reasons ("no source (404)" -> "no source"). */
const reasonOf = (why) => why.replace(/\s*\(.*$/, '');

/**
 * The report stage (exported for its test): every sampled document, from papers.json and the pinned templates.
 * `commit` is the commit the report runs on (the workflow's GITHUB_SHA, which the caller passes; null when unknown),
 * so the report depends on its arguments, not on the environment. Returns { complete, checks }: in a rehearsal, a
 * check that fails makes the stage fail.
 */
export function report(dir, results, out, shardsArg, { commit = null } = {}) {
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
  const mode = papersFile?.frame === 'local' ? 'local' : papersFile?.rehearsal === true ? 'rehearsal' : 'arxiv';
  const mainKind = { local: 'example', rehearsal: 'corpus', arxiv: 'paper' }[mode];
  const sample = sampleDocuments(papersFile?.papers ?? [], mode === 'arxiv' ? list.templates : [], papersFile?.seed ?? rules.seed, shards);
  const { documents, missingShards } = assemble(sample, shards, byShard);
  const result = buildReport(documents, frame, rules.compile.pageTolerance, mainKind);

  // What the report cannot vouch for comes first.
  if (!papersFile) {
    notes.unshift('There is no papers.json: the sample is unknown, and no paper is counted.');
  } else if (papersFile.complete !== true) {
    notes.unshift(
      mode === 'local'
        ? `The local stage stopped before the sample was drawn in full${papersFile.stopped ? ` (${papersFile.stopped})` : ''}: ${papersFile.papers.length} documents. No share of this run stands.`
        : `The fetch stopped before every quota was met: ${papersFile.papers.length} of ${rules.sampleSize} papers were sampled.`,
    );
  }
  if (missingShards.length > 0) {
    const lost = documents.filter((d) => missingShards.includes(d.shard)).length;
    notes.unshift(`Shard(s) ${missingShards.join(', ')} of ${shards} returned no results: their ${lost} document(s) are counted as not measured.`);
  }
  const short = Object.entries(papersFile?.quotas ?? {})
    .map(([s, q]) => [s, q, (papersFile?.papers ?? []).filter((p) => p.stratum === s).length])
    .filter(([, q, n]) => n < q);
  if (papersFile?.complete === true && short.length > 0) {
    notes.push(`Stratum ${short.map(([s, q, n]) => `${s} has ${n} of its ${q}`).join(', ')} (it ran out of eligible ${mode === 'local' ? 'packages' : 'papers with LaTeX sources'}).`);
  }
  // The shards and the report must have run on one commit; a shard that recorded none is named as such.
  const unrecorded = found.filter((f) => !f.shard.commit).map((f) => f.index);
  const others = [...new Set(found.map((f) => f.shard.commit).filter((c) => c && c !== commit))];
  if (commit && unrecorded.length > 0) {
    notes.push(`Shard(s) ${unrecorded.join(', ')} recorded no commit; the report ran on ${commit}.`);
  }
  if (commit && others.length > 0) {
    notes.push(`Shards ran on commit(s) ${others.join(', ')}, the report on ${commit}.`);
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
    mode,
    method: {
      'docs/coverage-method.md': fileHash('docs/coverage-method.md'),
      'engine/coverage-frame.json': fileHash('engine/coverage-frame.json'),
      'engine/coverage-local-frame.json': fileHash('engine/coverage-local-frame.json'),
      'engine/coverage-templates.json': fileHash('engine/coverage-templates.json'),
    },
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
  // The checks: the rehearsal's, and for the frame without arXiv the bound on what was not measured in each part.
  const localSpec = readJson(path.join(root, 'engine', 'coverage-local-frame.json'));
  const parts = ['example', 'template', 'beamer', 'corpus'];
  const checks =
    mode !== 'arxiv'
      ? [
          ...rehearsalChecks(documents, { offline: references.length > 0 && full.referenceOffline, ghostscript: full.ghostscript }),
          ...(mode === 'local' ? measuredChecks(documents, parts, localSpec.notMeasuredLimit, rules.compile.pageTolerance) : []),
          ...canaryChecks(found.map((f) => ({ index: f.index, canary: f.ours?.canary }))),
          ...canaryChecks(found.map((f) => ({ index: f.index, canary: f.reference?.canary })), 'tex-live'),
          ...(mode === 'local'
            ? [
                ...texLiveChecks(documents, ['example', 'template', 'beamer'], { fails: localSpec.failsOnTeXLiveLimit, broken: localSpec.brokenAsSubmittedLimit }),
                ...leftOutShardChecks(documents, ['example', 'template', 'beamer'], localSpec.shardLeftOutChance),
              ]
            : []),
        ]
      : null;
  // Package examples that load PSTricks may need the DVI route without asking for it (docs/coverage-method.md).
  const pst = documents.filter((d) => d.kind === 'example' && d.pstricks);
  const pstLeftOut = pst.filter((d) => result.excluded.some((e) => e.key === d.key && e.as !== 'not measured'));
  full.pstricks = { examples: pst.length, leftOut: pstLeftOut.map((d) => d.key) };
  if (checks) {
    full.rehearsal = checks;
  }
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'coverage-report.json'), full);

  const counts = (items) => Object.entries(items.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join('; ');
  const left = result.papers.leftOut;
  const NONE = { k: 0, n: 0, share: null, low: null, high: null };
  const kind = (k) => result.kinds[k] ?? { core: NONE, extra: NONE };
  const shareRow = (label, k) => `| ${label} | ${formatShare(kind(k).core)} | ${formatShare(kind(k).extra)} |`;
  const local = mode === 'local';
  const allDocs = result.documents;
  const failed = (checks ?? []).filter((c) => !c.ok);
  const lines = [
    ...(checks
      ? [
          failed.length === 0
            ? local
              ? `**All ${checks.length} checks pass.** No request went to arXiv.`
              : `**Rehearsal: all ${checks.length} checks pass.** No arXiv paper was fetched; the shares below are not a measurement.`
            : `**${local ? '' : 'Rehearsal: '}${failed.length} of ${checks.length} checks fail** (${failed.map((c) => c.key).join(', ')}). ${local ? 'The shares below do not count until every check passes.' : 'No arXiv paper was fetched.'}`,
          '',
          '| Check | What it proves | Result | Got |',
          '|---|---|---|---|',
          ...checks.map((c) => `| ${c.key} | ${c.what} | ${c.ok ? 'pass' : 'FAIL'} | ${c.got} |`),
          '',
        ]
      : []),
    full.complete ? `**Complete.** Every one of the ${allDocs.length} sampled documents has an outcome.` : `**Incomplete.** ${notes.join(' ')}`,
    '',
    local ? "# Coverage of TeX Live's own example and template documents (M5, without arXiv)" : '# Coverage measurement (M5)',
    '',
    ...(local
      ? [
          "These are documents TeX Live's packages ship as examples, samples, templates and demos. They are written to compile and to show their own package, so the shares measure package coverage, not papers (docs/coverage-method.md).",
          '',
        ]
      : []),
    `Method: docs/coverage-method.md (SHA-256 ${full.method['docs/coverage-method.md'].slice(0, 12)}), commit ${commit ?? 'unknown'}. ` +
      `Reference: ${full.texLive.join(', ') || 'unknown'}, Ghostscript ${full.ghostscript.join(', ') || 'unknown'}, ${full.referenceOffline ? 'without network' : 'NOT shown to be without network'}. ` +
      `Data packages: ${packages.join(', ') || 'unknown'}.`,
    '',
    '| Documents | Core alone | Core with extra |',
    '|---|---|---|',
    ...(local
      ? [
          shareRow('Package examples (one per package, by stratum)', 'example'),
          shareRow('Journal, conference and thesis templates (publisher collection)', 'template'),
          shareRow('Beamer packages and themes', 'beamer'),
          shareRow('Public corpus', 'corpus'),
        ]
      : mode === 'rehearsal'
        ? [shareRow('Public corpus', 'corpus')]
        : [
            `| arXiv papers | ${formatShare(result.papers.core)} | ${formatShare(result.papers.extra)} |`,
            `| Thesis templates | ${formatShare(result.thesis.core)} | ${formatShare(result.thesis.extra)} |`,
            `| Beamer templates | ${formatShare(result.beamer.core)} | ${formatShare(result.beamer.extra)} |`,
          ]),
    '',
    `${local ? 'Package examples' : mode === 'rehearsal' ? 'Corpus documents' : 'Papers'} left out of the shares: ${left['not measured']} not measured, ${left['broken as submitted']} broken as submitted (a file missing on TeX Live too), ` +
      `${left['fails on TeX Live']} that do not compile on TeX Live either. Skipped while the sample was drawn: ${skipped.length}` +
      `${skipped.length ? ` (${counts(skipped.map((s) => reasonOf(s.why)))})` : ''}.`,
    '',
    ...(local
      ? [
          '| Part | In the frame | Drawn | Skipped while drawn | Not measured (download; engine; other) | Left out (TeX Live) | Counted |',
          '|---|---|---|---|---|---|---|',
          ...parts.map((k) => {
            // The frame's own sizes, as the local stage wrote them in frame.json.
            const inFrame =
              k === 'example' ? Object.values(frame.strata ?? {}).reduce((a, s) => a + (s.eligible ?? 0), 0) : k === 'corpus' ? (result.kinds[k]?.documents ?? 0) : (frame.census?.[k] ?? '');
            const skips = skipped.filter((s) => s.kind === k);
            const drawn = (result.kinds[k]?.documents ?? 0) + skips.length;
            const l = result.kinds[k]?.leftOut ?? { 'not measured': 0, 'broken as submitted': 0, 'fails on TeX Live': 0 };
            const reasons = skips.length ? ` (${counts(skips.map((s) => reasonOf(s.why)))})` : '';
            const why = documents.filter((d) => d.kind === k && d.notMeasured).map((d) => d.notMeasured);
            const download = why.filter((w) => /documentation archive could not be/.test(w)).length;
            const engine = why.filter((w) => /engine rejected/.test(w)).length;
            const causes = `${l['not measured']} (${download}; ${engine}; ${l['not measured'] - download - engine})`;
            return `| ${k} | ${inFrame} | ${drawn} | ${skips.length}${reasons} | ${causes} | ${l['broken as submitted'] + l['fails on TeX Live']} | ${result.kinds[k]?.core.n ?? 0} |`;
          }),
          '',
          // What the bound on "not measured" allows: the most it could move each share.
          ...parts.map((k) => {
            const x = result.kinds[k];
            const pc = (s) => (s && s.share !== null ? `${(100 * s.share).toFixed(1)} %` : 'n/a');
            return x
              ? `${k}: core alone ${pc(x.core)}, from ${pc(x.worst.core)} (every document not measured failing) to ${pc(x.best.core)} (every one compiling); ` +
                  `core with extra ${pc(x.extra)}, from ${pc(x.worst.extra)} to ${pc(x.best.extra)}.`
              : `${k}: no documents.`;
          }),
          '',
          `The package examples' share stratified by the frame's stratum sizes (beside the pooled share above): core ${result.stratified.core === null ? 'n/a' : `${(100 * result.stratified.core).toFixed(1)} %`}, core with extra ${result.stratified.extra === null ? 'n/a' : `${(100 * result.stratified.extra).toFixed(1)} %`}.`,
          '',
          `Not measured, per part (the run counts only with at most ${(100 * localSpec.notMeasuredLimit).toFixed(0)} % in each): ` +
            parts.map((k) => `${k} ${result.kinds[k]?.leftOut['not measured'] ?? 0} of ${result.kinds[k]?.documents ?? 0}`).join(', ') +
            '.',
          '',
          `Package examples that load PSTricks: ${pst.length}; left out of the shares: ${pstLeftOut.length}${pstLeftOut.length ? ` (${pstLeftOut.map((d) => d.key).join(', ')})` : ''}. They may need the DVI route without asking for it.`,
          '',
          // Rule 4's documents: run on another engine than TeX Live's (a LuaLaTeX request on XeTeX, the DVI route on
          // pdfLaTeX), each counted as compiling only with no more TeX errors than TeX Live's log.
          'Run on another engine than TeX Live (a LuaLaTeX request on XeTeX, the DVI route on pdfLaTeX; rule 4): ' +
            parts
              .map((k) => {
                const s = result.kinds[k]?.swapped ?? { documents: 0, compiles: 0, moreErrors: 0 };
                return `${k} ${s.documents} (compile with core alone: ${s.compiles}; fail only for more TeX errors than TeX Live: ${s.moreErrors})`;
              })
              .join(', ') +
            '.',
          '',
        ]
      : []),
    `Engines${local ? ' (package examples)' : ''}: ${Object.entries(result.engines).map(([e, x]) => `${e === 'latex' ? 'latex (the DVI route)' : e} ${x.papers} (${x.leftOut} left out)`).join(', ') || 'none'}.`,
    '',
    ...(mode === 'arxiv'
      ? [
          `Sensitivity figure, not for the README: reweighted to all papers of the window, assuming that within a stratum CC BY and CC0 papers compile as often as the rest: ` +
            `core ${result.papers.reweighted.core === null ? 'n/a' : `${(100 * result.papers.reweighted.core).toFixed(1)} %`}, ` +
            `core with extra ${result.papers.reweighted.extra === null ? 'n/a' : `${(100 * result.papers.reweighted.extra).toFixed(1)} %`}.`,
          '',
          '| Stratum | Papers in the window | CC BY or CC0 | Sampled | Not measured | Left out (TeX Live) | Core alone | Core with extra |',
        ]
      : [`| Stratum | ${local ? 'Packages with examples' : 'Documents'} | Quota | Sampled | Not measured | Left out (TeX Live) | Core alone | Core with extra |`]),
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(result.strata).map(
      ([id, s]) =>
        `| ${id} | ${mode === 'arxiv' ? (s.window ?? '') : (s.eligible ?? '')} | ${mode === 'arxiv' ? (s.eligible ?? '') : (frame.strata?.[id]?.quota ?? '')} | ${s.sampled} | ${s.leftOut['not measured']} | ${s.leftOut['broken as submitted'] + s.leftOut['fails on TeX Live']} | ${formatShare(s.core)} | ${formatShare(s.extra)} |`,
    ),
    '',
    `## Missing packages (${mode === 'arxiv' ? 'papers' : 'documents'} that fail with core alone)`,
    '',
    `| Package | ${mode === 'arxiv' ? 'Papers' : 'Documents'} | Where |`,
    '|---|---|---|',
    ...result.missingPackages.slice(0, 40).map((m) => `| ${m.package} | ${m.documents} | ${m.where} |`),
    '',
    `Blocked attempts to start a program or open a connection on the extension's side: ${result.blocked.length} document(s)` +
      `, ${stubs.reduce((n, s) => n + (s.blocked?.length ?? 0), 0)} in the runner itself` +
      `; compiles whose worker sent no stubs record: ${stubs.reduce((n, s) => n + (s.workers?.withoutRecord ?? 0), 0)}` +
      `; compiles the engine rejected (after one more try on a fresh service): ${stubs.reduce((n, s) => n + (s.workers?.rejected ?? 0), 0)}` +
      `; starts or loads tried again: ${stubs.reduce((n, s) => n + (s.workers?.startRetried ?? 0), 0)}` +
      `; engine hosts that died during a compile (each retried once): ${stubs.reduce((n, s) => n + (s.workers?.died ?? 0), 0)}` +
      `, of which a fresh engine could not start after: ${stubs.reduce((n, s) => n + (s.workers?.restartFailed ?? 0), 0)}` +
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
  for (const p of [dir, templatesDir, arg('--work'), arg('--out'), arg('--results'), arg('--texdir'), arg('--archives')].filter(Boolean)) {
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
  if ((stage === 'sample' || stage === 'fetch') && !arxivEnabled(frame)) {
    console.error("coverage.mjs: the arXiv frame waits for arXiv's permission (engine/coverage-frame.json harvest.enabled is false; docs/coverage-method.md). No request goes to arXiv.");
    process.exit(2);
  }
  try {
    if (stage === 'sample') {
      mkdirSync(dir, { recursive: true });
      await sample(dir, frame);
    } else if (stage === 'fetch') {
      await fetchSources(dir, frame);
    } else if (stage === 'templates') {
      await templates(templatesDir, process.argv.includes('--pin'), frame);
    } else if (stage === 'prepare') {
      prepare(dir, templatesDir, arg('--shard') ?? '0/1', path.resolve(arg('--work') ?? path.join(dir, 'work')), frame, { commit: process.env.GITHUB_SHA ?? null });
    } else if (stage === 'reference') {
      await reference(path.resolve(arg('--work') ?? path.join(dir, 'work')), Number(arg('--minutes') ?? 60));
    } else if (stage === 'profile') {
      process.stdout.write(referenceProfile(path.resolve(arg('--texdir') ?? '')));
    } else if (stage === 'report') {
      const { checks } = report(dir, path.resolve(arg('--results') ?? path.join(dir, 'results')), path.resolve(arg('--out') ?? path.join(dir, 'report')), arg('--shards'), {
        commit: process.env.GITHUB_SHA ?? null,
      });
      if (checks && checks.some((c) => !c.ok)) {
        process.exitCode = 1;
      }
    } else if (stage === 'rehearse') {
      mkdirSync(dir, { recursive: true });
      await rehearse(dir);
    } else if (stage === 'mirror-check') {
      console.log(await mirrorCheck());
    } else if (stage === 'local') {
      mkdirSync(dir, { recursive: true });
      await local(dir, { archives: path.resolve(arg('--archives') ?? path.join(dir, 'archives')) });
    } else {
      console.error('--stage mirror-check | local | rehearse | prepare | reference | report | profile | templates (sample and fetch wait for arXiv)');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`coverage ${stage}: ${message(err)}`);
    process.exitCode = 1;
  }
}
