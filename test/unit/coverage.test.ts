// M5's coverage measurement, the pure parts (scripts/lib/coverage.mjs; docs/coverage-method.md): the OAI-PMH page
// reader, the frame and its strata, the draw (order, quotas and shards), the pacer under arXiv's terms, a source's
// version, main file and engine, what "compiles" means for both sides, the Wilson interval, every document's
// outcome and the report. No network and no process here; the report stage's test writes only a temp folder.

import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { importScript, root } from '../support/helpers';
import { extensionEngine, measurementSetting } from '../engine/coverageEngine';
import { lzma2Encode, xzStream, type Chunk } from '../support/xzEncode';

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
type Outcome = { pdf: boolean; pages: number | null; fatal: boolean; missing: string[]; errors?: number; engine?: string; timedOut?: boolean; unsupported?: string; engineStopped?: boolean; restartFailed?: boolean };
type Share = { k: number; n: number; share: number | null; low: number | null; high: number | null };
type LeftOut = Record<'not measured' | 'broken as submitted' | 'fails on TeX Live', number>;
type LocalCounts = { examples: Record<string, number>; templates: number; beamer: number };
type LocalFrame = { examples: Record<string, string[]>; templates: string[]; beamer: string[]; counts: LocalCounts };
type LocalSpec = {
  seed: string;
  names: string;
  examples: { sampleSize: number; strata: { id: string; topics: string[] }[] };
  templates: { collection: string; beamer: { topic: string; name: string } };
  fetch: { secondsBetweenRequests: number; attempts: number; retrySeconds: number; stopAfter: number };
  notMeasuredLimit: number;
  failsOnTeXLiveLimit: number;
  brokenAsSubmittedLimit: number;
  shardLeftOutChance: number;
  expected: LocalCounts & { members: string };
};
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
  sampleDocuments(papers: { key: string; kind: string; stratum: string | null }[], templates: Template[], seed: string, shards: number): SampledDoc[];
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
  judge(ours: Outcome | null, reference: Outcome | null, tolerance?: number, options?: { swapped?: boolean }): { compiles: boolean | null; why: string };
  errorsInLog(log: string): number;
  engineSwapped(ours: string | null | undefined, reference: { engine?: string } | null | undefined): boolean;
  wilson(k: number, n: number, z?: number): Share;
  formatShare(s: Share): string;
  referenceProfile(dir: string): string;
  tarOf(files: Map<string, Uint8Array>): Buffer;
  arxivEnabled(frame: unknown): boolean;
  topicStratum(topics: string[], strata: { id: string; topics: string[] }[]): string;
  exampleFiles(pkg: { docfiles: string[] }, names: string): string[];
  exampleOrder(seed: string, name: string, files: string[]): string[];
  docTreeEngine(file: string): string | null;
  referenceEngine(requested: string | null, ours: { engine?: string; started?: string } | undefined): string;
  measuredChecks(documents: { kind: string; notMeasured?: string }[], kinds: string[], limit: number, tolerance?: number): { key: string; ok: boolean; got: string }[];
  cnfSettings(text: string, names: string[]): Record<string, string>;
  LOG_LINE_SETTINGS: string[];
  loadsPstricks(text: string): boolean;
  exampleFolder(archive: Map<string, Uint8Array>, file: string): Map<string, Uint8Array>;
  frameDiffers(frame: LocalFrame, expected: LocalCounts & { members?: string }): string | null;
  frameMembers(frame: LocalFrame): string;
  ENGINE_FILES: string[];
  missingFiles(names: string[], exists: (name: string) => boolean): string[];
  canaryChecks(shards: { index: number; canary?: unknown }[], side?: string): { key: string; ok: boolean; got: string }[];
  texLiveChecks(documents: { kind: string; notMeasured?: string; reference?: unknown }[], kinds: string[], limits: { fails: number; broken: number }): { key: string; ok: boolean; got: string }[];
  leftOutShardChecks(documents: { kind: string; shard: number; notMeasured?: string; reference?: unknown }[], kinds: string[], alpha: number): { key: string; ok: boolean; got: string }[];
  binomialTail(n: number, k: number, p: number): number;
  CANARY_DOCUMENTS: Record<string, string>;
  localFrame(db: Map<string, unknown>, local: LocalSpec): LocalFrame;
  rehearsalProbes(): { key: string; what: string; files: Record<string, string>; ok(r: Outcome & { engine: string }): boolean }[];
  rehearsalChecks(documents: unknown[], facts: { offline: boolean; ghostscript: string[] }): { key: string; what: string; ok: boolean; got: string }[];
  assemble(sample: SampledDoc[], shards: number, results: Record<number, unknown>): { documents: Assembled[]; missingShards: number[] };
  buildReport(documents: unknown[], frame?: unknown, tolerance?: number, mainKind?: string): {
    main: string;
    kinds: Record<string, { documents: number; core: Share; extra: Share; leftOut: LeftOut }>;
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

/**
 * A made-up tlpdb for the frame without arXiv: the publisher collection with one member, a Beamer theme, six
 * packages with example files (one listing maths before font, two with no topic, one whose archive no mirror
 * serves, one whose first example cannot be one folder), and three that are not in the frame (no example file, a
 * TLCore record, an example outside the doc tree). `archives` gives the doc archives'
 * SHA-512 and size.
 */
function FAKE_TLPDB(archives: Record<string, { sha512: string; size: number }>): string {
  const doc = (name: string) => (archives[name] ? `doccontainersize ${archives[name].size}\ndoccontainerchecksum ${archives[name].sha512}\n` : '');
  return [
    'name collection-publishers\ncategory Collection\ndepend pubA\n',
    `name pubA\ncategory Package\ncatalogue-topics class journalpub\n${doc('pubA')}docfiles size=1\n RELOC/doc/latex/pubA/pubA-template.tex\n RELOC/doc/latex/pubA/README\n`,
    `name beamertheme-x\ncategory Package\ncatalogue-topics presentation\n${doc('beamertheme-x')}docfiles size=1\n RELOC/doc/lualatex/beamertheme-x/demo.tex\n`,
    `name fontpkg\ncategory Package\nrelocated 1\ncatalogue-topics maths font\n${doc('fontpkg')}docfiles size=1\n RELOC/doc/lualatex/fontpkg/fontpkg-sample.tex details="Example"\n`,
    `name mathpkg\ncategory Package\ncatalogue-topics maths-theorem\n${doc('mathpkg')}docfiles size=1\n RELOC/doc/latex/mathpkg/examples/example-a.tex\n RELOC/doc/latex/mathpkg/examples/example-b.tex\n RELOC/doc/latex/mathpkg/mathpkg.pdf\n`,
    `name oddpkg\ncategory Package\n${doc('oddpkg')}docfiles size=1\n texmf-dist/doc/latex/oddpkg/Minimal.TEX\n`,
    `name brokenpkg\ncategory Package\ncatalogue-topics pgf-tikz\n${doc('brokenpkg')}docfiles size=1\n RELOC/doc/latex/brokenpkg/example.tex\n`,
    `name gonepkg\ncategory Package\ncatalogue-topics diagram\n${doc('gonepkg')}docfiles size=1\n RELOC/doc/latex/gonepkg/example.tex\n`,
    `name clashpkg\ncategory Package\n${doc('clashpkg')}docfiles size=1\n RELOC/doc/latex/clashpkg/a/example.tex\n RELOC/doc/latex/clashpkg/b/example.tex\n`,
    'name plainpkg\ncategory Package\ncatalogue-topics maths\ndocfiles size=1\n RELOC/doc/latex/plainpkg/plainpkg.tex\n RELOC/doc/latex/plainpkg/README\n',
    'name tlcorething\ncategory TLCore\ndocfiles size=1\n texmf-dist/doc/x/example.tex\n',
    'name runonly\ncategory Package\ncatalogue-topics maths\nrunfiles size=1\n RELOC/tex/latex/runonly/example.tex\n',
  ].join('\n');
}

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
    // A % !TEX program = latex line asks for the DVI route, which the reference runs.
    assert.deepEqual(lib.chooseMain(files({ 'a.tex': `% !TEX program = latex\n${MAIN}` })), { main: 'a.tex', engine: 'latex', how: 'the one main file' });
    assert.equal((lib.chooseMain(files({ 'a.tex': `%!TeX TS-program = LaTeX\n${MAIN}` })) as { engine: string }).engine, 'latex');
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

    // Rule 4: on another engine than TeX Live's (a LuaLaTeX request on XeTeX, the DVI route on pdfLaTeX), a compile
    // counts only with no more TeX errors than TeX Live's log. luacode on XeTeX stops with an error TeX recovers from.
    const log = [
      'This is XeTeX, Version 3.141592653',
      './main.tex:4: Package luacode Error: LuaTeX is required for this package. Aborting.',
      'See the luacode package documentation for explanation.',
      '! Undefined control sequence.',
      'l.7 \\luaexec',
      'Output written on main.pdf (1 page).',
    ].join('\n');
    assert.equal(lib.errorsInLog(log), 2);
    assert.equal(lib.errorsInLog(''), 0);
    assert.equal(lib.engineSwapped('xelatex', { engine: 'lualatex' }), true);
    assert.equal(lib.engineSwapped('pdflatex', { engine: 'latex' }), true);
    assert.equal(lib.engineSwapped('xelatex', { engine: 'xelatex' }), false);
    assert.equal(lib.engineSwapped(null, { engine: 'lualatex' }), false);
    const clean = { ...ref, errors: 0 };
    assert.deepEqual(lib.judge({ ...ok, errors: 2 }, clean, 1, { swapped: true }), { compiles: false, why: "2 TeX error(s) on another engine than TeX Live's, which has 0" });
    assert.deepEqual(lib.judge({ ...ok, errors: 1 }, { ...ref, errors: 1 }, 1, { swapped: true }), { compiles: true, why: 'compiles' });
    assert.deepEqual(lib.judge({ ...ok, errors: 2 }, clean), { compiles: true, why: 'compiles' }, 'on the same engine, errors TeX recovers from do not count by themselves');
    assert.deepEqual(lib.judge(ok, ref, 1, { swapped: true }), { compiles: null, why: 'not measured: run on another engine than TeX Live, with no error count to compare' });
    // Rules 1 to 3 come first.
    assert.deepEqual(lib.judge({ ...ok, errors: 2, pages: 12 }, clean, 1, { swapped: true }), { compiles: false, why: '12 page(s), TeX Live 10' });
  });

  it('writes the reference\'s log with the extension\'s line lengths, so rule 4 counts the same errors on both sides', async () => {
    // The extension's engine reads engine/texmf-override.cnf; TeX Live's default max_print_line (79) would break a
    // long "file:line:" across lines on the reference's side only.
    const override = readFileSync(path.join(root, 'engine', 'texmf-override.cnf'), 'utf8');
    const ours = Object.fromEntries(lib.LOG_LINE_SETTINGS.map((n) => [n, new RegExp(`^${n}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(override)?.[1]]));
    assert.deepEqual(lib.LOG_LINE_SETTINGS, ['max_print_line', 'error_line', 'half_error_line']);
    assert.ok(Object.values(ours).every((v) => typeof v === 'string' && Number(v) > 0), JSON.stringify(ours));
    assert.ok(Number(ours.max_print_line) >= 1000, 'the extension does not wrap its log');
    const { referenceEnvironment } = await importScript<{ referenceEnvironment(base: Record<string, string>): Record<string, string> }>('scripts/coverage.mjs');
    const env = referenceEnvironment({ PATH: '/usr/bin', HOME: '/home/runner' });
    for (const n of lib.LOG_LINE_SETTINGS) {
      assert.equal(env[n], ours[n], n);
    }
    assert.deepEqual([env.openin_any, env.openout_any, env.shell_escape, env.PATH], ['p', 'p', 'p', '/usr/bin']);
    const script = readFileSync(path.join(root, 'scripts', 'coverage.mjs'), 'utf8');
    assert.ok(script.includes('const env = referenceEnvironment();'), 'the reference runs with that environment');
    // The reader takes "name = value" lines, ignores comments, and refuses a setting that is not there.
    assert.deepEqual(lib.cnfSettings('% a comment\nerror_line = 254 % why\nmax_print_line=10000\n', ['max_print_line', 'error_line']), { max_print_line: '10000', error_line: '254' });
    assert.throws(() => lib.cnfSettings('error_line = 254\n', ['error_line', 'half_error_line']), /not set in the configuration: half_error_line/);
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
    // The extension's side: the corpus compiles with core-data, as TeX Live does; `ours` breaks it.
    const docs = (over: Record<string, Partial<Outcome & { engine: string }>> = {}, ours: Record<string, Partial<Outcome>> = {}) =>
      Object.entries(good).map(([key, r]) => ({
        key,
        stratum: key.startsWith('corpus') ? 'corpus' : 'probe',
        reference: { ...r, ...over[key] },
        core: { pdf: true, pages: r.pages, fatal: false, missing: [], ...ours[key] },
      }));
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
    // A broken engine on the extension's side fails the corpus check, not the share.
    assert.deepEqual(
      lib.rehearsalChecks(docs({}, { 'corpus-P1': { pdf: false, pages: null, fatal: true } }), facts).filter((c) => !c.ok).map((c) => c.key),
      ['corpus-P1'],
    );
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
      assert.ok(['corpus-P1', 'corpus-P5', 'corpus-P8', 'corpus-multiroot', 'corpus-xelatex'].every((k) => keys.includes(k)), keys.join(' '));
      // The XeLaTeX corpus document gets XeLaTeX by the extension's rule (fontspec), so the corpus check covers it.
      assert.equal(papers.papers.find((p) => p.key === 'corpus-xelatex')?.main, 'xelatex.tex');
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
      const healthy = { before: { pdflatex: true, xelatex: true }, after: { pdflatex: true, xelatex: true } };
      write('ours.json', { stubs: { checked: true, blocked: [], workers: { withoutRecord: 0 } }, canary: healthy, documents: Object.fromEntries(sample.map((d) => [d.key, { engine: 'pdflatex', core: ok }])) });
      write('reference.json', { ghostscript: '10.02.1', offline: true, canary: healthy, documents: Object.fromEntries(sample.map((d) => [d.key, ref(d.key)])) });
      const passed = report(dir, path.join(tmp, 'results'), path.join(tmp, 'out'), '1');
      assert.deepEqual(passed.checks?.filter((c) => !c.ok), []);
      const md = readFileSync(path.join(tmp, 'out', 'coverage-report.md'), 'utf8');
      assert.match(md.split('\n')[0], /^\*\*Rehearsal: all \d+ checks pass\.\*\* No arXiv paper was fetched/);
      // TeX Live reads /etc/passwd: the rehearsal fails, and says which check.
      write('reference.json', { ghostscript: '10.02.1', offline: true, canary: healthy, documents: Object.fromEntries(sample.map((d) => [d.key, d.key === 'probe-openin' ? { ...ok, engine: 'pdflatex', pages: 2 } : ref(d.key)])) });
      const failed = report(dir, path.join(tmp, 'results'), path.join(tmp, 'out'), '1');
      assert.deepEqual(failed.checks?.filter((c) => !c.ok).map((c) => c.key), ['probe-openin']);
      assert.match(readFileSync(path.join(tmp, 'out', 'coverage-report.md'), 'utf8').split('\n')[0], /^\*\*Rehearsal: 1 of \d+ checks fail\*\* \(probe-openin\)/);
    } finally {
      console.log = log;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('counts what is in flight and what could not be fetched, and bounds what is not measured', () => {
    const sample = lib.sampleDocuments(
      [
        { key: 'example:a', kind: 'example', stratum: 'fonts' },
        { key: 'example:b', kind: 'example', stratum: 'fonts' },
        { key: 'example:c', kind: 'example', stratum: 'fonts', unavailable: 'HTTP 503' } as { key: string; kind: string; stratum: string },
      ],
      [],
      '20261026',
      1,
    );
    const ok = { pdf: true, pages: 1, fatal: false, missing: [] };
    const results = {
      0: {
        shard: { shard: '0/1', documents: [{ key: 'example:a' }, { key: 'example:b' }], unreadable: [] },
        // a: the extension's process stopped during it; b: TeX Live's did.
        ours: { documents: { 'example:a': { started: 'now', engine: 'pdflatex' }, 'example:b': { engine: 'pdflatex', core: ok } } },
        reference: { documents: { 'example:a': { engine: 'pdflatex', ...ok }, 'example:b': { started: 'now', engine: 'pdflatex' } } },
      },
    };
    const { documents } = lib.assemble(sample, 1, results);
    const r = lib.buildReport(documents, { strata: {} }, 1, 'example');
    const why = (k: string) => r.documents.find((d) => d.key === k)?.core;
    assert.equal(why('example:a'), 'the process stopped during this document');
    // TeX Live's process stopped: the runner's stop, so not measured (inside the bound), never left out.
    assert.equal(why('example:b'), "not measured: TeX Live's process stopped during it (shard 0)");
    assert.equal(why('example:c'), 'not measured: its documentation archive could not be fetched (HTTP 503)');
    assert.deepEqual([r.kinds.example.core.k, r.kinds.example.core.n], [0, 1]);
    // An engine host that died twice on a document is the document's failure.
    const ok1 = { pdf: true, pages: 1, fatal: false, missing: [] };
    assert.deepEqual(lib.judge({ ...ok1, pdf: false, pages: null, fatal: true, engineStopped: true }, ok1), { compiles: false, why: 'the engine stopped on this document' });
    // So is a death after which the fresh engine could not start: its own reason, never "not measured".
    assert.deepEqual(lib.judge({ ...ok1, pdf: false, pages: null, fatal: true, engineStopped: true, restartFailed: true }, ok1), {
      compiles: false,
      why: 'the engine stopped on this document, and a fresh one could not start after it',
    });
    const runner = readFileSync(path.join(root, 'test', 'engine', 'coverageRun.ts'), 'utf8');
    assert.ok(runner.includes('return { ...again, rejected: null, engineStopped: true, restartFailed: true };'), 'a failed restart after a death');

    // The in-flight mark holds the extension's own engine choice, so TeX Live runs the same engine when the
    // measuring process dies on the document (a fontspec preamble is XeTeX even when nothing asks for it).
    const fontspec = '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nx\n\\end{document}\n';
    const plain = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n';
    assert.equal(extensionEngine(fontspec, null), 'xelatex');
    assert.equal(extensionEngine(plain, null), 'pdflatex');
    assert.equal(extensionEngine(plain, 'lualatex'), 'xelatex', 'a LuaLaTeX request by the documentation tree: the measurement sets XeLaTeX');
    assert.equal(extensionEngine(`% !TEX program = lualatex\n${plain}`, null), 'xelatex');
    assert.equal(extensionEngine(`% !TEX program = latex\n${fontspec}`, 'latex'), 'pdflatex', 'the DVI route runs pdfLaTeX on the extension');
    assert.deepEqual([null, 'pdflatex', 'latex', 'xelatex', 'lualatex'].map((e) => measurementSetting(e)), ['pdflatex', 'pdflatex', 'pdflatex', 'xelatex', 'xelatex']);
    assert.ok(runner.includes('results[doc.key] = { started: new Date().toISOString(), engine: markEngine(doc) };'), "the mark holds the extension's engine");
    assert.ok(runner.includes('engineSetting: measurementSetting(doc.engine),'), "the compile gets the measurement's setting");
    // TeX Live then runs the engine of the mark: a crash on a fontspec document is judged against XeLaTeX.
    const mark = { started: '2026-10-27T12:00:00Z', engine: extensionEngine(fontspec, null) };
    assert.equal(lib.referenceEngine(null, mark), 'xelatex');
    assert.equal(lib.referenceEngine('lualatex', { started: '2026-10-27T12:00:00Z', engine: extensionEngine(plain, 'lualatex') }), 'lualatex', 'what the document asks for comes first');
    assert.equal(lib.referenceEngine(null, undefined), 'pdflatex');
    const crashed = lib.assemble([{ key: 'example:fs', kind: 'example', stratum: 'fonts', shard: 0 }], 1, {
      0: {
        shard: { shard: '0/1', documents: [{ key: 'example:fs' }], unreadable: [] },
        ours: { documents: { 'example:fs': { started: '2026-10-27T12:00:00Z', engine: extensionEngine(fontspec, null) } } },
        reference: { documents: { 'example:fs': { engine: 'xelatex', ...ok1 } } },
      },
    }).documents;
    assert.equal(lib.buildReport(crashed, { strata: {} }, 1, 'example').documents[0].core, 'the process stopped during this document');

    // A LuaLaTeX example run on XeTeX: counted as compiling only with no more TeX errors than TeX Live's LuaLaTeX.
    const lua = ['example:lua1', 'example:lua2', 'example:plain'].map((key) => ({ key, kind: 'example', stratum: 'engines-pdf', shard: 0 }));
    const runOn = (errors: number, engine = 'xelatex') => ({ engine, core: { ...ok1, errors }, missingCore: [] });
    const swappedDocs = lib.assemble(lua, 1, {
      0: {
        shard: { shard: '0/1', documents: lua.map((d) => ({ key: d.key })), unreadable: [] },
        ours: { documents: { 'example:lua1': runOn(0), 'example:lua2': runOn(1), 'example:plain': runOn(3, 'pdflatex') } },
        reference: {
          documents: {
            'example:lua1': { engine: 'lualatex', ...ok1, errors: 0 },
            'example:lua2': { engine: 'lualatex', ...ok1, errors: 0 },
            'example:plain': { engine: 'pdflatex', ...ok1, errors: 0 },
          },
        },
      },
    }).documents;
    const swappedReport = lib.buildReport(swappedDocs, { strata: {} }, 1, 'example') as unknown as {
      kinds: Record<string, { swapped: { documents: number; compiles: number; moreErrors: number } }>;
      documents: { key: string; core: string; ranOn?: string }[];
    };
    assert.deepEqual(swappedReport.kinds.example.swapped, { documents: 2, compiles: 1, moreErrors: 1 });
    // A document rule 4 cannot judge (no error count on one side) is not measured, and counts in the 5 % bound
    // like every other cause.
    const pair = ['example:lua3', 'example:fine3'].map((key) => ({ key, kind: 'example', stratum: 'engines-pdf', shard: 0 }));
    const unjudged = lib.assemble(pair, 1, {
      0: {
        shard: { shard: '0/1', documents: pair.map((d) => ({ key: d.key })), unreadable: [] },
        ours: { documents: { 'example:lua3': { engine: 'xelatex', core: ok1, missingCore: [] }, 'example:fine3': runOn(0, 'pdflatex') } },
        reference: { documents: { 'example:lua3': { engine: 'lualatex', ...ok1, errors: 0 }, 'example:fine3': { engine: 'pdflatex', ...ok1, errors: 0 } } },
      },
    }).documents;
    assert.equal(
      (lib.buildReport(unjudged, { strata: {} }, 1, 'example') as unknown as { documents: { core: string }[] }).documents[0].core,
      'not measured: run on another engine than TeX Live, with no error count to compare',
    );
    assert.deepEqual(
      lib.measuredChecks(unjudged as unknown as { kind: string; notMeasured?: string }[], ['example'], 0.05).map((c) => [c.ok, c.got]),
      [[false, '1 of 2 (50.0 %) not measured; with the add-on 1 (50.0 %)']],
    );
    // The report passes its page tolerance, which rules 1 to 3 use before rule 4.
    assert.ok(readFileSync(path.join(root, 'scripts', 'coverage.mjs'), 'utf8').includes('measuredChecks(documents, parts, localSpec.notMeasuredLimit, rules.compile.pageTolerance)'));
    assert.deepEqual(
      swappedReport.documents.map((d) => [d.key, d.core, d.ranOn ?? null]),
      [
        ['example:lua1', 'compiles', 'xelatex'],
        ['example:lua2', "1 TeX error(s) on another engine than TeX Live's, which has 0", 'xelatex'],
        ['example:plain', 'compiles', null],
      ],
    );
    // The runner records TeX's error count, and tries a failed start or load once more for the document.
    assert.ok(runner.includes('errors: helpers.errorsInLog(log),'), 'the extension side counts errors');
    assert.ok(runner.includes('workers.startRetried++;'), 'a failed start or load is tried once more');
    const script = readFileSync(path.join(root, 'scripts', 'coverage.mjs'), 'utf8');
    assert.ok(script.includes('errors: errorsInLog(text),'), 'the TeX Live side counts errors');
    // The bound: at most 5 % of a part not measured.
    const part = (n: number, missing: number) => Array.from({ length: n }, (_, i) => ({ kind: 'example', ...(i < missing ? { notMeasured: 'x' } : {}) }));
    assert.equal(lib.measuredChecks(part(20, 1), ['example'], 0.05)[0].ok, true);
    assert.equal(lib.measuredChecks(part(20, 2), ['example'], 0.05)[0].ok, false);
    assert.equal(lib.measuredChecks(part(20, 2), ['example'], 0.05)[0].got, '2 of 20 (10.0 %) not measured; with the add-on 2 (10.0 %)');
    assert.equal(lib.measuredChecks([], ['template'], 0.05)[0].ok, false, 'a part with no document at all is no valid run');
    // PSTricks, outside comments.
    assert.deepEqual(
      ['\\usepackage{pstricks}', '\\usepackage[x]{amsmath,pst-node}', '% \\usepackage{pstricks}', '\\usepackage{tikz}', '\\RequirePackage{pst-plot}', '\\usepackage{pstool}'].map((s) => lib.loadsPstricks(s)),
      [true, true, false, false, true, false],
    );
  });

  it("guards the extension's engine: every engine file, a canary in every shard, a rejected compile not measured", () => {
    assert.deepEqual(lib.ENGINE_FILES, ['busytex.js', 'busytex.wasm', 'texmf-override.cnf', 'fonts.conf']);
    assert.deepEqual(lib.missingFiles(lib.ENGINE_FILES, (n) => n !== 'fonts.conf'), ['fonts.conf']);
    assert.deepEqual(lib.missingFiles(lib.ENGINE_FILES, () => true), []);
    // The canary: both known-good documents, before and after; a shard without the record fails too.
    const healthy = { before: { pdflatex: true, xelatex: true }, after: { pdflatex: true, xelatex: true } };
    const checks = lib.canaryChecks([
      { index: 0, canary: healthy },
      { index: 1, canary: { ...healthy, after: { pdflatex: false, xelatex: false } } },
      { index: 2, canary: { ...healthy, before: { pdflatex: true, xelatex: false } } },
      { index: 3 },
      { index: 4, canary: { before: {}, after: { pdflatex: true } } },
    ]);
    assert.deepEqual(
      checks.map((c) => [c.key, c.ok, c.got]),
      [
        ['canary-shard-0', true, 'pdflatex and xelatex, before and after'],
        ['canary-shard-1', false, 'failed: pdflatex after, xelatex after'],
        ['canary-shard-2', false, 'failed: xelatex before'],
        ['canary-shard-3', false, 'failed: none before, none after'],
        // A record that lists no engine, or only one, fails: both canaries must have passed.
        ['canary-shard-4', false, 'failed: pdflatex before, xelatex before, xelatex after'],
      ],
    );
    // A compile the engine service rejected says nothing about the document: not measured, with the reason.
    const sample = lib.sampleDocuments([{ key: 'example:a', kind: 'example', stratum: 'fonts' }], [], '20261026', 1);
    const { documents } = lib.assemble(sample, 1, {
      0: {
        shard: { shard: '0/1', documents: [{ key: 'example:a' }], unreadable: [] },
        ours: { documents: { 'example:a': { engine: 'pdflatex', rejected: 'EngineUnavailableError: the engine failed to start' } } },
        reference: { documents: { 'example:a': { engine: 'pdflatex', pdf: true, pages: 1, fatal: false, missing: [] } } },
      },
    });
    assert.equal(documents[0].notMeasured, 'the engine rejected its compile (EngineUnavailableError: the engine failed to start)');

    // Only the compile with the add-on was rejected: the core failure stays in the core share, and only the add-on
    // side is not measured, inside the bound with its own count.
    const two = lib.sampleDocuments(
      [
        { key: 'example:missing', kind: 'example', stratum: 'fonts' },
        { key: 'example:fine', kind: 'example', stratum: 'fonts' },
      ],
      [],
      '20261026',
      1,
    );
    const page = { pdf: true, pages: 1, fatal: false, missing: [] };
    const assembled = lib.assemble(two, 1, {
      0: {
        shard: { shard: '0/1', documents: two.map((d) => ({ key: d.key })), unreadable: [] },
        ours: {
          documents: {
            'example:missing': { engine: 'pdflatex', core: { ...page, missing: ['x.sty'] }, missingCore: [{ file: 'x.sty', package: 'x', inExtra: true }], extraRejected: 'EngineUnavailableError: the engine failed to load its data' },
            'example:fine': { engine: 'pdflatex', core: page },
          },
        },
        reference: { documents: { 'example:missing': { engine: 'pdflatex', ...page }, 'example:fine': { engine: 'pdflatex', ...page } } },
      },
    }).documents;
    const r = lib.buildReport(assembled, { strata: {} }, 1, 'example');
    assert.deepEqual([r.kinds.example.core.k, r.kinds.example.core.n], [1, 2], 'the core failure is counted');
    assert.deepEqual([r.kinds.example.extra.k, r.kinds.example.extra.n], [1, 1], 'the add-on side leaves the rejected compile out');
    assert.equal(r.documents.find((d) => d.key === 'example:missing')?.core, 'missing x.sty');
    assert.deepEqual(
      lib.measuredChecks(assembled as unknown as { kind: string; notMeasured?: string }[], ['example'], 0.05).map((c) => [c.ok, c.got]),
      [[false, '0 of 2 (0.0 %) not measured; with the add-on 1 (50.0 %)']],
    );
    // The same canaries on TeX Live, with checks of their own; and a bound on what fails on TeX Live.
    assert.equal(lib.canaryChecks([{ index: 7, canary: healthy }], 'tex-live')[0].key, 'canary-tex-live-shard-7');
    const onTexLive = (fails: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: 'template', reference: i < fails ? { ...page, pdf: false, pages: null, fatal: true } : page }));
    const limits = { fails: 0.2, broken: 0.2 };
    assert.deepEqual(lib.texLiveChecks(onTexLive(2, 10), ['template'], limits).map((c) => [c.key, c.ok]), [['tex-live-template', true], ['broken-template', true]]);
    assert.equal(lib.texLiveChecks(onTexLive(3, 10), ['template'], limits)[0].ok, false);
    assert.equal(lib.texLiveChecks(onTexLive(3, 10), ['template'], limits)[0].got, '3 of 10 (30.0 %)');
    // Broken as submitted is its own outcome, not counted as failing on TeX Live, with a bound of its own: a TeX
    // Live that lacks part of its tree leaves documents out this way.
    const brokenOnTexLive = (broken: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: 'template', reference: i < broken ? { ...page, missing: ['fig.pdf'] } : page }));
    assert.deepEqual(lib.texLiveChecks(brokenOnTexLive(1, 1), ['template'], limits).map((c) => c.got), ['0 of 1 (0.0 %)', '1 of 1 (100.0 %)']);
    assert.deepEqual(lib.texLiveChecks(brokenOnTexLive(2, 10), ['template'], limits).map((c) => c.ok), [true, true]);
    assert.deepEqual(lib.texLiveChecks(brokenOnTexLive(3, 10), ['template'], limits).map((c) => c.ok), [true, false]);
    // A part with no measured document passes neither bound.
    assert.deepEqual(lib.texLiveChecks([], ['beamer'], limits).map((c) => c.ok), [false, false]);

    // The shards' check: left-out documents fall on the shards by chance; one shard far above the others fails.
    assert.equal(lib.binomialTail(10, 0, 0.3), 1);
    assert.equal(lib.binomialTail(2, 2, 0.5), 0.25);
    assert.ok(Math.abs(lib.binomialTail(3, 2, 0.5) - 0.5) < 1e-12);
    assert.equal(lib.binomialTail(3, 4, 0.5), 0);
    const shard = (s: number, leftOut: number, n: number, missing = false) =>
      Array.from({ length: n }, (_, i) => ({ kind: 'example', shard: s, reference: i < leftOut ? (missing ? { ...page, missing: ['a.sty'] } : { ...page, fatal: true }) : page }));
    const even = [0, 1, 2, 3].flatMap((s) => shard(s, 3, 40));
    assert.deepEqual(lib.leftOutShardChecks(even, ['example'], 0.001).map((c) => [c.key, c.ok]), [0, 1, 2, 3].map((s) => [`left-out-shard-${s}`, true]));
    // Shard 2's TeX Live lacks part of its tree: 15 of its 40 documents broken as submitted, against 3 in each other.
    const partial = [...shard(0, 3, 40), ...shard(1, 3, 40), ...shard(2, 15, 40, true), ...shard(3, 3, 40)];
    const byShard = lib.leftOutShardChecks(partial, ['example'], 0.001);
    assert.deepEqual(byShard.map((c) => c.ok), [true, true, false, true]);
    assert.match(byShard[2].got, /^15 of 40 left out; the other shards 9 of 120; chance \d/);
    // Not measured documents, other parts and a single shard are outside the check.
    assert.deepEqual(lib.leftOutShardChecks(shard(0, 30, 40), ['example'], 0.001), []);
    assert.deepEqual(lib.leftOutShardChecks(partial.map((d) => ({ ...d, kind: 'corpus' })), ['example'], 0.001), []);
    // What the method says it can catch: with 60 documents a shard and nine other shards of 60, a shard fails at
    // about 19 left out where 9 are expected (15 %), and at about 10 where 3 are expected (5 %); one or two more
    // than expected pass.
    const flagsAt = (rate: number) => {
      const kRest = Math.round(rate * 540);
      let k = 0;
      while (lib.binomialTail(60, k, (kRest + 1) / 542) >= 0.001) {
        k++;
      }
      return k;
    };
    assert.deepEqual([flagsAt(0.15), flagsAt(0.05)], [19, 10]);
    const methodText = readFileSync(path.join(root, 'docs', 'coverage-method.md'), 'utf8');
    assert.ok(methodText.includes('a shard fails at about 19 left') && methodText.includes('at about 10, where 3 are expected'), 'the method gives these numbers');
  });

  it('downloads the frame without arXiv with curl, and refuses what is not the file', async () => {
    type Reply = { status: number; body: Buffer; type: string; error: string | null };
    const script = await importScript<{
      local: (...a: unknown[]) => unknown;
      downloadWithCurl: (...a: unknown[]) => unknown;
      curlArgs(url: string, userAgent: string | null, options?: { headers?: string; body?: string }): string[];
      mirrorCheck(options: { pins: unknown; download: (url: string) => Reply }): Promise<string>;
      badReply(reply: Reply, size?: number): string | null;
    }>('scripts/coverage.mjs');
    // texlive.info's bot check decides by the User-Agent: it answers Node's fetch, and curl with a project
    // User-Agent, with an HTML page. The stage downloads with curl and curl's own User-Agent, as B1 does.
    assert.match(script.local.toString(), /download \?\? \(\(url\) => downloadWithCurl\(url, maxBytes\)\)/);
    assert.doesNotMatch(script.local.toString(), /\bfetch\(/);
    assert.match(script.downloadWithCurl.toString(), /\bcurl\(url, null, /);
    assert.equal(script.curlArgs('https://h/x', null, { headers: 'h', body: 'b' }).includes('-A'), false, "no -A: curl's own User-Agent");
    const withAgent = script.curlArgs('https://h/x', 'liveMd2Tex-coverage/0.0.1', { headers: 'h', body: 'b' });
    assert.equal(withAgent[withAgent.indexOf('-A') + 1], 'liveMd2Tex-coverage/0.0.1');
    assert.equal(script.curlArgs('https://h/x', null, { headers: 'h', body: 'b' }).includes('-L'), false, 'no redirect is followed');
    // The mirror check: the tlpdb's signed checksum, as a file, naming the pinned SHA-512.
    const signed = 'f'.repeat(128);
    const pins = { snapshot: 's', mirrors: ['https://mirror.example/{snapshot}/'], tlpdb: { file: 'tlpkg/texlive.tlpdb.xz', signedSha512: signed } };
    const asked: string[] = [];
    const answer = (r: Partial<Reply>) => (url: string): Reply => (asked.push(url), { status: 200, body: Buffer.from(`${signed}  texlive.tlpdb\n`), type: 'text/plain', error: null, ...r });
    assert.match(await script.mirrorCheck({ pins, download: answer({}) }), /the signed SHA-512 the pins name/);
    assert.deepEqual(asked, ['https://mirror.example/s/tlpkg/texlive.tlpdb.sha512']);
    await assert.rejects(script.mirrorCheck({ pins, download: answer({ type: 'text/html', body: Buffer.from('<!doctype html>Oh noes!') }) }), /an HTML page instead of the file/);
    await assert.rejects(script.mirrorCheck({ pins, download: answer({ body: Buffer.from(`${'0'.repeat(128)}  texlive.tlpdb\n`) }) }), /does not name the pinned SHA-512/);
    await assert.rejects(script.mirrorCheck({ pins, download: answer({ status: 403 }) }), /HTTP 403/);
    const reply = (over: Partial<{ status: number; body: Buffer; type: string; error: string | null }>) => ({ status: 200, body: Buffer.from('xz bytes'), type: 'application/x-xz', error: null, ...over });
    assert.equal(script.badReply(reply({}), 8), null);
    assert.equal(script.badReply(reply({}), 9), "8 bytes, not the tlpdb's 9");
    assert.equal(script.badReply(reply({ status: 503 })), 'HTTP 503');
    assert.equal(script.badReply(reply({ error: 'curl: (28) Operation timed out' })), 'curl: (28) Operation timed out');
    assert.equal(script.badReply(reply({ type: 'text/html' })), 'an HTML page instead of the file (a bot check?)');
    assert.equal(script.badReply(reply({ body: Buffer.from('  <!DOCTYPE html><p>Oh noes!') })), 'an HTML page instead of the file (a bot check?)');
  });

  it('keeps the arXiv frame disabled until arXiv agrees, as the method says', () => {
    const arxiv = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-frame.json'), 'utf8')) as unknown;
    assert.equal(lib.arxivEnabled(arxiv), false);
    assert.equal(lib.arxivEnabled({ harvest: { enabled: true } }), true);
    assert.equal(lib.arxivEnabled({ harvest: { enabled: 'yes' } }), false);
    const method = readFileSync(path.join(root, 'docs', 'coverage-method.md'), 'utf8');
    assert.match(method, /^## The arXiv frame \(disabled: it waits for arXiv's permission\)$/m);
    assert.match(method, /No request goes to arXiv/);
  });

  it('agrees with docs/coverage-method.md on the frame without arXiv: the seed, the sizes, the strata, the README', () => {
    const spec = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-local-frame.json'), 'utf8')) as LocalSpec;
    const method = readFileSync(path.join(root, 'docs', 'coverage-method.md'), 'utf8');
    assert.ok(method.includes(`(the seed is **${spec.seed}**)`));
    assert.ok(method.includes(`**(a) Package examples: ${spec.examples.sampleSize} packages**`));
    for (const word of spec.names.split('|')) {
      assert.ok(method.includes(`\`${word}\``), word);
    }
    const total = Object.values(spec.expected.examples).reduce((a, b) => a + b, 0);
    for (const n of [total, spec.expected.templates, spec.expected.beamer]) {
      assert.ok(method.includes(`**${n}** packages`), String(n));
    }
    const quotas = lib.allocate(spec.expected.examples, spec.examples.sampleSize);
    assert.equal(Object.values(quotas).reduce((a, b) => a + b, 0), spec.examples.sampleSize);
    const rows = method.split('\n');
    for (const s of [...spec.examples.strata, { id: 'other', topics: [] }]) {
      const row = rows.find((r) => r.startsWith(`| ${s.id} | ${spec.expected.examples[s.id]} | ${quotas[s.id]} |`));
      assert.ok(row, s.id);
      for (const p of s.topics) {
        assert.ok((row as string).includes(p.endsWith('*') ? `\`${p}\`` : p), `${s.id}: ${p}`);
      }
    }
    assert.match(method, /\*\*These are TeX Live's own example and template documents, not papers\.\*\*/);
    // The bound on "not measured", the fetch rounds, and the dated list of changes since the method commit.
    assert.ok(method.includes(`more than **${(100 * spec.notMeasuredLimit).toFixed(0)} %** of any part is not`), 'the bound');
    assert.ok(method.includes(`more than **${(100 * spec.failsOnTeXLiveLimit).toFixed(0)} %** of a part's measured documents do not compile on`), 'the TeX Live bound');
    assert.ok(method.includes(`more than **${(100 * spec.brokenAsSubmittedLimit).toFixed(0)} %** are broken as submitted`), 'the broken-as-submitted bound');
    assert.ok(method.includes(`below **${spec.shardLeftOutChance}**`), 'the shards check');
    assert.equal(spec.fetch.stopAfter, 10);
    assert.ok(method.includes('Ten packages in a row whose downloads fail stop the measurement'));
    assert.equal(spec.fetch.attempts, 3);
    assert.ok(method.includes(`after ${spec.fetch.retrySeconds} seconds and after ${2 * spec.fetch.retrySeconds} more (three rounds)`), 'the rounds');
    assert.match(method, /^## Changes since the method was first written down$/m);
    assert.match(method, /first committed in 845b14b/);
    assert.match(method, /An example that needs the DVI route without asking for it drops out/);
    // The README reports the shares of TeX Live's own documents, never of papers.
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## How many documents compile'), readme.indexOf('\n## ', readme.indexOf('## How many documents compile') + 5));
    assert.match(section, /of TeX Live's own example and template documents/);
    assert.ok(section.includes('for each part on its own (package examples,'), 'each part on its own');
    assert.match(section, /with its worst and\s+best case/, "each share's worst and best case");
    assert.match(method, /beside each share, its worst and best case/, 'the worst and best case land in the README');
    assert.doesNotMatch(section, /of (recent arXiv )?papers|arXiv papers/i);
  });

  it('draws the frame without arXiv from a tlpdb: three parts, strata by topic priority, example files by name', async () => {
    const { parseTlpdb } = await importScript<{ parseTlpdb(text: string): Map<string, { name: string; docfiles: string[]; topics: string[] }> }>('scripts/lib/tlpdb.mjs');
    const spec = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-local-frame.json'), 'utf8')) as LocalSpec;
    const db = parseTlpdb(FAKE_TLPDB({}));
    assert.deepEqual(db.get('fontpkg')?.topics, ['maths', 'font']);
    const f = lib.localFrame(db, spec);
    assert.deepEqual(f.templates, ['pubA']);
    assert.deepEqual(f.beamer, ['beamertheme-x']);
    // fontpkg lists maths first, but fonts comes first in the strata table; oddpkg has no topic.
    assert.deepEqual(f.examples, {
      fonts: ['fontpkg'],
      'maths-science': ['mathpkg'],
      graphics: lib.drawOrder(spec.seed, ['brokenpkg', 'gonepkg']),
      other: lib.drawOrder(spec.seed, ['clashpkg', 'oddpkg']),
    });
    assert.deepEqual(f.counts, { examples: { fonts: 1, graphics: 2, 'maths-science': 1, other: 2 }, templates: 1, beamer: 1 });
    assert.equal(lib.topicStratum(['maths', 'font-type1'], spec.examples.strata), 'fonts');
    assert.equal(lib.topicStratum(['maths-theorem'], spec.examples.strata), 'maths-science');
    assert.equal(lib.topicStratum(['tagged-pdf-partially'], spec.examples.strata), 'engines-pdf');
    assert.equal(lib.topicStratum([], spec.examples.strata), 'other');
    // Example files: .tex files of the doc tree whose name says so; never another tree, never another kind of file.
    assert.deepEqual(lib.exampleFiles({ docfiles: ['RELOC/doc/latex/a/examples/example-1.tex', 'RELOC/doc/latex/a/a.tex', 'RELOC/doc/latex/a/sample.pdf', 'RELOC/tex/latex/a/demo.tex', 'texmf-dist/doc/latex/a/My-Template.TEX'] }, spec.names), [
      'doc/latex/a/examples/example-1.tex',
      'doc/latex/a/My-Template.TEX',
    ]);
    const files = ['doc/x/example-a.tex', 'doc/x/example-b.tex', 'doc/x/sample.tex'];
    assert.deepEqual(lib.exampleOrder(spec.seed, 'x', [...files].reverse()), lib.exampleOrder(spec.seed, 'x', files));
    assert.deepEqual([...lib.exampleOrder(spec.seed, 'x', files)].sort(), files);
    const archive = new Map([['doc/x/ex/example.tex', bytes(MAIN)], ['doc/x/ex/fig.pdf', bytes('%PDF')], ['doc/x/x.pdf', bytes('%PDF')]]);
    assert.deepEqual([...lib.exampleFolder(archive, 'doc/x/ex/example.tex').keys()], ['example.tex', 'fig.pdf']);
    // The engine an example's documentation tree names, after any % !TEX line.
    assert.deepEqual(
      ['doc/lualatex/a/sample.tex', 'doc/luatex/a/sample.tex', 'doc/xelatex/a/demo.tex', 'doc/latex/a/example.tex', 'doc/fonts/lualatex/x.tex', 'doc/platex/a/sample.tex'].map((p) => lib.docTreeEngine(p)),
      ['lualatex', 'lualatex', 'xelatex', null, null, null],
    );
    const written = { ...f.counts, members: lib.frameMembers(f) };
    assert.equal(lib.frameDiffers(f, written), null);
    assert.match(lib.frameDiffers(f, { ...written, templates: 2 }) ?? '', /not the one written down/);
    // The same counts with other members: two packages swapped between strata.
    const swapped = { ...f, examples: { ...f.examples, fonts: ['mathpkg'], 'maths-science': ['fontpkg'] } };
    assert.match(lib.frameDiffers(swapped, written) ?? '', /members .* are not the ones written down/);
    // A long name survives the tar the documents are packed in.
    const long = `doc/${'deep/'.repeat(30)}example.tex`;
    const { sourceFiles } = await importScript<{ sourceFiles(b: Uint8Array, id: string): { files: Map<string, Uint8Array> } }>('scripts/coverage.mjs');
    assert.deepEqual([...sourceFiles(gzipSync(lib.tarOf(new Map([[long, bytes(MAIN)]]))), 'x').files.keys()], [long]);
  });

  it('runs the local stage end to end on a made-up snapshot: only its mirror, checked archives, the frame written down', async () => {
    const { local, report } = await importScript<{
      local(dir: string, options: { download: (url: string) => Reply; pins: unknown; spec: LocalSpec; archives?: string }): Promise<void>;
      report(dir: string, results: string, out: string, shards: string): { complete: boolean; checks: { key: string; ok: boolean }[] | null };
    }>('scripts/coverage.mjs');
    const xz = await importScript<{ crc64(b: Uint8Array): string }>('scripts/lib/xz.mjs');
    const { parseTlpdb } = await importScript<{ parseTlpdb(text: string): Map<string, unknown> }>('scripts/lib/tlpdb.mjs');
    type Reply = { status: number; body: Buffer; type: string; error: string | null };
    const toXz = (data: Uint8Array) => {
      const chunks: Chunk[] = [];
      for (let i = 0; i < data.length; i += 65536) {
        chunks.push({ kind: 'stored', bytes: Math.min(65536, data.length - i), dictReset: i === 0 });
      }
      return Buffer.from(xzStream(lzma2Encode(data, chunks.length ? chunks : [{ kind: 'stored', bytes: 0, dictReset: true }]), data, 4, xz.crc64));
    };
    const hash = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest('hex');
    const PST = `% !TEX program = latex\n${MAIN.replace('\\begin{document}', '\\usepackage{pstricks}\n\\begin{document}')}`;
    const real = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-local-frame.json'), 'utf8')) as LocalSpec;
    const [clashFirst, clashOther] = lib.exampleOrder(real.seed, 'clashpkg', ['doc/latex/clashpkg/a/example.tex', 'doc/latex/clashpkg/b/example.tex']);
    const BEAMER = '\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}A frame.\\end{frame}\n\\end{document}\n';
    const trees: Record<string, Record<string, string>> = {
      pubA: { 'texmf-dist/doc/latex/pubA/pubA-template.tex': MAIN, 'texmf-dist/doc/latex/pubA/README': 'Read me.' },
      // Under doc/lualatex/ with no % !TEX line: LuaLaTeX.
      'beamertheme-x': { 'texmf-dist/doc/lualatex/beamertheme-x/demo.tex': BEAMER },
      // A relocated package's archive holds its paths without texmf-dist/.
      // Under doc/lualatex/, but its % !TEX line asks for XeLaTeX, and the line wins.
      fontpkg: { 'doc/lualatex/fontpkg/fontpkg-sample.tex': `% !TEX program = xelatex\n${MAIN}` },
      // Its one LaTeX main file asks for the DVI route and loads PSTricks.
      mathpkg: {
        'texmf-dist/doc/latex/mathpkg/examples/example-a.tex': 'Not a main file.',
        'texmf-dist/doc/latex/mathpkg/examples/example-b.tex': PST,
        'texmf-dist/doc/latex/mathpkg/examples/fig.pdf': '%PDF-1.5',
      },
      oddpkg: { 'texmf-dist/doc/latex/oddpkg/Minimal.TEX': 'No document class here.' },
      brokenpkg: { 'texmf-dist/doc/latex/brokenpkg/example.tex': MAIN },
      gonepkg: { 'texmf-dist/doc/latex/gonepkg/example.tex': MAIN },
      // The example tried first sits in a folder that cannot be one folder (a file and a folder of one name); the
      // other one is fine, and is never tried: the package is skipped.
      clashpkg: {
        [`texmf-dist/${clashFirst}`]: MAIN,
        [`texmf-dist/${clashFirst.replace(/example\.tex$/, 'x')}`]: 'a file',
        [`texmf-dist/${clashFirst.replace(/example\.tex$/, 'x/y')}`]: 'and a folder',
        [`texmf-dist/${clashOther}`]: MAIN,
      },
    };
    const archives = Object.fromEntries(Object.entries(trees).map(([n, files]) => [n, toXz(lib.tarOf(new Map(Object.entries(files).map(([p, s]) => [p, bytes(s)]))))]));
    const tlpdbText = FAKE_TLPDB(Object.fromEntries(Object.entries(archives).map(([n, a]) => [n, { sha512: hash('sha512', a), size: a.length }])));
    const tlpdbXz = toXz(bytes(tlpdbText));
    const base = 'https://mirror.example/snap/';
    const served = new Map<string, Uint8Array>([[`${base}tlpkg/texlive.tlpdb.xz`, tlpdbXz]]);
    for (const [n, a] of Object.entries(archives).filter(([n]) => n !== 'gonepkg')) {
      // The mirror changes one archive's bytes (same size, another SHA-512); gonepkg's comes back as a bot check's page.
      served.set(`${base}archive/${n}.doc.tar.xz`, n === 'brokenpkg' ? Buffer.from(a.map((b, i) => (i === a.length - 1 ? b ^ 1 : b))) : a);
    }
    const asked: string[] = [];
    let busy = true;
    const download = (url: string): Reply & { retryAfter?: number } => {
      asked.push(url);
      if (url.endsWith('gonepkg.doc.tar.xz')) {
        return { status: 200, body: Buffer.from('<!doctype html><title>Oh noes!</title>'), type: 'text/html', error: null };
      }
      // The host is busy once: a 503 with Retry-After, waited out, and the next round gets the file.
      if (url.endsWith('mathpkg.doc.tar.xz') && busy) {
        busy = false;
        return { status: 503, body: Buffer.alloc(0), type: 'text/plain', retryAfter: 0, error: null };
      }
      const b = served.get(url);
      return b ? { status: 200, body: Buffer.from(b), type: 'application/octet-stream', error: null } : { status: 404, body: Buffer.alloc(0), type: 'text/plain', error: null };
    };
    const pins = { snapshot: 'snap', mirrors: ['https://mirror.example/{snapshot}/'], tlpdb: { file: 'tlpkg/texlive.tlpdb.xz', sha256: hash('sha256', tlpdbXz), signatureChecked: 'the test' } };
    const spec: LocalSpec = {
      ...real,
      examples: { ...real.examples, sampleSize: 6 },
      fetch: { secondsBetweenRequests: 0, attempts: 3, retrySeconds: 0, stopAfter: 10 },
      expected: { examples: { fonts: 1, graphics: 2, 'maths-science': 1, other: 2 }, templates: 1, beamer: 1, members: '' },
    };
    spec.expected.members = lib.frameMembers(lib.localFrame(parseTlpdb(tlpdbText), spec));
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-local-test-'));
    const log = console.log;
    console.log = () => undefined;
    try {
      const dir = path.join(tmp, 'coverage');
      mkdirSync(dir);
      await local(dir, { download, pins, spec });
      assert.ok(asked.length > 0 && asked.every((u) => u.startsWith(base)), asked.join(' '));
      assert.ok(!asked.some((u) => /arxiv/i.test(u)));
      // A download that fails (an HTML page, another SHA-512) is asked for in three rounds, then kept as not measured.
      assert.equal(asked.filter((u) => u.endsWith('gonepkg.doc.tar.xz')).length, 3);
      assert.equal(asked.filter((u) => u.endsWith('brokenpkg.doc.tar.xz')).length, 3);
      assert.equal(asked.filter((u) => u.endsWith('mathpkg.doc.tar.xz')).length, 2, 'a 503, then the file');
      // The archives sit in a folder of their own, which the compile jobs never restore.
      assert.ok(existsSync(path.join(dir, 'archives', 'mathpkg.doc.tar.xz')));
      type Entry = { key: string; kind: string; stratum: string | null; source: string; main: string; engine: string | null; package?: string; file?: string; archiveSha512?: string; unavailable?: string; pstricks?: boolean };
      const papers = JSON.parse(readFileSync(path.join(dir, 'papers.json'), 'utf8')) as { frame: string; seed: string; complete: boolean; papers: Entry[]; skipped: { id: string; why: string }[] };
      assert.deepEqual([papers.frame, papers.seed, papers.complete], ['local', real.seed, true]);
      const byKey = new Map(papers.papers.map((p) => [p.key, p]));
      assert.deepEqual(
        papers.papers.filter((p) => p.kind !== 'corpus' && p.kind !== 'probe' && !p.unavailable).map((p) => [p.key, p.kind, p.stratum, p.main, p.engine]).sort(),
        [
          ['beamer:beamertheme-x', 'beamer', null, 'demo.tex', 'lualatex'],
          ['example:fontpkg', 'example', 'fonts', 'fontpkg-sample.tex', 'xelatex'],
          // % !TEX program = latex: the DVI route on the reference.
          ['example:mathpkg', 'example', 'maths-science', 'example-b.tex', 'latex'],
          ['template:pubA', 'template', null, 'pubA-template.tex', null],
        ],
      );
      assert.equal(byKey.get('example:mathpkg')?.archiveSha512, hash('sha512', archives.mathpkg));
      assert.equal(byKey.get('example:mathpkg')?.pstricks, true);
      // Kept in the sample, in its stratum's quota, never replaced.
      assert.equal(byKey.get('example:gonepkg')?.stratum, 'graphics');
      assert.match(byKey.get('example:gonepkg')?.unavailable ?? '', /an HTML page instead of the file/);
      assert.match(byKey.get('example:brokenpkg')?.unavailable ?? '', /the SHA-512 is not the tlpdb's/);
      assert.equal(byKey.has('example:clashpkg'), false);
      // The document is its example's folder, as arXiv packs a source.
      const { sourceFiles } = await importScript<{ sourceFiles(b: Uint8Array, id: string): { files: Map<string, Uint8Array> } }>('scripts/coverage.mjs');
      const folder = sourceFiles(readFileSync(path.join(dir, 'sources', byKey.get('example:mathpkg')?.source as string)), 'x').files;
      assert.deepEqual([...folder.keys()].sort(), ['example-a.tex', 'example-b.tex', 'fig.pdf']);
      assert.deepEqual(papers.skipped.map((s) => [s.id, s.why.replace(/ \(.*$/, '')]).sort(), [
        ['clashpkg', "its example's folder cannot be used"],
        ['oddpkg', 'no example file is a LaTeX main file'],
      ]);
      assert.ok(papers.papers.some((p) => p.kind === 'corpus') && papers.papers.some((p) => p.key === 'probe-openin'));

      // The report: the checks first, the shares of TeX Live's own documents, never of papers.
      const sample = lib.sampleDocuments(papers.papers, [], papers.seed, 1);
      const ok = { pdf: true, pages: 1, fatal: false, timedOut: false, missing: [] as string[] };
      const ref = (key: string) =>
        key === 'probe-dvi' ? { ...ok, engine: 'latex' } : key === 'probe-biber' ? { ...ok, engine: 'pdflatex', pages: 5 } : key === 'probe-missing' ? { ...ok, engine: 'pdflatex', missing: ['missing-figure.pdf'] } : { ...ok, engine: 'pdflatex' };
      const results = path.join(tmp, 'results', 'coverage-shard-0');
      mkdirSync(results, { recursive: true });
      writeFileSync(path.join(results, 'shard.json'), JSON.stringify({ shard: '0/1', documents: sample.map((d) => ({ key: d.key })), unreadable: [] }));
      // fontpkg's process stopped during it: only its start mark is there.
      const oursOf = (key: string) => (key === 'example:fontpkg' ? { started: '2026-10-26T12:00:00Z', engine: 'xelatex' } : { engine: 'pdflatex', core: ok });
      const healthy = { before: { pdflatex: true, xelatex: true }, after: { pdflatex: true, xelatex: true } };
      writeFileSync(path.join(results, 'ours.json'), JSON.stringify({ stubs: { checked: true, blocked: [], workers: { withoutRecord: 0 } }, canary: healthy, documents: Object.fromEntries(sample.map((d) => [d.key, oursOf(d.key)])) }));
      writeFileSync(path.join(results, 'reference.json'), JSON.stringify({ ghostscript: '10.02.1', offline: true, canary: healthy, documents: Object.fromEntries(sample.map((d) => [d.key, ref(d.key)])) }));
      const done = report(dir, path.join(tmp, 'results'), path.join(tmp, 'out'), '1');
      // Two package examples of four could not be fetched: past the 5 % bound, so the run does not count.
      assert.deepEqual(done.checks?.filter((c) => !c.ok).map((c) => c.key), ['measured-example']);
      const md = readFileSync(path.join(tmp, 'out', 'coverage-report.md'), 'utf8');
      assert.match(md.split('\n')[0], /^\*\*1 of \d+ checks fail\*\* \(measured-example\)\. The shares below do not count until every check passes\.$/);
      assert.match(md, /^# Coverage of TeX Live's own example and template documents \(M5, without arXiv\)$/m);
      // The document in flight counts as failing, not as not measured: 1 of 2.
      assert.match(md, /^\| Package examples \(one per package, by stratum\) \| 50\.0 % .*1 of 2\) \|/m);
      assert.match(md, /^\| Journal, conference and thesis templates \(publisher collection\) \| 100\.0 %/m);
      assert.match(md, /^\| Stratum \| Packages with examples \| Quota \|/m);
      assert.ok(md.includes('Not measured, per part (the run counts only with at most 5 % in each): example 2 of 4, template 0 of 1, beamer 0 of 1, corpus 0 of 5.'), md);
      assert.ok(md.includes('Package examples that load PSTricks: 1; left out of the shares: 0.'));
      // Each part's accounting, from the frame the stage wrote: in the frame, drawn, skipped, not measured, counted.
      assert.ok(md.includes("| example | 6 | 6 | 2 (its example's folder cannot be used 1; no example file is a LaTeX main file 1) | 2 (2; 0; 0) | 0 | 2 |"), md);
      assert.ok(md.includes('| template | 1 | 1 | 0 | 0 (0; 0; 0) | 0 | 1 |'), md);
      // What the bound allows: two of four examples not measured move the core share between 25 % and 75 %.
      assert.ok(md.includes('example: core alone 50.0 %, from 25.0 % (every document not measured failing) to 75.0 % (every one compiling);'), md);
      assert.match(md, /stratified by the frame's stratum sizes .*: core 50\.0 %/);
      assert.doesNotMatch(md, /arXiv papers|Sensitivity figure/);
      const json = JSON.parse(readFileSync(path.join(tmp, 'out', 'coverage-report.json'), 'utf8')) as {
        mode: string;
        kinds: Record<string, { documents: number }>;
        documents: { key: string; core: string }[];
        pstricks: { examples: number; leftOut: string[] };
      };
      assert.equal(json.mode, 'local');
      assert.deepEqual([json.kinds.example.documents, json.kinds.template.documents, json.kinds.beamer.documents], [4, 1, 1]);
      assert.equal(json.documents.find((d) => d.key === 'example:fontpkg')?.core, 'the process stopped during this document');
      assert.match(json.documents.find((d) => d.key === 'example:gonepkg')?.core ?? '', /^not measured: its documentation archive could not be fetched/);
      assert.deepEqual(json.pstricks, { examples: 1, leftOut: [] });

      // A frame that is not the one written down stops the stage; so does a tlpdb that is not the pinned one.
      const before = asked.length;
      await assert.rejects(local(path.join(tmp, 'other'), { download, pins, spec: { ...spec, expected: { ...spec.expected, templates: 2 } } }), /not the one written down/);
      assert.deepEqual(asked.slice(before), [`${base}tlpkg/texlive.tlpdb.xz`], 'nothing but the tlpdb before the frame stops the stage');
      // The tlpdb gets the archives' rounds too; and an earlier run's sample, restored from the cache, is removed
      // first, so a stage that stops early leaves none to be uploaded as its own.
      const third = path.join(tmp, 'third');
      mkdirSync(third);
      writeFileSync(path.join(third, 'papers.json'), JSON.stringify({ complete: true, papers: [] }));
      writeFileSync(path.join(third, 'frame.json'), '{}');
      const beforeThird = asked.length;
      await assert.rejects(local(third, { download, pins: { ...pins, tlpdb: { ...pins.tlpdb, sha256: 'f'.repeat(64) } }, spec }), /no mirror gave the pinned tlpdb/);
      assert.equal(asked.slice(beforeThird).filter((u) => u === `${base}tlpkg/texlive.tlpdb.xz`).length, spec.fetch.attempts, 'three rounds for the tlpdb');
      assert.deepEqual([existsSync(path.join(third, 'papers.json')), existsSync(path.join(third, 'frame.json'))], [false, false], 'no stale sample');
      // A host that stops answering: after so many packages in a row without a download, the stage stops.
      const blocked = (url: string): Reply => (url.includes('/archive/') ? { status: 200, body: Buffer.from('<!doctype html>Oh noes!'), type: 'text/html', error: null } : download(url));
      await assert.rejects(local(path.join(tmp, 'fourth'), { download: blocked, pins, spec: { ...spec, fetch: { ...spec.fetch, stopAfter: 2 } } }), /the snapshot's host stopped answering: 2 packages in a row/);
      // The stop is loud: the sample is saved as incomplete with the reason, and the report says no share stands.
      const stopped = JSON.parse(readFileSync(path.join(tmp, 'fourth', 'papers.json'), 'utf8')) as { complete: boolean; stopped?: string };
      assert.equal(stopped.complete, false);
      assert.match(stopped.stopped ?? '', /^the snapshot's host stopped answering: 2 packages in a row/);
      report(path.join(tmp, 'fourth'), path.join(tmp, 'no-results'), path.join(tmp, 'out-fourth'), '1');
      const stoppedMd = readFileSync(path.join(tmp, 'out-fourth', 'coverage-report.md'), 'utf8');
      assert.match(stoppedMd, /^\*\*Incomplete\.\*\* [^\n]*The local stage stopped before the sample was drawn in full \(the snapshot's host stopped answering: 2 packages in a row[^\n]*\): \d+ documents\. No share of this run stands\./m);
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
    const { report } = await importScript<{ report(dir: string, results: string, out: string, shards: string, options?: { commit?: string | null }): void }>('scripts/coverage.mjs');
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'coverage-report-test-'));
    // The report reads its commit from its arguments only: a GITHUB_SHA in the environment (as on CI) changes nothing.
    const sha = process.env.GITHUB_SHA;
    process.env.GITHUB_SHA = 'from-the-environment';
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
      assert.match(md, /Skipped while the sample was drawn: 1 \(a PDF submission 1\)/);
      assert.doesNotMatch(md, /from-the-environment|commit\(s\)|recorded no commit/);

      // With the commit given: the shards' commit is checked against it, and a shard that recorded none is named.
      const reportOn = (commit: string, shardCommit: string | undefined) => {
        writeFileSync(path.join(results, 'shard.json'), JSON.stringify({ shard: '0/2', commit: shardCommit, documents: mine.map((d) => ({ key: d.key })), unreadable: [] }));
        console.log = () => undefined;
        try {
          report(dir, path.join(tmp, 'results'), out, '2', { commit });
        } finally {
          console.log = log;
        }
        const j = JSON.parse(readFileSync(path.join(out, 'coverage-report.json'), 'utf8')) as { commit: string; notes: string[] };
        return { commit: j.commit, notes: j.notes, first: readFileSync(path.join(out, 'coverage-report.md'), 'utf8').split('\n')[0] };
      };
      const same = reportOn('b'.repeat(40), 'b'.repeat(40));
      assert.equal(same.commit, 'b'.repeat(40));
      assert.equal(same.notes.length, 1, same.notes.join(' | '));
      const other = reportOn('b'.repeat(40), 'a'.repeat(40));
      assert.ok(other.notes.includes(`Shards ran on commit(s) ${'a'.repeat(40)}, the report on ${'b'.repeat(40)}.`), other.notes.join(' | '));
      assert.ok(other.first.includes(`Shards ran on commit(s) ${'a'.repeat(40)}`));
      const none = reportOn('b'.repeat(40), undefined);
      assert.ok(none.notes.includes(`Shard(s) 0 recorded no commit; the report ran on ${'b'.repeat(40)}.`), none.notes.join(' | '));
    } finally {
      if (sha === undefined) {
        delete process.env.GITHUB_SHA;
      } else {
        process.env.GITHUB_SHA = sha;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
