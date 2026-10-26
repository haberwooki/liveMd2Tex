// One compile, from the editors' unsaved text to its record (docs/DESIGN.md#live-behaviour, #engine-and-data): the
// project files are collected (pipeline.ts), missing packages are announced, the engine compiles, and the result
// goes to the Problems panel, the preview, SyncTeX, the PDF next to the source on save, the status bar and the
// log. A Markdown file takes the same road after the converter (src/converter) when the "Open LaTeX preview"
// command, its front matter or the folder config asks; its problems are shown on Markdown lines through the line
// map.
//
// Build gate 1: unsaved buffers are encoded in the document's own encoding (G1E-08); one pop-up per cause and
// session (G1E-02), and a compile command always answers (G1BE-06).

import { posix } from 'node:path';
import * as vscode from 'vscode';
import { DISPLAY_NAME } from '../../shared/identity';
import { pdfProblem } from '../../shared/pdfCheck';
import { withErrorHelp } from '../diagnostics/errorHelp';
import type { DataResolver } from '../engine/dataResolver';
import { EngineUnavailableError, type EngineService } from '../engine/engineService';
import { interimFontsFolder, readInterimFonts } from '../engine/interimFonts';
import type { ConversionService, DocumentConversion } from '../markdown/conversion';
import { publishConverterProblems } from '../markdown/problems';
import { fingerprint } from '../project/collect';
import { relativeTo } from '../project/uris';
import type { SyncService } from '../sync/syncService';
import { MissingNotices, ProblemsPanel, unsavedInputs, whyNotWritePdf, writePdf } from './outputs';
import { diagnosticsFor, imagesForNotFound, nextState, prepareCompile, prepareMarkdownCompile, type DocumentState, type PreparedCompile } from './pipeline';
import { revealBesideEditor, type Previews } from './previews';
import type { CompileRecord, CompileRecords } from './records';
import type { CompileOutcome, CompileRequest, CompileScheduler } from './scheduler';
import { config } from './settings';
import type { StatusItems } from './status';
import type { Target, Targets } from './targets';

export interface CompileRunnerOptions {
  extensionPath: string;
  engine: EngineService;
  log: vscode.LogOutputChannel;
  conversions: ConversionService;
  data: DataResolver;
  targets: Targets;
  previews: Previews;
  sync: SyncService;
  status: StatusItems;
  problems: ProblemsPanel;
  missing: MissingNotices;
  records: CompileRecords;
  /** The scheduler, for a compile again with an image mounted (it is made after the runner). */
  scheduler: () => CompileScheduler;
}

export class CompileRunner {
  /** The state each target's last good compile carried (its .aux and .bbl, and what the next pass needs). */
  private readonly states = new Map<string, DocumentState>();
  /** Data images each target mounts although its scan needs none of their packages (an earlier "not found"). */
  private readonly mountSets = new Map<string, Set<string>>();
  /** Error messages already shown in a pop-up this session (later ones go to the status bar and the log). */
  private readonly shownErrors = new Set<string>();
  /** Conversions whose time is already in the log (a cached one is not logged again). */
  private readonly conversionsLogged = new WeakSet<DocumentConversion>();

  constructor(private readonly o: CompileRunnerOptions) {}

  /** Whether `key` has had a good compile (its state is carried to the next one). */
  hasState(key: string): boolean {
    return this.states.has(key);
  }

  forget(key: string): void {
    this.states.delete(key);
    this.mountSets.delete(key);
  }

  /** Runs one scheduled compile and tells the scheduler how it went. */
  async execute(request: CompileRequest): Promise<CompileOutcome> {
    const target = this.o.targets.get(request.key);
    if (!target) {
      return { cancelled: false, pdf: false, wantsFullPass: false };
    }
    const record = await this.run(target, request);
    return { cancelled: record.cancelled, pdf: record.pdfBytes > 0, wantsFullPass: record.wantsFullPass };
  }

  /** The text document of a Markdown target (open in an editor, or loaded from disk). */
  private async markdownDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? vscode.workspace.openTextDocument(uri);
  }

  private async prepare(target: Target, request: CompileRequest, overrides: Map<string, Uint8Array>): Promise<PreparedCompile> {
    const previous = this.states.get(target.key);
    if (target.source === 'tex') {
      return prepareCompile({
        fs: this.o.targets.projectFs(target, request.kind),
        mainRel: target.mainRel,
        engineSetting: config<'pdflatex' | 'xelatex'>('engine', 'pdflatex'),
        overrides,
        previous,
        pass: request.kind,
        limits: target.limits,
        packages: await this.o.data.get(),
        mountSets: this.mountSets.get(target.key),
      });
    }
    const doc = await this.markdownDocument(target.uri);
    const conversion = await this.o.conversions.convert(doc);
    if (!this.conversionsLogged.has(conversion)) {
      this.conversionsLogged.add(conversion);
      this.o.log.info(`${target.label}: Markdown converted in ${conversion.convertMs} ms (${conversion.passes} converter pass(es))`);
    }
    // The converter's own problems (unsupported constructs, characters, the engine chosen) on Markdown lines.
    publishConverterProblems(doc.uri, conversion.diagnostics);
    return prepareMarkdownCompile({
      fs: this.o.targets.projectFs(target, request.kind),
      markdownRel: relativeTo(target.folder, target.uri) ?? posix.basename(target.uri.path),
      latex: conversion.latex,
      lineMap: conversion.lineMap,
      engine: conversion.engine,
      overrides,
      previous,
      pass: request.kind,
      limits: target.limits,
      packages: await this.o.data.get(),
      mountSets: this.mountSets.get(target.key),
      extraFiles: await readInterimFonts(interimFontsFolder(this.o.extensionPath), conversion.fontFiles),
      bodyStartLine: conversion.bodyStartLine,
      appendix: conversion.appendixMap && conversion.appendixFile ? { file: conversion.appendixFile, map: conversion.appendixMap } : undefined,
    });
  }

  private async run(target: Target, request: CompileRequest): Promise<CompileRecord> {
    const { key, folder, mainRel } = target;
    const { log, previews, targets } = this.o;
    const eventAt = request.lastEventAt;
    previews.markFresh(key);
    this.o.status.set('compiling');
    this.o.status.show();

    // Unsaved editors inside the project folder are compiled as shown (docs/DESIGN.md#live-behaviour).
    const overrides = new Map<string, Uint8Array>();
    for (const open of vscode.workspace.textDocuments) {
      const rel = open.isDirty ? relativeTo(folder, open.uri) : undefined;
      if (rel) {
        // The document's own encoding (a Latin-1 file stays Latin-1), not the one the settings would pick (G1E-08).
        overrides.set(rel, await vscode.workspace.encode(open.getText(), { encoding: open.encoding }));
      }
    }

    const record: CompileRecord = {
      root: key,
      main: target.label,
      source: target.source,
      trigger: request.triggers.join('+'),
      pass: request.kind,
      generation: request.generation,
      engine: '',
      engineReason: '',
      ok: false,
      cancelled: false,
      passes: 0,
      bibtexRan: false,
      errors: 0,
      warnings: 0,
      pdfBytes: 0,
      pdfWritten: null,
      collectMs: 0,
      engineStartMs: 0,
      workerMs: 0,
      warmWorker: false,
      texMs: 0,
      engineTotalMs: 0,
      saveToPreviewMs: null,
      saveToDoneMs: 0,
      keystrokeToPreviewMs: null,
      wantsFullPass: false,
      readFiles: [],
      engineStubs: null,
    };
    const finish = () => this.o.records.add(record);
    try {
      targets.readStartedAt.set(key, performance.now());
      const prepared = await this.prepare(target, request, overrides);
      targets.usedFiles.set(key, new Map(prepared.job.files.map((f) => [f.path, fingerprint(f.data)])));
      record.engine = prepared.engine.engine;
      record.engineReason = prepared.engine.reason;
      record.collectMs = prepared.collectMs;
      if (prepared.truncated) {
        log.warn(`the project folder is large; only part of it was read (${prepared.job.files.length} files)`);
      }
      // The cancel rule also covers the time spent collecting: a superseded compile does not start the engine.
      if (request.superseded() && !request.first) {
        record.cancelled = true;
        return finish();
      }
      // Missing packages are listed before the compile (docs/DESIGN.md#engine-and-data); the compile still runs.
      if (prepared.packageScan) {
        record.missingPackages = prepared.packageScan.missing.map((m) => m.file);
        this.o.missing.announce(target, prepared.packageScan);
      }
      // Only the files that changed since this target's last compile cross to the engine host (G1E-03).
      const { result, engineStartMs } = await this.o.engine.compile(prepared.job, target.key);
      if (result.error === 'cancelled') {
        record.cancelled = true;
        log.info(`${target.label}: generation ${request.generation} cancelled by a newer change`);
        return finish();
      }
      record.ok = result.ok;
      record.passes = result.passes;
      record.bibtexRan = result.bibtexRan;
      record.engineStartMs = engineStartMs;
      record.warmWorker = result.timings.warm === true;
      record.workerMs = record.warmWorker ? 0 : result.timings.workerBootMs + result.timings.instantiateMs + result.timings.mountMs;
      record.texMs = result.steps.reduce((n, s) => n + s.ms, 0);
      record.engineTotalMs = result.timings.totalMs;
      record.error = result.error;
      record.engineStubs = result.stubs ?? null;
      record.wantsFullPass = result.rerunRequested === true || result.bibtexNeeded === true;
      record.readFiles = (result.readFiles ?? []).filter((f) => f !== mainRel || target.source === 'tex');
      if (result.ok) {
        this.states.set(key, nextState(result, prepared));
        targets.readSets.set(key, new Set(record.readFiles));
      }
      // TeX's errors with their plain-words help, where there is one, and epstopdf's shell-escape note only when an
      // .eps file is in the project (docs/DESIGN.md#help-for-new-users).
      const diagnostics = withErrorHelp(
        diagnosticsFor(result, prepared),
        prepared.job.files.map((f) => f.path),
      );
      this.o.problems.publish(key, folder, diagnostics);
      // A package loaded a file that only an installed data image has, which this compile did not mount: the
      // next compile mounts that image (build gate 2, G2E-02).
      const more = imagesForNotFound(result, prepared).filter((id) => !this.mountSets.get(key)?.has(id));
      if (more.length > 0) {
        this.mountSets.set(key, new Set([...(this.mountSets.get(key) ?? []), ...more]));
        log.info(`${target.label}: a file was not found that ${more.join(', ')} has; compiling again with it`);
        this.o.scheduler().fileChanged(key, 'full');
      }
      record.errors = diagnostics.filter((d) => d.severity === 'error').length;
      record.warnings = diagnostics.filter((d) => d.severity === 'warning').length;

      // No PDF (the engine stopped): the last good PDF stays in the viewer (docs/DESIGN.md#live-behaviour).
      if (result.pdf) {
        record.pdfBytes = result.pdf.length;
        // The SyncTeX data goes with this PDF, under one tag; a compile without a PDF keeps both the old PDF and
        // the old data (build gate 1, G1E-07).
        const syncTag = this.o.sync.update(key, folder, result.synctex, prepared);
        // Quick-pass PDFs stay in memory; a save writes the PDF next to the source (docs/DESIGN.md#live-behaviour).
        if (request.save && config('writePdfOnSave', true)) {
          const problem = pdfProblem(result.pdf);
          record.pdfNotWritten =
            (await whyNotWritePdf(target)) ?? unsavedInputs(prepared.job.files, overrides) ?? (problem ? `the PDF is not whole (${problem})` : undefined);
          if (record.pdfNotWritten) {
            log.info(`${target.label}: the PDF was not written next to the source: ${record.pdfNotWritten}`);
          } else {
            record.pdfWritten = await writePdf(folder, mainRel, result.pdf, log);
          }
        }
        record.saveToDoneMs = Math.round(performance.now() - eventAt);
        if ((config('openPreviewOnCompile', true) && !previews.closedByUserHas(key)) || previews.has(key)) {
          const panel = previews.panelFor(key, target.panelTitle);
          // Several documents' previews share the column beside the editor; the one being edited comes to front,
          // unless the user put it in the editor's own group (revealBesideEditor).
          if (targets.isActiveTarget(key)) {
            await revealBesideEditor(panel, vscode.window.activeTextEditor?.viewColumn);
          }
          const loaded = await panel.display(result.pdf, syncTag);
          if (loaded) {
            const painted = performance.now();
            record.saveToPreviewMs = Math.round(painted - eventAt);
            record.keystrokeToPreviewMs = request.lastEditAt !== null ? Math.round(painted - request.lastEditAt) : null;
          }
        }
      } else {
        record.saveToDoneMs = Math.round(performance.now() - eventAt);
      }
      previews.noteRecent(key);
      // For screen readers (docs/DESIGN.md#accessibility): the viewer says "Preview updated" itself; errors are added here.
      const panel = previews.get(key);
      if (panel && !panel.isDisposed && (record.errors > 0 || !result.pdf)) {
        panel.announce(
          result.pdf
            ? `Preview updated, with ${record.errors} error(s): see the Problems panel.`
            : `Compile failed with ${record.errors} error(s); the last good PDF stays. See the Problems panel.`,
        );
      }
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      record.saveToDoneMs = Math.round(performance.now() - eventAt);
      log.error(`${target.label}: ${record.error}`);
      // One pop-up per cause and session; later failures stay in the status bar and the log (G1E-02). A compile
      // the user asked for by command always answers (re-gate G1BE-06).
      const firstTime = err instanceof EngineUnavailableError ? err.firstTime && !this.shownErrors.has(record.error) : !this.shownErrors.has(record.error);
      if (firstTime || request.triggers.includes('command')) {
        this.shownErrors.add(record.error);
        void vscode.window.showErrorMessage(`${DISPLAY_NAME} could not compile ${target.label}: ${record.error}`);
      }
    }
    const seconds = (record.saveToDoneMs / 1000).toFixed(1);
    this.o.status.set(record.errors > 0 || !record.ok ? 'failed' : 'done', record.errors > 0 ? `${record.errors}` : `${seconds} s`);
    log.info(
      `${target.label}${target.source === 'markdown' ? ` (as ${mainRel})` : ''}: ${record.pass} pass for ${record.trigger}, ` +
        `generation ${record.generation}; ${record.engine} (${record.engineReason}); ${record.passes} pass(es)${record.bibtexRan ? ' + bibtex8' : ''}; ` +
        `${record.errors} error(s), ${record.warnings} warning(s); PDF ${record.pdfBytes} bytes; latency: ` +
        `${record.keystrokeToPreviewMs !== null ? `last keystroke to preview ${record.keystrokeToPreviewMs} ms, ` : ''}` +
        `event to PDF ${record.saveToDoneMs} ms, event to preview ${record.saveToPreviewMs ?? 'n/a (viewer hidden)'} ms ` +
        `[collect ${record.collectMs}, engine start ${record.engineStartMs}, worker ${record.warmWorker ? 'warm' : record.workerMs}, TeX ${record.texMs}]`,
    );
    return finish();
  }
}
