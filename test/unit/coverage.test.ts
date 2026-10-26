// M5's coverage measurement, the pure parts (scripts/lib/coverage.mjs; docs/coverage-method.md): the OAI-PMH page
// reader, the frame and its strata, the draw (order, quotas and shards), the pacer under arXiv's terms, a source's
// version, main file and engine, what "compiles" means for both sides, the Wilson interval, every document's
// outcome and the report. No network and no process here; the report stage's test writes only a temp folder.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { importScript, root } from '../support/helpers';

type Rec = { id: string; created: string | null; categories: string[]; license: string | null; deleted: boolean };
type Stratum = { id: string; prefixes: string[] };
type Frame = {
  window: { from: string; to: string };
  licences: string[];
  seed: string;
  sampleSize: number;
  strata: Stratum[];
  harvest: { oai: string; source: string; userAgent: string; secondsBetweenRequests: number };
  source: { maxBytes: number };
  compile: { pageTolerance: number };
};
type Outcome = { pdf: boolean; pages: number | null; fatal: boolean; missing: string[]; timedOut?: boolean; unsupported?: string };
type Share = { k: number; n: number; share: number | null; low: number | null; high: number | null };
type LeftOut = Record<'not measured' | 'broken as submitted' | 'fails on TeX Live', number>;
type Template = { id: string; kind: string; sha256: string | null; mains: string[] };
type SampledDoc = { key: string; kind: string; stratum: string | null; shard: number; main?: string; template?: string };
type Assembled = { key: string; shard: number; notMeasured?: string; core?: Outcome; reference?: Outcome | null };
interface Lib {
  parseOaiPage(xml: string): { records: Rec[]; token: string | null; listSize: number | null; cursor: number | null; error: { code: string; message: string } | null };
  stratumOf(categories: string[], strata: Stratum[]): string | null;
  eligible(r: Rec, frame: Frame): boolean;
  orderKey(seed: string, id: string): string;
  drawOrder(seed: string, ids: string[]): string[];
  allocate(counts: Record<string, number>, total: number): Record<string, number>;
  sampleDocuments(papers: { key: string; kind: string; stratum: string }[], templates: Template[], seed: string, shards: number): SampledDoc[];
  Pacer: new (seconds: number, clock: { now(): number; sleep(ms: number): Promise<void> }) => {
    run<T>(f: () => T | Promise<T>): Promise<T>;
    hold(ms: number): Promise<void>;
    mark(): void;
  };
  retryAfterSeconds(headers: string, now?: number, max?: number): number | undefined;
  arxivEndpoint(url: string): boolean;
  userAgent(template: string, version: string): string;
  sourceVersion(headers: string): { version: string | null; etag: string | null };
  sourceKind(bytes: Uint8Array): string;
  withoutComments(text: string): string;
  isLatexMain(text: string): boolean;
  chooseMain(files: Map<string, Uint8Array>): { main: string; engine: string | null; how: string } | { skip: string };
  filesProblem(files: Map<string, Uint8Array>, maxBytes: number): string | null;
  shippedBbl(files: Map<string, Uint8Array>, main: string): string | null;
  fatalInLog(log: string): boolean;
  notFoundInLog(log: string): string[];
  brokenRule(o: Outcome): string | null;
  judge(ours: Outcome | null, reference: Outcome | null, tolerance?: number): { compiles: boolean | null; why: string };
  wilson(k: number, n: number, z?: number): Share;
  formatShare(s: Share): string;
  referenceProfile(dir: string): string;
  tarOf(files: Map<string, Uint8Array>): Buffer;
  rehearsalProbes(): { key: string; what: string; files: Record<string, string>; ok(r: Outcome & { engine: string }): boolean }[];
  rehearsalChecks(documents: unknown[], facts: { offline: boolean; ghostscript: string[] }): { key: string; what: string; ok: boolean; got: string }[];
  assemble(sample: SampledDoc[], shards: number, results: Record<number, unknown>): { documents: Assembled[]; missingShards: number[] };
  buildReport(documents: unknown[], frame?: unknown, tolerance?: number): {
    papers: { core: Share; extra: Share; leftOut: LeftOut; reweighted: { core: number | null; extra: number | null } };
    thesis: { core: Share };
    beamer: { core: Share };
    strata: Record<string, { window: number | null; eligible: number | null; sampled: number; leftOut: LeftOut; core: Share; extra: Share }>;
    engines: Record<string, { papers: number; leftOut: number }>;
    missingPackages: { package: string; documents: number; where: string; files: string[] }[];
    excluded: { key: string; as: string; why: string }[];
    documents: { key: string; core: string }[];
  };
}

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const MAIN = '\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n';

describe('M5: the coverage measurement (pure parts)', () => {
  let lib: Lib;
  let frame: Frame;
  before(async () => {
    lib = await importScript<Lib>('scripts/lib/coverage.mjs');
    frame = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-frame.json'), 'utf8')) as Frame;
  });

  it('agrees with docs/coverage-method.md: the window, the licences, the seed, the size, the strata, the rules', () => {
    const method = readFileSync(path.join(root, 'docs', 'coverage-method.md'), 'utf8');
    assert.ok(method.includes(`**${frame.window.from} to ${frame.window.to}**`));
    for (const l of frame.licences) {
      assert.ok(method.includes(l), l);
    }
    assert.ok(method.includes(`(the seed is **${frame.seed}**)`));
    assert.ok(method.includes(`- **Size.** ${frame.sampleSize} papers`));
    for (const s of frame.strata) {
      assert.ok(method.includes(`| ${s.id} |`), s.id);
    }
    assert.ok(method.includes('**one page**') && frame.compile.pageTolerance === 1);
    assert.ok(method.includes('**300 seconds**'));
    assert.ok(method.includes(`**${frame.source.maxBytes.toLocaleString('en-US')} bytes**`), 'the size cap');
    assert.match(method, /no more than one\s+request every three seconds, one connection at a time, across every machine/);
    assert.equal(frame.harvest.secondsBetweenRequests, 3);
    // Where the requests go, and who they say they are from: as the method states them.
    assert.ok(method.includes(`\`${frame.harvest.oai}\``) && method.includes(`\`${frame.harvest.source.replace('{id}', '<id>')}\``));
    assert.ok(method.includes(`\`${frame.harvest.userAgent.replace('{version}', '<version>')}\``));
  });

  it('asks arXiv only at its programmatic endpoints, with a User-Agent that names the repository and no e-mail', () => {
    assert.equal(lib.arxivEndpoint(frame.harvest.oai), true);
    assert.equal(lib.arxivEndpoint(`${frame.harvest.oai}?verb=ListRecords&resumptionToken=a%7Cb`), true);
    assert.equal(lib.arxivEndpoint(frame.harvest.source.replace('{id}', '2607.01234')), true);
    for (const url of [
      'https://arxiv.org/src/2607.01234', // arxiv.org's robots.txt disallows /src, /e-print, /api and /oai2
      'https://arxiv.org/e-print/2607.01234',
      'https://www.arxiv.org/src/2607.01234',
      'https://export.arxiv.org/oai2?verb=Identify', // the old OAI-PMH base URL
      'https://export.arxiv.org/abs/2607.01234',
      'https://export.arxiv.org/src/2607.01234?x=1',
      'https://export.arxiv.org/src/../abs/2607.01234',
      'http://export.arxiv.org/src/2607.01234',
      'https://export.arxiv.org:8443/src/2607.01234',
      'https://oaipmh.arxiv.org/other',
      'https://export.arxiv.org.example/src/2607.01234',
      'not a url',
    ]) {
      assert.equal(lib.arxivEndpoint(url), false, url);
    }
    const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
    const ua = lib.userAgent(frame.harvest.userAgent, version);
    assert.equal(ua, `liveMd2Tex-coverage/${version} (+https://github.com/haberwooki/liveMd2Tex)`);
    assert.doesNotMatch(ua, /@/, 'no e-mail address');
  });

  it('reads an OAI-PMH page of the arXiv format: records, deleted ones, the token, and errors', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>
<record><header><identifier>oai:arXiv.org:2607.01234</identifier><datestamp>2026-07-03</datestamp><setSpec>cs:cs:LG</setSpec></header>
<metadata><arXiv xmlns="http://arxiv.org/OAI/arXiv/"><id>2607.01234</id><created>2026-07-02</created><updated>2026-08-01</updated>
<categories>cs.LG stat.ML</categories><license>http://creativecommons.org/licenses/by/4.0/</license><title>A &amp; B</title></arXiv></metadata></record>
<record><header status="deleted"><identifier>oai:arXiv.org:2607.09999</identifier><datestamp>2026-07-05</datestamp></header></record>
<resumptionToken cursor="0">tok&amp;en|1001</resumptionToken>
</ListRecords></OAI-PMH>`;
    const page = lib.parseOaiPage(xml);
    assert.deepEqual(page.records, [
      { id: '2607.01234', created: '2026-07-02', categories: ['cs.LG', 'stat.ML'], license: 'http://creativecommons.org/licenses/by/4.0/', deleted: false },
      { id: '2607.09999', created: null, categories: [], license: null, deleted: true },
    ]);
    assert.equal(page.token, 'tok&en|1001');
    assert.deepEqual([page.cursor, page.listSize], [0, null]);
    const sized = lib.parseOaiPage('<OAI-PMH><ListRecords><resumptionToken completeListSize="250000" cursor="1000">t2</resumptionToken></ListRecords></OAI-PMH>');
    assert.deepEqual([sized.token, sized.listSize, sized.cursor], ['t2', 250000, 1000]);
    assert.equal(lib.parseOaiPage('<OAI-PMH><ListRecords><resumptionToken cursor="5"/></ListRecords></OAI-PMH>').token, null);
    assert.deepEqual(lib.parseOaiPage('<OAI-PMH><error code="badResumptionToken">expired</error></OAI-PMH>').error, { code: 'badResumptionToken', message: 'expired' });
  });

  it('puts each paper in its stratum by the first category, and keeps the frame to the window and the licences', () => {
    const s = (c: string) => lib.stratumOf([c], frame.strata);
    assert.deepEqual(
      ['cs.LG', 'math.AG', 'math-ph', 'astro-ph', 'astro-ph.GA', 'cond-mat.str-el', 'hep-th', 'quant-ph', 'gr-qc', 'nucl-ex', 'physics.optics', 'stat.ML', 'eess.SP', 'q-bio.NC', 'econ.EM', 'q-fin.ST'].map(s),
      ['cs', 'math', 'physics-other', 'astro-ph', 'astro-ph', 'cond-mat', 'hep', 'quant-ph', 'physics-other', 'physics-other', 'physics-other', 'stat', 'eess', 'other', 'other', 'other'],
    );
    assert.equal(lib.stratumOf(['stat.ML', 'cs.LG'], frame.strata), 'stat');
    assert.equal(lib.stratumOf([], frame.strata), null);
    const rec = (over: Partial<Rec>): Rec => ({ id: 'x', created: '2026-08-15', categories: ['cs.LG'], license: frame.licences[0], deleted: false, ...over });
    assert.equal(lib.eligible(rec({}), frame), true);
    assert.equal(lib.eligible(rec({ license: frame.licences[1] }), frame), true);
    assert.equal(lib.eligible(rec({ created: frame.window.from }), frame), true);
    assert.equal(lib.eligible(rec({ created: frame.window.to }), frame), true);
    assert.equal(lib.eligible(rec({ created: '2026-06-30' }), frame), false);
    assert.equal(lib.eligible(rec({ created: '2026-10-01' }), frame), false);
    assert.equal(lib.eligible(rec({ license: 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/' }), frame), false);
    assert.equal(lib.eligible(rec({ license: 'http://creativecommons.org/licenses/by-nc-sa/4.0/' }), frame), false);
    assert.equal(lib.eligible(rec({ license: null }), frame), false);
    assert.equal(lib.eligible(rec({ deleted: true }), frame), false);
  });

  it('draws in a fixed order (SHA-256 of seed:id) and allocates the 400 in proportion, at least one each', () => {
    assert.equal(lib.orderKey('20261022', '2607.01234'), createHash('sha256').update('20261022:2607.01234').digest('hex'));
    const ids = Array.from({ length: 50 }, (_, i) => `2607.${String(i).padStart(5, '0')}`);
    const order = lib.drawOrder('20261022', ids);
    assert.deepEqual(lib.drawOrder('20261022', [...ids].reverse()), order, 'the order depends on the ids, not on how they came');
    assert.notDeepEqual(lib.drawOrder('1', ids), order, 'another seed, another order');
    assert.deepEqual([...order].sort(), [...ids].sort());
    const quotas = lib.allocate({ cs: 5000, math: 3000, hep: 1500, other: 2 }, 400);
    assert.equal(Object.values(quotas).reduce((a, b) => a + b, 0), 400);
    assert.ok(quotas.other >= 1);
    assert.ok(Math.abs(quotas.cs - (5000 * 400) / 9502) <= 1.01);
    assert.deepEqual(lib.allocate({ a: 0, b: 10 }, 4), { b: 4 });
    assert.deepEqual(lib.allocate({ a: 1, b: 1, c: 1 }, 2), { a: 1, b: 1, c: 0 }, 'fewer places than strata: the first by the order of the remainders');
    assert.deepEqual(lib.allocate({ a: 3 }, 10), { a: 3 }, 'never more than the stratum has');
  });

  it('shares the sample among the shards in draw order, strata interleaved, the pinned templates included', () => {
    const papers = [
      ...Array.from({ length: 30 }, (_, i) => ({ key: `2607.${String(i).padStart(5, '0')}`, kind: 'paper', stratum: 'cs' })),
      ...Array.from({ length: 30 }, (_, i) => ({ key: `2608.${String(i).padStart(5, '0')}`, kind: 'paper', stratum: 'math' })),
    ];
    const templates: Template[] = [
      { id: 'pinned', kind: 'thesis', sha256: 'ab', mains: ['a.tex', 'sub/b.tex'] },
      { id: 'unpinned', kind: 'beamer', sha256: null, mains: ['c.tex'] },
    ];
    const docs = lib.sampleDocuments(papers, templates, '20261022', 4);
    assert.equal(docs.length, 62);
    assert.deepEqual(
      docs.filter((d) => d.kind === 'thesis').map((d) => d.key).sort(),
      ['pinned:a.tex', 'pinned:sub/b.tex'],
    );
    assert.ok(!docs.some((d) => d.key.startsWith('unpinned')), 'an unpinned template is not measured');
    const keys = docs.map((d) => d.key);
    assert.deepEqual(keys, [...keys].sort((a, b) => (lib.orderKey('20261022', a) < lib.orderKey('20261022', b) ? -1 : 1)), 'in draw order');
    assert.deepEqual(lib.sampleDocuments([...papers].reverse(), templates, '20261022', 4), docs, 'the same however papers.json lists them');
    const sizes = [0, 1, 2, 3].map((s) => docs.filter((d) => d.shard === s).length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, JSON.stringify(sizes));
    // Each shard's first half holds both strata: a shard that runs out of time does not drop one stratum.
    for (const s of [0, 1, 2, 3]) {
      const head = docs.filter((d) => d.shard === s).slice(0, 8);
      assert.ok(head.some((d) => d.stratum === 'cs') && head.some((d) => d.stratum === 'math'), `shard ${s}`);
    }
  });

  it('paces requests three seconds apart, one at a time, and waits out Retry-After', async () => {
    let now = 1000;
    const slept: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => void (slept.push(ms), (now += ms)) };
    const pacer = new lib.Pacer(3, clock);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await pacer.run(() => {
        starts.push(now);
        now += 500; // the request itself takes half a second
      });
    }
    assert.deepEqual(starts, [1000, 4000, 7000]);
    assert.deepEqual(slept, [2500, 2500]);
    // A slow request leaves no wait before the next.
    await pacer.run(() => void (now += 5000));
    const before = slept.length;
    await pacer.run(() => undefined);
    assert.equal(slept.length, before);
    // Two at once is refused, not overlapped.
    const first = pacer.run(() => new Promise<void>((r) => setTimeout(r, 5)));
    await assert.rejects(pacer.run(() => undefined), /one request at a time/);
    await first;
    // A new stage's pacer counts the previous stage's last request: its first request waits the full gap.
    const next = new lib.Pacer(3, clock);
    next.mark();
    const at = now;
    await next.run(() => undefined);
    assert.equal(now - at, 3000);
    assert.deepEqual(lib.sourceVersion('HTTP/2 200\r\ncontent-type: application/gzip\r\ncontent-disposition: attachment; filename="2607.01234v2.tar.gz"\r\netag: "sha256:abc"\r\n\r\n'), {
      version: '2607.01234v2',
      etag: '"sha256:abc"',
    });
    assert.deepEqual(lib.sourceVersion('HTTP/1.1 200 OK\r\n\r\n'), { version: null, etag: null });
    assert.equal(lib.retryAfterSeconds('HTTP/1.1 503\r\nRetry-After: 120\r\n'), 120);
    assert.equal(lib.retryAfterSeconds('HTTP/1.1 503\r\nretry-after: 99999\r\n'), 600);
    assert.equal(lib.retryAfterSeconds('HTTP/1.1 503\r\nRetry-After: Wed, 21 Oct 2026 07:28:30 GMT\r\n', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 30);
    assert.equal(lib.retryAfterSeconds('HTTP/1.1 200 OK\r\n'), undefined);
  });

  it('finds the main file and the engine of a source as the method says', () => {
    const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, bytes(v)]));
    assert.equal(lib.sourceKind(gzipSync(Buffer.from('x'))), 'gzip');
    assert.equal(lib.sourceKind(bytes('%PDF-1.7')), 'pdf');
    assert.equal(lib.sourceKind(bytes('hello')), 'other');
    assert.equal(lib.withoutComments('a % b\nc \\% d % e'), 'a \nc \\% d ');
    assert.equal(lib.isLatexMain('% \\documentclass{article}\n\\begin{document}'), false);
    assert.deepEqual(lib.chooseMain(files({ 'paper.tex': MAIN, 'sec.tex': 'Section.' })), { main: 'paper.tex', engine: null, how: 'the one main file' });
    assert.deepEqual(lib.chooseMain(files({ 'a.tex': MAIN, 'main.tex': MAIN, 'zzz.tex': `${MAIN}%${'x'.repeat(100)}` })), { main: 'main.tex', engine: null, how: 'by its name' });
    assert.deepEqual(lib.chooseMain(files({ 'a.tex': MAIN, 'b.tex': `${MAIN}%${'x'.repeat(100)}` })), { main: 'b.tex', engine: null, how: 'the largest' });
    const readme = JSON.stringify({ spec_version: 1, process: { compiler: 'xelatex' }, sources: [{ filename: 'b.tex', usage: 'toplevel' }] });
    assert.deepEqual(lib.chooseMain(files({ '00README.json': readme, 'a.tex': MAIN, 'b.tex': MAIN })), { main: 'b.tex', engine: 'xelatex', how: '00README.json' });
    assert.deepEqual(lib.chooseMain(files({ '00README.json': JSON.stringify({ process: { compiler: 'latex' } }), 'a.tex': MAIN })), { main: 'a.tex', engine: 'latex', how: 'the one main file' }, 'the DVI route');
    assert.equal(
      (lib.chooseMain(files({ '00README.json': JSON.stringify({ process: { compiler: 'pdflatex' } }), 'a.tex': `% !TEX program = xelatex\n${MAIN}` })) as { engine: string }).engine,
      'pdflatex',
      "00README.json's compiler comes before a % !TEX line, as the method says",
    );
    assert.deepEqual(lib.chooseMain(files({ 'a.tex': `% !TEX program = lualatex\n${MAIN}` })), { main: 'a.tex', engine: 'lualatex', how: 'the one main file' });
    assert.deepEqual(lib.chooseMain(files({ '00README.json': JSON.stringify({ process: { compiler: 'pdftex' } }), 'a.tex': '\\bye' })), { skip: 'plain TeX (pdftex)' });
    assert.deepEqual(lib.chooseMain(files({ 'a.tex': 'Just text \\bye' })), { skip: 'no LaTeX main file' });
    assert.deepEqual(lib.chooseMain(files({ 'fig.png': 'x' })), { skip: 'no .tex file' });
    assert.deepEqual(lib.chooseMain(files({ 'sub/a.tex': MAIN })), { skip: 'no LaTeX main file' }, 'only top-level files are main files');
    assert.equal(lib.shippedBbl(files({ 'paper.tex': MAIN, 'paper.bbl': 'x' }), 'paper.tex'), 'paper.bbl');
    assert.equal(lib.shippedBbl(files({ 'paper.tex': MAIN }), 'paper.tex'), null);
  });

  it('says when a compile compiles: no missing file, no fatal error, within one page of the reference', () => {
    const ok: Outcome = { pdf: true, pages: 10, fatal: false, missing: [] };
    const ref: Outcome = { pdf: true, pages: 10, fatal: false, missing: [] };
    assert.deepEqual(lib.judge(ok, ref), { compiles: true, why: 'compiles' });
    assert.equal(lib.judge({ ...ok, pages: 11 }, ref).compiles, true);
    assert.equal(lib.judge({ ...ok, pages: 9 }, ref).compiles, true);
    assert.deepEqual(lib.judge({ ...ok, pages: 12 }, ref), { compiles: false, why: '12 page(s), TeX Live 10' });
    assert.deepEqual(lib.judge({ ...ok, missing: ['revtex4-2.cls'] }, ref), { compiles: false, why: 'missing revtex4-2.cls' });
    assert.deepEqual(lib.judge({ ...ok, fatal: true }, ref), { compiles: false, why: 'fatal error' });
    assert.deepEqual(lib.judge({ ...ok, pdf: false, pages: null }, ref), { compiles: false, why: 'fatal error' });
    assert.deepEqual(lib.judge({ ...ok, timedOut: true }, ref), { compiles: false, why: 'timed out' });
    assert.deepEqual(lib.judge({ ...ok, unsupported: 'asks for LuaLaTeX' }, ref), { compiles: false, why: 'asks for LuaLaTeX' });
    assert.deepEqual(lib.judge({ ...ok, pages: null }, ref), { compiles: false, why: 'no readable page' });
    assert.deepEqual(lib.judge(ok, { ...ref, pdf: false, pages: null }), { compiles: null, why: 'does not compile on TeX Live either (fatal error)' });
    assert.deepEqual(lib.judge(ok, { ...ref, fatal: true }), { compiles: null, why: 'does not compile on TeX Live either (fatal error)' });
    assert.deepEqual(lib.judge(ok, { ...ref, timedOut: true }), { compiles: null, why: 'does not compile on TeX Live either (timed out)' });
    // Rule 1 holds for both sides: a file missing on TeX Live too means the paper is broken as submitted, and it is
    // left out; it never counts against the extension.
    assert.deepEqual(lib.judge({ ...ok, missing: ['fig.pdf'] }, { ...ref, missing: ['fig.pdf'] }), { compiles: null, why: 'broken as submitted: missing fig.pdf on TeX Live too' });
    assert.deepEqual(lib.judge(ok, { ...ref, missing: ['fig.pdf'] }).compiles, null);
    assert.deepEqual(lib.judge({ ...ok, missing: ['fig.pdf'] }, ref), { compiles: false, why: 'missing fig.pdf' }, 'missing only on our side counts');
    // The same rule function judges both sides.
    for (const o of [ok, { ...ok, missing: ['x.sty'] }, { ...ok, fatal: true }, { ...ok, timedOut: true }, { ...ok, pages: 0 }]) {
      assert.equal(lib.brokenRule(o) === null, lib.judge(ok, o).compiles !== null, JSON.stringify(o));
    }
    assert.deepEqual(lib.judge(null, ref), { compiles: null, why: 'not measured' });
    assert.deepEqual(lib.judge(ok, null), { compiles: null, why: 'not measured on TeX Live' });
    assert.equal(lib.fatalInLog('./main.tex:12: Emergency stop.'), true);
    assert.equal(lib.fatalInLog('!  ==> Fatal error occurred, no output PDF file produced!'), true);
    assert.equal(lib.fatalInLog('./main.tex:3: Undefined control sequence.'), false);
    assert.deepEqual(lib.notFoundInLog("! LaTeX Error: File `revtex4-2.cls' not found.\n! LaTeX Error: File `revtex4-2.cls' not found."), ['revtex4-2.cls']);
  });

  it('gives the Wilson interval', () => {
    const w = lib.wilson(80, 100);
    assert.equal(w.share, 0.8);
    assert.ok(Math.abs((w.low ?? 0) - 0.7112) < 0.0005 && Math.abs((w.high ?? 0) - 0.8667) < 0.0005, JSON.stringify(w));
    assert.deepEqual([lib.wilson(0, 10).low, lib.wilson(10, 10).high], [0, 1]);
    assert.ok((lib.wilson(0, 10).high ?? 0) > 0.25 && (lib.wilson(0, 10).high ?? 0) < 0.35);
    assert.equal(lib.wilson(0, 0).share, null);
    assert.equal(lib.formatShare(lib.wilson(80, 100)), '80.0 % (95 % interval 71.1 to 86.7 %, 80 of 100)');
  });

  it('reports the shares per stratum, the reweighted figure, the missing packages and what was left out', () => {
    const ref = { pdf: true, pages: 5, fatal: false, missing: [] };
    const good = { pdf: true, pages: 5, fatal: false, missing: [] };
    const missing = { pdf: true, pages: 4, fatal: false, missing: ['revtex4-2.cls'] };
    const docs = [
      { key: 'a', kind: 'paper', stratum: 'cs', core: good, reference: ref },
      { key: 'b', kind: 'paper', stratum: 'cs', core: missing, extra: good, reference: ref, missingCore: [{ file: 'revtex4-2.cls', package: 'revtex', inExtra: true }] },
      { key: 'c', kind: 'paper', stratum: 'math', core: missing, extra: missing, reference: ref, missingCore: [{ file: 'revtex4-2.cls', package: 'revtex', inExtra: true }, { file: 'odd.sty', package: 'odd', inExtra: false }] },
      { key: 'd', kind: 'paper', stratum: 'math', engine: 'latex', core: good, reference: { ...ref, pdf: false, pages: null } },
      { key: 'e', kind: 'paper', stratum: 'math', notMeasured: 'shard 3 returned no results' },
      { key: 'f', kind: 'paper', stratum: 'cs', core: missing, reference: { ...ref, missing: ['revtex4-2.cls'] } },
      { key: 't', kind: 'thesis', core: good, reference: ref },
      { key: 'm', kind: 'beamer', core: missing, reference: ref, missingCore: [] },
    ];
    const r = lib.buildReport(docs, { strata: { cs: { window: 300, eligible: 100 }, math: { window: 100, eligible: 20 } } });
    assert.deepEqual([r.papers.core.k, r.papers.core.n, r.papers.extra.k, r.papers.extra.n], [1, 3, 2, 3]);
    assert.deepEqual([r.strata.cs.core.k, r.strata.cs.core.n, r.strata.math.core.k, r.strata.math.core.n], [1, 2, 0, 1]);
    assert.equal(r.strata.cs.sampled, 3);
    assert.equal(r.strata.cs.window, 300);
    assert.deepEqual(r.strata.math.leftOut, { 'not measured': 1, 'broken as submitted': 0, 'fails on TeX Live': 1 });
    assert.deepEqual(r.papers.leftOut, { 'not measured': 1, 'broken as submitted': 1, 'fails on TeX Live': 1 });
    assert.deepEqual(r.engines, { 'not known': { papers: 5, leftOut: 2 }, latex: { papers: 1, leftOut: 1 } });
    // cs: core 1/2, math 0/1, weighted 3:1 by the window -> 0.375.
    assert.equal(r.papers.reweighted.core, 0.375);
    assert.deepEqual([r.thesis.core.k, r.thesis.core.n, r.beamer.core.k, r.beamer.core.n], [1, 1, 0, 1]);
    assert.deepEqual(r.missingPackages, [
      { package: 'revtex', documents: 2, where: 'extra-data', files: ['revtex4-2.cls'] },
      { package: 'odd', documents: 1, where: 'neither set', files: ['odd.sty'] },
    ]);
    assert.deepEqual(r.excluded.map((e) => [e.key, e.as, e.why]), [
      ['d', 'fails on TeX Live', 'does not compile on TeX Live either (fatal error)'],
      ['e', 'not measured', 'not measured: shard 3 returned no results'],
      ['f', 'broken as submitted', 'broken as submitted: missing revtex4-2.cls on TeX Live too'],
    ]);
    assert.equal(r.documents.length, docs.length, 'every document has an outcome');
  });

  it('gives every sampled document an outcome: a lost shard, a document that could not be unpacked, a side that stopped', () => {
    const papers = Array.from({ length: 9 }, (_, i) => ({ key: `2607.0000${i}`, kind: 'paper', stratum: i % 2 ? 'cs' : 'math' }));
    const sample = lib.sampleDocuments(papers, [], '20261022', 3);
    const of = (s: number) => sample.filter((d) => d.shard === s).map((d) => d.key);
    const ok = { pdf: true, pages: 3, fatal: false, missing: [] };
    const [a, b, c] = of(1);
    const results = {
      0: {
        shard: { shard: '0/3', documents: of(0).map((key) => ({ key })), unreadable: [] },
        ours: { documents: Object.fromEntries(of(0).map((k) => [k, { engine: 'pdflatex', core: ok }])) },
        reference: { documents: Object.fromEntries(of(0).map((k) => [k, { engine: 'pdflatex', ...ok }])) },
      },
      1: {
        shard: { shard: '1/3', documents: [{ key: b }, { key: c }], unreadable: [{ key: a, why: 'EEXIST: "a" is both a file and a folder' }] },
        ours: { stopped: "its 150 minutes on the extension's side ran out", documents: { [b]: { engine: 'pdflatex', core: ok } } },
        reference: { stopped: null, documents: {}, unmeasured: { [b]: 'ENOSPC' } },
      },
    };
    const { documents, missingShards } = lib.assemble(sample, 3, results);
    assert.deepEqual(missingShards, [2]);
    assert.equal(documents.length, sample.length, 'none is lost');
    const why = (k: string) => documents.find((d) => d.key === k)?.notMeasured;
    assert.equal(why(a), 'it could not be unpacked for its compile (EEXIST: "a" is both a file and a folder)');
    assert.equal(why(b), 'TeX Live could not be run on it (ENOSPC)');
    assert.equal(why(c), "the extension's side did not reach it (shard 1: its 150 minutes on the extension's side ran out)");
    for (const k of of(2)) {
      assert.equal(why(k), 'shard 2 returned no results');
    }
    for (const k of of(0)) {
      assert.equal(why(k), undefined);
    }
    const r = lib.buildReport(documents);
    assert.equal(r.papers.leftOut['not measured'], of(1).length + of(2).length);
    assert.equal(r.papers.core.n, of(0).length);
  });

  it('rehearses without arXiv: probes that are LaTeX main files, a tar that unpacks as a source, and checks that fail plainly', async () => {
    const { sourceFiles } = await importScript<{ sourceFiles(b: Uint8Array, id: string): { files: Map<string, Uint8Array> } | { skip: string } }>('scripts/coverage.mjs');
    const probes = lib.rehearsalProbes();
    assert.deepEqual(
      probes.map((p) => p.key),
      ['probe-eps', 'probe-dvi', 'probe-biber', 'probe-openin', 'probe-missing'],
    );
    for (const p of probes) {
      const files = new Map(Object.entries(p.files).map(([n, s]) => [n, bytes(s)]));
      // Packed as arXiv packs a source, and read back by the same code as a paper.
      const back = sourceFiles(gzipSync(lib.tarOf(files)), p.key) as { files: Map<string, Uint8Array> };
      assert.deepEqual([...back.files.keys()].sort(), [...files.keys()].sort(), p.key);
      assert.equal(Buffer.from(back.files.get('main.tex') as Uint8Array).toString(), p.files['main.tex'], p.key);
      const chosen = lib.chooseMain(back.files) as { main: string; engine: string | null };
      assert.equal(chosen.main, 'main.tex', p.key);
      assert.equal(chosen.engine, p.key === 'probe-dvi' ? 'latex' : null, p.key);
      assert.doesNotMatch(JSON.stringify(p.files), /arxiv/i, p.key);
    }
    // The checks: what TeX Live must give for each probe, and the run-wide facts.
    const good: Record<string, Outcome & { engine: string }> = {
      'probe-eps': { engine: 'pdflatex', pdf: true, pages: 1, fatal: false, missing: [] },
      'probe-dvi': { engine: 'latex', pdf: true, pages: 1, fatal: false, missing: [] },
      'probe-biber': { engine: 'pdflatex', pdf: true, pages: 4, fatal: false, missing: [] },
      'probe-openin': { engine: 'pdflatex', pdf: true, pages: 1, fatal: false, missing: [] },
      'probe-missing': { engine: 'pdflatex', pdf: true, pages: 1, fatal: false, missing: ['missing-figure.pdf'] },
      'corpus-P1': { engine: 'pdflatex', pdf: true, pages: 2, fatal: false, missing: [] },
    };
    const docs = (over: Record<string, Partial<Outcome & { engine: string }>> = {}) =>
      Object.entries(good).map(([key, r]) => ({ key, stratum: key.startsWith('corpus') ? 'corpus' : 'probe', reference: { ...r, ...over[key] } }));
    const facts = { offline: true, ghostscript: ['10.02.1'] };
    const all = lib.rehearsalChecks(docs(), facts);
    assert.deepEqual(all.filter((c) => !c.ok), []);
    assert.equal(all.length, 5 + 1 + 3);
    const failing = (over: Record<string, Partial<Outcome & { engine: string }>>, f = facts) =>
      lib.rehearsalChecks(docs(over), f).filter((c) => !c.ok).map((c) => c.key);
    assert.deepEqual(failing({ 'probe-openin': { pages: 2 } }), ['probe-openin'], 'TeX read /etc/passwd');
    assert.deepEqual(failing({ 'probe-eps': { missing: ['figure-eps-converted-to.pdf'] } }), ['probe-eps'], 'no Ghostscript');
    assert.deepEqual(failing({ 'probe-dvi': { engine: 'pdflatex' } }), ['probe-dvi']);
    assert.deepEqual(failing({ 'probe-biber': { pages: 1 } }), ['probe-biber'], 'an empty bibliography');
    assert.deepEqual(failing({ 'probe-missing': { missing: [] } }), ['probe-missing']);
    assert.deepEqual(failing({ 'corpus-P1': { fatal: true } }), ['corpus-P1']);
    assert.deepEqual(failing({}, { offline: false, ghostscript: [] }), ['network', 'ghostscript']);
    assert.deepEqual(
      lib.rehearsalChecks([...docs(), { key: 'probe-x', stratum: 'probe', notMeasured: 'shard 1 returned no results' }], facts).filter((c) => !c.ok).map((c) => c.key),
      ['all'],
    );
  });

  it('runs a rehearsal end to end from the repository: the corpus and the probes, no templates, and the checks first', async () => {
    const { rehearse, report } = await importScript<{
      rehearse(dir: string): Promise<void>;
      report(dir: string, results: string, out: string, shards: string): { complete: boolean; checks: { key: string; ok: boolean }[] | null };
    }>('scripts/coverage.mjs');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-rehearsal-test-'));
    const log = console.log;
    console.log = () => undefined;
    try {
      const dir = path.join(tmp, 'coverage');
      mkdirSync(dir);
      await rehearse(dir);
      const papers = JSON.parse(readFileSync(path.join(dir, 'papers.json'), 'utf8')) as { rehearsal: boolean; complete: boolean; papers: { key: string; kind: string; stratum: string; main: string; engine: string | null }[] };
      assert.equal(papers.rehearsal, true);
      assert.equal(papers.complete, true);
      const keys = papers.papers.map((p) => p.key);
      assert.ok(['corpus-P1', 'corpus-P5', 'corpus-P8', 'corpus-multiroot'].every((k) => keys.includes(k)), keys.join(' '));
      assert.equal(papers.papers.find((p) => p.key === 'corpus-multiroot')?.main, 'paper.tex');
      // P1's figure, which the tests draw from code, is in its source, so P1 is complete on TeX Live.
      const p1 = await importScript<{ sourceFiles(b: Uint8Array, id: string): { files: Map<string, Uint8Array> } }>('scripts/coverage.mjs');
      assert.ok(p1.sourceFiles(readFileSync(path.join(dir, 'sources', 'corpus-P1')), 'corpus-P1').files.has('fig-response.pdf'));
      assert.equal(keys.filter((k) => k.startsWith('probe-')).length, lib.rehearsalProbes().length);
      // One shard that returns everything, with TeX Live giving what each probe needs.
      const sample = lib.sampleDocuments(papers.papers, [], frame.seed, 1);
      const ok = { pdf: true, pages: 1, fatal: false, timedOut: false, missing: [] as string[] };
      const ref = (key: string) =>
        key === 'probe-dvi' ? { ...ok, engine: 'latex' } : key === 'probe-biber' ? { ...ok, engine: 'pdflatex', pages: 5 } : key === 'probe-missing' ? { ...ok, engine: 'pdflatex', missing: ['missing-figure.pdf'] } : { ...ok, engine: 'pdflatex' };
      const results = path.join(tmp, 'results', 'coverage-shard-0');
      mkdirSync(results, { recursive: true });
      const write = (name: string, value: unknown) => writeFileSync(path.join(results, name), JSON.stringify(value));
      write('shard.json', { shard: '0/1', documents: sample.map((d) => ({ key: d.key })), unreadable: [] });
      write('ours.json', { stubs: { checked: true, blocked: [], workers: { withoutRecord: 0 } }, documents: Object.fromEntries(sample.map((d) => [d.key, { engine: 'pdflatex', core: ok }])) });
      write('reference.json', { ghostscript: '10.02.1', offline: true, documents: Object.fromEntries(sample.map((d) => [d.key, ref(d.key)])) });
      const passed = report(dir, path.join(tmp, 'results'), path.join(tmp, 'out'), '1');
      assert.deepEqual(passed.checks?.filter((c) => !c.ok), []);
      const md = readFileSync(path.join(tmp, 'out', 'coverage-report.md'), 'utf8');
      assert.match(md.split('\n')[0], /^\*\*Rehearsal: all \d+ checks pass\.\*\* No arXiv paper was fetched/);
      // TeX Live reads /etc/passwd: the rehearsal fails, and says which check.
      write('reference.json', { ghostscript: '10.02.1', offline: true, documents: Object.fromEntries(sample.map((d) => [d.key, d.key === 'probe-openin' ? { ...ok, engine: 'pdflatex', pages: 2 } : ref(d.key)])) });
      const failed = report(dir, path.join(tmp, 'results'), path.join(tmp, 'out'), '1');
      assert.deepEqual(failed.checks?.filter((c) => !c.ok).map((c) => c.key), ['probe-openin']);
      assert.match(readFileSync(path.join(tmp, 'out', 'coverage-report.md'), 'utf8').split('\n')[0], /^\*\*Rehearsal: 1 of \d+ checks fail\*\* \(probe-openin\)/);
    } finally {
      console.log = log;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('installs the reference as all of TeX Live, without documentation or sources', () => {
    const p = lib.referenceProfile('/tmp/tl/');
    assert.match(p, /^selected_scheme scheme-full$/m);
    assert.match(p, /^TEXDIR \/tmp\/tl$/m);
    assert.match(p, /^tlpdbopt_install_docfiles 0$/m);
    assert.match(p, /^tlpdbopt_install_srcfiles 0$/m);
  });
  it('unpacks a source: a gzipped tar, a lone gzipped file, and refuses PDFs and paths that leave the folder', async () => {
    type Files = { files: Map<string, Uint8Array> } | { skip: string };
    const { sourceFiles } = await importScript<{ sourceFiles(b: Uint8Array, id: string, maxBytes?: number): Files }>('scripts/coverage.mjs');
    const header = (name: string, size: number) => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'utf8');
      h.write('0000644\0', 100);
      h.write('0000000\0', 108);
      h.write('0000000\0', 116);
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      h.write('00000000000\0', 136);
      h.write('0', 156);
      h.write('ustar\0', 257);
      h.write('00', 263);
      h.fill(0x20, 148, 156);
      let sum = 0;
      for (const b of h) {
        sum += b;
      }
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
      return h;
    };
    const tar = (entries: Record<string, string>) =>
      Buffer.concat([
        ...Object.entries(entries).flatMap(([name, text]) => {
          const body = Buffer.from(text);
          return [header(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512)];
        }),
        Buffer.alloc(1024),
      ]);
    const unpacked = sourceFiles(gzipSync(tar({ 'paper.tex': MAIN, 'figs/a.pdf': '%PDF-1.5' })), '2607.01234') as { files: Map<string, Uint8Array> };
    assert.deepEqual([...unpacked.files.keys()].sort(), ['figs/a.pdf', 'paper.tex']);
    assert.equal(Buffer.from(unpacked.files.get('paper.tex') as Uint8Array).toString(), MAIN);
    const lone = sourceFiles(gzipSync(Buffer.from(MAIN)), '2607.01234') as { files: Map<string, Uint8Array> };
    assert.deepEqual([...lone.files.keys()], ['2607.01234.tex']);
    assert.deepEqual(sourceFiles(bytes('%PDF-1.7 ...'), 'x'), { skip: 'a PDF submission' });
    assert.deepEqual(sourceFiles(gzipSync(Buffer.from('%PDF-1.7 ...')), 'x'), { skip: 'a PDF submission' });
    assert.match((sourceFiles(gzipSync(tar({ '../../etc/x.tex': MAIN })), 'x') as { skip: string }).skip, /unreadable archive/);
    assert.deepEqual(sourceFiles(bytes('<html>'), 'x'), { skip: 'not a TeX source' });
    // A source that cannot be one folder, or is too big unpacked, is an unreadable archive, never a stopped stage.
    assert.deepEqual(sourceFiles(gzipSync(tar({ a: 'x', 'a/b.tex': MAIN })), 'x'), { skip: 'an unreadable archive ("a" is both a file and a folder)' });
    assert.deepEqual(sourceFiles(gzipSync(Buffer.alloc(5000)), 'x', 1000), { skip: 'an unreadable archive (more than 1000 bytes unpacked)' });
    assert.deepEqual(sourceFiles(tar({ 'a.tex': 'x'.repeat(600), 'b.tex': 'y'.repeat(600) }), 'x', 1000), {
      skip: 'an unreadable archive (more than 1000 bytes unpacked)',
    });
    assert.equal(lib.filesProblem(new Map([['a/b', bytes('x')], ['a/c', bytes('y')]]), 10), null);
  });

  it('reports every sampled document from papers.json and the templates, and says first when a shard is missing', async () => {
    const { report } = await importScript<{ report(dir: string, results: string, out: string, shards: string): void }>('scripts/coverage.mjs');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-report-test-'));
    try {
      const papers = Array.from({ length: 6 }, (_, i) => ({ key: `2607.0010${i}`, kind: 'paper', stratum: 'cs', main: 'main.tex', engine: null }));
      const dir = path.join(tmp, 'coverage');
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'papers.json'), JSON.stringify({ complete: true, quotas: { cs: 6 }, papers, skipped: [{ id: '2607.09999', stratum: 'cs', why: 'a PDF submission' }] }));
      writeFileSync(path.join(dir, 'frame.json'), JSON.stringify({ strata: { cs: { window: 60, eligible: 6, quota: 6 } } }));
      const templates = (JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-templates.json'), 'utf8')) as { templates: Template[] }).templates;
      const sample = lib.sampleDocuments(papers, templates, frame.seed, 2);
      const ok = { pdf: true, pages: 2, fatal: false, missing: [] };
      const mine = sample.filter((d) => d.shard === 0);
      const results = path.join(tmp, 'results', 'coverage-shard-0');
      mkdirSync(results, { recursive: true });
      writeFileSync(path.join(results, 'shard.json'), JSON.stringify({ shard: '0/2', documents: mine.map((d) => ({ key: d.key })), unreadable: [] }));
      writeFileSync(path.join(results, 'ours.json'), JSON.stringify({ documents: Object.fromEntries(mine.map((d) => [d.key, { engine: 'pdflatex', core: ok }])) }));
      writeFileSync(path.join(results, 'reference.json'), JSON.stringify({ documents: Object.fromEntries(mine.map((d) => [d.key, { engine: 'pdflatex', ...ok }])) }));
      const out = path.join(tmp, 'out');
      const log = console.log;
      console.log = () => undefined;
      try {
        report(dir, path.join(tmp, 'results'), out, '2');
      } finally {
        console.log = log;
      }
      const md = readFileSync(path.join(out, 'coverage-report.md'), 'utf8');
      const json = JSON.parse(readFileSync(path.join(out, 'coverage-report.json'), 'utf8')) as { complete: boolean; documents: { key: string; core: string }[]; method: Record<string, string> };
      const lost = sample.filter((d) => d.shard === 1).length;
      assert.equal(md.split('\n')[0], `**Incomplete.** Shard(s) 1 of 2 returned no results: their ${lost} document(s) are counted as not measured.`);
      assert.equal(json.complete, false);
      assert.equal(json.documents.length, sample.length);
      assert.equal(json.documents.filter((d) => d.core === 'not measured: shard 1 returned no results').length, lost);
      assert.equal(json.method['docs/coverage-method.md'], createHash('sha256').update(readFileSync(path.join(root, 'docs', 'coverage-method.md'))).digest('hex'));
      assert.match(md, new RegExp(`${lost} not measured`));
      assert.match(md, /Skipped before each quota was met: 1 \(a PDF submission 1\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
