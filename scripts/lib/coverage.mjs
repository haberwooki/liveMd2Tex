// M5's coverage measurement (docs/coverage-method.md; docs/DESIGN.md#engine-and-data, #testing): the pure parts, with
// no file, network or process access, so the unit tests check each rule. scripts/coverage.mjs does the work.
//
//   - the OAI-PMH pages of arXiv's `arXiv` metadata format, read into records;
//   - the frame: which records are in the window, under an eligible licence, and in which stratum;
//   - the draw: the order by SHA-256 of "<seed>:<id>", and the quotas by largest remainders;
//   - the sample's documents in draw order, each with its shard;
//   - the pacer that keeps one request every three seconds;
//   - a source's kind, its main file, its engine, and whether its files fit in a folder;
//   - whether a compile "compiles" (the same rules for both sides), the Wilson interval;
//   - every sampled document's result or the reason it has none, and the report.

import { createHash } from 'node:crypto';
import { texmfPath } from './tlpdb.mjs';

// ---- The reference ------------------------------------------------------------------------------------------------

/** The install-tl profile of the reference: all of TeX Live (scheme-full) under `dir`, without documentation or sources. */
export function referenceProfile(dir) {
  const d = dir.replace(/\/+$/, '');
  return [
    'selected_scheme scheme-full',
    `TEXDIR ${d}`,
    `TEXMFLOCAL ${d}/texmf-local`,
    `TEXMFSYSVAR ${d}/texmf-var`,
    `TEXMFSYSCONFIG ${d}/texmf-config`,
    `TEXMFVAR ${d}/user/texmf-var`,
    `TEXMFCONFIG ${d}/user/texmf-config`,
    `TEXMFHOME ${d}/user/texmf`,
    'instopt_adjustpath 0',
    'instopt_adjustrepo 0',
    'tlpdbopt_autobackup 0',
    'tlpdbopt_install_docfiles 0',
    'tlpdbopt_install_srcfiles 0',
    '',
  ].join('\n');
}

// ---- OAI-PMH pages ------------------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its five entities and numeric references decoded. */
export function xmlText(s) {
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e],
  );
}

/** The text of the first element `name` in `xml` (namespace prefixes ignored), or undefined. */
function element(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? xmlText(m[1].trim()) : undefined;
}

/**
 * One ListRecords page: its records ({ id, created, categories, license, deleted }), its resumption token (null on
 * the last page), the list's size and this page's cursor when the token gives them (else null), and an OAI error
 * ({ code, message }) when there is one ("noRecordsMatch" is an empty answer).
 */
export function parseOaiPage(xml) {
  const err = /<error\s+code="([^"]+)"[^>]*>([\s\S]*?)<\/error>/.exec(xml);
  if (err) {
    return { records: [], token: null, listSize: null, cursor: null, error: { code: err[1], message: xmlText(err[2].trim()) } };
  }
  const records = [];
  for (const m of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const body = m[1];
    const header = /<header([^>]*)>([\s\S]*?)<\/header>/.exec(body);
    const deleted = header ? /status="deleted"/.test(header[1]) : false;
    const identifier = header ? element(header[2], 'identifier') : undefined;
    const id = element(body, 'id') ?? identifier?.replace(/^oai:arXiv\.org:/, '');
    if (!id) {
      continue;
    }
    const categories = (element(body, 'categories') ?? '').split(/\s+/).filter(Boolean);
    records.push({ id, created: element(body, 'created') ?? null, categories, license: element(body, 'license') ?? null, deleted });
  }
  const t = /<resumptionToken([^>]*?)\/?>(?:([^<]*)<\/resumptionToken>)?/.exec(xml);
  const token = t && t[2] && t[2].trim() ? xmlText(t[2].trim()) : null;
  const attribute = (name) => {
    const m = t ? new RegExp(`\\b${name}="(\\d+)"`).exec(t[1]) : null;
    return m ? Number(m[1]) : null;
  };
  return { records, token, listSize: attribute('completeListSize'), cursor: attribute('cursor'), error: null };
}

// ---- The frame ----------------------------------------------------------------------------------------------------

/** The stratum of a list of categories: by the first listed one; null when no stratum takes it. */
export function stratumOf(categories, strata) {
  const first = categories[0];
  if (!first) {
    return null;
  }
  for (const s of strata) {
    if (s.prefixes.some((p) => (p.endsWith('.') ? first.startsWith(p) : first === p || first.startsWith(`${p}.`)))) {
      return s.id;
    }
  }
  return null;
}

/** Whether a record's first version falls in the window (dates as YYYY-MM-DD, both ends included). */
export function inWindow(record, window) {
  return !record.deleted && typeof record.created === 'string' && record.created >= window.from && record.created <= window.to;
}

/** Whether a record is in the frame: in the window, under an eligible licence, in a stratum. */
export function eligible(record, frame) {
  return inWindow(record, frame.window) && frame.licences.includes(record.license ?? '') && stratumOf(record.categories, frame.strata) !== null;
}

// ---- The draw -----------------------------------------------------------------------------------------------------

/** The draw's order key of an arXiv id: the SHA-256 of "<seed>:<id>", in hex. */
export function orderKey(seed, id) {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/** The ids of a stratum in the order they are taken. */
export function drawOrder(seed, ids) {
  return [...ids].map((id) => ({ id, key: orderKey(seed, id) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.id);
}

/**
 * Quotas in proportion to `counts` (stratum -> eligible papers) summing to `total`, by largest remainders, with at
 * least one for every stratum that has a paper (taken from the largest quotas when the minimum overshoots).
 */
export function allocate(counts, total) {
  const ids = Object.keys(counts).filter((k) => counts[k] > 0);
  const sum = ids.reduce((n, k) => n + counts[k], 0);
  const quotas = {};
  if (sum === 0 || total <= 0) {
    return quotas;
  }
  const exact = ids.map((k) => ({ k, q: (counts[k] * total) / sum }));
  for (const { k, q } of exact) {
    quotas[k] = Math.floor(q);
  }
  let left = total - exact.reduce((n, { k }) => n + quotas[k], 0);
  for (const { k } of [...exact].sort((a, b) => b.q - Math.floor(b.q) - (a.q - Math.floor(a.q)) || (a.k < b.k ? -1 : 1))) {
    if (left <= 0) {
      break;
    }
    quotas[k]++;
    left--;
  }
  for (const k of ids) {
    while (quotas[k] < 1) {
      const donor = ids.filter((d) => quotas[d] > 1).sort((a, b) => quotas[b] - quotas[a] || (a < b ? -1 : 1))[0];
      if (!donor) {
        break;
      }
      quotas[donor]--;
      quotas[k]++;
    }
    quotas[k] = Math.min(quotas[k], counts[k]);
  }
  return quotas;
}

/**
 * The documents to compile, as every compile job and the report see them: the sampled papers (papers.json) and the
 * main files of the pinned templates, in draw order (the SHA-256 of "<seed>:<key>"), each given its shard (its
 * place modulo `shards`). The strata are interleaved, so a shard that runs out of time leaves a random tail.
 */
export function sampleDocuments(papers, templates, seed, shards) {
  const docs = [
    ...papers.map((p) => ({ ...p })),
    ...templates.filter((t) => t.sha256).flatMap((t) => t.mains.map((main) => ({ key: `${t.id}:${main}`, kind: t.kind, stratum: null, template: t.id, main }))),
  ];
  const keyed = docs.map((d) => ({ d, k: orderKey(seed, d.key) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.map(({ d }, i) => ({ ...d, shard: i % shards }));
}

// ---- The rehearsal ------------------------------------------------------------------------------------------------

/** One ustar header block. */
function tarHeader(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/**
 * A tar archive of `files` ("/"-paths to bytes), as arXiv serves a source before gzip; a name longer than 100 bytes
 * gets a GNU long-name entry before it, which readTar (scripts/lib/tar.mjs) reads.
 */
export function tarOf(files) {
  const blocks = [];
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const [name, data] of files) {
    const bytes = Buffer.from(data);
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 100) {
      const long = Buffer.concat([nameBytes, Buffer.alloc(1)]);
      blocks.push(tarHeader('././@LongLink', long.length, 'L'), long, pad(long.length));
    }
    blocks.push(tarHeader(name, bytes.length, '0'), bytes, pad(bytes.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const EPS = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 10 10 moveto 90 90 lineto stroke\nshowpage\n%%EOF\n';
const BIB = Array.from({ length: 120 }, (_, i) => `@book{b${i},\n  author = {Example, Author${i}},\n  title = {A Rehearsal Title ${i}},\n  publisher = {Example Press},\n  year = {${2000 + (i % 25)}}\n}\n`).join('\n');

/**
 * The rehearsal's probes: small documents written for it, each proving one part of the reference before any arXiv
 * request, with what TeX Live must give for it (`ok`, on the reference's result). Written by the project; CC0.
 * No probe asks whether TeX can read outside the folder: since TeX Live 2026 it can, whatever openin_any says
 * (docs/coverage-method.md, "The reference").
 */
export function rehearsalProbes() {
  return [
    {
      key: 'probe-eps',
      what: 'an .eps figure is converted (repstopdf in the restricted shell escape, then Ghostscript)',
      files: { 'main.tex': String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics{figure.eps}
\end{document}
`, 'figure.eps': EPS },
      ok: (r) => r.pdf && r.pages === 1 && r.missing.length === 0 && !r.fatal,
    },
    {
      key: 'probe-dvi',
      what: "00README.json's latex runs the DVI route (latex, dvips, ps2pdf)",
      files: {
        '00README.json': JSON.stringify({ spec_version: 1, process: { compiler: 'latex' }, sources: [{ filename: 'main.tex', usage: 'toplevel' }] }),
        'main.tex': String.raw`\documentclass{article}
\usepackage{pstricks}
\begin{document}
\begin{pspicture}(0,0)(4,4)
\psframe(0,0)(4,4)
\psline(0,0)(4,4)
\end{pspicture}
\end{document}
`,
      },
      ok: (r) => r.engine === 'latex' && r.pdf && r.pages === 1 && !r.fatal,
    },
    {
      key: 'probe-biber',
      what: 'biber runs without network and fills the bibliography',
      files: { 'main.tex': String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
Text.\nocite{*}
\printbibliography
\end{document}
`, 'refs.bib': BIB },
      ok: (r) => r.pdf && r.pages >= 3 && !r.fatal,
    },
    {
      key: 'probe-missing',
      what: 'a file missing on TeX Live too is found, so the paper is left out as broken as submitted',
      files: { 'main.tex': String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
A figure the source lacks:
\includegraphics{missing-figure.pdf}
\end{document}
` },
      ok: (r) => r.missing.includes('missing-figure.pdf'),
    },
  ];
}

/**
 * The rehearsal's checks, from assembled documents (assemble) and the shards' facts ({ offline, ghostscript }):
 * [{ key, what, ok, got }]. Every probe gives what it must; every corpus document compiles on TeX Live and, with
 * core-data alone, on the extension; every corpus document and probe was measured on both sides; the reference ran
 * without network and with Ghostscript.
 */
export function rehearsalChecks(documents, facts) {
  const got = (r) =>
    r ? `${r.engine}, ${r.pages ?? 'no'} page(s)${r.missing.length ? `, missing ${r.missing.join(' ')}` : ''}${r.fatal ? ', fatal error' : ''}${r.timedOut ? ', timed out' : ''}` : 'not measured on TeX Live';
  const checks = [];
  for (const p of rehearsalProbes()) {
    const r = documents.find((d) => d.key === p.key)?.reference ?? null;
    checks.push({ key: p.key, what: p.what, ok: Boolean(r) && p.ok(r), got: got(r) });
  }
  for (const d of documents.filter((x) => x.stratum === 'corpus')) {
    // The corpus is the extension's own test set: it compiles with core-data alone, so a broken engine fails here.
    const ours = d.core && d.reference ? judge(d.core, d.reference) : { compiles: null, why: 'not measured' };
    checks.push({
      key: d.key,
      what: 'TeX Live, and the extension with core-data alone, compile this public corpus document',
      ok: Boolean(d.reference) && brokenRule(d.reference) === null && ours.compiles === true,
      got: `TeX Live: ${got(d.reference ?? null)}; the extension: ${ours.why}`,
    });
  }
  const repository = documents.filter((d) => d.stratum === 'corpus' || d.stratum === 'probe');
  const unmeasured = repository.filter((d) => d.notMeasured);
  checks.push({
    key: 'all',
    what: 'every corpus document and probe was measured on both sides',
    ok: repository.length > 0 && unmeasured.length === 0,
    got: unmeasured.length ? unmeasured.map((d) => `${d.key}: ${d.notMeasured}`).join('; ') : `${repository.length} documents`,
  });
  checks.push({ key: 'network', what: 'the reference ran without network in every shard', ok: facts.offline === true, got: String(facts.offline) });
  checks.push({ key: 'ghostscript', what: 'Ghostscript was there for the reference', ok: facts.ghostscript.length > 0, got: facts.ghostscript.join(', ') || 'none' });
  return checks;
}

// ---- The frame without arXiv ----------------------------------------------------------------------------------------

/** Whether a Catalogue topic falls under a stratum's pattern: "font*" is a prefix, any other pattern the whole topic. */
const topicMatches = (pattern, topic) => (pattern.endsWith('*') ? topic.startsWith(pattern.slice(0, -1)) : topic === pattern);

/** A package's stratum: the first stratum, in the frame's order, that one of its Catalogue topics falls under; else "other". */
export function topicStratum(topics, strata) {
  for (const s of strata) {
    if (s.topics.some((p) => topics.some((t) => topicMatches(p, t)))) {
      return s.id;
    }
  }
  return 'other';
}

/** A package's example files: the .tex files of its doc tree whose name matches `names` (case ignored), texmf-relative. */
export function exampleFiles(pkg, names) {
  const re = new RegExp(names, 'i');
  return pkg.docfiles
    .map((f) => texmfPath(f))
    .filter((p) => p !== null && p.startsWith('doc/') && /\.tex$/i.test(p) && re.test(p.split('/').pop()));
}

/**
 * The frame without arXiv (docs/coverage-method.md), from the pinned tlpdb (parseTlpdb) and engine/coverage-local-frame.json:
 * every package (category Package) with at least one example file, in one of three parts. A package of the
 * publishers' collection is a journal, conference or thesis template; a package with the presentation topic and
 * "beamer" in its name is a Beamer package; every other one is a package example, in its topic stratum. Returns
 * { examples: { stratum: [names in draw order] }, templates: [names in draw order], beamer: [...], counts }.
 */
export function localFrame(db, local) {
  const publishers = new Set(db.get(local.templates.collection)?.depends ?? []);
  const beamerName = new RegExp(local.templates.beamer.name, 'i');
  const examples = {};
  const templates = [];
  const beamer = [];
  for (const p of db.values()) {
    if (p.category !== 'Package' || exampleFiles(p, local.names).length === 0) {
      continue;
    }
    if (publishers.has(p.name)) {
      templates.push(p.name);
    } else if (p.topics.includes(local.templates.beamer.topic) && beamerName.test(p.name)) {
      beamer.push(p.name);
    } else {
      (examples[topicStratum(p.topics, local.examples.strata)] ??= []).push(p.name);
    }
  }
  const ordered = Object.fromEntries(Object.entries(examples).map(([s, names]) => [s, drawOrder(local.seed, names)]));
  return {
    examples: ordered,
    templates: drawOrder(local.seed, templates),
    beamer: drawOrder(local.seed, beamer),
    counts: { examples: Object.fromEntries(Object.entries(ordered).map(([s, n]) => [s, n.length]).sort((a, b) => (a[0] < b[0] ? -1 : 1))), templates: templates.length, beamer: beamer.length },
  };
}

/**
 * The engine an example file's documentation tree names: doc/lualatex/ and doc/luatex/ hold LuaLaTeX packages,
 * doc/xelatex/ XeLaTeX ones.
 */
export function docTreeEngine(file) {
  return /^doc\/(lualatex|luatex)\//.test(file) ? 'lualatex' : /^doc\/xelatex\//.test(file) ? 'xelatex' : null;
}

/** A package's example files in the order they are tried: by the SHA-256 of "<seed>:<package>/<path>". */
export function exampleOrder(seed, name, files) {
  return files
    .map((f) => ({ f, k: orderKey(seed, `${name}/${f}`) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.f);
}

/** The folder of an example file: every file of its doc archive under the file's own directory, relative to it. */
export function exampleFolder(archive, file) {
  const dir = file.slice(0, file.lastIndexOf('/'));
  return new Map([...archive].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, b]) => [p.slice(dir.length + 1), b]));
}

/** The SHA-256 of a frame's members in draw order (strata sorted by name): it holds the frame exactly, not only its counts. */
export function frameMembers(frame) {
  const examples = Object.fromEntries(Object.entries(frame.examples).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  return createHash('sha256').update(JSON.stringify({ examples, templates: frame.templates, beamer: frame.beamer })).digest('hex');
}

/**
 * Whether a frame is the one written down (engine/coverage-local-frame.json "expected": its counts and the SHA-256
 * of its members); else why not. `frame` is localFrame's result.
 */
export function frameDiffers(frame, expected) {
  const { counts } = frame;
  const a = JSON.stringify({ examples: counts.examples, templates: counts.templates, beamer: counts.beamer });
  const b = JSON.stringify({ examples: Object.fromEntries(Object.entries(expected.examples).sort((x, y) => (x[0] < y[0] ? -1 : 1))), templates: expected.templates, beamer: expected.beamer });
  if (a !== b) {
    return `the frame from the tlpdb (${a}) is not the one written down (${b})`;
  }
  const members = frameMembers(frame);
  return members === expected.members ? null : `the frame's members (SHA-256 ${members}) are not the ones written down (${expected.members})`;
}

// ---- The pacer ----------------------------------------------------------------------------------------------------

/**
 * One request at a time, each starting at least `seconds` after the previous one started (arXiv's terms: one
 * request every three seconds, one connection). `clock` gives now() in ms and sleep(ms); the tests pass a fake.
 */
export class Pacer {
  constructor(seconds, clock) {
    this.gap = seconds * 1000;
    this.clock = clock;
    this.last = -Infinity;
    this.busy = false;
  }

  /** Runs `request` (synchronous or async) when its turn comes; never two at once. */
  async run(request) {
    if (this.busy) {
      throw new Error('the pacer runs one request at a time');
    }
    this.busy = true;
    try {
      const wait = this.last + this.gap - this.clock.now();
      if (wait > 0) {
        await this.clock.sleep(wait);
      }
      this.last = this.clock.now();
      return await request();
    } finally {
      this.busy = false;
    }
  }

  /** Waits `ms` more before the next request (a Retry-After). */
  async hold(ms) {
    await this.clock.sleep(ms);
  }

  /** Counts a request made just now by another pacer (an earlier stage), so the next one waits its full gap. */
  mark() {
    this.last = this.clock.now();
  }
}

/** The engine files coverageRun hands to the engine service (dist/engine/): all must be there before a compile. */
export const ENGINE_FILES = ['busytex.js', 'busytex.wasm', 'texmf-override.cnf', 'fonts.conf'];

/** Which of `names` are missing, by `exists(name)`. */
export function missingFiles(names, exists) {
  return names.filter((n) => !exists(n));
}

/** Whether the arXiv frame may run: only when its frame file says so. It waits for arXiv's permission. */
export function arxivEnabled(frame) {
  return frame?.harvest?.enabled === true;
}

/**
 * Whether a URL is one the method may ask arXiv for: OAI-PMH at https://oaipmh.arxiv.org/oai, and a source at
 * https://export.arxiv.org/src/<id>, the hosts arXiv sets aside for programmatic access. Never arxiv.org itself,
 * whose robots.txt disallows /src, /e-print, /api and /oai2, and never another host or path.
 */
export function arxivEndpoint(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    return false;
  }
  if (u.hostname === 'oaipmh.arxiv.org') {
    return u.pathname === '/oai';
  }
  if (u.hostname === 'export.arxiv.org') {
    return /^\/src\/[\w.-]+(\/[\w.-]+)?$/.test(u.pathname) && !u.pathname.includes('..') && u.search === '';
  }
  return false;
}

/** The User-Agent of every request: the project, its version and the repository's address; no e-mail address. */
export function userAgent(template, version) {
  return template.replace('{version}', version);
}

/** The seconds of an HTTP Retry-After header (a number, or an HTTP date), capped at `max`; undefined without one. */
export function retryAfterSeconds(headers, now = Date.now(), max = 600) {
  const m = /^retry-after:\s*(.+?)\s*$/im.exec(headers);
  if (!m) {
    return undefined;
  }
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : Math.ceil((Date.parse(m[1]) - now) / 1000);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : undefined;
}

/**
 * What a source's answer says it is: the version from its content-disposition file name ("2607.01234v2.tar.gz"
 * -> "2607.01234v2") and its ETag, each null when absent. With several answers (redirects), the last one counts.
 */
export function sourceVersion(headers) {
  const blocks = headers.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : headers;
  const disposition = /^content-disposition:.*?filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/im.exec(last);
  const name = disposition ? (disposition[1].split(/[\\/]/).pop() ?? '') : '';
  const version = /^(.+?v\d+)(?:\.[A-Za-z0-9.]+)?$/.exec(name)?.[1] ?? null;
  const etag = /^etag:\s*(.+?)\s*$/im.exec(last);
  return { version, etag: etag ? etag[1] : null };
}

// ---- A source and its main file -------------------------------------------------------------------------------------

/** What the bytes of a downloaded source are: 'gzip', 'pdf', 'tar' or 'other'. */
export function sourceKind(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'gzip';
  }
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') {
    return 'pdf';
  }
  if (bytes.length >= 262 && Buffer.from(bytes.subarray(257, 262)).toString('latin1') === 'ustar') {
    return 'tar';
  }
  return 'other';
}

/** True when the bytes are a tar archive (the "ustar" magic at byte 257). */
export function isTar(bytes) {
  return sourceKind(bytes) === 'tar';
}

/** TeX text without its comments ("%" to the end of the line, unless the % is escaped). */
export function withoutComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '%') {
          let slashes = 0;
          for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) {
            slashes++;
          }
          if (slashes % 2 === 0) {
            return line.slice(0, i);
          }
        }
      }
      return line;
    })
    .join('\n');
}

/** Whether a .tex text is a LaTeX main file: \documentclass and \begin{document}, outside comments. */
export function isLatexMain(text) {
  const t = withoutComments(text);
  return /\\documentclass\s*[[{]/.test(t) && /\\begin\s*\{document\}/.test(t);
}

const PREFERRED = ['main', 'ms', 'paper', 'article', 'manuscript'];

/**
 * The main file of a source and the engine it asks for. `files` maps "/"-paths to bytes. Returns
 * { main, engine: 'pdflatex' | 'latex' | 'xelatex' | 'lualatex' | null, how } or { skip: reason }. `engine` is null
 * when only the extension's own rule decides (the preamble), which the compile applies. 00README.json's compiler
 * comes first (arXiv builds with it), then a "% !TEX program" line; 'latex' is arXiv's DVI route.
 */
export function chooseMain(files) {
  const names = [...files.keys()];
  const text = (p) => Buffer.from(files.get(p)).toString('utf8');
  let readme;
  if (files.has('00README.json')) {
    try {
      readme = JSON.parse(text('00README.json'));
    } catch {
      readme = undefined;
    }
  }
  const compiler = typeof readme?.process?.compiler === 'string' ? readme.process.compiler : readme?.process?.compiler?.engine;
  if (typeof compiler === 'string' && /^(tex|pdftex|pdfetex|etex)\b/.test(compiler)) {
    return { skip: `plain TeX (${compiler})` };
  }
  const fromReadme = Array.isArray(readme?.sources)
    ? readme.sources.find((s) => s && s.usage === 'toplevel' && typeof s.filename === 'string' && files.has(s.filename))
    : undefined;
  let main;
  let how;
  if (fromReadme) {
    main = fromReadme.filename;
    how = '00README.json';
  } else {
    const candidates = names.filter((p) => !p.includes('/') && /\.tex$/i.test(p) && isLatexMain(text(p)));
    if (candidates.length === 0) {
      return { skip: names.some((p) => /\.tex$/i.test(p)) ? 'no LaTeX main file' : 'no .tex file' };
    }
    if (candidates.length === 1) {
      main = candidates[0];
      how = 'the one main file';
    } else {
      const byName = PREFERRED.map((n) => candidates.find((c) => c.toLowerCase() === `${n}.tex`)).find(Boolean);
      main = byName ?? [...candidates].sort((a, b) => files.get(b).length - files.get(a).length || (a < b ? -1 : 1))[0];
      how = byName ? 'by its name' : 'the largest';
    }
  }
  const magic = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(text(main).split(/\r?\n/).slice(0, 40).join('\n'));
  let engine = null;
  if (typeof compiler === 'string') {
    if (/xelatex|xetex/.test(compiler)) {
      engine = 'xelatex';
    } else if (/lualatex|luatex/.test(compiler)) {
      engine = 'lualatex';
    } else if (/pdflatex/.test(compiler)) {
      engine = 'pdflatex';
    } else if (/^latex\b/.test(compiler)) {
      engine = 'latex';
    }
  }
  if (engine === null && magic && /^(xelatex|lualatex|pdflatex|latex)$/i.test(magic[1])) {
    engine = magic[1].toLowerCase();
  }
  return { main, engine, how };
}

/**
 * Why a source's files cannot be written out as one folder, or null: more than `maxBytes` in all, or a path that is
 * a file and also the folder of another file ("a" and "a/b"), which no file system can hold.
 */
export function filesProblem(files, maxBytes) {
  let total = 0;
  for (const data of files.values()) {
    total += data.length;
  }
  if (total > maxBytes) {
    return `more than ${maxBytes} bytes unpacked`;
  }
  const folders = new Set();
  for (const p of files.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'));
    }
  }
  const both = [...files.keys()].find((p) => folders.has(p));
  return both === undefined ? null : `"${both}" is both a file and a folder`;
}

/** The shipped .bbl of a main file ("paper.tex" -> "paper.bbl"), if the source has it. */
export function shippedBbl(files, main) {
  const bbl = main.replace(/\.tex$/i, '.bbl');
  return files.has(bbl) ? bbl : null;
}

// ---- Whether a compile compiles --------------------------------------------------------------------------------------

/** A log's fatal stop: "Emergency stop" or "Fatal error". */
export function fatalInLog(log) {
  return /^! Emergency stop|^!.*Fatal error|^\S+:\d+: Emergency stop|Fatal error occurred/m.test(log ?? '');
}

/** The kpathsea settings that decide how TeX writes its log's lines: the reference takes the extension's values. */
export const LOG_LINE_SETTINGS = ['max_print_line', 'error_line', 'half_error_line'];

/**
 * The values of `names` in a kpathsea configuration text ("name = value" lines; "%" starts a comment), as strings.
 * Throws when one is not set, so the reference never runs with TeX Live's defaults by mistake.
 */
export function cnfSettings(text, names) {
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*([^%]*?)\s*(?:%.*)?$/.exec(line);
    if (m && names.includes(m[1])) {
      values[m[1]] = m[2];
    }
  }
  const missing = names.filter((n) => !(n in values) || values[n] === '');
  if (missing.length > 0) {
    throw new Error(`not set in the configuration: ${missing.join(', ')}`);
  }
  return values;
}

/**
 * The TeX errors in a log: lines that start with "!" or, with -file-line-error (both sides use it), with
 * "file:line: ". Errors TeX recovers from are counted too: rule 4 compares them for a document run on another
 * engine than TeX Live's (docs/coverage-method.md).
 */
export function errorsInLog(log) {
  return (log ?? '').split('\n').filter((l) => /^!|^[^\s:]+:\d+: /.test(l)).length;
}

/** The files a log says were not found ("File `x' not found"), sorted. */
export function notFoundInLog(log) {
  return [...new Set([...(log ?? '').matchAll(/File [`']([^`'\s]+)' not found/g)].map((m) => m[1]))].sort();
}

/**
 * The engine TeX Live runs for a document: the one the document asks for ('latex' is the DVI route), else the one
 * the extension chose by its own rule, which the extension's record or its in-flight mark holds
 * (docs/coverage-method.md, "A document in flight counts"), else pdfLaTeX.
 */
export function referenceEngine(requested, ours) {
  return requested ?? ours?.engine ?? 'pdflatex';
}

/**
 * Rules 1 and 2 of "compiles" (docs/coverage-method.md), the same for the extension's compile and the reference's:
 * the first rule a compile breaks, or null. An outcome is { pdf: boolean, pages: number | null, fatal: boolean,
 * missing: string[], timedOut?: boolean, unsupported?: string }.
 */
export function brokenRule(outcome) {
  if (outcome.crashed) {
    return 'the process stopped during this document';
  }
  if (outcome.engineStopped) {
    return outcome.restartFailed ? 'the engine stopped on this document, and a fresh one could not start after it' : 'the engine stopped on this document';
  }
  if (outcome.unsupported) {
    return outcome.unsupported;
  }
  if (outcome.timedOut) {
    return 'timed out';
  }
  if ((outcome.missing ?? []).length > 0) {
    return `missing ${outcome.missing.join(', ')}`;
  }
  if (!outcome.pdf || outcome.fatal) {
    return 'fatal error';
  }
  if (typeof outcome.pages !== 'number' || outcome.pages < 1) {
    return 'no readable page';
  }
  return null;
}

/**
 * Whether the extension ran another engine than TeX Live for a document: a LuaLaTeX request on XeTeX, or the DVI
 * route (`latex`) on pdfLaTeX. `ours`: the engine the extension ran; `reference`: TeX Live's outcome.
 */
export function engineSwapped(ours, reference) {
  return Boolean(ours && reference?.engine && ours !== reference.engine);
}

/**
 * Whether a compile of ours compiles, against the reference: { compiles, why }. Both sides are held to rules 1 and
 * 2 (brokenRule); a document whose reference breaks one is left out (compiles: null): with a missing file it is
 * broken as submitted, else it does not compile on TeX Live either. Rule 3 then compares the page counts. Either
 * side may be null when it was not measured; the report gives the reason (assemble).
 */
export function judge(ours, reference, tolerance = 1, { swapped = false } = {}) {
  if (!ours) {
    return { compiles: null, why: 'not measured' };
  }
  if (!reference) {
    return { compiles: null, why: 'not measured on TeX Live' };
  }
  const theirs = brokenRule(reference);
  if (theirs !== null) {
    return {
      compiles: null,
      why: theirs.startsWith('missing ') ? `broken as submitted: ${theirs} on TeX Live too` : `does not compile on TeX Live either (${theirs})`,
    };
  }
  const mine = brokenRule(ours);
  if (mine !== null) {
    return { compiles: false, why: mine };
  }
  if (Math.abs(ours.pages - reference.pages) > tolerance) {
    return { compiles: false, why: `${ours.pages} page(s), TeX Live ${reference.pages}` };
  }
  // Rule 4: on another engine than TeX Live's, no more TeX errors than TeX Live's log has (a package that does not
  // work on that engine often stops with an error TeX recovers from, and the PDF lacks what it does).
  if (swapped) {
    if (typeof ours.errors !== 'number' || typeof reference.errors !== 'number') {
      return { compiles: null, why: 'not measured: run on another engine than TeX Live, with no error count to compare' };
    }
    if (ours.errors > reference.errors) {
      return { compiles: false, why: `${ours.errors} TeX error(s) on another engine than TeX Live's, which has ${reference.errors}` };
    }
  }
  return { compiles: true, why: 'compiles' };
}

/**
 * One assembled document judged on both sides (assemble): { swapped, core, extra }, each side { compiles, why }. A
 * document not measured is so on both sides; one whose compile with the add-on alone was rejected is not measured
 * on that side only. The report and the bound on "not measured" both judge through this.
 */
export function judgeDocument(d, tolerance = 1) {
  if (d.notMeasured) {
    const out = { compiles: null, why: `not measured: ${d.notMeasured}` };
    return { swapped: false, core: out, extra: out };
  }
  const swapped = engineSwapped(d.ourEngine, d.reference);
  return {
    swapped,
    core: judge(d.core ?? null, d.reference ?? null, tolerance, { swapped }),
    extra: d.extraNotMeasured
      ? { compiles: null, why: `not measured: ${d.extraNotMeasured}` }
      : judge(d.extra ?? d.core ?? null, d.reference ?? null, tolerance, { swapped }),
  };
}

/** Whether the reference compile counts: it keeps rules 1 and 2. */
export function referenceCompiles(reference) {
  return Boolean(reference) && brokenRule(reference) === null;
}

// ---- Statistics ---------------------------------------------------------------------------------------------------

/**
 * The share k/n and its Wilson score interval (z = 1.96 for 95 %): E. B. Wilson, "Probable inference, the law of
 * succession, and statistical inference", J. Am. Stat. Assoc. 22 (1927) 209-212.
 */
export function wilson(k, n, z = 1.96) {
  if (n === 0) {
    return { k, n, share: null, low: null, high: null };
  }
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { k, n, share: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** A share as "62.5 % (95 % interval 58.1 to 66.7 %, 300 of 480)". */
export function formatShare(s) {
  if (s.share === null) {
    return 'no documents';
  }
  const pc = (x) => (100 * x).toFixed(1);
  return `${pc(s.share)} % (95 % interval ${pc(s.low)} to ${pc(s.high)} %, ${s.k} of ${s.n})`;
}

/**
 * Every sampled document with its results, or the reason it has none, so that no document leaves the report
 * uncounted. `sample` is sampleDocuments(...); `results` maps a shard's index to { shard (its shard.json), ours (its
 * ours.json, or null), reference (its reference.json, or null) } for the shards that came back. Returns
 * { documents, missingShards }; a document without both results carries `notMeasured` (why).
 */
export function assemble(sample, shards, results) {
  const missingShards = [];
  for (let i = 0; i < shards; i++) {
    if (!results[i]) {
      missingShards.push(i);
    }
  }
  const stopped = (file, side) => (file?.stopped ? `shard ${side}: ${file.stopped}` : `shard ${side}: the job stopped first`);
  const documents = sample.map((d) => {
    const base = { key: d.key, kind: d.kind, stratum: d.stratum ?? null, shard: d.shard, engine: d.engine ?? null, ...(d.pstricks ? { pstricks: true } : {}) };
    if (d.unavailable) {
      return { ...base, notMeasured: `its documentation archive could not be fetched (${d.unavailable})` };
    }
    const r = results[d.shard];
    if (!r) {
      return { ...base, notMeasured: `shard ${d.shard} returned no results` };
    }
    const unreadable = (r.shard?.unreadable ?? []).find((u) => u.key === d.key);
    if (unreadable) {
      return { ...base, notMeasured: `it could not be unpacked for its compile (${unreadable.why})` };
    }
    if (!(r.shard?.documents ?? []).some((x) => x.key === d.key)) {
      return { ...base, notMeasured: `it is missing from shard ${d.shard}'s list` };
    }
    // A document whose side recorded only that it started: its process stopped during it, which counts as a failure.
    const crashed = (x) => ({ engine: x.engine ?? base.engine, pdf: false, pages: null, fatal: true, timedOut: false, missing: [], crashed: true });
    const ours = r.ours?.documents?.[d.key];
    const o = ours?.started && !ours.core ? { engine: ours.engine, core: crashed(ours), missingCore: [] } : ours;
    // A compile the engine service rejected says nothing about the document: the shard's engine stopped working.
    if (o?.rejected) {
      return { ...base, notMeasured: `the engine rejected its compile (${o.rejected})` };
    }
    // Only the compile with the add-on was rejected: the core result stands; only the add-on side is not measured.
    const extraNotMeasured = o?.extraRejected ? { extraNotMeasured: `the engine rejected its compile with the add-on (${o.extraRejected})` } : {};
    if (!o) {
      return { ...base, notMeasured: r.ours ? `the extension's side did not reach it (${stopped(r.ours, d.shard)})` : `shard ${d.shard} has no results on the extension's side` };
    }
    const theirs = r.reference?.documents?.[d.key];
    const entry = {
      ...base,
      ...extraNotMeasured,
      engine: theirs?.engine ?? o.engine ?? base.engine,
      ourEngine: o.engine ?? null,
      core: o.core,
      extra: o.extraRejected ? null : (o.extra ?? o.core),
      missingCore: o.missingCore ?? [],
      blocked: o.blocked ?? [],
    };
    // The reference's process stopped during it: that is the runner's stop, not TeX Live's, so it is not measured
    // (inside the bound on what is not measured), never left out.
    if (theirs?.started && theirs.pdf === undefined) {
      return { ...entry, reference: null, notMeasured: `TeX Live's process stopped during it (shard ${d.shard})` };
    }
    const ref = theirs;
    if (!ref) {
      const failed = r.reference?.unmeasured?.[d.key];
      const why = failed ? `TeX Live could not be run on it (${failed})` : r.reference ? `TeX Live did not reach it (${stopped(r.reference, d.shard)})` : `shard ${d.shard} has no results on TeX Live`;
      return { ...entry, reference: null, notMeasured: why };
    }
    return { ...entry, reference: ref };
  });
  return { documents, missingShards };
}

/**
 * The bound on what was not measured: for each part (kind), [{ key, what, ok, got }] with ok when at most `limit`
 * (a share, 0.05 for 5 %) of its documents are not measured. Past it the run is not valid (docs/coverage-method.md).
 */
export function measuredChecks(documents, kinds, limit, tolerance = 1) {
  // A document both sides measured that the rules still cannot judge (rule 4 without both error counts) is not
  // measured too, and counts in the bound like every other cause.
  const unjudged = (d, which) => !d.notMeasured && Boolean(d.core) && Boolean(d.reference) && judgeDocument(d, tolerance)[which].why.startsWith('not measured');
  return kinds.map((kind) => {
    const docs = documents.filter((d) => d.kind === kind);
    // The core side, and the add-on side (a document whose compile with the add-on alone was rejected).
    const missing = docs.filter((d) => d.notMeasured || unjudged(d, 'core')).length;
    const missingExtra = docs.filter((d) => d.notMeasured || d.extraNotMeasured || unjudged(d, 'extra')).length;
    const share = docs.length ? missing / docs.length : 0;
    const shareExtra = docs.length ? missingExtra / docs.length : 0;
    return {
      key: `measured-${kind}`,
      what: `at most ${(100 * limit).toFixed(0)} % of the ${kind} documents are not measured, with core alone and with the add-on`,
      ok: docs.length > 0 && share <= limit && shareExtra <= limit,
      got: `${missing} of ${docs.length} (${(100 * share).toFixed(1)} %) not measured; with the add-on ${missingExtra} (${(100 * shareExtra).toFixed(1)} %)`,
    };
  });
}

/**
 * The bounds on what TeX Live leaves out: for each part, ok when at most `limits.fails` of its measured documents do
 * not compile on TeX Live either, and at most `limits.broken` are broken as submitted (a file missing on TeX Live
 * too). These are TeX Live's own documents on all of TeX Live, so past either bound the reference, not the
 * documents, is in doubt (docs/coverage-method.md). The two kinds are told apart as judge() tells them apart.
 */
export function texLiveChecks(documents, kinds, limits) {
  return kinds.flatMap((kind) => {
    const measured = documents.filter((d) => d.kind === kind && !d.notMeasured && d.reference);
    const why = measured.map((d) => brokenRule(d.reference)).filter((w) => w !== null);
    const broken = why.filter((w) => w.startsWith('missing ')).length;
    const fails = why.length - broken;
    const share = (k) => (measured.length ? k / measured.length : 0);
    const got = (k) => `${k} of ${measured.length} (${(100 * share(k)).toFixed(1)} %)`;
    return [
      {
        key: `tex-live-${kind}`,
        what: `at most ${(100 * limits.fails).toFixed(0)} % of the measured ${kind} documents do not compile on TeX Live either`,
        ok: measured.length > 0 && share(fails) <= limits.fails,
        got: got(fails),
      },
      {
        key: `broken-${kind}`,
        what: `at most ${(100 * limits.broken).toFixed(0)} % of the measured ${kind} documents are broken as submitted (a file missing on TeX Live too)`,
        ok: measured.length > 0 && share(broken) <= limits.broken,
        got: got(broken),
      },
    ];
  });
}

/** P(X >= k) for X binomial with n trials and probability p: the upper tail, summed term by term. */
export function binomialTail(n, k, p) {
  if (k <= 0) {
    return 1;
  }
  if (k > n) {
    return 0;
  }
  let term = (1 - p) ** n;
  let tail = 0;
  for (let x = 0; x <= n; x++) {
    if (x >= k) {
      tail += term;
    }
    term *= ((n - x) / (x + 1)) * (p / (1 - p));
  }
  return Math.min(1, tail);
}

/**
 * The shards' check on what TeX Live leaves out (failing on TeX Live too, or broken as submitted). The shards share
 * the documents in hash order, so left-out documents fall on them by chance alone. For each shard: the chance of
 * leaving out at least as many of its measured documents as it did, at the other shards' rate (one more left out
 * and one more kept are added to that rate, so it is never 0 or 1). A shard fails when that chance is below `alpha`,
 * so a TeX Live that lacks part of its tree in one shard cannot leave that shard's documents out quietly
 * (docs/coverage-method.md). With one shard there is nothing to compare, and no check.
 */
export function leftOutShardChecks(documents, kinds, alpha) {
  const measured = documents.filter((d) => kinds.includes(d.kind) && !d.notMeasured && d.reference && typeof d.shard === 'number');
  const shards = [...new Set(measured.map((d) => d.shard))].sort((a, b) => a - b);
  if (shards.length < 2) {
    return [];
  }
  const out = (d) => brokenRule(d.reference) !== null;
  return shards.map((s) => {
    const mine = measured.filter((d) => d.shard === s);
    const rest = measured.filter((d) => d.shard !== s);
    const k = mine.filter(out).length;
    const kRest = rest.filter(out).length;
    const chance = binomialTail(mine.length, k, (kRest + 1) / (rest.length + 2));
    return {
      key: `left-out-shard-${s}`,
      what: `TeX Live left out no more of this shard's documents than chance gives at the other shards' rate (a chance of at least ${alpha})`,
      ok: chance >= alpha,
      got: `${k} of ${mine.length} left out; the other shards ${kRest} of ${rest.length}; chance ${chance.toPrecision(2)}`,
    };
  });
}

/** The engines every canary record must hold: the two the extension has. */
export const CANARY_ENGINES = ['pdflatex', 'xelatex'];

/**
 * The canaries: a known-good document for each of those engines, compiled with core-data alone on the extension's
 * side and on TeX Live, before a shard's documents and after them. Written by the project; CC0.
 */
export const CANARY_DOCUMENTS = {
  pdflatex: '\\documentclass{article}\n\\begin{document}\nThe canary: the engine works.\n\\end{document}\n',
  xelatex: '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nThe canary: XeLaTeX and its fonts work (\u00e9, \u00fc, \u00df).\n\\end{document}\n',
};

/**
 * The canary check of every shard: the extension's engine compiled its known-good documents (a pdfLaTeX one and a
 * XeLaTeX one) before the shard's documents and after them. `shards`: [{ index, canary }] from ours.json, or from
 * reference.json with `side` 'tex-live' (the same documents on TeX Live).
 */
export function canaryChecks(shards, side = 'extension') {
  return shards.map((s) => {
    const when = ['before', 'after'].map((w) => [w, s.canary?.[w] ?? null]);
    // Both engines must be there and have passed: a record that lists no engine, or one, fails.
    const bad = when.flatMap(([w, c]) => (c ? CANARY_ENGINES.filter((engine) => c[engine] !== true).map((engine) => `${engine} ${w}`) : [`none ${w}`]));
    return {
      key: side === 'tex-live' ? `canary-tex-live-shard-${s.index}` : `canary-shard-${s.index}`,
      what: `${side === 'tex-live' ? 'TeX Live' : "the extension's engine"} compiled the known-good documents before and after this shard's documents`,
      ok: bad.length === 0,
      got: bad.length === 0 ? 'pdflatex and xelatex, before and after' : `failed: ${bad.join(', ')}`,
    };
  });
}

/** Whether a TeX text loads PSTricks (pstricks or a pst-* package), outside comments: such a file wants the DVI route. */
export function loadsPstricks(text) {
  return /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:pstricks|pst-[\w-]+)\b/.test(withoutComments(text));
}

/** What a left-out document's reason says: 'not measured', 'broken as submitted' or 'fails on TeX Live'. */
export function leftOutAs(why) {
  return why.startsWith('not measured') ? 'not measured' : why.startsWith('broken as submitted') ? 'broken as submitted' : 'fails on TeX Live';
}

/**
 * The report from the documents (assemble): [{ key, kind, stratum, engine, core, extra, reference, missingCore:
 * [{ file, package, inExtra }], notMeasured? }]; `frame`: { strata: { id: { window, eligible } } }; `mainKind`: the
 * kind the strata belong to ('paper' in the arXiv frame, 'example' in the frame without arXiv). Returns the shares
 * of every kind (`kinds`; `papers` is the main kind's), the per-stratum table (with what was left out), the engines,
 * the reweighted sensitivity figure, the top missing packages (from every kind but the probes) and every
 * document's outcome.
 */
export function buildReport(documents, frame = { strata: {} }, tolerance = 1, mainKind = 'paper') {
  const judged = documents.map((d) => ({ ...d, ...judgeDocument(d, tolerance) }));
  const share = (docs, which) => {
    const counted = docs.filter((d) => d[which].compiles !== null);
    return wilson(counted.filter((d) => d[which].compiles).length, counted.length);
  };
  const leftOut = (docs) => {
    const counts = { 'not measured': 0, 'broken as submitted': 0, 'fails on TeX Live': 0 };
    for (const d of docs.filter((x) => x.core.compiles === null)) {
      counts[leftOutAs(d.core.why)]++;
    }
    return counts;
  };
  const papers = judged.filter((d) => d.kind === mainKind);
  const strata = {};
  for (const id of [...new Set([...Object.keys(frame.strata ?? {}), ...papers.map((d) => d.stratum)])].sort()) {
    const docs = papers.filter((d) => d.stratum === id);
    strata[id] = {
      window: frame.strata?.[id]?.window ?? null,
      eligible: frame.strata?.[id]?.eligible ?? null,
      sampled: docs.length,
      leftOut: leftOut(docs),
      core: share(docs, 'core'),
      extra: share(docs, 'extra'),
    };
  }
  // The stratified share of the main kind: each stratum's share weighted by its documents in the frame ("eligible"),
  // over the strata that have a counted document; beside the pooled share, which weights by counted documents.
  const stratified = (which) => {
    let weight = 0;
    let sum = 0;
    for (const s of Object.values(strata)) {
      if (s.eligible && s[which].share !== null) {
        weight += s.eligible;
        sum += s.eligible * s[which].share;
      }
    }
    return weight > 0 ? sum / weight : null;
  };
  const engines = {};
  for (const d of papers) {
    const e = (engines[d.engine ?? 'not known'] ??= { papers: 0, leftOut: 0 });
    e.papers++;
    e.leftOut += d.core.compiles === null ? 1 : 0;
  }
  // The reweighted figure: each stratum's share weighted by its papers in the window (all licences).
  const reweighted = (which) => {
    let weight = 0;
    let sum = 0;
    for (const s of Object.values(strata)) {
      if (s.window && s[which].share !== null) {
        weight += s.window;
        sum += s.window * s[which].share;
      }
    }
    return weight > 0 ? sum / weight : null;
  };
  const missing = new Map();
  for (const d of judged.filter((x) => x.kind !== 'probe' && x.core.compiles === false)) {
    for (const m of d.missingCore ?? []) {
      const entry = missing.get(m.package) ?? { package: m.package, documents: 0, inExtra: m.inExtra, files: new Set() };
      entry.documents++;
      entry.files.add(m.file);
      entry.inExtra = entry.inExtra || m.inExtra;
      missing.set(m.package, entry);
    }
  }
  const excluded = judged.filter((d) => d.core.compiles === null).map((d) => ({ key: d.key, kind: d.kind, as: leftOutAs(d.core.why), why: d.core.why }));
  return {
    papers: {
      core: share(papers, 'core'),
      extra: share(papers, 'extra'),
      leftOut: leftOut(papers),
      // A sensitivity figure for the CI report only (docs/coverage-method.md, Statistics), not for the README.
      reweighted: { core: reweighted('core'), extra: reweighted('extra') },
    },
    main: mainKind,
    stratified: { core: stratified('core'), extra: stratified('extra') },
    kinds: Object.fromEntries(
      [...new Set(judged.map((d) => d.kind))].map((k) => {
        const docs = judged.filter((d) => d.kind === k);
        // What the bound allows: each share again, with every document not measured counted as failing (the worst
        // case) and as compiling (the best case), beside the share itself.
        const notMeasured = (d, which) => d[which].compiles === null && d[which].why.startsWith('not measured');
        const bound = (which, asCompiled) => {
          const counted = docs.filter((d) => d[which].compiles !== null || notMeasured(d, which));
          return wilson(counted.filter((d) => d[which].compiles === true || (asCompiled && notMeasured(d, which))).length, counted.length);
        };
        return [
          k,
          {
            documents: docs.length,
            core: share(docs, 'core'),
            extra: share(docs, 'extra'),
            leftOut: leftOut(docs),
            worst: { core: bound('core', false), extra: bound('extra', false) },
            best: { core: bound('core', true), extra: bound('extra', true) },
            // Run on another engine than TeX Live's: how many, how many count as compiling with core alone, and how
            // many fail only by rule 4 (more TeX errors than TeX Live's log).
            swapped: {
              documents: docs.filter((d) => d.swapped).length,
              compiles: docs.filter((d) => d.swapped && d.core.compiles === true).length,
              moreErrors: docs.filter((d) => d.swapped && d.core.compiles === false && / TeX error\(s\) on another engine/.test(d.core.why)).length,
            },
          },
        ];
      }),
    ),
    thesis: { core: share(judged.filter((d) => d.kind === 'thesis'), 'core'), extra: share(judged.filter((d) => d.kind === 'thesis'), 'extra') },
    beamer: { core: share(judged.filter((d) => d.kind === 'beamer'), 'core'), extra: share(judged.filter((d) => d.kind === 'beamer'), 'extra') },
    strata,
    engines,
    missingPackages: [...missing.values()]
      .map((e) => ({ package: e.package, documents: e.documents, where: e.inExtra ? 'extra-data' : 'neither set', files: [...e.files].sort() }))
      .sort((a, b) => b.documents - a.documents || (a.package < b.package ? -1 : 1)),
    excluded,
    blocked: judged.filter((d) => (d.blocked ?? []).length > 0).map((d) => ({ key: d.key, blocked: d.blocked })),
    documents: judged.map((d) => ({
      key: d.key,
      kind: d.kind,
      stratum: d.stratum ?? null,
      shard: d.shard ?? null,
      engine: d.engine ?? null,
      ...(d.swapped ? { ranOn: d.ourEngine } : {}),
      core: d.core.why,
      extra: d.extra.why,
    })),
  };
}
