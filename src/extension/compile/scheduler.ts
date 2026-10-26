// When to compile (docs/DESIGN.md#architecture, #live-behaviour to 4.3; docs/DESIGN.md#engine-and-data): the scheduler of the live preview.
// No VS Code here, so Node tests drive it with the real engine and a scripted editing session.
//
// - An edit starts a quick pass (one TeX pass on the unsaved buffers, reusing the .aux and .bbl) after a pause
//   with no further edit (1 s by default). A save, a changed .bib or figure, or a manual compile asks for a full
//   pass (LaTeX, BibTeX, LaTeX, LaTeX as needed); a save also writes the PDF next to the source.
// - Every event raises the document's generation number. One compile runs at a time, for all documents.
// - The cancel rule: a newer edit, save or file change of the same document terminates its running compile
//   (the engine host's worker.terminate(); the process, the module and the image stay), except the document's
//   first compile, which always finishes so that something is on screen. A cancelled compile's pass kind and
//   save flag carry over to the compile that replaces it.
// - A quick pass whose log asks for another pass, or whose citations need bibtex8, is followed by a full pass.
// - "On save" mode (the status bar switch) ignores edits; saves, file changes and commands still compile.
// - A watchdog: a compile that has not finished after WATCHDOG_MS (the engine, the viewer or a file read hung)
//   is logged, cancelled and released, so one stuck compile never stops all the others (build gate 1, G1E-09).
// - Time comes from options.now and the timers from options.setTimer and clearTimer, so tests can run the
//   scheduler on a fake clock (G1E-17).
// - Tool jobs (runTool): other work for the engine, such as building a package's .ins file for "Add a package
//   from a file". They take the same single slot, before waiting compiles; a compile never cancels a tool job and
//   a tool job never cancels a compile, because the engine runs one job at a time and a new job would cancel the
//   running one (build gate 2, G2E-01).

export type PassKind = 'quick' | 'full';
export type Trigger = 'edit' | 'save' | 'file' | 'command' | 'rerun';

export interface CompileRequest {
  key: string;
  /** The document's generation when the compile started. */
  generation: number;
  kind: PassKind;
  /** The compile includes a save: its PDF is written next to the source. */
  save: boolean;
  triggers: Trigger[];
  /** performance.now() of the last edit this compile includes; null when it includes no edit. */
  lastEditAt: number | null;
  /** performance.now() of the last event (edit, save, file change, command) this compile includes. */
  lastEventAt: number;
  /** No PDF has been shown for this document yet: this compile is never cancelled. */
  first: boolean;
  /** True once a newer event of the same document has superseded this compile (and it may be cancelled). */
  superseded(): boolean;
}

export interface CompileOutcome {
  cancelled: boolean;
  /** A PDF came back (with or without errors). */
  pdf: boolean;
  /** The log asks for another pass, or the bibliography needs bibtex8. */
  wantsFullPass: boolean;
}

export interface SchedulerOptions {
  pauseMs(): number;
  mode(): 'pause' | 'save';
  /** Whether the document has auxiliary state from an earlier compile (a quick pass needs it). */
  hasState(key: string): boolean;
  run(request: CompileRequest): Promise<CompileOutcome>;
  /** Terminates the running compile's worker. */
  cancelRunning(): void;
  now?(): number;
  log?(line: string): void;
  /** How long one compile may run before the watchdog releases it (WATCHDOG_MS by default). */
  watchdogMs?(): number;
  /** The watchdog released `key`'s compile after `ms`, so the user can be told. */
  onWatchdog?(key: string, ms: number): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * The longest a compile may take before the scheduler gives up on it. It is longer than the engine's own limit for
 * one compile (10 minutes, src/extension/engineHostClient.ts), so it never stops a compile the engine would still
 * finish; it catches a compile stuck elsewhere, in a file read or in the viewer (re-gate G1BE-07).
 */
export const WATCHDOG_MS = 12 * 60 * 1000;

/** How long a save or a file change waits, so that "Save All" or a burst of file writes makes one compile. */
export const SAVE_GROUP_MS = 150;
export const FILE_GROUP_MS = 300;

interface Pending {
  kind: PassKind;
  save: boolean;
  triggers: Trigger[];
  lastEditAt: number | null;
  lastEventAt: number;
  dueAt: number;
  timer?: unknown;
  ready: boolean;
}

interface Doc {
  generation: number;
  pending?: Pending;
  shownPdf: boolean;
}

export class CompileScheduler {
  private readonly docs = new Map<string, Doc>();
  private running: { request: CompileRequest; cancelRequested: boolean; watchdog?: unknown; tool?: boolean } | null = null;
  private readonly tools: { label: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  private toolCount = 0;
  private disposed = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  private doc(key: string): Doc {
    let d = this.docs.get(key);
    if (!d) {
      d = { generation: 0, shownPdf: false };
      this.docs.set(key, d);
    }
    return d;
  }

  generation(key: string): number {
    return this.docs.get(key)?.generation ?? 0;
  }

  /** The key of the compile running now, if any. */
  get runningKey(): string | undefined {
    return this.running?.request.key;
  }

  /** An edit of an unsaved buffer that belongs to the document (`full` for a .bib buffer). */
  edit(key: string, kind: PassKind = 'quick'): void {
    if (this.options.mode() === 'save') {
      return;
    }
    this.event(key, kind, 'edit', this.options.pauseMs(), { lastEditAt: this.now() });
  }

  save(key: string): void {
    this.event(key, 'full', 'save', SAVE_GROUP_MS, { save: true });
  }

  /** A file the last compile read changed on disk: a .bib or a figure asks for a full pass, a .tex file a quick one. */
  fileChanged(key: string, kind: PassKind): void {
    this.event(key, kind, 'file', FILE_GROUP_MS, {});
  }

  /** A manual compile: a full pass now. */
  request(key: string, save = false): void {
    this.event(key, 'full', 'command', 0, { save });
  }

  private event(key: string, kind: PassKind, trigger: Trigger, delay: number, extra: { lastEditAt?: number; save?: boolean }): void {
    if (this.disposed) {
      return;
    }
    const doc = this.doc(key);
    doc.generation++;
    this.pend(doc, key, kind, trigger, delay, extra);
    this.maybeCancel(key);
  }

  private pend(doc: Doc, key: string, kind: PassKind, trigger: Trigger, delay: number, extra: { lastEditAt?: number | null; save?: boolean }): void {
    const p: Pending = doc.pending ?? { kind, save: false, triggers: [], lastEditAt: null, lastEventAt: 0, dueAt: 0, ready: false };
    p.lastEventAt = this.now();
    p.kind = p.kind === 'full' || kind === 'full' ? 'full' : 'quick';
    p.save = p.save || extra.save === true;
    if (!p.triggers.includes(trigger)) {
      p.triggers.push(trigger);
    }
    if (extra.lastEditAt !== undefined && extra.lastEditAt !== null) {
      p.lastEditAt = Math.max(p.lastEditAt ?? 0, extra.lastEditAt);
    }
    // Each event restarts the wait: the compile starts after the last event plus its delay.
    if (p.timer) {
      this.clearTimer(p.timer);
    }
    p.ready = false;
    p.dueAt = this.now() + delay;
    p.timer = this.setTimer(() => {
      p.timer = undefined;
      p.ready = true;
      this.pump();
    }, delay);
    doc.pending = p;
  }

  /** Runs `run` in the engine's slot as a tool job (see the header); resolves with its result. */
  runTool<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('The compile scheduler has stopped.'));
    }
    return new Promise<T>((resolve, reject) => {
      this.tools.push({ label, run, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private startTool(tool: { label: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }): void {
    const request: CompileRequest = {
      key: `\u0000tool:${++this.toolCount}:${tool.label}`,
      generation: 0,
      kind: 'full',
      save: false,
      triggers: ['command'],
      lastEditAt: null,
      lastEventAt: this.now(),
      first: true,
      superseded: () => false,
    };
    const running: { request: CompileRequest; cancelRequested: boolean; watchdog?: unknown; tool?: boolean } = { request, cancelRequested: false, tool: true };
    this.running = running;
    let settled = false;
    const limit = this.options.watchdogMs?.() ?? WATCHDOG_MS;
    const release = () => {
      if (this.running === running) {
        this.running = null;
      }
      this.pump();
    };
    const watchdog = this.setTimer(() => {
      if (!settled) {
        settled = true;
        this.options.log?.(`${tool.label} did not finish in ${Math.round(limit / 1000)} s; cancelled and released`);
        this.options.cancelRunning();
        release();
      }
    }, limit);
    (watchdog as { unref?: () => void } | undefined)?.unref?.();
    running.watchdog = watchdog;
    tool.run().then(
      (value) => {
        tool.resolve(value);
        if (!settled) {
          settled = true;
          this.clearTimer(watchdog);
          release();
        }
      },
      (err: unknown) => {
        tool.reject(err);
        if (!settled) {
          settled = true;
          this.clearTimer(watchdog);
          release();
        }
      },
    );
  }

  private maybeCancel(key: string): void {
    const running = this.running;
    if (running && !running.tool && running.request.key === key && !running.request.first && !running.cancelRequested) {
      running.cancelRequested = true;
      this.options.log?.(`${key}: generation ${running.request.generation} superseded; cancelling its compile`);
      this.options.cancelRunning();
    }
  }

  private pump(): void {
    if (this.running || this.disposed) {
      return;
    }
    const tool = this.tools.shift();
    if (tool) {
      this.startTool(tool);
      return;
    }
    let next: { key: string; doc: Doc; pending: Pending } | undefined;
    for (const [key, doc] of this.docs) {
      const p = doc.pending;
      if (p?.ready && (!next || p.dueAt < next.pending.dueAt)) {
        next = { key, doc, pending: p };
      }
    }
    if (!next) {
      return;
    }
    const { key, doc, pending } = next;
    doc.pending = undefined;
    const generation = doc.generation;
    const request: CompileRequest = {
      key,
      generation,
      kind: pending.kind === 'quick' && this.options.hasState(key) ? 'quick' : 'full',
      save: pending.save,
      triggers: pending.triggers,
      lastEditAt: pending.lastEditAt,
      lastEventAt: pending.lastEventAt,
      first: !doc.shownPdf,
      superseded: () => doc.generation > generation,
    };
    const running: { request: CompileRequest; cancelRequested: boolean; watchdog?: unknown } = { request, cancelRequested: false };
    this.running = running;
    const finish = (outcome: CompileOutcome) => {
      this.running = null;
      if (outcome.cancelled) {
        // The newer event's compile inherits what this one was asked to do.
        const replacement = doc.pending;
        if (replacement) {
          replacement.kind = request.kind === 'full' ? 'full' : replacement.kind;
          replacement.save = replacement.save || request.save;
          replacement.lastEditAt = Math.max(replacement.lastEditAt ?? 0, request.lastEditAt ?? 0) || null;
          for (const t of request.triggers) {
            if (!replacement.triggers.includes(t)) {
              replacement.triggers.push(t);
            }
          }
        } else if (!this.disposed) {
          this.pend(doc, key, request.kind, request.triggers[0] ?? 'command', 0, { save: request.save, lastEditAt: request.lastEditAt });
        }
      } else {
        if (outcome.pdf) {
          doc.shownPdf = true;
        }
        if (outcome.wantsFullPass && request.kind === 'quick' && !doc.pending) {
          this.pend(doc, key, 'full', 'rerun', 0, {});
        }
      }
      this.pump();
    };
    let settled = false;
    const limit = this.options.watchdogMs?.() ?? WATCHDOG_MS;
    const watchdog = this.setTimer(() => {
      if (settled) {
        return;
      }
      settled = true;
      this.options.log?.(`${key}: generation ${generation} did not finish in ${Math.round(limit / 1000)} s; cancelled and released`);
      this.options.cancelRunning();
      this.options.onWatchdog?.(key, limit);
      finish({ cancelled: false, pdf: false, wantsFullPass: false });
    }, limit);
    // The watchdog alone never keeps the process alive.
    (watchdog as { unref?: () => void } | undefined)?.unref?.();
    running.watchdog = watchdog;
    const done = (outcome: CompileOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      this.clearTimer(watchdog);
      finish(outcome);
    };
    this.options.run(request).then(done, (err: unknown) => {
      this.options.log?.(`${key}: compile failed: ${err instanceof Error ? err.message : String(err)}`);
      done({ cancelled: false, pdf: false, wantsFullPass: false });
    });
  }

  /** "On save" mode was switched on: compiles that only edits asked for, and that have not started, are dropped. */
  dropPendingEdits(): void {
    for (const doc of this.docs.values()) {
      const p = doc.pending;
      if (p && p.triggers.every((t) => t === 'edit')) {
        if (p.timer) {
          this.clearTimer(p.timer);
        }
        doc.pending = undefined;
      }
    }
  }

  /** Forgets a document (its editor closed and nothing else needs it). */
  forget(key: string): void {
    const doc = this.docs.get(key);
    if (doc?.pending?.timer) {
      this.clearTimer(doc.pending.timer);
    }
    this.docs.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const tool of this.tools.splice(0)) {
      tool.reject(new Error('The compile scheduler has stopped.'));
    }
    if (this.running?.watchdog !== undefined) {
      this.clearTimer(this.running.watchdog);
    }
    for (const doc of this.docs.values()) {
      if (doc.pending?.timer) {
        this.clearTimer(doc.pending.timer);
      }
    }
    this.docs.clear();
  }
}
