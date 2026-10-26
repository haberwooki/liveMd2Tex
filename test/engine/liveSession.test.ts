// M2-A exit criteria at Node level (docs/DESIGN.md#testing): a scripted editing session drives the live preview's
// scheduler (src/extension/compile/scheduler.ts) with simulated typing and pauses, and every compile goes through
// the same pipeline and engine service the extension uses, on the unsaved text. It measures the share of pauses
// that produce a fresh PDF (one that holds every keystroke before the pause, before the next keystroke) and the
// latency from the last keystroke to the PDF.
//
// The session model (seeded, so runs compare): bursts of 4 to 30 keystrokes 60 to 220 ms apart, inserted into the
// first paragraph after the first \section (with an occasional backspace); in 15 percent of bursts a 1.0 to 1.8 s
// hesitation mid-burst, which starts a compile that the next keystroke cancels; between bursts a pause of 2 to
// 10 s (a writer stopping to read), and at 10 percent of pauses a save (a full pass). Only the pauses between
// bursts count toward the share; the hesitations are reported apart.
//
// Length: M2A_SESSION_SECONDS per document (600 for the exit criterion; default 45 for the regular suite). A run
// shorter than 300 s has too few pauses to judge a 90 percent share; its test title says so, and it checks only
// that the loop gives fresh PDFs (build gate 1, G1S-05).
// The viewer is not in this process: the latency is to the PDF bytes, and 100 ms is added for the viewer's swap
// (S3 measured 90 to 95 ms) before comparing with the limit.

import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nextState, prepareCompile, type DocumentState } from '../../src/extension/compile/pipeline';
import { CompileScheduler, type CompileOutcome, type CompileRequest } from '../../src/extension/compile/scheduler';
import { bundledEngineAssets, EngineService } from '../../src/extension/engine/engineService';
import { materializeCorpus, type CorpusProject } from '../support/corpusProjects';
import { root } from '../support/helpers';
import { nodeFs } from '../support/nodeFs';
import { docstripWith } from '../support/prepareV0Workspace';
import { record, writeResults } from './support';

const SESSION_SECONDS = Number(process.env.M2A_SESSION_SECONDS ?? 45);
const PAINT_MS = 100;
/** S1's warm single pass of T1 (docs/DESIGN.md#testing's reference): VS Code's Node 24 and plain Node 22. */
const S1_T1_SINGLE_PASS_MS = process.versions.electron ? 1490 : 1790;
/**
 * P1's warm single pass, measured once the way S1 measured T1 (after a full run: TeX plus the worker's boot,
 * instantiate and mount; median of 9), so the limit does not move with the run it judges (G1S-05). Measured
 * 2026-10-16 on the laptop: 826 and 855 ms under VS Code 1.142's runtime (Electron 43.7.7, Node 24.21.0), 951
 * and 917 ms under Node 22.22.3.
 */
const P1_SINGLE_PASS_MS = process.versions.electron ? 840 : 930;
const FULL_SESSION = SESSION_SECONDS >= 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Where typing goes: the end of the first plain text line after the first \section. */
function insertionPoint(text: string): number {
  let pos = text.indexOf('\n', text.indexOf('\\section')) + 1;
  while (pos > 0 && pos < text.length) {
    const end = text.indexOf('\n', pos);
    const line = text.slice(pos, end < 0 ? undefined : end).replace(/\r$/, '');
    if (/^[A-Za-z]/.test(line) && !line.includes('%')) {
      return pos + line.length;
    }
    pos = end + 1;
  }
  throw new Error('no plain text line after the first \\section');
}

interface Pdf {
  at: number;
  /** Keystrokes in the text this compile read. */
  edits: number;
  kind: string;
  trigger: string;
  totalMs: number;
  texMs: number;
  /** tex + the worker's boot, instantiate and mount: S1's way of timing a single pass. */
  s1StyleMs: number;
  warm: boolean;
}

async function session(engine: EngineService, project: CorpusProject, seconds: number, seed: number) {
  const random = rng(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  const fs = nodeFs(project.folder);
  const original = readFileSync(path.join(project.folder, project.main), 'utf8');
  const at = insertionPoint(original);
  let typed = '';
  let edits = 0;
  const phrase = ' the measured conductivity follows the model within the error bars';
  let state: DocumentState | undefined;
  const pdfs: Pdf[] = [];
  let cancelled = 0;
  let superseded = 0;
  const key = project.id;

  const run = async (request: CompileRequest): Promise<CompileOutcome> => {
    const editsRead = edits;
    const text = original.slice(0, at) + typed + original.slice(at);
    const prepared = await prepareCompile({
      fs,
      mainRel: project.main,
      engineSetting: 'pdflatex',
      overrides: new Map([[project.main, new TextEncoder().encode(text)]]),
      previous: state,
      pass: request.kind,
    });
    if (request.superseded() && !request.first) {
      superseded++;
      return { cancelled: true, pdf: false, wantsFullPass: false };
    }
    const { result } = await engine.compile(prepared.job);
    if (result.error === 'cancelled') {
      cancelled++;
      return { cancelled: true, pdf: false, wantsFullPass: false };
    }
    if (result.ok) {
      state = nextState(result, prepared);
    }
    if (result.pdf) {
      const texMs = result.steps.reduce((n, s) => n + s.ms, 0);
      pdfs.push({
        at: performance.now(),
        edits: editsRead,
        kind: request.kind,
        trigger: request.triggers.join('+'),
        totalMs: result.timings.totalMs,
        texMs,
        s1StyleMs: texMs + result.timings.workerBootMs + result.timings.instantiateMs + result.timings.mountMs,
        warm: result.timings.warm === true,
      });
    }
    return { cancelled: false, pdf: result.pdf !== null, wantsFullPass: result.rerunRequested === true || result.bibtexNeeded === true };
  };

  const scheduler = new CompileScheduler({
    pauseMs: () => 1000,
    mode: () => 'pause',
    hasState: () => state !== undefined,
    run,
    cancelRunning: () => void engine.cancel(),
  });

  // The document is open and compiled once before the session (not counted).
  scheduler.request(key);
  while (pdfs.length === 0) {
    await sleep(50);
  }
  await sleep(500);
  pdfs.length = 0;

  let lastKeyAt = 0;
  const keystroke = () => {
    if (typed.length > 0 && random() < 0.1) {
      typed = typed.slice(0, -1);
    } else {
      typed += phrase[typed.length % phrase.length];
    }
    edits++;
    lastKeyAt = performance.now();
    scheduler.edit(key);
  };

  const pauses: { start: number; end: number; edits: number; save: boolean }[] = [];
  const hesitations: { start: number; end: number; edits: number }[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    const n = Math.round(between(4, 30));
    const hesitateAt = random() < 0.15 ? Math.floor(between(1, n - 1)) : -1;
    for (let i = 0; i < n; i++) {
      keystroke();
      if (i === hesitateAt) {
        const start = lastKeyAt;
        await sleep(between(1000, 1800));
        hesitations.push({ start, end: performance.now(), edits });
      } else {
        await sleep(between(60, 220));
      }
    }
    const save = random() < 0.1;
    // The pause starts at the last keystroke (latency is measured from it).
    const start = lastKeyAt;
    if (save) {
      scheduler.save(key);
    }
    await sleep(between(2000, 10000));
    pauses.push({ start, end: performance.now(), edits, save });
  }
  // Let the last compile finish before the engine is reused.
  const settleUntil = performance.now() + 30000;
  while (scheduler.runningKey && performance.now() < settleUntil) {
    await sleep(100);
  }
  scheduler.dispose();

  const fresh = (p: { start: number; end: number; edits: number }) => pdfs.find((d) => d.edits >= p.edits && d.at >= p.start && d.at <= p.end);
  const latencies: number[] = [];
  let freshCount = 0;
  for (const p of pauses) {
    const d = fresh(p);
    if (d) {
      freshCount++;
      latencies.push(d.at - p.start);
    }
  }
  const quick = pdfs.filter((d) => d.kind === 'quick');
  return {
    seconds: Math.round((performance.now() - t0) / 1000),
    keystrokes: edits,
    pauses: pauses.length,
    freshPauses: freshCount,
    freshShare: freshCount / pauses.length,
    saves: pauses.filter((p) => p.save).length,
    hesitations: hesitations.length,
    hesitationsWithPdf: hesitations.filter((h) => fresh(h)).length,
    compiles: pdfs.length,
    quickPasses: quick.length,
    fullPasses: pdfs.filter((d) => d.kind === 'full').length,
    cancelledByEdit: cancelled,
    supersededBeforeEngine: superseded,
    warmShare: quick.filter((d) => d.warm).length / Math.max(1, quick.length),
    latencyMedianMs: Math.round(median(latencies)),
    latencyP90Ms: Math.round(quantile(latencies, 0.9)),
    quickTotalMedianMs: Math.round(median(quick.map((d) => d.totalMs))),
    quickTexMedianMs: Math.round(median(quick.map((d) => d.texMs))),
    s1StyleSinglePassMedianMs: Math.round(median(quick.map((d) => d.s1StyleMs))),
  };
}

describe(`M2-A live session (Node): scripted typing and pauses, ${SESSION_SECONDS} s per document`, function () {
  this.timeout((SESSION_SECONDS * 2 + 600) * 1000);
  let engine: EngineService;
  let tmp = '';
  let projects: CorpusProject[] = [];

  before(async function () {
    if (!bundledEngineAssets(root)) {
      this.skip();
    }
    engine = new EngineService({
      modulePath: path.join(root, 'dist', 'engine-host.js'),
      assets: () => bundledEngineAssets(root),
      idleMinutes: () => 0,
      log: () => undefined,
    });
    engine.execArgv = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];
    tmp = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-live-'));
    projects = await materializeCorpus(tmp, docstripWith(engine));
  });

  after(async () => {
    await engine?.stop();
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`      results: ${writeResults()}`);
  });

  for (const [id, seed] of [['P1', 11], ['T1', 13]] as const) {
    const title = FULL_SESSION
      ? `${id}: at least 90 percent of pauses give a fresh PDF; median latency within the single pass plus 1 s`
      : `${id}: a short session gives fresh PDFs at pauses (the 90 percent criterion runs with M2A_SESSION_SECONDS=600)`;
    it(title, async function () {
      const project = projects.find((p) => p.id === id);
      if (!project) {
        this.skip();
      }
      const r = await session(engine, project as CorpusProject, SESSION_SECONDS, seed);
      const memory = await engine.memory();
      const reference = id === 'T1' ? S1_T1_SINGLE_PASS_MS : P1_SINGLE_PASS_MS;
      const limit = reference + 1000;
      record(`M2A-session-${id}`, { ...r, runtime: process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`, referenceSinglePassMs: reference, limitMs: limit, paintAllowanceMs: PAINT_MS, engineMaxRssMb: memory ? Math.round(memory.maxRss / 1048576) : null });
      console.log(
        `      ${id}: ${r.seconds} s, ${r.keystrokes} keystrokes, ${r.pauses} pauses (${r.saves} with a save): ` +
          `${r.freshPauses} fresh (${(100 * r.freshShare).toFixed(1)} %); latency to PDF median ${r.latencyMedianMs} ms, p90 ${r.latencyP90Ms} ms ` +
          `(limit ${limit} ms = single pass ${reference} ms + 1 s, with ${PAINT_MS} ms for the viewer); ` +
          `${r.quickPasses} quick + ${r.fullPasses} full passes, quick pass median ${r.quickTotalMedianMs} ms (TeX ${r.quickTexMedianMs} ms, ` +
          `warm worker ${(100 * r.warmShare).toFixed(0)} %); ${r.cancelledByEdit} cancelled in the engine, ${r.supersededBeforeEngine} before it; ` +
          `${r.hesitations} hesitations (${r.hesitationsWithPdf} reached a PDF); engine max RSS ${memory ? Math.round(memory.maxRss / 1048576) : '?'} MB`,
      );
      if (!FULL_SESSION) {
        // A short run has a handful of pauses, too few to judge a 90 percent share; it checks that the loop works.
        console.log('      (a short run; the exit criterion is judged with M2A_SESSION_SECONDS=600)');
        assert.ok(r.freshPauses >= 1 && r.quickPasses >= 1, 'no pause gave a fresh PDF');
        return;
      }
      assert.ok(r.freshShare >= 0.9, `only ${(100 * r.freshShare).toFixed(1)} % of pauses gave a fresh PDF`);
      assert.ok(r.latencyMedianMs + PAINT_MS <= limit, `median latency ${r.latencyMedianMs} ms + ${PAINT_MS} ms is over ${limit} ms`);
    });
  }
});
