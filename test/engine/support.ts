// Shared helpers for the S1 engine-gate tests (test/engine). One engine host per test run, forked from the fork
// file with the engine-host stubs; the test process itself runs under the unit-test stubs (.mocharc.engine.cjs).
// Results are written OUTSIDE the repository, to ../s1_runs/. For a private document they hold numbers only:
// no log line, which could quote its text (build gate 1, G1S-14). For the public corpus they keep the first five
// error lines, to help find a failure.

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { EngineHost } from '../../src/extension/engineHostClient';
import type { CompileJob, CompileResult, EngineAssetPaths, EngineInitInfo, ProjectFile } from '../../src/shared/engineJobs';
import type { EngineReady } from '../../src/shared/engineProtocol';
import { root } from '../support/helpers';

export const assetsRoot = path.resolve(root, '..', 'engine_assets');
const runsRoot = path.resolve(root, '..', 's1_runs');

/** The pinned engine files, or null when they have not been fetched (the engine tests then skip). */
export function engineAssetPaths(): EngineAssetPaths | null {
  const pins = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')) as {
    sources: { id: string; folder: string; patchedGlue: { sha256: string } }[];
  };
  const tl = pins.sources.find((s) => s.id === 'texlyre-busytex');
  if (!tl) {
    return null;
  }
  const dir = path.join(assetsRoot, tl.folder);
  const paths: EngineAssetPaths = {
    // The glue these pins name, in its own folder (scripts/lib/derived-glue.mjs), never another worktree's.
    glue: path.join(assetsRoot, 'derived', tl.patchedGlue.sha256.slice(0, 16), 'busytex.patched.js'),
    wasm: path.join(dir, 'busytex.wasm'),
    data: path.join(dir, 'texlive-extra.data'),
    loader: path.join(dir, 'texlive-extra.js'),
    cnfOverride: path.join(root, 'engine', 'texmf-override.cnf'),
    fontsConf: path.join(root, 'engine', 'fonts.conf'),
  };
  return Object.values(paths).every((p) => existsSync(p)) ? paths : null;
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
      throw new Error('engine assets missing; run node scripts/engine-assets.mjs and node scripts/engine-patch.mjs');
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
