// The compile loop in VS Code (docs/DESIGN.md#live-behaviour, #engine-and-data, #testing): the wiring of its parts
// and the commands that start a compile. Each part has its own file:
//   - targets.ts: which document a change belongs to (targets, roots, Markdown opt-in, read sets, watchers);
//   - events.ts: typing, saves, changes on disk, closed editors, and the preview following the editor;
//   - scheduler.ts: when to compile (one at a time, pauses, cancels, tool jobs, the watchdog);
//   - runner.ts: one compile, from the unsaved text to its record;
//   - outputs.ts: the PDF next to the source, the Problems panel, the missing-package notices;
//   - previews.ts: the preview panels and the one rule for bringing one to the front;
//   - records.ts, status.ts, trust.ts, settings.ts: the records, the status bar, Restricted Mode, the settings;
//   - ../packages/commands.ts: Install Extra Packages, Add a package from a file, Report a missing package.
//
// Build gate 1: a preview the user closed stays closed while its document stays open, until a command opens it
// (G1E-10); the compile records keep the last 200, and a target with no preview and no editor tab is forgotten
// everywhere (G1E-12).

import * as vscode from 'vscode';
import { COMMAND_PREFIX, DISPLAY_NAME } from '../../shared/identity';
import { DataResolver } from '../engine/dataResolver';
import type { EngineService } from '../engine/engineService';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { ConversionService } from '../markdown/conversion';
import { PackageCommands } from '../packages/commands';
import { SyncService } from '../sync/syncService';
import type { PreviewPanel } from '../viewer/previewPanel';
import { DocumentEvents } from './events';
import { MissingNotices, ProblemsPanel } from './outputs';
import { Previews } from './previews';
import { CompileRecords, type CompileRecord } from './records';
import { CompileRunner } from './runner';
import { CompileScheduler } from './scheduler';
import { config } from './settings';
import { StatusItems } from './status';
import { Targets } from './targets';
import { Trust } from './trust';

export { MAX_RECORDS, type CompileRecord } from './records';
export { setRestrictedAnswerForTests } from './trust';

export class TexCompiler implements vscode.Disposable {
  /** SyncTeX both ways for the preview panels (M2-A, agent B). */
  readonly sync: SyncService;
  /** The data sets packages come from (docs/DESIGN.md#store-and-packaging, #engine-and-data). */
  readonly data: DataResolver;
  private readonly recordBook = new CompileRecords();
  readonly onCompiled = this.recordBook.onCompiled;
  private readonly status = new StatusItems();
  private readonly problems = new ProblemsPanel();
  private readonly trust: Trust;
  private readonly targets: Targets;
  private readonly previews: Previews;
  private readonly packages: PackageCommands;
  private readonly missing: MissingNotices;
  private readonly runner: CompileRunner;
  private readonly scheduler: CompileScheduler;
  private readonly events: DocumentEvents;
  private readonly disposables: vscode.Disposable[] = [];
  private disposing = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly engine: EngineService,
    private readonly log: vscode.LogOutputChannel,
    /** Shared with the Markdown features (build gate 1, G1E-15): one conversion per document version. */
    private readonly conversions: ConversionService = new ConversionService(),
  ) {
    this.data = new DataResolver(context.extensionPath, context.globalStorageUri, log);
    this.trust = new Trust(log);
    this.targets = new Targets({
      log,
      onDiskChange: (uri) => this.events.onDiskChange(uri),
      onlyPreviewed: (found, ownRoot) => this.previews.onlyPreviewed(found, ownRoot),
    });
    this.scheduler = new CompileScheduler({
      pauseMs: () => Math.max(200, config<number>('pauseMilliseconds', 1000)),
      mode: () => config<'pause' | 'save'>('compileOn', 'pause'),
      hasState: (key) => this.runner.hasState(key),
      run: (request) => this.runner.execute(request),
      cancelRunning: () => void this.engine.cancel(),
      onWatchdog: (key, ms) => {
        const label = this.targets.get(key)?.label ?? key;
        const text = `${DISPLAY_NAME}: the compile of ${label} did not finish in ${Math.round(ms / 60000)} minutes and was stopped (see the log)`;
        this.log.warn(text);
        vscode.window.setStatusBarMessage(text, 15000);
      },
      log: (line) => this.log.debug(line),
    });
    this.sync = new SyncService(context.extensionPath, (doc) => this.previewKeyFor(doc), log);
    this.previews = new Previews({
      extensionUri: context.extensionUri,
      sync: this.sync,
      log,
      labelOf: (key) => this.targets.get(key)?.label ?? key,
      onUserClosed: (key) => this.maybeForget(key),
      // A document left out when a shared file changed catches up when its preview shows again (G3E-03).
      onOutdatedShown: (key, kind) => {
        if (this.trust.trusted()) {
          this.scheduler.fileChanged(key, kind);
        }
      },
    });
    this.packages = new PackageCommands({ data: this.data, engine, scheduler: this.scheduler, log });
    this.missing = new MissingNotices({
      extraInstalled: () => this.data.extraInstalled(),
      installExtraPackages: () => this.installExtraPackages(),
      addPackageFromFile: () => this.addPackageFromFile(),
    });
    this.runner = new CompileRunner({
      extensionPath: context.extensionPath,
      engine,
      log,
      conversions,
      data: this.data,
      targets: this.targets,
      previews: this.previews,
      sync: this.sync,
      status: this.status,
      problems: this.problems,
      missing: this.missing,
      records: this.recordBook,
      scheduler: () => this.scheduler,
    });
    this.events = new DocumentEvents({
      targets: this.targets,
      previews: this.previews,
      scheduler: this.scheduler,
      trust: this.trust,
      log,
      hasState: (key) => this.runner.hasState(key),
      maybeForget: (key) => this.maybeForget(key),
    });
    this.disposables.push(
      this.sync,
      this.data,
      // The add-on installed or a package added: compile the documents that miss something again.
      this.data.onDidChange(() => {
        for (const key of this.missing.keys()) {
          this.scheduler.request(key);
        }
      }),
      this.problems,
      this.status,
      this.recordBook,
      { dispose: () => this.scheduler.dispose() },
      vscode.workspace.onDidChangeTextDocument((e) => this.events.onChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.events.onSaved(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.events.onClosed(doc)),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.events.onTabsClosed(e.closed)),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.status.updateVisibility(e, this.records.length > 0);
        void this.events.followEditor(e).catch((err: unknown) => this.log.debug(`follow: ${String(err)}`));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${COMMAND_PREFIX}.compileOn`) || e.affectsConfiguration(`${COMMAND_PREFIX}.pauseMilliseconds`)) {
          this.status.updateModeItem();
          if (config<'pause' | 'save'>('compileOn', 'pause') === 'save') {
            this.scheduler.dropPendingEdits();
          }
        }
      }),
    );
    this.status.updateVisibility(vscode.window.activeTextEditor, this.records.length > 0);
  }

  /** The last compile records (the last 200; G1E-12). */
  get records(): CompileRecord[] {
    return this.recordBook.list;
  }

  /** Tests only: holds back each file watcher event this long, as a slow or remote file system would. */
  get diskEventDelayMs(): number {
    return this.targets.diskEventDelayMs;
  }

  set diskEventDelayMs(ms: number) {
    this.targets.diskEventDelayMs = ms;
  }

  /** The root document whose compile is running now, if any (for the tests). */
  get runningKey(): string | undefined {
    return this.scheduler.runningKey;
  }

  /** The status bar switch: live (after a pause) or on save only. Stored as the user's setting. */
  toggleLive(): Promise<void> {
    return this.status.toggleLive();
  }

  /**
   * A target with no preview panel and no editor tab is forgotten: the scheduler, the SyncTeX worker, the
   * compile state and the read set let go of it, and a folder no target uses loses its watcher and read cache
   * (G1E-12). Opening the document again starts afresh, and its preview opens again on compile.
   */
  private maybeForget(key: string): void {
    const target = this.targets.get(key);
    if (!target || this.disposing || this.previews.has(key) || this.scheduler.runningKey === key || this.targets.shownInTabs(key)) {
      return;
    }
    this.previews.forget(key);
    this.scheduler.forget(key);
    this.sync.forget(key);
    this.engine.forget(key);
    this.runner.forget(key);
    this.missing.forget(key);
    this.targets.forget(key);
    if (target.source === 'markdown') {
      this.conversions.forget(target.uri);
    }
    this.log.debug(`${target.label}: no preview and no editor; forgotten`);
  }

  // ---- Commands --------------------------------------------------------------------------------------

  /** The command: a full compile of the active document now, with its PDF written (Markdown: open its preview). */
  async compileActive(): Promise<CompileRecord | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && isMarkdownDocument(doc)) {
      return this.openMarkdownPreview();
    }
    if (!doc || !isTexDocument(doc)) {
      void vscode.window.showWarningMessage('Open a .tex file to compile it.');
      return undefined;
    }
    if (!(await this.trust.allowedManually())) {
      return undefined;
    }
    const target = this.targets.texTarget(await this.targets.resolveRoot(doc));
    const key = target.key;
    // The command is the user's way to start over: a fresh read of the folder, and a new try at the engine.
    this.targets.cacheFor(target)?.clear();
    this.engine.retry();
    this.previews.reopen(key);
    this.targets.rootOf.set(doc.uri.toString(), key);
    this.scheduler.request(key, true);
    return this.recordBook.nextFinished(key, this.scheduler.generation(key));
  }

  /**
   * The "Open LaTeX preview" command for a Markdown file: convert, typeset and show it now, and again after
   * each pause and save for the rest of the session.
   */
  async openMarkdownPreview(): Promise<CompileRecord | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isMarkdownDocument(doc)) {
      void vscode.window.showWarningMessage('Open a Markdown file to see its LaTeX preview.');
      return undefined;
    }
    if (!(await this.trust.allowedManually())) {
      return undefined;
    }
    this.targets.markdownOptIn.add(doc.uri.toString());
    const target = this.targets.markdownTarget(doc.uri);
    const key = target.key;
    // As for .tex (compileActive): the command starts over, with a fresh read and a new try at the engine
    // (build gate 1 re-gate, G1BE-06), and a fresh conversion.
    this.targets.cacheFor(target)?.clear();
    this.engine.retry();
    this.conversions.forget(doc.uri);
    this.previews.reopen(key);
    this.scheduler.request(key, true);
    return this.recordBook.nextFinished(key, this.scheduler.generation(key));
  }

  async showPreview(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || (!isTexDocument(doc) && !isMarkdownDocument(doc))) {
      void vscode.window.showWarningMessage('Open a .tex or Markdown file to see its preview.');
      return;
    }
    const key = isTexDocument(doc) ? (await this.resolveRoot(doc)).toString() : doc.uri.toString();
    const panel = this.previews.get(key);
    if (panel && !panel.isDisposed) {
      panel.panel.reveal(vscode.ViewColumn.Beside, true);
    } else {
      await this.compileActive();
    }
  }

  /** The root document: "% !TEX root", the file itself when it has \documentclass, or a file that includes it. */
  resolveRoot(doc: vscode.TextDocument): Promise<vscode.Uri> {
    return this.targets.resolveRoot(doc);
  }

  /** The preview key of a document: its root document's URI for .tex, its own for Markdown; else undefined. */
  previewKeyFor(doc: vscode.TextDocument): Promise<string | undefined> {
    return this.targets.previewKeyFor(doc);
  }

  installExtraPackages(): Promise<void> {
    return this.packages.installExtraPackages();
  }

  addPackageFromFile(): Promise<void> {
    return this.packages.addPackageFromFile();
  }

  addPackageFiles(files: vscode.Uri[], projectFolder?: vscode.Uri): Promise<{ packages: string[]; built: string[] }> {
    return this.packages.addPackageFiles(files, projectFolder);
  }

  reportMissingPackage(): Promise<void> {
    return this.packages.reportMissingPackage();
  }

  // ---- Previews ---------------------------------------------------------------------------------------

  /** The preview the viewer commands act on: the active one, else a visible one, else the most recently shown. */
  currentPreview(): PreviewPanel | undefined {
    return this.previews.current();
  }

  /** Whether `key`'s preview panel is open (the tests ask). */
  hasPreview(key: string): boolean {
    return this.previews.isOpen(key);
  }

  /** The title, column and visibility of `key`'s open preview (the tests ask). */
  previewState(key: string): { title: string; viewColumn: vscode.ViewColumn | undefined; visible: boolean } | undefined {
    const panel = this.previews.get(key);
    return panel && !panel.isDisposed ? { title: panel.panel.title, viewColumn: panel.panel.viewColumn, visible: panel.panel.visible } : undefined;
  }

  /** Closes `key`'s preview as the user would (the tests use it). */
  closePreview(key: string): void {
    this.previews.close(key);
  }

  dispose(): void {
    this.disposing = true;
    this.previews.dispose();
    this.targets.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
