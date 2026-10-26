// B1's engine steps (scripts/lib/bundle-engine.mjs; docs/DESIGN.md#engine-and-data), on the engine and the pinned engine build's
// image, which stands in for the new core tree here: the formats made in initex mode, the cost of the hyphenation
// patterns, and the closure test (a package that loads, one that needs XeTeX, and one that is not there). The
// real tree is built and tested on CI. Needs the engine files; skips without them.

import * as assert from 'node:assert/strict';
import { importScript, root } from '../support/helpers';
import { engineAssetPaths } from './support';

interface Host {
  stop(): Promise<unknown>;
  memory(): Promise<{ maxRss: number }>;
}
interface Format {
  name: string;
  engine: string;
  options: string;
  mode: boolean;
}
interface BundleEngine {
  startEngines(root: string, assets: object, count: number): Promise<Host[]>;
  buildFormats(host: Host, formats: Format[], wanted?: string[]): Promise<{ formats: Map<string, Buffer>; logs: Record<string, string> }>;
  patternCost(host: Host, formats: Format[], usOnly: string): Promise<{ withAll: number; usOnly: number; patterns: number }>;
  loadTarget(name: string, runfiles: string[]): { kind: string; name: string; file: string; main: boolean } | null;
  closureTest(host: Host, target: { kind: string; name: string; file: string; main: boolean }): Promise<{ engine: string; ok: boolean; missing: string[]; error: string | null }>;
  pool<T>(hosts: Host[], tasks: ((host: Host) => Promise<T>)[]): Promise<T[]>;
}

/** The AddFormat lines of TeX Live's latex-bin and xetex packages for the two formats the worker uses. */
const FORMATS: Format[] = [
  { name: 'pdflatex', engine: 'pdftex', options: '-etex -translate-file=cp227.tcx pdflatex.ini', mode: true },
  { name: 'xelatex', engine: 'xetex', options: '-etex xelatex.ini', mode: true },
];

describe('B1: the formats, the patterns\' cost and the closure test on the engine', function () {
  this.timeout(900000);
  let be: BundleEngine;
  let hosts: Host[] = [];

  before(async function () {
    const assets = engineAssetPaths();
    if (!assets) {
      this.skip();
    }
    be = await importScript<BundleEngine>('scripts/lib/bundle-engine.mjs');
    hosts = await be.startEngines(root, assets as object, 2);
  });
  after(async () => {
    await Promise.all(hosts.map((h) => h.stop()));
  });

  it('makes pdflatex.fmt and xelatex.fmt in initex mode, under the paths the worker reads', async () => {
    const { formats, logs } = await be.buildFormats(hosts[0], FORMATS);
    assert.deepEqual([...formats.keys()], ['texmf-var/web2c/pdftex/pdflatex.fmt', 'texmf-var/web2c/xetex/xelatex.fmt']);
    for (const [rel, bytes] of formats) {
      assert.ok(bytes.length > 1_000_000, `${rel}: ${bytes.length} bytes`);
    }
    assert.match(logs.pdflatex, /Beginning to dump on file pdflatex\.fmt/);
    assert.match(logs.xelatex, /Beginning to dump on file xelatex\.fmt/);
  });

  it('measures what the hyphenation patterns add to pdflatex.fmt', async () => {
    const cost = await be.patternCost(hosts[0], FORMATS, '% US English only\n');
    assert.ok(cost.usOnly < cost.withAll, JSON.stringify(cost));
    assert.ok(cost.patterns > 100_000, `the patterns add only ${cost.patterns} bytes`);
  });

  it('closure test: a package that loads, one that needs XeTeX, and one that is not there', async () => {
    const tex = (pkg: string, file: string) => be.loadTarget(pkg, [`tex/latex/${pkg}/${file}`, `doc/latex/${pkg}/README.md`]);
    assert.deepEqual(tex('amsmath', 'amsmath.sty'), { kind: 'package', name: 'amsmath', file: 'tex/latex/amsmath/amsmath.sty', main: true });
    assert.equal(be.loadTarget('fonts-only', ['fonts/type1/x/x.pfb']), null);
    const [amsmath, fontspec, missing] = await be.pool(hosts, [
      (h) => be.closureTest(h, tex('amsmath', 'amsmath.sty') as never),
      (h) => be.closureTest(h, tex('fontspec', 'fontspec.sty') as never),
      (h) => be.closureTest(h, { kind: 'package', name: 'no-such-package-b1', file: 'tex/latex/x/no-such-package-b1.sty', main: true }),
    ]);
    assert.deepEqual({ ...amsmath, error: null }, { engine: 'pdflatex', ok: true, missing: [], error: null });
    assert.equal(fontspec.engine, 'xelatex', 'fontspec runs on XeTeX');
    assert.equal(fontspec.ok, true, fontspec.missing.join('; '));
    assert.equal(missing.ok, false);
    assert.match(missing.missing.join(), /no-such-package-b1\.sty' not found/);
    const memory = await hosts[0].memory();
    assert.ok(memory.maxRss > 0);
  });
});
