// The Markdown features of C0a in the extension host (docs/DESIGN.md#converter):
//   - the generated-LaTeX view: a read-only virtual document beside the Markdown, updated as the Markdown
//     changes, with the line map used both ways (the view follows the Markdown cursor; "Go to Markdown source");
//   - Export LaTeX: writes the .tex next to the .md, asking first when the target has uncommitted changes
//     (the Git reader's status, with the CRLF rule) or is not committed at all;
//   - Compare generated LaTeX with the committed .tex: a diff against the file at HEAD, read with the Git reader;
//   - the HTML view plugin for VS Code's Markdown preview, inert by default.
// Nothing here starts a process or opens a connection; files are read and written through workspace.fs.

import * as vscode from 'vscode';
import { CONFIG_FILE, configFromMeta } from '../../converter/config';
import { htmlViewPlugin } from '../../converter/htmlView';
import { latexToMarkdownLine, markdownToLatexLine } from '../../converter/markdownToLatex';
import { GitReader, GitReaderError, type FileStatus } from '../../git/repository';
import { readerPath, workspaceReadOnlyFs } from '../../git/workspaceFs';
import { COMMAND_PREFIX } from '../../shared/identity';
import { confinedWriteProblem, writeBoundary, writeConfined } from '../project/confinedWrite';
import { ConversionService, type DocumentConversion } from './conversion';
import { HtmlViewGate } from './htmlViewGate';
import { converterProblemCollection, disposeConverterProblems, publishConverterProblems } from './problems';

export const LATEX_SCHEME = 'livemd2tex-latex';
export const COMMITTED_SCHEME = 'livemd2tex-committed';

/** Asks before overwriting; the tests replace it. Returns true to go ahead. */
export type Confirm = (message: string, detail: string) => Promise<boolean>;

const modalConfirm: Confirm = async (message, detail) =>
  (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Overwrite')) === 'Overwrite';

export interface ExportOutcome {
  written: boolean;
  target: vscode.Uri;
  status?: FileStatus | 'no-repository';
  reason?: string;
}

export interface MarkdownTestApi {
  generatedUri(markdown: vscode.Uri): vscode.Uri;
  convert(markdown: vscode.Uri): Promise<DocumentConversion>;
  exportLatex(markdown: vscode.Uri, confirm: Confirm): Promise<ExportOutcome>;
  committedText(file: vscode.Uri): Promise<string | undefined>;
  fileStatus(file: vscode.Uri): Promise<FileStatus | 'no-repository'>;
  /** The gate as the preview's parse sees it: by document, or (VS Code's case) by the text being parsed. */
  htmlViewEnabled(markdown: vscode.Uri, text?: string): boolean;
}

function isMarkdown(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  return !!document && document.languageId === 'markdown' && document.uri.scheme !== LATEX_SCHEME;
}

/** The virtual document that shows the LaTeX generated from a Markdown file. */
export function generatedUri(markdown: vscode.Uri): vscode.Uri {
  const path = markdown.path.replace(/\.(md|markdown|mdown|mkd|mkdn)$/i, '') + '.tex';
  return vscode.Uri.from({ scheme: LATEX_SCHEME, path, query: markdown.toString() });
}

function markdownOf(latex: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse(latex.query, true);
}

async function markdownText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

export function registerMarkdownFeatures(context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
  const service = new ConversionService();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const gate = new HtmlViewGate();
  const latestByMarkdown = new Map<string, DocumentConversion>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const convertUri = async (uri: vscode.Uri): Promise<DocumentConversion> => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const result = open ? await service.convert(open) : await service.run(uri, await markdownText(uri));
    latestByMarkdown.set(uri.toString(), result);
    publishDiagnostics(uri, result);
    return result;
  };

  const publishDiagnostics = (uri: vscode.Uri, result: DocumentConversion) => {
    publishConverterProblems(uri, result.diagnostics);
    if (result.configUri && result.configProblems.length > 0) {
      log.warn(`${result.configUri.fsPath}: ${result.configProblems.join(' ')}`);
    }
  };

  // The generated-LaTeX view.
  const latexProvider: vscode.TextDocumentContentProvider = {
    onDidChange: changed.event,
    async provideTextDocumentContent(uri) {
      try {
        return (await convertUri(markdownOf(uri))).latex;
      } catch (err) {
        return `% The Markdown could not be converted: ${(err as Error).message}\n`;
      }
    },
  };

  // The committed version of a file, for the comparison.
  const committedProvider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri) {
      const file = vscode.Uri.parse(uri.query, true);
      const text = await committedText(file);
      return text ?? '';
    },
  };

  const openReader = async (file: vscode.Uri): Promise<GitReader | undefined> => {
    try {
      return await GitReader.open(workspaceReadOnlyFs(file), readerPath(file));
    } catch (err) {
      if (err instanceof GitReaderError) {
        void vscode.window.showWarningMessage(err.message);
        return undefined;
      }
      throw err;
    }
  };

  const committedText = async (file: vscode.Uri): Promise<string | undefined> => {
    const reader = await openReader(file);
    const bytes = await reader?.readCommitted(readerPath(file));
    return bytes ? new TextDecoder('utf-8').decode(bytes).replace(/\r\n/g, '\n') : undefined;
  };

  const fileStatus = async (file: vscode.Uri): Promise<FileStatus | 'no-repository'> => {
    const reader = await openReader(file);
    return reader ? reader.status(readerPath(file)) : 'no-repository';
  };

  const exportLatex = async (markdown: vscode.Uri, confirm: Confirm): Promise<ExportOutcome> => {
    const result = await convertUri(markdown);
    const target = result.exportUri;
    let targetExists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      targetExists = false;
    }
    let status: FileStatus | 'no-repository' | undefined;
    if (targetExists) {
      status = await fileStatus(target);
      const name = target.path.slice(target.path.lastIndexOf('/') + 1);
      let ask: string | undefined;
      if (status === 'modified') {
        ask = `${name} has changes that are not committed. Overwrite it with the generated LaTeX?`;
      } else if (status === 'new') {
        ask = `${name} is not committed to Git, so overwriting it cannot be undone. Overwrite it?`;
      } else if (status === 'no-repository') {
        ask = `${name} already exists and is not in a Git repository. Overwrite it?`;
      }
      if (ask && !(await confirm(ask, 'Export LaTeX writes the LaTeX generated from the Markdown file.'))) {
        return { written: false, target, status, reason: 'not confirmed' };
      }
    }
    // Never read or write through a link out of the project (build gate 2, G2S-02).
    const boundary = writeBoundary(target);
    const problem = await confinedWriteProblem(boundary, target);
    if (problem) {
      void vscode.window.showWarningMessage(`Export LaTeX: not written, because ${problem}. Nothing outside the project folder is written.`);
      return { written: false, target, status, reason: problem };
    }
    const current = await vscode.workspace.fs.readFile(target).then(
      (b) => new TextDecoder('utf-8').decode(b),
      () => undefined,
    );
    if (current !== result.latex) {
      await writeConfined(boundary, target, new TextEncoder().encode(result.latex));
    }
    return { written: true, target, status };
  };

  const revealLatexFor = (editor: vscode.TextEditor, latexEditor: vscode.TextEditor) => {
    const result = latestByMarkdown.get(editor.document.uri.toString());
    if (!result) {
      return;
    }
    const line = markdownToLatexLine(result, editor.selection.active.line + 1) - 1;
    const range = new vscode.Range(line, 0, line, 0);
    latexEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    latexEditor.selection = new vscode.Selection(range.start, range.start);
  };

  const visibleLatexEditor = (markdown: vscode.Uri) =>
    vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === LATEX_SCHEME && markdownOf(e.document.uri).toString() === markdown.toString());

  // A changed folder config changes every conversion below it: drop the cache and refresh the open views.
  const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  const configChanged = () => {
    service.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === LATEX_SCHEME) {
        changed.fire(doc.uri);
      }
    }
  };

  context.subscriptions.push(
    changed,
    gate,
    { dispose: disposeConverterProblems },
    configWatcher,
    configWatcher.onDidChange(configChanged),
    configWatcher.onDidCreate(configChanged),
    configWatcher.onDidDelete(configChanged),
    vscode.workspace.registerTextDocumentContentProvider(LATEX_SCHEME, latexProvider),
    vscode.workspace.registerTextDocumentContentProvider(COMMITTED_SCHEME, committedProvider),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isMarkdown(e.document)) {
        return;
      }
      const uri = e.document.uri;
      if (!visibleLatexEditor(uri) && !vscode.workspace.textDocuments.some((d) => d.uri.toString() === generatedUri(uri).toString())) {
        return;
      }
      const key = uri.toString();
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          changed.fire(generatedUri(uri));
        }, 300),
      );
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      service.forget(d.uri);
      if (d.uri.scheme === LATEX_SCHEME) {
        latestByMarkdown.delete(markdownOf(d.uri).toString());
      } else if (isMarkdown(d)) {
        converterProblemCollection().delete(d.uri);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isMarkdown(e.textEditor.document) || e.kind === vscode.TextEditorSelectionChangeKind.Command) {
        return;
      }
      const latexEditor = visibleLatexEditor(e.textEditor.document.uri);
      if (latexEditor) {
        revealLatexFor(e.textEditor, latexEditor);
      }
    }),

    // Returns the view's document (undefined when there is no Markdown file to show), so a caller can tell what
    // it showed without reading the window's state afterwards.
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.showGeneratedLatex`, async (arg?: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
      const editor = vscode.window.activeTextEditor;
      const uri = arg instanceof vscode.Uri ? arg : isMarkdown(editor?.document) ? editor?.document.uri : undefined;
      if (!uri) {
        void vscode.window.showWarningMessage('Open a Markdown file first.');
        return undefined;
      }
      await convertUri(uri);
      const doc = await vscode.workspace.openTextDocument(generatedUri(uri));
      if (doc.languageId !== 'latex') {
        await vscode.languages.setTextDocumentLanguage(doc, 'latex').then(undefined, () => undefined);
      }
      const latexEditor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
      if (editor && editor.document.uri.toString() === uri.toString()) {
        revealLatexFor(editor, latexEditor);
      }
      return latexEditor.document;
    }),

    vscode.commands.registerCommand(`${COMMAND_PREFIX}.goToMarkdownSource`, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== LATEX_SCHEME) {
        void vscode.window.showWarningMessage('Use this command in the generated LaTeX view.');
        return;
      }
      const markdown = markdownOf(editor.document.uri);
      const result = latestByMarkdown.get(markdown.toString()) ?? (await convertUri(markdown));
      const line = latexToMarkdownLine(result, editor.selection.active.line + 1) - 1;
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(markdown, { selection: range, viewColumn: vscode.ViewColumn.One });
    }),

    vscode.commands.registerCommand(`${COMMAND_PREFIX}.exportLatex`, async (arg?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const uri = arg instanceof vscode.Uri ? arg : isMarkdown(editor?.document) ? editor?.document.uri : undefined;
      if (!uri) {
        void vscode.window.showWarningMessage('Open a Markdown file first.');
        return;
      }
      if (uri.scheme === 'untitled') {
        void vscode.window.showWarningMessage('Save the Markdown file first: Export LaTeX writes the .tex beside it.');
        return;
      }
      const outcome = await exportLatex(uri, modalConfirm);
      if (outcome.written) {
        const warnings = latestByMarkdown.get(uri.toString())?.diagnostics.filter((d) => d.kind === 'unsupported').length ?? 0;
        const tail = warnings > 0 ? ` (${warnings} unsupported construct${warnings === 1 ? '' : 's'}; see the Problems panel)` : '';
        void vscode.window.showInformationMessage(`Exported ${vscode.workspace.asRelativePath(outcome.target)}${tail}.`);
      }
    }),

    vscode.commands.registerCommand(`${COMMAND_PREFIX}.createFolderConfig`, async (arg?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const uri = arg instanceof vscode.Uri ? arg : isMarkdown(editor?.document) ? editor?.document.uri : undefined;
      if (!uri || uri.scheme === 'untitled') {
        void vscode.window.showWarningMessage('Open a saved Markdown file first: the config file goes in its folder.');
        return;
      }
      const target = vscode.Uri.joinPath(uri, '..', CONFIG_FILE);
      const exists = await vscode.workspace.fs.stat(target).then(
        () => true,
        () => false,
      );
      if (exists && !(await modalConfirm(`${CONFIG_FILE} already exists in this folder. Replace it?`, 'The new file holds the settings this document converts with now.'))) {
        return;
      }
      const result = await convertUri(uri);
      const text = `${JSON.stringify(configFromMeta(result.meta), null, 2)}\n`;
      try {
        // Never through a link out of the project (build gate 2, G2S-02).
        await writeConfined(writeBoundary(target), target, new TextEncoder().encode(text));
      } catch (err) {
        void vscode.window.showWarningMessage(`Create folder config: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await vscode.window.showTextDocument(target);
    }),

    vscode.commands.registerCommand(`${COMMAND_PREFIX}.compareWithCommittedTex`, async (arg?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const uri = arg instanceof vscode.Uri ? arg : isMarkdown(editor?.document) ? editor?.document.uri : undefined;
      if (!uri) {
        void vscode.window.showWarningMessage('Open a Markdown file first.');
        return;
      }
      if (uri.scheme === 'untitled') {
        void vscode.window.showWarningMessage('Save the Markdown file first: the committed .tex is looked up beside it.');
        return;
      }
      const result = await convertUri(uri);
      const target = result.exportUri;
      const committed = await committedText(target);
      const name = target.path.slice(target.path.lastIndexOf('/') + 1);
      if (committed === undefined) {
        void vscode.window.showInformationMessage(`There is no committed ${name} to compare with.`);
        return;
      }
      const left = vscode.Uri.from({ scheme: COMMITTED_SCHEME, path: target.path, query: target.toString() });
      await vscode.commands.executeCommand('vscode.diff', left, generatedUri(uri), `${name} (committed) ↔ generated from Markdown`);
    }),
  );

  const testApi: MarkdownTestApi = {
    generatedUri,
    convert: convertUri,
    exportLatex,
    committedText,
    fileStatus,
    htmlViewEnabled: (markdown, text) => gate.isEnabled(text === undefined ? { currentDocument: markdown } : {}, text),
  };
  log.info('Markdown features registered (HTML view plugin inert unless switched on).');
  return {
    extendMarkdownIt: <T>(md: T): T => htmlViewPlugin(md as never, { isEnabled: (env, text) => gate.isEnabled(env, text) }) as T,
    testApi,
    /** The one ConversionService of the window: the compile and the generated-LaTeX view share its results. */
    conversions: service,
  };
}
