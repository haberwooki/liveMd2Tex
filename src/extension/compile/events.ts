// What starts a compile (docs/DESIGN.md#live-behaviour): typing (after a pause), a save, a change on disk to a file
// the last compile read, and the preview following the active editor (M2-B). Closing an editor or its tab may let
// a target be forgotten. When to compile is the scheduler's job (scheduler.ts); this file only tells it.

import { posix } from 'node:path';
import * as vscode from 'vscode';
import { isMarkdownDocument, isTexDocument } from '../languages';
import { fingerprint } from '../project/collect';
import { relativeTo } from '../project/uris';
import { revealBesideEditor, type Previews } from './previews';
import type { CompileScheduler } from './scheduler';
import { config } from './settings';
import { isProjectDocument, tabUri, type Targets } from './targets';
import type { Trust } from './trust';

/** How long the active editor must stay on a document before the preview follows it with a compile (M2-B). */
const FOLLOW_DELAY_MS = 500;

export interface DocumentEventsOptions {
  targets: Targets;
  previews: Previews;
  scheduler: CompileScheduler;
  trust: Trust;
  log: vscode.LogOutputChannel;
  /** Whether `key` has had a good compile. */
  hasState: (key: string) => boolean;
  /** `key` may have nothing left that shows it. */
  maybeForget: (key: string) => void;
}

export class DocumentEvents {
  constructor(private readonly o: DocumentEventsOptions) {}

  onChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (e.contentChanges.length === 0 || !isProjectDocument(doc) || !this.o.trust.trusted()) {
      return;
    }
    if (config<'pause' | 'save'>('compileOn', 'pause') !== 'pause') {
      return;
    }
    // Known documents are handled at once, so the scheduler sees each keystroke's real time.
    const known = this.o.targets.knownTargets(doc);
    if (known) {
      for (const t of known) {
        this.o.scheduler.edit(t.key, t.kind);
      }
      return;
    }
    void this.o.targets.targetsFor(doc).then((targets) => {
      for (const t of targets) {
        this.o.scheduler.edit(t.key, t.kind);
      }
    });
  }

  onSaved(doc: vscode.TextDocument): void {
    const { targets } = this.o;
    if (/(^|\/)\.latexpreview\.json$/i.test(doc.uri.path)) {
      targets.folderConfigAsks.clear();
    }
    if (!isProjectDocument(doc) || !this.o.trust.trusted()) {
      return;
    }
    // The saved text is on disk now; no read cache may answer with the text of the save before (G1BE-01).
    targets.invalidateCaches(doc.uri);
    targets.savedAt.set(doc.uri.toString(), performance.now());
    // The magic comment or the \documentclass line may have changed.
    targets.dropRoot(doc.uri.toString());
    targets.folderConfigAsks.delete(doc.uri.toString());
    void targets.targetsFor(doc).then((found) => {
      for (const t of found) {
        this.o.scheduler.save(t.key);
      }
    });
  }

  /** A file that some target's last compile read changed on disk (an editor's own changes come as edits). */
  onDiskChange(uri: vscode.Uri): void {
    const { targets, scheduler, log } = this.o;
    if (/(^|\/)\.latexpreview\.json$/i.test(uri.path)) {
      targets.folderConfigAsks.clear();
    }
    // Every change under a project folder reaches its read cache, open in an editor or not.
    targets.invalidateCaches(uri);
    if (!this.o.trust.trusted()) {
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open?.isDirty) {
      // The editor's unsaved text is what the compiles use; the disk does not matter for it.
      return;
    }
    const readers = targets.withReaders(uri, [], undefined);
    if (!open) {
      for (const { key, kind } of readers) {
        log.info(`${targets.get(key)?.label}: ${relativeTo(targets.get(key)?.folder ?? uri, uri) ?? uri.path} changed on disk`);
        scheduler.fileChanged(key, kind);
      }
      return;
    }
    // A file open in an editor and saved: the save compiled it. The watcher's news may come late, or come from
    // another program (in "On save" mode its change reaches no edit). Compile again only when the disk now holds
    // other bytes than the last compile of a target used (G1BE-01).
    // A save after the last compile started reading has its own compile coming, which reads the disk afresh.
    const saved = targets.savedAt.get(uri.toString()) ?? -1;
    const waiting = readers.filter(({ key }) => saved <= (targets.readStartedAt.get(key) ?? -1));
    if (waiting.length > 0) {
      void vscode.workspace.fs.readFile(uri).then(
        (bytes) => {
          const now = fingerprint(bytes);
          for (const { key, kind } of waiting) {
            const target = targets.get(key);
            const rel = target ? relativeTo(target.folder, uri) : undefined;
            const used = rel ? targets.usedFiles.get(key)?.get(rel) : undefined;
            if (rel && used !== undefined && used !== now) {
              log.info(`${target?.label}: ${rel} on disk differs from what the last compile used`);
              scheduler.fileChanged(key, kind);
            }
          }
        },
        () => undefined,
      );
    }
  }

  /** An editor's document closed: forget its root, and the target when nothing shows it any more. */
  onClosed(doc: vscode.TextDocument): void {
    const { targets } = this.o;
    const uri = doc.uri.toString();
    const key = targets.rootOf.get(uri) ?? (targets.has(uri) ? uri : undefined);
    targets.dropRoot(uri);
    targets.savedAt.delete(uri);
    if (key) {
      this.o.maybeForget(key);
    }
  }

  /** Editor tabs were closed: their targets may now have nothing that shows them. */
  onTabsClosed(closed: readonly vscode.Tab[]): void {
    const { targets } = this.o;
    for (const uri of closed.map(tabUri).filter((u): u is string => u !== undefined)) {
      const key = targets.rootOf.get(uri) ?? (targets.has(uri) ? uri : undefined);
      if (key) {
        this.o.maybeForget(key);
      }
    }
  }

  /**
   * The preview follows the active editor: the document's own preview comes to the front (unless it is in the
   * editor's own group; revealBesideEditor); a document without one is typeset when another preview is showing
   * (a second root in the folder, say). A root already known is not looked up again, and a target is made only
   * for a compile (build gate 3, G3E-04).
   */
  async followEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    const { targets, previews, scheduler } = this.o;
    if (!editor || !config<boolean>('previewFollowsEditor', true) || !isProjectDocument(editor.document)) {
      return;
    }
    const doc = editor.document;
    const isTex = isTexDocument(doc);
    if (!isTex && !(isMarkdownDocument(doc) && (await targets.markdownAsks(doc)))) {
      return;
    }
    const uri = doc.uri.toString();
    const key = isTex ? await targets.rootKeyFor(doc) : uri;
    const panel = previews.get(key);
    if (panel && !panel.isDisposed) {
      // A preview's target exists as long as the preview does.
      if (isTex) {
        targets.rootOf.set(uri, key);
      }
      void revealBesideEditor(panel, editor.viewColumn);
      previews.noteRecent(key);
      return;
    }
    // Typeset only a document the user stays on, and only when nothing else is compiling it already (the compile
    // command often comes right after the editor opens).
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_DELAY_MS));
    if (vscode.window.activeTextEditor?.document !== doc || scheduler.runningKey === key) {
      return;
    }
    if (previews.anyVisible() && this.o.trust.trusted() && !this.o.hasState(key) && !previews.has(key)) {
      this.o.log.info(`${posix.basename(doc.uri.path)}: the preview follows the editor`);
      if (isTex) {
        targets.texTarget(vscode.Uri.parse(key));
        targets.rootOf.set(uri, key);
      } else {
        targets.markdownTarget(doc.uri);
      }
      scheduler.request(key, false);
    }
  }
}
