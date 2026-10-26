// Which document a change belongs to (docs/DESIGN.md#live-behaviour, #confinement-and-trust): the compile targets
// (a .tex root document, or an opted-in Markdown file), the root of each open .tex file, the files each target's
// last compile read, the project folder's read cache and file watcher, and forgetting a target nothing shows.
//
// The project folder is the workspace folder that holds the document (or the document's own folder when none
// does); only the document's folder and below are read, plus files the documents name elsewhere in the project
// folder. Nothing outside it is read (project/confine.ts).

import { posix } from 'node:path';
import * as vscode from 'vscode';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { findFolderConfig } from '../markdown/conversion';
import { DEFAULT_LIMITS, FileCache, LinkRefusedError, type CollectLimits, type ProjectFs } from '../project/collect';
import { insideProject } from '../project/confine';
import { noLinkOnTheWay } from '../project/linkWalk';
import { folderConfigAsksForTypesetting, frontMatterAsksForTypesetting } from '../project/markdownOptIn';
import { realPathWithin } from '../project/realPath';
import { findRoot, type RootFs } from '../project/roots';
import { relativeTo } from '../project/uris';
import { generatedMainFor } from './pipeline';
import type { PassKind } from './scheduler';

/**
 * workspace.fs below one folder. Only plain relative paths inside it are accepted (project/confine.ts). The walk
 * does not enter links, and a file is read only when no link on its way leads outside the folder: for files on
 * this computer its real path must lie in the folder's real path (this covers Windows junctions); on a remote
 * file system no folder or file on the way may be a symbolic link (build gate 1, G1S-02).
 */
function folderFs(folder: vscode.Uri): ProjectFs {
  const at = (rel: string) => {
    if (rel && !insideProject(rel)) {
      throw new Error(`refused a path outside the project folder: ${rel}`);
    }
    return rel ? vscode.Uri.joinPath(folder, ...rel.split('/')) : folder;
  };
  const confined = async (rel: string, uri: vscode.Uri) => {
    if (folder.scheme === 'file') {
      return realPathWithin(folder.fsPath, uri.fsPath);
    }
    // The one remote link walk, shared with the folder config readers (project/linkWalk.ts; G1BE-05). A missing
    // segment ends it as "no link"; the read then fails as a missing file.
    return noLinkOnTheWay(folder, rel);
  };
  return {
    async readDirectory(rel) {
      const entries = await vscode.workspace.fs.readDirectory(at(rel));
      return entries.map(([name, type]) => [
        name,
        type & vscode.FileType.SymbolicLink ? 'other' : type & vscode.FileType.Directory ? 'dir' : type & vscode.FileType.File ? 'file' : 'other',
      ]);
    },
    async readFile(rel) {
      const uri = at(rel);
      if (!(await confined(rel, uri))) {
        throw new LinkRefusedError(rel);
      }
      return vscode.workspace.fs.readFile(uri);
    },
    async stat(rel) {
      const s = await vscode.workspace.fs.stat(at(rel));
      return { size: s.size, mtime: s.mtime };
    },
  };
}

export const dirOf = (uri: vscode.Uri) => vscode.Uri.joinPath(uri, '..');

/** The document a text editor tab shows (the changed side of a diff); undefined for other tabs. */
export function tabUri(tab: vscode.Tab): string | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri.toString();
  }
  return input instanceof vscode.TabInputTextDiff ? input.modified.toString() : undefined;
}

/** Documents the preview may read: files on disk (or a remote file system), not output panes or virtual views. */
export function isProjectDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' || (vscode.workspace.getWorkspaceFolder(doc.uri) !== undefined && doc.uri.scheme !== 'untitled');
}

/** One compile target: a .tex root document, or an opted-in Markdown file. */
export interface Target {
  key: string;
  /** The project folder (MEMFS /project). */
  folder: vscode.Uri;
  /** The root document as the engine sees it (the generated .tex for Markdown), relative to the folder. */
  mainRel: string;
  /** The document itself: the root .tex, or the Markdown file. */
  uri: vscode.Uri;
  /** What the log and the record call it. */
  label: string;
  source: 'tex' | 'markdown';
  panelTitle: string;
  limits: CollectLimits;
  /** In no workspace folder: only its own folder level is walked and watched, and nothing is cached. */
  loose: boolean;
}

/** A target a change asks to compile, with the pass it asks for. */
export interface TargetPass {
  key: string;
  kind: PassKind;
}

const FULL_PASS_FILE = /\.(bib|pdf|png|jpe?g|eps|svg|jbig2|jb2)$/i;

export interface TargetsOptions {
  log: vscode.LogOutputChannel;
  /** A file changed under a watched folder. */
  onDiskChange: (uri: vscode.Uri) => void;
  /** Of the targets that read one shared file, the ones to compile (M2-B: the previewed ones; previews.ts). */
  onlyPreviewed: (targets: TargetPass[], ownRoot: string | undefined) => TargetPass[];
}

export class Targets {
  private readonly targets = new Map<string, Target>();
  /** Root document of each open .tex file (cleared when the file is saved or closed). */
  readonly rootOf = new Map<string, string>();
  /** Roots found while following the editor, for documents that have no target yet (build gate 3, G3E-04). */
  private readonly rootHints = new Map<string, string>();
  /** The project files each target's last compile read, for the file watchers. */
  readonly readSets = new Map<string, Set<string>>();
  /** What each target's last compile used, file by file (a fingerprint), to tell a late disk event from news. */
  readonly usedFiles = new Map<string, Map<string, string>>();
  /** When each document was last saved, and when each target's last compile started reading (G1BE-01). */
  readonly savedAt = new Map<string, number>();
  readonly readStartedAt = new Map<string, number>();
  /** Markdown files whose LaTeX preview was opened by the command in this session. */
  readonly markdownOptIn = new Set<string>();
  /** Whether a Markdown file's folder config asks for typesetting (cached; cleared when a config is saved). */
  readonly folderConfigAsks = new Map<string, boolean>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  /** Read caches by project folder (G1E-03); a file watcher invalidates them. */
  private readonly caches = new Map<string, FileCache>();
  /** Tests only: holds back each file watcher event this long, as a slow or remote file system would. */
  diskEventDelayMs = 0;

  constructor(private readonly options: TargetsOptions) {}

  get(key: string): Target | undefined {
    return this.targets.get(key);
  }

  has(key: string): boolean {
    return this.targets.has(key);
  }

  /**
   * The project folder for a document, and how deep to read it. A loose file (in no workspace folder, on any file
   * system) has only the files beside it walked, plus the files it names; its folder could be a home folder or a
   * drive's top (build gate 1, G1E-11).
   */
  private projectFor(uri: vscode.Uri): { folder: vscode.Uri; rel: string; limits: CollectLimits; loose: boolean } {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    const rel = ws ? relativeTo(ws.uri, uri) : undefined;
    if (ws && rel) {
      return { folder: ws.uri, rel, limits: DEFAULT_LIMITS, loose: false };
    }
    return { folder: dirOf(uri), rel: posix.basename(uri.path), limits: { ...DEFAULT_LIMITS, maxDepth: 0 }, loose: true };
  }

  private noteLoose(rel: string, loose: boolean): void {
    if (loose) {
      this.options.log.info(`${rel} is in no workspace folder; the files beside it and the files it names are read. Open its folder (File > Open Folder) to preview a project with subfolders.`);
    }
  }

  /**
   * The project's files through its read cache (a loose file's folder has none). A file open in an editor is
   * always read from disk: after a save, the disk is newer than any watcher event that has arrived (re-gate
   * G1BE-01). A full pass checks each kept file's size and time (G1BE-02).
   */
  projectFs(target: Target, kind: PassKind): ProjectFs {
    const cache = this.cacheFor(target);
    if (!cache) {
      return folderFs(target.folder);
    }
    const open = new Set(
      vscode.workspace.textDocuments.map((d) => relativeTo(target.folder, d.uri)).filter((r): r is string => r !== undefined),
    );
    return cache.wrap(folderFs(target.folder), { open, verify: kind === 'full' });
  }

  /** The read cache of a project folder (none for a loose file's folder, which is not watched recursively). */
  cacheFor(target: Target): FileCache | undefined {
    if (target.loose) {
      return undefined;
    }
    const key = target.folder.toString();
    let cache = this.caches.get(key);
    if (!cache) {
      cache = new FileCache();
      this.caches.set(key, cache);
    }
    return cache;
  }

  texTarget(root: vscode.Uri): Target {
    const key = root.toString();
    let target = this.targets.get(key);
    if (!target) {
      const { folder, rel, limits, loose } = this.projectFor(root);
      this.noteLoose(rel, loose);
      const name = posix.basename(rel);
      target = { key, folder, mainRel: rel, uri: root, label: name, source: 'tex', panelTitle: `Preview ${name.replace(/\.tex$/i, '.pdf')}`, limits, loose };
      this.targets.set(key, target);
      // Watch before the first read, so the read cache never misses a change.
      this.watch(folder, loose);
    }
    return target;
  }

  markdownTarget(uri: vscode.Uri): Target {
    const key = uri.toString();
    let target = this.targets.get(key);
    if (!target) {
      const { folder, rel, limits, loose } = this.projectFor(uri);
      this.noteLoose(rel, loose);
      const name = posix.basename(rel);
      const pdfName = posix.basename(generatedMainFor(rel)).replace(/\.tex$/i, '.pdf');
      target = { key, folder, mainRel: generatedMainFor(rel), uri, label: name, source: 'markdown', panelTitle: `Preview ${pdfName} (from ${name})`, limits, loose };
      this.targets.set(key, target);
      this.watch(folder, loose);
    }
    return target;
  }

  /** A Markdown file is typeset only when the command opened its preview, or its front matter or folder config asks. */
  async markdownAsks(doc: vscode.TextDocument): Promise<boolean> {
    const key = doc.uri.toString();
    if (this.markdownOptIn.has(key) || frontMatterAsksForTypesetting(doc.getText())) {
      return true;
    }
    const cached = this.folderConfigAsks.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let asks = false;
    const found = await findFolderConfig(doc.uri);
    if (found.uri) {
      try {
        asks = folderConfigAsksForTypesetting(new TextDecoder().decode(await vscode.workspace.fs.readFile(found.uri)));
      } catch {
        asks = false;
      }
    }
    this.folderConfigAsks.set(key, asks);
    return asks;
  }

  /** The targets a document belongs to, with the pass its change asks for. */
  async targetsFor(doc: vscode.TextDocument): Promise<TargetPass[]> {
    const out: TargetPass[] = [];
    if (isTexDocument(doc)) {
      let rootKey = this.rootOf.get(doc.uri.toString());
      if (!rootKey) {
        const root = await this.resolveRoot(doc);
        rootKey = this.texTarget(root).key;
        this.rootOf.set(doc.uri.toString(), rootKey);
      }
      out.push({ key: rootKey, kind: 'quick' });
    } else if (isMarkdownDocument(doc) && (await this.markdownAsks(doc))) {
      out.push({ key: this.markdownTarget(doc.uri).key, kind: 'quick' });
    }
    return this.withReaders(doc.uri, out, this.rootOf.get(doc.uri.toString()));
  }

  /** Adds every target whose last compile read `uri` (a .bib, a style file, an \input file of another root). */
  withReaders(uri: vscode.Uri, out: TargetPass[], ownRoot: string | undefined): TargetPass[] {
    for (const [key, files] of this.readSets) {
      const target = this.targets.get(key);
      const rel = target ? relativeTo(target.folder, uri) : undefined;
      if (rel && files.has(rel) && !out.some((o) => o.key === key)) {
        out.push({ key, kind: FULL_PASS_FILE.test(rel) ? 'full' : 'quick' });
      }
    }
    // A file several roots read compiles only the root being previewed (M2-B, previewedTargets).
    return this.options.onlyPreviewed(out, ownRoot);
  }

  /** targetsFor without waiting, when everything it needs is already known; undefined otherwise. */
  knownTargets(doc: vscode.TextDocument): TargetPass[] | undefined {
    const out: TargetPass[] = [];
    const uri = doc.uri.toString();
    if (isTexDocument(doc)) {
      const root = this.rootOf.get(uri);
      if (!root) {
        return undefined;
      }
      out.push({ key: root, kind: 'quick' });
    } else if (isMarkdownDocument(doc)) {
      const asks = this.markdownOptIn.has(uri) || frontMatterAsksForTypesetting(doc.getText()) || this.folderConfigAsks.get(uri);
      if (asks === undefined) {
        return undefined;
      }
      if (asks) {
        out.push({ key: this.markdownTarget(doc.uri).key, kind: 'quick' });
      }
    }
    return this.withReaders(doc.uri, out, this.rootOf.get(uri));
  }

  /** Drops `uri` (a file, or a folder and what is under it) from every read cache. */
  invalidateCaches(uri: vscode.Uri): void {
    for (const [key, cache] of this.caches) {
      const rel = relativeTo(vscode.Uri.parse(key), uri);
      if (rel) {
        cache.invalidate(rel);
      }
    }
  }

  /** A workspace folder is watched recursively (VS Code watches it already); a loose file's folder one level. */
  private watch(folder: vscode.Uri, loose: boolean): void {
    const key = folder.toString();
    if (this.watchers.has(key)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, loose ? '*' : '**/*'));
    const news = (uri: vscode.Uri) => {
      if (this.diskEventDelayMs > 0) {
        setTimeout(() => this.options.onDiskChange(uri), this.diskEventDelayMs);
      } else {
        this.options.onDiskChange(uri);
      }
    };
    watcher.onDidChange(news);
    watcher.onDidCreate(news);
    watcher.onDidDelete(news);
    this.watchers.set(key, watcher);
  }

  /** The root document: "% !TEX root", the file itself when it has \documentclass, or a file that includes it. */
  async resolveRoot(doc: vscode.TextDocument): Promise<vscode.Uri> {
    const { folder: project, rel } = this.projectFor(doc.uri);
    const at = (r: string) => (r === '' ? project : vscode.Uri.joinPath(project, ...r.split('/')));
    const fs: RootFs = {
      readDirectory: async (r) =>
        (await vscode.workspace.fs.readDirectory(at(r))).map(([name, type]): [string, 'file' | 'dir' | 'other'] => [
          name,
          type & vscode.FileType.Directory ? 'dir' : type & vscode.FileType.File ? 'file' : 'other',
        ]),
      readFile: async (r) => vscode.workspace.fs.readFile(at(r)),
      exists: async (r) => {
        try {
          await vscode.workspace.fs.stat(at(r));
          return true;
        } catch {
          return false;
        }
      },
    };
    const root = await findRoot(fs, rel, doc.getText(), (message) => this.options.log.warn(message));
    return root === rel ? doc.uri : at(root);
  }

  /**
   * The root key of a .tex document from what is already known (its target's root, or an earlier lookup), so
   * switching editors does not read the folder each time; else from resolveRoot. Makes no target (G3E-04).
   */
  async rootKeyFor(doc: vscode.TextDocument): Promise<string> {
    const uri = doc.uri.toString();
    const known = this.rootOf.get(uri) ?? this.rootHints.get(uri);
    if (known) {
      return known;
    }
    const key = (await this.resolveRoot(doc)).toString();
    this.rootHints.set(uri, key);
    return key;
  }

  /** Forgets what is known about a document's root: it was saved (its root comment may have changed) or closed. */
  dropRoot(uri: string): void {
    this.rootOf.delete(uri);
    this.rootHints.delete(uri);
  }

  /** The preview key of a document: its root document's URI for .tex, its own for Markdown; else undefined. */
  async previewKeyFor(doc: vscode.TextDocument): Promise<string | undefined> {
    if (isTexDocument(doc)) {
      return this.rootOf.get(doc.uri.toString()) ?? (await this.resolveRoot(doc)).toString();
    }
    return isMarkdownDocument(doc) ? doc.uri.toString() : undefined;
  }

  /** Whether the active editor's document belongs to the target `key` (its root, the Markdown file, or a read file). */
  isActiveTarget(key: string): boolean {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      return false;
    }
    const uri = doc.uri.toString();
    if (uri === key || this.rootOf.get(uri) === key) {
      return true;
    }
    const target = this.targets.get(key);
    const rel = target ? relativeTo(target.folder, doc.uri) : undefined;
    return rel !== undefined && (this.readSets.get(key)?.has(rel) ?? false);
  }

  /** Whether an editor tab shows the target `key`: its own document, or a file whose root it is. */
  shownInTabs(key: string): boolean {
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map(tabUri));
    return open.some((u) => u !== undefined && (u === key || this.rootOf.get(u) === key));
  }

  /**
   * Forgets the target `key`: its read set and timings, the roots that point to it, and the watcher and read cache
   * of a folder no other target uses. Returns the target that was forgotten.
   */
  forget(key: string): Target | undefined {
    const target = this.targets.get(key);
    if (!target) {
      return undefined;
    }
    this.readSets.delete(key);
    this.usedFiles.delete(key);
    this.readStartedAt.delete(key);
    this.targets.delete(key);
    for (const [doc, root] of this.rootOf) {
      if (root === key) {
        this.rootOf.delete(doc);
      }
    }
    const folder = target.folder.toString();
    if (![...this.targets.values()].some((t) => t.folder.toString() === folder)) {
      this.watchers.get(folder)?.dispose();
      this.watchers.delete(folder);
      this.caches.delete(folder);
    }
    return target;
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
  }
}
