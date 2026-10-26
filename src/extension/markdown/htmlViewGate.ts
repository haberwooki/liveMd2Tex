// Who gets the HTML view plugin (docs/DESIGN.md#confinement-and-trust; review item V4-R2-09): nobody by default. It acts for a
// document when the user setting livemd2tex.markdown.htmlViewPlugin is on for its folder, or when the
// nearest .latexpreview.json says "htmlView": true. markdown-it calls the gate synchronously, so folder configs
// are read ahead into a cache, kept fresh by a file watcher; a change refreshes open Markdown previews. In
// Restricted Mode only the user's own setting counts: the folder configs are ignored, and VS Code ignores the
// workspace's value of the setting (a restricted configuration in package.json).

import * as vscode from 'vscode';
import { CONFIG_FILE, parseFolderConfig } from '../../converter/config';
import { COMMAND_PREFIX } from '../../shared/identity';
import { folderRel, readInsideProject } from './conversion';

export const HTML_VIEW_SETTING = 'markdown.htmlViewPlugin';

export class HtmlViewGate implements vscode.Disposable {
  /** Folder URI string -> htmlView from that folder's .latexpreview.json (undefined: no file there). */
  private readonly folders = new Map<string, boolean | undefined>();
  private readonly pending = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
    const changed = (uri: vscode.Uri) => {
      this.folders.delete(vscode.Uri.joinPath(uri, '..').toString());
      void this.load(vscode.Uri.joinPath(uri, '..')).then(() => this.refreshPreviews());
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshPreviews()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${COMMAND_PREFIX}.${HTML_VIEW_SETTING}`)) {
          this.refreshPreviews();
        }
      }),
    );
  }

  /** The synchronous answer markdown-it needs; schedules a read of folder configs it has not seen yet. */
  isEnabled(env: Record<string | symbol, unknown>, text?: string): boolean {
    const doc = this.documentOf(env, text);
    if (!doc) {
      return false;
    }
    if (vscode.workspace.getConfiguration(COMMAND_PREFIX, doc).get<boolean>(HTML_VIEW_SETTING, false) === true) {
      // In Restricted Mode VS Code reads this setting from the user only (a restricted configuration).
      return true;
    }
    if (!vscode.workspace.isTrusted) {
      // A repository's folder config cannot switch the plugin on in Restricted Mode (docs/DESIGN.md#confinement-and-trust).
      return false;
    }
    const root = vscode.workspace.getWorkspaceFolder(doc)?.uri;
    let dir = vscode.Uri.joinPath(doc, '..');
    for (;;) {
      const key = dir.toString();
      if (!this.folders.has(key)) {
        void this.load(dir).then((found) => {
          if (found) {
            this.refreshPreviews();
          }
        });
      } else {
        const value = this.folders.get(key);
        if (value !== undefined) {
          return value;
        }
      }
      if (!root || dir.path === root.path || !dir.path.startsWith(root.path)) {
        break;
      }
      const parent = vscode.Uri.joinPath(dir, '..');
      if (parent.path === dir.path) {
        break;
      }
      dir = parent;
    }
    return false;
  }

  /**
   * The document being parsed: env.currentDocument when the caller sets it; otherwise (VS Code's preview parses
   * with it undefined) the open Markdown document whose text is exactly the text being parsed. Lengths are
   * compared first, so no document's text is copied unless it could match.
   */
  private documentOf(env: Record<string | symbol, unknown>, text?: string): vscode.Uri | undefined {
    const raw = env.currentDocument as { scheme?: unknown; path?: unknown } | undefined;
    if (raw && typeof raw.scheme === 'string' && typeof raw.path === 'string') {
      return raw instanceof vscode.Uri ? raw : vscode.Uri.from(raw as vscode.Uri);
    }
    if (text === undefined) {
      return undefined;
    }
    for (const d of vscode.workspace.textDocuments) {
      if (d.languageId !== 'markdown' || d.isClosed) {
        continue;
      }
      const end = d.lineAt(d.lineCount - 1).range.end;
      if (d.offsetAt(end) === text.length && d.getText() === text) {
        return d.uri;
      }
    }
    return undefined;
  }

  /** Reads one folder's config into the cache; true if it switches the plugin on. */
  private async load(dir: vscode.Uri): Promise<boolean> {
    const key = dir.toString();
    if (this.pending.has(key)) {
      return false;
    }
    this.pending.add(key);
    try {
      // Read like every folder config: not through a link that leads out of the project folder (G1B-S-03).
      const project = vscode.workspace.getWorkspaceFolder(dir)?.uri ?? dir;
      const rel = folderRel(project, dir);
      const read = rel === undefined ? undefined : await readInsideProject(project, rel ? `${rel}/${CONFIG_FILE}` : CONFIG_FILE);
      if (read === undefined || typeof read === 'string') {
        this.folders.set(key, undefined);
        return false;
      }
      const value = parseFolderConfig(read.text).config.markdown.htmlView;
      this.folders.set(key, value ?? false);
      return value === true;
    } catch {
      this.folders.set(key, undefined);
      return false;
    } finally {
      this.pending.delete(key);
    }
  }

  private refreshPreviews(): void {
    void vscode.commands.executeCommand('markdown.preview.refresh').then(undefined, () => undefined);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
