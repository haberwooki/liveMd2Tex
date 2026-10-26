// SyncTeX both ways for the preview panels (docs/DESIGN.md#sync, M2-A):
//   - inverse search: a double-click or a Ctrl/Cmd-click in the PDF opens the source line, through the
//     converter's line map for Markdown, refined by the word and the typeset line under the click;
//   - forward search: "Show line in PDF" scrolls the preview to the cursor's line with a brief highlight, on the
//     page that holds the cursor's word; optionally on every cursor move (a setting, off by default);
//   - for the keyboard: "Go to the source of the PDF view's centre", and an aria-live note on every jump.
// The .synctex file of each compile is read in the SyncTeX worker (a worker thread), never on this thread.
// SyncTeX data goes with the PDF it describes (build gate 1, G1E-07): it is loaded only when a compile gave a PDF,
// each PDF and its data share a tag, and the viewer reports the tag of the PDF a click was on. The data of a PDF the
// viewer may still show is kept until the viewer confirms the next one.
// A click on the contents list or the bibliography goes to the heading or the .bib entry (generated.ts), through the
// auxiliary files the compile read (the previous compile's: on a document's first compile they are not at hand).

import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND_PREFIX } from '../../shared/identity';
import type { PagePoint, ViewerRevealed } from '../../shared/viewerProtocol';
import { generatedOfSource, mergeForward, refineHit, sourceOfGenerated, type MarkdownOrigin, type SourceLine } from '../../synctex/compose';
import { GENERATED_FILE, sourceOfList, type AuxFile } from '../../synctex/generated';
import type { PreparedCompile } from '../compile/pipeline';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { relativeTo } from '../project/uris';
import type { PreviewPanel } from '../viewer/previewPanel';
import { SyncClient } from './syncClient';

/** The SyncTeX data of one PDF. */
interface SyncTarget {
  /** The project folder: SyncTeX's file names are relative to it. */
  folder: vscode.Uri;
  /** For converted Markdown: the generated file and the line map. */
  origin?: MarkdownOrigin;
  /** The data's name in the worker; undefined when the compile wrote no SyncTeX. */
  workerKey?: string;
  loaded: Promise<unknown>;
  /** The auxiliary files the compile read (the contents lists, the bibliography, the .aux). */
  aux: AuxFile[];
  /** The project files the compile read, from the SyncTeX data, once loaded. */
  files: string[];
}

/** The auxiliary files the list lookup needs, as text. */
const LIST_AUX = /\.(toc|lof|lot|bbl|aux)$/i;

const config = <T>(key: string, fallback: T): T => vscode.workspace.getConfiguration(COMMAND_PREFIX).get<T>(key, fallback);

export class SyncService implements vscode.Disposable {
  private readonly client: SyncClient;
  /** Per preview key: the SyncTeX data of each PDF the viewer shows or may still show, by tag. */
  private readonly targets = new Map<string, Map<number, SyncTarget>>();
  private nextTag = 0;
  private readonly panels = new Map<string, PreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private followTimer: NodeJS.Timeout | undefined;
  /** The last jump, for the tests and the log. */
  lastJump: { kind: 'inverse' | 'forward'; file?: string; line?: number; page?: number } | undefined;
  /** The last SyncTeX data loaded, for the tests and the log. */
  lastUpdate: { key: string; tag: number } | undefined;

  constructor(
    extensionPath: string,
    /** The preview key of a document (its root document's URI for .tex, its own for Markdown). */
    private readonly keyFor: (doc: vscode.TextDocument) => Promise<string | undefined>,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.client = new SyncClient(path.join(extensionPath, 'dist', 'synctex-worker.js'));
    this.disposables.push(vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)));
  }

  /**
   * After a compile that gave a PDF: its SyncTeX data (read in the worker) for the preview `key`. Returns the tag
   * that goes with the PDF to the viewer. Without SyncTeX data, clicks on that PDF find no source.
   */
  update(key: string, folder: vscode.Uri, synctex: Uint8Array | null, prepared: PreparedCompile): number {
    const tag = ++this.nextTag;
    const workerKey = synctex ? `${key}#${tag}` : undefined;
    const md = prepared.markdown;
    const origin: MarkdownOrigin | undefined = md
      ? {
          main: prepared.job.main,
          markdown: md.source,
          lineMap: md.lineMap,
          bodyStartLine: md.bodyStartLine ?? 1,
          latexLines: md.latex?.split('\n'),
          appendix: md.appendix,
        }
      : undefined;
    const loaded =
      synctex && workerKey
        ? this.client.load(workerKey, synctex).catch((err: unknown) => {
            this.log.warn(`SyncTeX could not be read: ${String(err)}`);
            return null;
          })
        : Promise.resolve(null);
    let byTag = this.targets.get(key);
    if (!byTag) {
      byTag = new Map();
      this.targets.set(key, byTag);
    }
    const aux = (prepared.job.state ?? []).filter((f) => LIST_AUX.test(f.path)).map((f) => ({ path: f.path, text: new TextDecoder().decode(f.data) }));
    const entry: SyncTarget = { folder, origin, workerKey, loaded, aux, files: [] };
    void loaded.then((result) => {
      entry.files = (result as { files?: string[] } | null)?.files ?? [];
    });
    byTag.set(tag, entry);
    this.lastUpdate = { key, tag };
    this.prune(key);
    return tag;
  }

  /**
   * The SyncTeX data of the PDF with `tag` (a click reports it); without a tag, of the PDF last sent to the viewer
   * (the viewer handles messages in order, so a forward search is shown on that PDF), else the newest.
   */
  private target(key: string, tag?: number): SyncTarget | undefined {
    const byTag = this.targets.get(key);
    if (!byTag || byTag.size === 0) {
      return undefined;
    }
    if (tag !== undefined) {
      return byTag.get(tag);
    }
    const sent = this.panels.get(key)?.latestTag;
    return (sent !== undefined ? byTag.get(sent) : undefined) ?? byTag.get(Math.max(...byTag.keys()));
  }

  /** Keeps the data of the newest PDF, the one the viewer shows and the one last sent to it; drops the rest. */
  private prune(key: string): void {
    const byTag = this.targets.get(key);
    if (!byTag) {
      return;
    }
    const panel = this.panels.get(key);
    const keep = new Set([Math.max(...byTag.keys()), panel?.shownTag, panel?.latestTag]);
    for (const [tag, target] of byTag) {
      if (!keep.has(tag)) {
        byTag.delete(tag);
        if (target.workerKey) {
          void this.client.drop(target.workerKey).catch(() => undefined);
        }
      }
    }
  }

  /** For the tests: the preview panel of `key`. */
  panelOf(key: string): PreviewPanel | undefined {
    return this.panels.get(key);
  }

  /** For the tests: the tags whose SyncTeX data is kept for `key`. */
  keptTags(key: string): number[] {
    return [...(this.targets.get(key)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** A preview panel for `key`: its clicks ask for their source. */
  attach(key: string, panel: PreviewPanel): void {
    this.panels.set(key, panel);
    const sub = panel.onDidRequestSource((point) => void this.inverse(key, point));
    const shown = panel.onDidShow(() => this.prune(key));
    panel.panel.onDidDispose(() => {
      sub.dispose();
      shown.dispose();
      if (this.panels.get(key) === panel) {
        this.panels.delete(key);
      }
    });
  }

  /** Inverse search: the source of a point, opened in an editor with its line (and the word) selected. */
  async inverse(key: string, point: PagePoint): Promise<SourceLine | undefined> {
    const target = this.target(key, point.tag);
    const panel = this.panels.get(key);
    if (!target?.workerKey) {
      panel?.announce('No source line for this point.');
      return undefined;
    }
    await target.loaded;
    const hit = await this.client.inverse(target.workerKey, point.page, point.x, point.y);
    if (!hit?.file) {
      panel?.announce('No source line for this point.');
      return undefined;
    }
    let source: SourceLine;
    const list = GENERATED_FILE.test(hit.file);
    if (list) {
      // A line of the contents list or the bibliography: its heading or its .bib entry.
      const found = await this.sourceOfList(target, { file: hit.file, line: hit.line });
      if (!found) {
        panel?.announce('This is in a list TeX made (contents or bibliography); its source line was not found.');
        return undefined;
      }
      source = found;
    } else {
      source = target.origin ? sourceOfGenerated(target.origin, hit.file, hit.line) : { file: hit.file, line: hit.line };
    }
    const uri = vscode.Uri.joinPath(target.folder, source.file);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      panel?.announce(`The source ${source.file} could not be opened.`);
      return undefined;
    }
    const lines = doc.getText().split(/\r?\n/);
    if (!list) {
      source = refineHit(source, point.word, (f) => (f === source.file ? lines : undefined), point.context);
    }
    const line = Math.min(Math.max(source.line, 1), doc.lineCount) - 1;
    const text = doc.lineAt(line).text;
    const at = point.word ? new RegExp(`(?<![\\p{L}\\p{N}])${point.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').exec(text) : null;
    const selection = at ? new vscode.Range(line, at.index, line, at.index + at[0].length) : new vscode.Range(line, 0, line, 0);
    const column = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn ?? vscode.ViewColumn.One;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, selection, preserveFocus: false });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.lastJump = { kind: 'inverse', file: source.file, line: source.line };
    panel?.announce(`Source: ${path.posix.basename(source.file)}, line ${source.line}.`);
    return source;
  }

  /** The source of a hit in the contents list or the bibliography (generated.ts), searching the sources in order. */
  private async sourceOfList(target: SyncTarget, hit: SourceLine): Promise<SourceLine | undefined> {
    const sources = target.origin
      ? [target.origin.markdown, ...(target.origin.appendix ? [target.origin.appendix.file] : [])]
      : target.files.filter((f) => /\.(tex|ltx)$/i.test(f));
    const read = async (file: string) => {
      try {
        return (await vscode.workspace.openTextDocument(vscode.Uri.joinPath(target.folder, ...file.split('/')))).getText().split(/\r?\n/);
      } catch {
        return undefined;
      }
    };
    return sourceOfList(hit, target.aux, sources, read);
  }

  /** Forward search from an editor's cursor. `quiet`: no message when there is nothing to show (following). */
  async forward(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor, quiet = false): Promise<ViewerRevealed | undefined> {
    if (!editor) {
      return undefined;
    }
    const doc = editor.document;
    const key = await this.keyFor(doc);
    const target = key ? this.target(key) : undefined;
    const panel = key ? this.panels.get(key) : undefined;
    if (!key || !target?.workerKey || !panel || panel.isDisposed) {
      if (!quiet) {
        void vscode.window.showInformationMessage('Show the preview of this document first (compile it, or "Open LaTeX preview" for Markdown).');
      }
      return undefined;
    }
    const workerKey = target.workerKey;
    await target.loaded;
    // Case-insensitive on Windows: the workspace folder may be "/C:/..." and the document "/c:/...".
    const file = relativeTo(target.folder, doc.uri) ?? path.posix.relative(target.folder.path, doc.uri.path);
    const line = editor.selection.active.line + 1;
    const range = doc.getWordRangeAtPosition(editor.selection.active);
    const word = range ? doc.getText(range) : undefined;
    const queries = target.origin ? generatedOfSource({ ...target.origin, markdownLines: doc.getText().split(/\r?\n/) }, file, line) : [{ file, line }];
    const result = mergeForward(await Promise.all(queries.map((q) => this.client.forward(workerKey, q.file, q.line))));
    if (!result) {
      if (!quiet) {
        panel.announce(`Line ${line} is not in the PDF.`);
      }
      return undefined;
    }
    if (!panel.panel.visible) {
      panel.panel.reveal(undefined, true);
    }
    const shown = await panel.reveal(result.rects, result.page, word, `Line ${line} of ${path.posix.basename(file)}`);
    this.lastJump = { kind: 'forward', file, line, page: shown.page };
    return shown;
  }

  /** The source of the centre of the visible preview (keyboard users: pdf.js has no caret in a page). */
  async sourceOfViewCentre(): Promise<SourceLine | undefined> {
    const entries = [...this.panels].filter(([, p]) => !p.isDisposed);
    const entry = entries.find(([, p]) => p.panel.active) ?? entries.find(([, p]) => p.panel.visible);
    if (!entry) {
      void vscode.window.showInformationMessage('No PDF preview is open.');
      return undefined;
    }
    const centre = await entry[1].centre();
    return centre.point ? this.inverse(entry[0], centre.point) : undefined;
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    // Our own jumps (inverse search) move the cursor by command: they must not echo back.
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command || !config('syncFollowCursor', false)) {
      return;
    }
    const doc = e.textEditor.document;
    if (!isTexDocument(doc) && !isMarkdownDocument(doc)) {
      return;
    }
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => void this.forward(e.textEditor, true).catch(() => undefined), 300);
  }

  /** Lets go of a preview that is gone: its SyncTeX data here and in the worker (build gate 1, G1E-12). */
  forget(key: string): void {
    for (const target of this.targets.get(key)?.values() ?? []) {
      if (target.workerKey) {
        void this.client.drop(target.workerKey).catch(() => undefined);
      }
    }
    this.targets.delete(key);
    this.panels.delete(key);
  }

  dispose(): void {
    clearTimeout(this.followTimer);
    for (const d of this.disposables) {
      d.dispose();
    }
    void this.client.dispose();
  }
}

/** The commands: forward search, and the source of the view's centre. */
export function registerSyncCommands(sync: SyncService): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.syncToPdf`, () => sync.forward()),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.syncFromPdfCentre`, () => sync.sourceOfViewCentre()),
  ];
}
