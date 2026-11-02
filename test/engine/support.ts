// Shared helpers for the S1 engine-gate tests (test/engine). One engine host per test run, forked from the fork
// file with the engine-host stubs; the test process itself runs under the unit-test stubs (.mocharc.engine.cjs).
// Results are written OUTSIDE the repository, to ../s1_runs/. For a private document they hold numbers only:
// no log line, which could quote its text (build gate 1, G1S-14). For the public corpus they keep the first five
// error lines, to help find a failure.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackageContext } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData, readDataExtension } from '../../src/extension/engine/dataSets';
import { bundledEngineAssets } from '../../src/extension/engine/engineService';
import { EngineHost } from '../../src/extension/engineHostClient';
import type { InstalledSet } from '../../src/extension/project/packageScan';
import { imageKey, type CompileJob, type CompileResult, type DataImageRef, type EngineAssetPaths, type EngineInitInfo, type ProjectFile } from '../../src/shared/engineJobs';
import type { EngineReady } from '../../src/shared/engineProtocol';
import { EXTRA_DATA_NAME } from '../../src/shared/identity';
import { filesBothHold } from '../../src/shared/packageIndex';
import { importScript, root } from '../support/helpers';
import { missingInput } from '../support/missingData';

export const assetsRoot = path.resolve(root, '..', 'engine_assets');
const runsRoot = path.resolve(root, '..', 's1_runs');

/**
 * The engine files: engine.js and engine.wasm of the pinned engine release (engine/pins.json, livemd2tex-engine, in
 * ../engine_assets/<its folder>/), our texmf.cnf, and the core data in dist/data (scripts/stage-engine.mjs --data,
 * as its manifest names the image and index). Null when any is missing: the engine tests then skip, on CI with one
 * notice while the data packages are not pinned; once both are, a missing file fails them on CI (test/support/
 * missingData.ts), so a CI run never passes by skipping.
 */
export function engineAssetPaths(): EngineAssetPaths | null {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as { sources: { id: string; folder: string }[] };
  const engine = pins.sources.find((s) => s.id === 'livemd2tex-engine');
  const dir = engine ? path.join(assetsRoot, engine.folder) : '';
  const dataDir = path.join(root, 'dist', 'data');
  let image: { file?: string; index?: string } = {};
  try {
    image = (JSON.parse(readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')) as { image?: { file?: string; index?: string } }).image ?? {};
  } catch {
    // no core data staged
  }
  const paths: EngineAssetPaths = {
    glue: path.join(dir, 'engine.js'),
    wasm: path.join(dir, 'engine.wasm'),
    data: path.join(dataDir, image.file ?? 'missing.data'),
    index: path.join(dataDir, image.index ?? 'missing.index.json'),
    cnfOverride: path.join(root, 'engine', 'texmf-override.cnf'),
  };
  const missing = Object.values(paths).filter((p) => !existsSync(p));
  if (missing.length === 0 && engine) {
    return paths;
  }
  missingInput(missing.map((p) => path.relative(path.resolve(root, '..'), p)).join(', ') || 'the livemd2tex-engine pin');
  return null;
}

/**
 * Whether the staged engine and core data are there (dist/engine, dist/data: scripts/stage-engine.mjs --data). A
 * test without them skips, on CI with one notice while the data packages are not pinned; once both are, that is a
 * failure on CI (test/support/missingData.ts).
 */
export function stagedEngine(ctx: Mocha.Context): boolean {
  if (bundledEngineAssets(root)) {
    return true;
  }
  missingInput('the staged engine and core data (node scripts/stage-engine.mjs --data)');
  ctx.skip();
  return false;
}

let addOn: Promise<{ set: InstalledSet; image: DataImageRef } | null> | null = null;

/**
 * The Extra Packages add-on for the engine tests: the extra-data package that LIVEMD2TEX_EXTRA_DATA names, built by
 * the data builder for this engine, read as the extension reads an installed add-on. An unpacked package folder (the
 * builder's <out>/extra-data/) is read in place; a .vsix is unpacked once into a temporary folder, about 300 MB,
 * removed when the test process ends. Null without the variable or the staged core data. Documents whose packages
 * are in the add-on (memoir, biblatex, mwe and the rest) typeset only with it, as for a user who installed it
 * (needAddOn).
 */
export function extraAddOn(): Promise<{ set: InstalledSet; image: DataImageRef } | null> {
  addOn ??= (async () => {
    const file = process.env.LIVEMD2TEX_EXTRA_DATA;
    const core = await readCoreData(path.join(root, 'dist', 'data'));
    if (!file || !core) {
      return null;
    }
    let folder = file;
    if (!statSync(file).isDirectory()) {
      const { readZip } = await importScript<{ readZip(zip: Buffer): Map<string, Buffer> }>('scripts/lib/zip.mjs');
      folder = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-extra-'));
      const made = folder;
      process.once('exit', () => rmSync(made, { recursive: true, force: true }));
      for (const [name, bytes] of readZip(readFileSync(file))) {
        if (name.startsWith('extension/') && !name.endsWith('/')) {
          const out = path.join(folder, ...name.slice('extension/'.length).split('/'));
          mkdirSync(path.dirname(out), { recursive: true });
          writeFileSync(out, bytes);
        }
      }
    }
    const extra = await readDataExtension(folder, EXTRA_DATA_NAME, { texLive: core.manifest.texLive, abi: core.manifest.abi });
    assert.ok('image' in extra, `${path.basename(file)}: ${'problem' in extra ? extra.problem : ''}`);
    // The extension uses an add-on only when it shares no file name with the core (dataResolver.ts): so do the tests.
    const shared = filesBothHold(core.index, extra.set.index);
    assert.deepEqual(shared.slice(0, 5), [], `${path.basename(file)}: the extension would not use this add-on, which holds ${shared.length} of the core's file names`);
    return extra;
  })();
  return addOn;
}

/**
 * The add-on, for a test that needs it: a test without it skips, on CI with the notice while the data packages are
 * not pinned; once both are, that is a failure on CI (test/support/missingData.ts).
 */
export async function needAddOn(ctx: Mocha.Context): Promise<{ set: InstalledSet; image: DataImageRef }> {
  const extra = await extraAddOn();
  if (extra) {
    return extra;
  }
  missingInput('the Extra Packages add-on (LIVEMD2TEX_EXTRA_DATA, an extra-data package built for this engine)');
  ctx.skip();
  throw new Error('skipped');
}

/**
 * The extension's package context with the core data and, when the tests have it (extraAddOn), the add-on
 * installed: a document's preamble scan then mounts the add-on when it needs one of its packages, as the extension
 * does. Undefined without the staged core data.
 */
export async function testPackages(): Promise<PackageContext | undefined> {
  const core = await readCoreData(path.join(root, 'dist', 'data'));
  if (!core) {
    return undefined;
  }
  const extra = await extraAddOn();
  return packageContext(core, extra ? [extra] : []);
}

/**
 * A job with the add-on's image mounted, when the tests have the add-on: for the documents of the public corpus,
 * which a user would compile with it installed (memoir, mwe, biblatex are in it).
 */
export async function withAddOn(partial: Omit<CompileJob, 'id'>): Promise<Omit<CompileJob, 'id'>> {
  const extra = await extraAddOn();
  return extra ? { ...partial, dataImages: [extra.image], knownImages: [imageKey(extra.image)] } : partial;
}

export interface SharedEngine {
  host: EngineHost;
  ready: EngineReady;
  info: EngineInitInfo;
  startMs: number;
}

let shared: Promise<SharedEngine> | null = null;

/** Starts the engine host once per test run and loads the engine. */
export function sharedEngine(): Promise<SharedEngine> {
  shared ??= (async () => {
    const assets = engineAssetPaths();
    if (!assets) {
      throw new Error('engine assets missing; run node scripts/engine-assets.mjs and node scripts/stage-engine.mjs --data --data-package FILE');
    }
    const t0 = performance.now();
    const host = new EngineHost({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      execArgv: ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')],
      requestTimeoutMs: 120000,
    });
    const ready = await host.start();
    const info = await host.init(assets);
    return { host, ready, info, startMs: Math.round(performance.now() - t0) };
  })();
  return shared;
}

/** Every file below `dir`, as project files with "/" paths, skipping build leftovers (docs/DESIGN.md#live-behaviour). */
export function readFolder(dir: string, keep: (rel: string) => boolean = () => true): ProjectFile[] {
  const leftovers = /\.(aux|bbl|blg|log|synctex(\.gz)?|fls|fdb_latexmk|toc|out|xdv)$/i;
  const out: ProjectFile[] = [];
  const walk = (sub: string) => {
    for (const name of readdirSync(path.join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      const full = path.join(dir, rel);
      if (statSync(full).isDirectory()) {
        walk(rel);
      } else if (!leftovers.test(name) && keep(rel)) {
        out.push({ path: rel, data: new Uint8Array(readFileSync(full)) });
      }
    }
  };
  walk('');
  return out;
}

const FALLBACK = [
  /Font shape `[^']+' undefined/,
  /Some font shapes were not available, defaults substituted/,
  /Missing character: There is no/,
  /Could not locate a virtual\/physical font/,
  /font-not-found/,
  /Font [^\s]+ not found/,
  /not loadable: Metric \(TFM\) file not found/,
];
const SIZE_SUBSTITUTION = /Font shape `[^']+' in size <[^>]+> not available/;
const MKTEX = /mktex(pk|tfm|mf|fmt|tex)|kpathsea: Running/i;

export interface Analysis {
  pages: number | null;
  errors: string[];
  fallbacks: string[];
  sizeSubstitutions: number;
  mktex: string[];
  undefinedRefs: number;
}

export function analyse(result: CompileResult): Analysis {
  const text = `${result.log}\n${result.transcript}`;
  const lines = text.split('\n');
  const pagesMatch = /Output written on [^(]+\((\d+) pages?/.exec(result.log) ?? /(\d+) pages?, \d+ bytes/.exec(result.transcript);
  return {
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    // "! message", or "./file.tex:12: message" with -file-line-error.
    errors: [...new Set(result.log.split('\n').filter((l) => l.startsWith('!') || /^[^\s:]+:\d+: /.test(l)))],
    fallbacks: [...new Set(lines.filter((l) => FALLBACK.some((r) => r.test(l))).map((l) => l.trim()))],
    sizeSubstitutions: lines.filter((l) => SIZE_SUBSTITUTION.test(l)).length,
    mktex: [...new Set(lines.filter((l) => MKTEX.test(l)).map((l) => l.trim()))],
    // From the last pass's log only: earlier passes always have undefined references.
    undefinedRefs: result.log.split('\n').filter((l) => /undefined on input line|There were undefined (references|citations)/.test(l)).length,
  };
}

const results: Record<string, unknown> = { started: new Date().toISOString() };

export function record(name: string, value: unknown): void {
  results[name] = value;
}

export function writeResults(): string {
  mkdirSync(runsRoot, { recursive: true });
  const file = path.join(runsRoot, `s1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  return file;
}

let nextId = 1;
export function job(partial: Omit<CompileJob, 'id'>): CompileJob {
  return { id: nextId++, ...partial };
}

/** S1's pass test: the engine host's peak memory stays under 1.5 GB (docs/DESIGN.md#engine-and-data; G1S-05). */
export const MAX_RSS_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * A compile plus the engine host's memory afterwards, recorded under `name`. Fails when the engine host's peak
 * memory reaches 1.5 GB. `privateDoc`: record numbers only (G1S-14).
 */
export async function compileAndRecord(name: string, j: CompileJob, options: { privateDoc?: boolean } = {}): Promise<{ result: CompileResult; analysis: Analysis }> {
  const { host } = await sharedEngine();
  const result = await host.compile(j);
  const analysis = analyse(result);
  const memory = await host.memory();
  record(name, {
    ok: result.ok,
    error: result.error,
    pdfBytes: result.pdf?.length ?? 0,
    synctexBytes: result.synctex?.length ?? 0,
    timings: result.timings,
    steps: result.steps.map((s) => ({ tool: s.argv[0], exitCode: s.exitCode, ms: s.ms, heapMB: Math.round(s.heapBytes / 1048576) })),
    analysis: options.privateDoc
      ? { ...analysis, errors: analysis.errors.length, fallbacks: analysis.fallbacks.length, mktex: analysis.mktex.length }
      : { ...analysis, errors: analysis.errors.length, errorLines: analysis.errors.slice(0, 5) },
    workerStubs: result.stubs,
    maxRssMB: Math.round(memory.maxRss / 1048576),
    rssMB: Math.round(memory.rss / 1048576),
  });
  assert.ok(memory.maxRss < MAX_RSS_BYTES, `${name}: the engine host's peak memory is ${Math.round(memory.maxRss / 1048576)} MB, over 1.5 GB`);
  return { result, analysis };
}
