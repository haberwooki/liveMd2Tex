// M5's compiles on the extension's own route (docs/coverage-method.md; docs/DESIGN.md#engine-and-data, #testing): each
// document of a shard (scripts/coverage.mjs --stage prepare wrote shard.json) through the preamble scan, the
// pipeline and the engine service, with core-data alone and, when the core lacks a file, with extra-data
// installed. Run on CI with the stubs loaded, so no compile may start a program or open a connection:
//
//   node --require ./test/stubs/register-unit.cjs out/test/engine/coverageRun.js --work W --data D --packages P
//        [--minutes 150]
//
// D holds core-data/data and extra-data/data unpacked from the packages as they ship; P holds the .vsix files,
// whose SHA-256 the report names. Writes W/ours.json: per document the engine, each compile's outcome (PDF,
// pages, fatal, missing files, seconds), for core alone the missing packages and where they are, and any attempt
// the engine host's stubs blocked. It is written after every document; past --minutes no new document starts, and
// the report counts the rest as not measured. It refuses to start unless this process's stubs are loaded and all
// four engine files are staged, and records what the stubs blocked (its own attempts, and each compile's
// worker's). A mark before each document makes one during which the process stops count as failing. A compile the
// engine service rejects is recorded as rejected (the report counts it as not measured), and the service is
// replaced. The canary (a pdfLaTeX and a XeLaTeX document) runs before the documents and after them.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { imagesForNotFound, prepareCompile, type PackageContext, type PreparedCompile } from '../../src/extension/compile/pipeline';
import { packageContext, readCoreData, readDataExtension } from '../../src/extension/engine/dataSets';
import { EngineService, EngineUnavailableError } from '../../src/extension/engine/engineService';
import { STUB_STATE_KEY, type StubReport } from '../../src/shared/engineProtocol';
import { EXTRA_DATA_NAME } from '../../src/shared/identity';
import { importScript, root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { extensionEngine, measurementSetting } from './coverageEngine';

interface ShardDocument {
  key: string;
  kind: string;
  folder: string;
  main: string;
  /** The engine the document asks for, or null (the extension's rule decides). */
  engine: string | null;
  /** The source ships the main file's .bbl: no bibtex8, as on arXiv. */
  bbl: boolean;
}

interface Outcome {
  pdf: boolean;
  pages: number | null;
  fatal: boolean;
  timedOut: boolean;
  missing: string[];
  /** TeX's errors in the last pass's log (rule 4 compares them on another engine than TeX Live's). */
  errors?: number;
  unsupported?: string;
  /** The engine host died on this document twice, on two services, or died and a fresh one could not start. */
  engineStopped?: boolean;
  /** The second case: the host died on this document, and the fresh service could not start or load after it. */
  restartFailed?: boolean;
  seconds: number;
}

interface Helpers {
  fatalInLog(log: string): boolean;
  notFoundInLog(log: string): string[];
  errorsInLog(log: string): number;
  ENGINE_FILES: string[];
  missingFiles(names: string[], exists: (name: string) => boolean): string[];
  /** The canaries, the same on the reference's side (scripts/lib/coverage.mjs). */
  CANARY_DOCUMENTS: Record<'pdflatex' | 'xelatex', string>;
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function pagesOf(pdf: Uint8Array | null): Promise<number | null> {
  if (!pdf) {
    return null;
  }
  try {
    return (await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    return null;
  }
}

/** The stubs' record in this process (test/stubs/stub-state.cjs), or null when they are not loaded. */
function ownStubs(): StubReport | null {
  const state = (globalThis as Record<symbol, { report(): StubReport } | undefined>)[Symbol.for(STUB_STATE_KEY)];
  return state ? state.report() : null;
}

async function main(): Promise<void> {
  const own = ownStubs();
  if (!own || !own.stubs.includes('process') || !own.stubs.includes('network')) {
    throw new Error('the stubs are not loaded: run with --require ./test/stubs/register-unit.cjs');
  }
  const work = path.resolve(arg('--work') ?? '');
  const data = path.resolve(arg('--data') ?? '');
  const packagesDir = arg('--packages');
  const helpers = await importScript<Helpers>('scripts/lib/coverage.mjs');
  const frame = JSON.parse(readFileSync(path.join(root, 'engine', 'coverage-frame.json'), 'utf8')) as { compile: { secondsPerCompile: number } };
  const limit = frame.compile.secondsPerCompile * 1000;
  const { documents } = JSON.parse(readFileSync(path.join(work, 'shard.json'), 'utf8')) as { documents: ShardDocument[] };

  const coreDir = path.join(data, 'core-data', 'data');
  const core = await readCoreData(coreDir);
  if (!core?.index) {
    throw new Error(`no core-data in ${coreDir}`);
  }
  const manifest = core.manifest as typeof core.manifest & { image: { file: string; index?: string }; snapshot?: string };
  // The image's index: named in the manifest (B1), else beside the image under its name (the interim data).
  const imageIndex = manifest.image.index ?? manifest.image.file.replace(/\.data$/i, '.index.json');
  const extra = await readDataExtension(path.join(data, 'extra-data'), EXTRA_DATA_NAME, { texLive: manifest.texLive, abi: manifest.abi, snapshot: manifest.snapshot });
  if ('problem' in extra) {
    throw new Error(`extra-data: ${extra.problem}`);
  }
  const extraFiles = extra.set.index.files;
  const coreAlone = packageContext({ index: core.index, elsewhere: core.elsewhere }, []);
  const withExtra = packageContext({ index: core.index, elsewhere: core.elsewhere }, [extra]);
  const engineDir = path.join(root, 'dist', 'engine');
  // Without the engine every compile would fail, and the shard would report failures that are not the documents'.
  const missingEngine = helpers.missingFiles(helpers.ENGINE_FILES, (name) => existsSync(path.join(engineDir, name)));
  if (missingEngine.length > 0) {
    throw new Error(`the engine is not staged: ${missingEngine.join(', ')} missing in ${engineDir} (node scripts/stage-engine.mjs)`);
  }
  let service = newService();
  function newService(): EngineService {
    const s = new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => ({
        glue: path.join(engineDir, 'busytex.js'),
        wasm: path.join(engineDir, 'busytex.wasm'),
        cnfOverride: path.join(engineDir, 'texmf-override.cnf'),
        fontsConf: path.join(engineDir, 'fonts.conf'),
        data: path.join(coreDir, manifest.image.file),
        loader: path.join(coreDir, imageIndex),
      }),
      idleMinutes: () => 0,
      log: () => undefined,
    });
    s.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    return s;
  }

  /** The extension's engine for a document, before its compile (the main file unreadable: what it asks for). */
  function markEngine(doc: ShardDocument): string {
    try {
      return extensionEngine(readFileSync(path.join(doc.folder, doc.main), 'utf8'), doc.engine);
    } catch {
      return doc.engine ?? 'pdflatex';
    }
  }

  /** One compile on the extension's route, within the time limit. */
  async function compile(doc: ShardDocument, packages: PackageContext, mountSets?: ReadonlySet<string>) {
    const started = Date.now();
    const prepared: PreparedCompile = await prepareCompile({
      fs: nodeFs(doc.folder),
      mainRel: doc.main,
      // The measurement's setting: XeLaTeX for a XeLaTeX or LuaLaTeX request, as a user who asks for either would
      // set it (the extension has no LuaLaTeX); otherwise the default, pdfLaTeX. The document's own % !TEX line and
      // preamble still decide inside prepareCompile, as they do for a user.
      engineSetting: measurementSetting(doc.engine),
      packages,
      mountSets,
    });
    if (doc.bbl) {
      prepared.job.bibtex = 'never';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = service.compile(prepared.job).then((r) => r.result);
    const outcome = await Promise.race([run, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), limit)))]).catch(
      // The engine could not start or load its data (EngineUnavailableError): the compile says nothing about the
      // document. Any other rejection is the engine host dying during this compile. A CompileResult may carry an
      // error field itself.
      (err: unknown) => (err instanceof EngineUnavailableError ? ({ rejected: String(err) } as const) : ({ died: String(err) } as const)),
    );
    clearTimeout(timer);
    const rejected = outcome !== 'timeout' && 'rejected' in outcome ? String(outcome.rejected).slice(0, 200) : null;
    const died = outcome !== 'timeout' && 'died' in outcome ? String(outcome.died).slice(0, 200) : null;
    if (outcome === 'timeout' || rejected || died) {
      // A service that timed out, that rejects compiles (it remembers a failed start) or whose host died is
      // replaced, so the next compile gets a working engine.
      run.catch(() => undefined);
      await service.stop().catch(() => undefined);
      service = newService();
    }
    const result = outcome === 'timeout' || rejected || died ? null : (outcome as Exclude<typeof outcome, 'timeout' | { rejected: string } | { died: string }>);
    return { prepared, result, rejected, died, engineStopped: false, restartFailed: false, timedOut: outcome === 'timeout', seconds: Math.round((Date.now() - started) / 1000) };
  }

  /**
   * A document's compile. When the engine cannot start or load, once more on a fresh service; a second failure is
   * "not measured". When the engine host dies during it, once more on a fresh service. A second death is the
   * document's failure ("the engine stopped on this document"), as it would be for a user. So is a fresh service
   * that cannot start or load right after the death: that is most likely the death's aftermath (memory not yet
   * given back, say), so it is the document's failure with its own reason, not "not measured".
   */
  async function compileDocument(doc: ShardDocument, packages: PackageContext, mountSets?: ReadonlySet<string>) {
    let c = await compile(doc, packages, mountSets);
    if (c.rejected) {
      // The engine could not start or load: once more on the fresh service, so that a passing failure becomes a
      // measurement. A second rejection is "not measured".
      workers.startRetried++;
      c = await compile(doc, packages, mountSets);
    }
    if (!c.died) {
      return c;
    }
    workers.died++;
    const again = await compile(doc, packages, mountSets);
    if (again.died) {
      workers.died++;
      return { ...again, engineStopped: true };
    }
    if (again.rejected) {
      workers.restartFailed++;
      return { ...again, rejected: null, engineStopped: true, restartFailed: true };
    }
    return again;
  }

  /** The canary: each known-good document compiled with core-data alone; true when it gives a page, nothing missing. */
  async function canary(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [engine, text] of Object.entries(helpers.CANARY_DOCUMENTS)) {
      const folder = path.join(work, 'canary', engine);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'main.tex'), text);
      try {
        const c = await compile({ key: `canary-${engine}`, kind: 'canary', folder, main: 'main.tex', engine, bbl: false }, coreAlone);
        const o = await outcomeOf(c);
        out[engine] = o.pdf && !o.fatal && o.missing.length === 0 && (o.pages ?? 0) >= 1;
      } catch {
        out[engine] = false;
      }
    }
    return out;
  }

  async function outcomeOf(c: Awaited<ReturnType<typeof compile>>): Promise<Outcome> {
    const log = c.result?.log ?? '';
    const scanned = (c.prepared.packageScan?.missing ?? []).map((m) => m.file);
    return {
      pdf: Boolean(c.result?.pdf),
      pages: await pagesOf(c.result?.pdf ?? null),
      fatal: !c.result || !c.result.pdf || helpers.fatalInLog(log) || Boolean(c.result.error),
      timedOut: c.timedOut,
      ...(c.engineStopped ? { engineStopped: true } : {}),
      ...(c.restartFailed ? { restartFailed: true } : {}),
      missing: [...new Set([...scanned, ...helpers.notFoundInLog(log)])].sort(),
      errors: helpers.errorsInLog(log),
      seconds: c.seconds,
    };
  }

  const packages = packagesDir && existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .filter((f) => f.endsWith('.vsix'))
        .map((f) => `${f} ${createHash('sha256').update(readFileSync(path.join(packagesDir, f))).digest('hex')}`)
    : [];
  // Written after every document, so a shard that runs out of time keeps what it measured.
  const results: Record<string, unknown> = {};
  // What the stubs saw: this process's blocked attempts, and the workers' (each compile reports its own record).
  const workers = { compiles: 0, withoutRecord: 0, blocked: 0, rejected: 0, startRetried: 0, died: 0, restartFailed: 0 };
  let stopped: string | null = null;
  // The shard's health: the canary before its documents and after them (docs/coverage-method.md).
  const health: { before: Record<string, boolean> | null; after: Record<string, boolean> | null } = { before: null, after: null };
  const save = () => {
    const stubs = { checked: true, role: own.role, blocked: ownStubs()?.blocked ?? [], workers };
    writeFileSync(path.join(work, 'ours.json'), `${JSON.stringify({ packages, stubs, stopped, canary: health, documents: results }, null, 2)}\n`);
  };
  const minutes = Number(arg('--minutes') ?? 150);
  const began = Date.now();
  health.before = await canary();
  save();
  try {
    for (const doc of documents) {
      if (Date.now() - began > minutes * 60000) {
        stopped = `its ${minutes} minutes on the extension's side ran out`;
        console.log(`  the shard's time is up: ${documents.length - Object.keys(results).length} document(s) not measured`);
        break;
      }
      // Marked before it runs: a document during which this process stops counts as failing, not as not measured.
      // The mark holds the engine the extension's own rule chooses, so TeX Live then runs that engine too.
      results[doc.key] = { started: new Date().toISOString(), engine: markEngine(doc) };
      save();
      try {
        const first = await compileDocument(doc, coreAlone);
        const core = await outcomeOf(first);
        const missingCore = core.missing.map((file) => {
          const m = first.prepared.packageScan?.missing.find((x) => x.file === file);
          return { file, package: m?.package ?? extraFiles[file] ?? file, inExtra: m?.offer?.id === EXTRA_DATA_NAME || file in extraFiles };
        });
        // The add-on is mounted only for a file the core lacks: with nothing missing, its result is the core's.
        let extraOutcome: Outcome | undefined;
        const runs = [first];
        if (core.missing.length > 0) {
          let again = await compileDocument(doc, withExtra);
          runs.push(again);
          const more = again.result ? imagesForNotFound(again.result, again.prepared) : [];
          if (more.length > 0) {
            again = await compileDocument(doc, withExtra, new Set(more));
            runs.push(again);
          }
          extraOutcome = await outcomeOf(again);
        }
        const blocked = runs.flatMap((c) => c.result?.stubs?.blocked ?? []);
        workers.compiles += runs.filter((c) => c.result).length;
        workers.withoutRecord += runs.filter((c) => c.result && !c.result.stubs).length;
        workers.rejected += runs.filter((c) => c.rejected).length;
        workers.blocked += blocked.length;
        // A compile the engine service rejected (it could not start or load) says nothing about the document. When
        // the core compile was rejected, the document is not measured. When only a compile with the add-on was, the
        // core result stands, and only the add-on side is not measured: a core failure is never thrown away.
        const extraRejected = runs.slice(1).find((c) => c.rejected)?.rejected ?? null;
        const engine = first.prepared.engine.engine;
        results[doc.key] = first.rejected
          ? { engine, rejected: first.rejected }
          : extraRejected
            ? { engine, core, missingCore, extraRejected, ...(blocked.length > 0 ? { blocked } : {}) }
            : { engine, core, ...(extraOutcome ? { extra: extraOutcome } : {}), missingCore, ...(blocked.length > 0 ? { blocked } : {}) };
        console.log(
          `  ${doc.key}: core ${core.pages ?? 'no'} page(s)${core.missing.length ? `, missing ${core.missing.join(' ')}` : ''}` +
            `${extraOutcome ? `; with extra ${extraOutcome.pages ?? 'no'} page(s)${extraOutcome.missing.length ? `, missing ${extraOutcome.missing.join(' ')}` : ''}` : ''}`,
        );
      } catch (err) {
        // A document the route cannot even prepare (a file it refuses, say): a fatal error for both.
        const failed: Outcome = { pdf: false, pages: null, fatal: true, timedOut: false, missing: [], seconds: 0 };
        results[doc.key] = { engine: doc.engine ?? 'pdflatex', core: failed, extra: failed, missingCore: [], error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
        console.log(`  ${doc.key}: not compiled (${err instanceof Error ? err.message : String(err)})`);
      }
      save();
    }
  } finally {
    health.after = await canary().catch(() => ({ pdflatex: false, xelatex: false }));
    await service.stop().catch(() => undefined);
    save();
  }
}

main().catch((err: unknown) => {
  console.error(`coverageRun: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
