// Extension entry point (desktop: the Node extension host).
// V0 and M2-A: compile .tex and Markdown with the bundled engine when typing pauses and on save, the PDF beside the
// editor, the Problems panel, the PDF next to the source on save (docs/DESIGN.md#live-behaviour); the engine host starts on the
// first compile (docs/DESIGN.md#engine-and-data). SyncTeX both ways: ./sync/syncService.ts.
// C0a: the Markdown features (generated-LaTeX view, Export LaTeX, Compare with committed .tex, the inert HTML
// view plugin) live in ./markdown/features.ts; activate() returns extendMarkdownIt for markdown.markdownItPlugins.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { markdownToLatex } from '../converter/markdownToLatex';
import { STUB_STATE_KEY, type EngineReady } from '../shared/engineProtocol';
import { COMMAND_PREFIX, DISPLAY_NAME } from '../shared/identity';
import { offerLatexWorkshopSetup, setOfferAnswerForTests } from './coexist/offer';
import { setRestrictedAnswerForTests, TexCompiler, type CompileRecord } from './compile/controller';
import { bundledEngineAssets, EngineService } from './engine/engineService';
import { EngineHost } from './engineHostClient';
import { registerMarkdownFeatures, type MarkdownTestApi } from './markdown/features';
import { registerSyncCommands, type SyncService } from './sync/syncService';
import { registerNewDocument } from './templates/newDocument';
import { isTexDocument } from './languages';
import { registerViewerCommands } from './viewer/viewerCommands';
import { PreviewPanel, setLinkOpenerForTests, type PreviewPanelOptions } from './viewer/previewPanel';

/** Returned from activate() in every mode: VS Code's Markdown preview calls extendMarkdownIt. */
export interface ExtensionApi {
  extendMarkdownIt<T>(md: T): T;
}

/**
 * Added to the returned object only under test: VS Code runs the extension in ExtensionMode.Test and the test
 * stubs are loaded in this process (their record is on a global symbol). The API can start an engine host with
 * any Node flags, so it never reaches an ordinary window (build gate 1, G1S-09).
 */
export interface TestApi extends ExtensionApi {
  enginePath: string;
  extensionPath: string;
  /** Starts a fresh engine host with the given Node flags (the tests pass the stubs here). */
  startEngineHost(execArgv: string[]): Promise<{ host: EngineHost; ready: EngineReady }>;
  convert(markdown: string): { latex: string; lineMap: number[] };
  markdown: MarkdownTestApi;
  openViewer(options?: PreviewPanelOptions): PreviewPanel;
  /** Node flags for the engine host that compiles (set before the first compile). */
  setEngineExecArgv(execArgv: string[]): void;
  /** Resolves with the next finished compile of `rootPath` (any root when omitted); cancelled ones only if asked. */
  /** `accept`: only a compile it accepts (one a save started, say: the preview may follow the editor first). */
  nextCompile(rootPath?: string, options?: { includeCancelled?: boolean; accept?: (record: CompileRecord) => boolean }): Promise<CompileRecord>;
  compileRecords(): CompileRecord[];
  /** The root document (its key, a URI string) whose compile is running now, if any. */
  runningCompile(): string | undefined;
  engineAvailable(): boolean;
  /** Whether the preview of the root document at `rootPath` is open; closes it as the user would. */
  previewOpen(rootPath: string): boolean;
  closePreview(rootPath: string): void;
  /** The open preview of the root document at `rootPath`: its title, its editor group's column, whether it shows. */
  previewState(rootPath: string): { title: string; viewColumn: vscode.ViewColumn | undefined; visible: boolean } | undefined;
  /** Holds back the file watcher's events by `ms`, as a slow or remote file system would (0: no delay). */
  delayDiskEvents(ms: number): void;
  /** SyncTeX both ways (M2-A). */
  sync: SyncService;
  /** What opens a link clicked in a PDF preview (the tests record it instead of opening a browser). */
  setLinkOpener(opener: (uri: vscode.Uri) => Thenable<boolean>): void;
  /** M6: adds packages from files (what "Add a package from a file" does after its dialogs). */
  addPackageFiles(paths: string[], projectFolder?: string): Promise<{ packages: string[]; built: string[] }>;
  /** M6: whether the Extra Packages add-on is installed, and the number of packages each data set has. */
  dataSets(): Promise<{ extraInstalled: boolean; sets: Record<string, number> }>;
  /** M6: removes a package from the user's package folder. */
  removeUserPackage(pkg: string): Promise<void>;
  /** The preview key of a document (M2-B: its root document for .tex). */
  previewKeyFor(uri: vscode.Uri): Promise<string | undefined>;
  /** The answer the LaTeX Workshop question gets (null: ask). */
  setLatexWorkshopAnswer(answer: string | undefined | null): void;
  /** The answer the Restricted Mode question of a compile command gets (null: ask). */
  setRestrictedAnswer(answer: string | undefined | null): void;
}

let engine: EngineService | undefined;
const extraEngines: EngineHost[] = [];

export function activate(context: vscode.ExtensionContext): ExtensionApi | TestApi {
  const log = vscode.window.createOutputChannel(DISPLAY_NAME, { log: true });
  context.subscriptions.push(log);
  const markdown = registerMarkdownFeatures(context, log);
  const enginePath = context.asAbsolutePath(path.join('dist', 'engine-host.js'));
  engine = new EngineService({
    modulePath: enginePath,
    assets: () => bundledEngineAssets(context.extensionPath),
    idleMinutes: () => vscode.workspace.getConfiguration(COMMAND_PREFIX).get<number>('engineIdleMinutes', 10),
    log: (line) => log.info(line),
  });
  const compiler = new TexCompiler(context, engine, log, markdown.conversions);
  context.subscriptions.push(compiler, ...registerSyncCommands(compiler.sync), ...registerViewerCommands(() => compiler.currentPreview()));
  // M4: "New document from template" (docs/DESIGN.md#help-for-new-users); the walkthrough's buttons call it.
  context.subscriptions.push(...registerNewDocument(context));

  // LaTeX Workshop coexistence: offered once per workspace, when a .tex file is first opened or saved.
  const maybeOffer = (doc: vscode.TextDocument) => {
    if (isTexDocument(doc)) {
      void offerLatexWorkshopSetup(context, (line) => log.info(line));
    }
  };
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(maybeOffer));
  if (vscode.window.activeTextEditor) {
    maybeOffer(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.compile`, () => compiler.compileActive()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.showPreview`, () => compiler.showPreview()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.openLatexPreview`, () => compiler.openMarkdownPreview()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.showLog`, () => log.show(true)),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.toggleLive`, () => compiler.toggleLive()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.installExtraPackages`, () => compiler.installExtraPackages()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.addPackageFromFile`, () => compiler.addPackageFromFile()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.reportMissingPackage`, () => compiler.reportMissingPackage()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.engineHostCheck`, async () => {
      const host = new EngineHost({ modulePath: enginePath, log: (line) => log.info(line) });
      try {
        const ready = await host.start();
        const echo = await host.ping('hello');
        const sum = await host.wasmCheck();
        const where = ready.electron ? `VS Code's program in Node mode (Electron ${ready.electron})` : 'Node';
        const text = `Engine host ${ready.pid} runs under ${where}, Node ${ready.node}; echo "${echo}", WASM 2+3=${sum}.`;
        log.info(text);
        void vscode.window.showInformationMessage(text);
      } finally {
        await host.stop();
      }
    }),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.openPdfInViewer`, async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ['pdf'] } });
      if (!picked?.[0]) {
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      const panel = PreviewPanel.create(context.extensionUri, { title: path.basename(picked[0].fsPath) });
      context.subscriptions.push(panel);
      await panel.load(bytes);
    }),
  );

  if (!underTest(context)) {
    return { extendMarkdownIt: markdown.extendMarkdownIt };
  }
  const service = engine;
  return {
    extendMarkdownIt: markdown.extendMarkdownIt,
    markdown: markdown.testApi,
    enginePath,
    extensionPath: context.extensionPath,
    async startEngineHost(execArgv: string[]) {
      const host = new EngineHost({ modulePath: enginePath, execArgv, log: (line) => log.info(line) });
      extraEngines.push(host);
      return { host, ready: await host.start() };
    },
    convert: (markdown: string) => markdownToLatex(markdown),
    openViewer: (options?: PreviewPanelOptions) => {
      const panel = PreviewPanel.create(context.extensionUri, options);
      context.subscriptions.push(panel);
      return panel;
    },
    setEngineExecArgv: (execArgv: string[]) => {
      service.execArgv = execArgv;
    },
    nextCompile: (rootPath?: string, options?: { includeCancelled?: boolean; accept?: (record: CompileRecord) => boolean }) =>
      new Promise<CompileRecord>((resolve) => {
        const sub = compiler.onCompiled((record) => {
          if ((record.cancelled && !options?.includeCancelled) || (options?.accept && !options.accept(record))) {
            return;
          }
          if (!rootPath || vscode.Uri.parse(record.root).fsPath.toLowerCase() === rootPath.toLowerCase()) {
            sub.dispose();
            resolve(record);
          }
        });
      }),
    compileRecords: () => compiler.records.slice(),
    runningCompile: () => compiler.runningKey,
    engineAvailable: () => bundledEngineAssets(context.extensionPath) !== null,
    previewOpen: (rootPath: string) => compiler.hasPreview(vscode.Uri.file(rootPath).toString()),
    previewState: (rootPath: string) => compiler.previewState(vscode.Uri.file(rootPath).toString()),
    closePreview: (rootPath: string) => compiler.closePreview(vscode.Uri.file(rootPath).toString()),
    delayDiskEvents: (ms: number) => {
      compiler.diskEventDelayMs = ms;
    },
    sync: compiler.sync,
    setLinkOpener: setLinkOpenerForTests,
    addPackageFiles: (paths: string[], projectFolder?: string) =>
      compiler.addPackageFiles(
        paths.map((p) => vscode.Uri.file(p)),
        projectFolder ? vscode.Uri.file(projectFolder) : undefined,
      ),
    removeUserPackage: async (pkg: string) => {
      await compiler.data.user.remove(pkg);
      compiler.data.invalidate();
    },
    dataSets: async () => {
      const context = await compiler.data.get();
      const sets: Record<string, number> = { core: Object.keys(context.core?.packages ?? {}).length };
      for (const i of context.installed) {
        sets[i.set.id] = Object.keys(i.set.index.packages).length;
      }
      return { extraInstalled: compiler.data.extraInstalled(), sets };
    },
    previewKeyFor: async (uri: vscode.Uri) => compiler.previewKeyFor(await vscode.workspace.openTextDocument(uri)),
    setLatexWorkshopAnswer: (answer: string | undefined | null) => setOfferAnswerForTests(answer),
    setRestrictedAnswer: (answer: string | undefined | null) => setRestrictedAnswerForTests(answer),
  };
}

/** VS Code's test mode, with the test stubs loaded in the extension host (test/stubs/register-exthost.cjs). */
function underTest(context: vscode.ExtensionContext): boolean {
  const stubs = (globalThis as Record<symbol, unknown>)[Symbol.for(STUB_STATE_KEY)] as { role?: string } | undefined;
  return context.extensionMode === vscode.ExtensionMode.Test && stubs?.role === 'extension-host';
}

export async function deactivate(): Promise<void> {
  await Promise.all([engine?.stop(), ...extraEngines.map((e) => e.stop())]);
}
