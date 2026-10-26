// The preview panels of the compile targets (docs/DESIGN.md#live-behaviour, #multiple-documents): one panel per
// target, the order in which they were shown, the previews the user closed (they stay closed until a command opens
// them; G1E-10), the previews left out of date by a change to a shared file (they say so, and catch up when shown;
// build gate 3, G3E-03), and the one rule for bringing a preview to the front (revealBesideEditor).

import * as vscode from 'vscode';
import { previewedTargets } from '../project/roots';
import type { PassKind } from './scheduler';
import type { SyncService } from '../sync/syncService';
import { PreviewPanel } from '../viewer/previewPanel';

/**
 * Brings a hidden preview to the front of its group, unless that group is the editor's: a preview the user put in
 * the editor's own group stays behind the editor, so neither typing (re-gate G1BE-04) nor clicking the editor's
 * tab (build gate 3, G3E-01) is ever covered by it. Returns undefined when it stays hidden, else a promise that
 * resolves when it is shown (2 s at most).
 */
export function revealBesideEditor(panel: PreviewPanel, editorColumn: vscode.ViewColumn | undefined): Promise<void> | undefined {
  if (panel.panel.visible || panel.panel.viewColumn === editorColumn) {
    return undefined;
  }
  const shown = new Promise<void>((resolve) => {
    const sub = panel.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        sub.dispose();
        resolve();
      }
    });
    setTimeout(() => {
      sub.dispose();
      resolve();
    }, 2000);
  });
  panel.panel.reveal(undefined, true);
  return shown;
}

export interface PreviewsOptions {
  extensionUri: vscode.Uri;
  sync: SyncService;
  log: vscode.LogOutputChannel;
  /** What the log calls a target. */
  labelOf: (key: string) => string;
  /** The user closed the preview of `key` (it may now be forgotten). */
  onUserClosed: (key: string) => void;
  /** The out-of-date preview of `key` is showing again: compile it with a pass of `kind`. */
  onOutdatedShown: (key: string, kind: PassKind) => void;
}

/** What an out-of-date preview's title ends with until its document compiles again. */
export const OUTDATED_TITLE = ' (out of date)';

export class Previews {
  private readonly panels = new Map<string, PreviewPanel>();
  /** Preview keys, the most recently shown or compiled first. */
  private readonly recentPreviews: string[] = [];
  /** Targets whose preview the user closed: compiles do not open it again until a command does (G1E-10). */
  private readonly closedByUser = new Set<string>();
  /** Targets left out when a shared file changed, with the pass they missed (G3E-03). */
  private readonly stale = new Map<string, PassKind>();
  private disposing = false;

  constructor(private readonly options: PreviewsOptions) {}

  get(key: string): PreviewPanel | undefined {
    return this.panels.get(key);
  }

  /** Whether `key` has a panel entry (open, or closing). */
  has(key: string): boolean {
    return this.panels.has(key);
  }

  /** Whether `key`'s preview panel is open. */
  isOpen(key: string): boolean {
    const panel = this.panels.get(key);
    return panel !== undefined && !panel.isDisposed;
  }

  /** Whether any preview is showing. */
  anyVisible(): boolean {
    return [...this.panels.values()].some((p) => !p.isDisposed && p.panel.visible);
  }

  closedByUserHas(key: string): boolean {
    return this.closedByUser.has(key);
  }

  /** A command opens the preview of `key` again, and later compiles may show it. */
  reopen(key: string): void {
    this.closedByUser.delete(key);
  }

  /** The panel of `key`, made when there is none. */
  panelFor(key: string, title: string): PreviewPanel {
    let panel = this.panels.get(key);
    if (!panel || panel.isDisposed) {
      panel = PreviewPanel.create(this.options.extensionUri, { title });
      const created = panel;
      created.panel.onDidDispose(() => {
        if (this.panels.get(key) === created) {
          this.panels.delete(key);
          if (!this.disposing) {
            // The user closed it: compiles keep running for the Problems panel, but the preview stays closed.
            this.closedByUser.add(key);
            this.options.onUserClosed(key);
          }
        }
      });
      this.panels.set(key, created);
      this.options.sync.attach(key, created);
      created.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.noteRecent(key);
          const missed = this.stale.get(key);
          if (missed) {
            this.options.onOutdatedShown(key, missed);
          }
        }
      });
    }
    return panel;
  }

  noteRecent(key: string): void {
    const i = this.recentPreviews.indexOf(key);
    if (i >= 0) {
      this.recentPreviews.splice(i, 1);
    }
    this.recentPreviews.unshift(key);
    this.recentPreviews.length = Math.min(this.recentPreviews.length, 50);
  }

  private isPreviewed(key: string): boolean {
    const panel = this.panels.get(key);
    return panel !== undefined && !panel.isDisposed && panel.panel.visible;
  }

  /**
   * A file several documents read compiles only the previewed ones (roots.ts, previewedTargets). The others are
   * remembered with the pass they missed: their preview says it is out of date, and they compile when it shows.
   */
  onlyPreviewed<T extends { key: string; kind: PassKind }>(targets: T[], ownRoot: string | undefined): T[] {
    const keep = new Set(previewedTargets(targets.map((t) => t.key), (k) => this.isPreviewed(k), ownRoot, this.recentPreviews));
    if (keep.size < targets.length) {
      this.options.log.debug(`shared file: compiling ${[...keep].map((k) => this.options.labelOf(k)).join(', ')} only (the previewed document)`);
      for (const t of targets.filter((x) => !keep.has(x.key))) {
        this.markOutdated(t.key, t.kind);
      }
    }
    return targets.filter((t) => keep.has(t.key));
  }

  private markOutdated(key: string, kind: PassKind): void {
    this.stale.set(key, this.stale.get(key) === 'full' ? 'full' : kind);
    const panel = this.panels.get(key);
    if (panel && !panel.isDisposed && !panel.panel.title.endsWith(OUTDATED_TITLE)) {
      panel.panel.title += OUTDATED_TITLE;
    }
  }

  /** A compile of `key` has started: its preview is no longer out of date. */
  markFresh(key: string): void {
    if (!this.stale.delete(key)) {
      return;
    }
    const panel = this.panels.get(key);
    if (panel && !panel.isDisposed && panel.panel.title.endsWith(OUTDATED_TITLE)) {
      panel.panel.title = panel.panel.title.slice(0, -OUTDATED_TITLE.length);
    }
  }

  /** The preview the viewer commands act on: the active one, else a visible one, else the most recently shown. */
  current(): PreviewPanel | undefined {
    const open = [...this.panels].filter(([, p]) => !p.isDisposed);
    const pick = open.find(([, p]) => p.panel.active) ?? open.find(([, p]) => p.panel.visible) ?? open.find(([k]) => k === this.recentPreviews.find((r) => this.panels.has(r)));
    return pick?.[1];
  }

  /** Closes `key`'s preview as the user would (the tests use it). */
  close(key: string): void {
    this.panels.get(key)?.panel.dispose();
  }

  /** Lets go of `key` (its target is forgotten): it leaves the recent list too (build gate 3, G3E-06). */
  forget(key: string): void {
    this.closedByUser.delete(key);
    this.stale.delete(key);
    const i = this.recentPreviews.indexOf(key);
    if (i >= 0) {
      this.recentPreviews.splice(i, 1);
    }
  }

  dispose(): void {
    this.disposing = true;
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
  }
}
