// What a compile leaves behind outside the preview (docs/DESIGN.md#live-behaviour, #engine-and-data): the PDF next
// to the source on save, the log's problems in the Problems panel, and one notification per new set of missing
// packages.

import { posix } from 'node:path';
import * as vscode from 'vscode';
import { COMMAND_PREFIX, DISPLAY_NAME } from '../../shared/identity';
import { problemMessage, type HelpedDiagnostic } from '../diagnostics/errorHelp';
import { writeConfined, WriteRefusedError } from '../project/confinedWrite';
import { missingMessage, type ScanResult } from '../project/packageScan';
import type { Target } from './targets';

/**
 * A save writes the PDF next to the source only from saved text (docs/DESIGN.md#live-behaviour): when an input of this
 * compile is open with unsaved changes (typing replaced the save's compile), the PDF is not written (G1E-21).
 */
export function unsavedInputs(files: { path: string }[], overrides: Map<string, Uint8Array>): string | undefined {
  const dirty = files.map((f) => f.path).filter((p) => overrides.has(p));
  return dirty.length > 0 ? `${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes; the next save writes it` : undefined;
}

/**
 * A Markdown file's PDF is written next to it, except when a .tex file of the same name is there: then that
 * name belongs to the .tex file's own PDF, which is left alone.
 */
export async function whyNotWritePdf(target: Target): Promise<string | undefined> {
  if (target.source !== 'markdown') {
    return undefined;
  }
  // A save compile replaced by typing compiles unsaved Markdown; its PDF must not land next to the source
  // (G1E-21 for Markdown; build gate 1 re-gate, G1BE-04). The job's own files are the generated LaTeX, so the
  // Markdown document is checked here.
  if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === target.uri.toString())) {
    return `${posix.basename(target.uri.path)} has unsaved changes`;
  }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(target.folder, ...target.mainRel.split('/')));
    const name = posix.basename(target.mainRel);
    return `${name} is in the same folder, so ${name.replace(/\.tex$/i, '.pdf')} is left to it`;
  } catch {
    return undefined;
  }
}

/** The PDF next to the source (docs/DESIGN.md#live-behaviour): a temporary name, then a rename; three tries. */
export async function writePdf(folder: vscode.Uri, mainRel: string, pdf: Uint8Array, log: vscode.LogOutputChannel): Promise<string | null> {
  const pdfRel = mainRel.replace(/\.tex$/i, '.pdf');
  const target = vscode.Uri.joinPath(folder, ...pdfRel.split('/'));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // A temporary file and a rename, never through a link out of the project (build gate 2, G2S-02).
      await writeConfined(folder, target, pdf);
      return target.fsPath;
    } catch (err) {
      if (err instanceof WriteRefusedError) {
        log.warn(err.message);
        vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: ${err.message}`, 8000);
        return null;
      }
      if (attempt === 3) {
        log.warn(`could not write ${pdfRel}: ${String(err)}`);
        vscode.window.setStatusBarMessage(`${DISPLAY_NAME}: ${posix.basename(pdfRel)} is in use; the preview is up to date, the file on disk is not`, 8000);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  return null;
}

/** The log's problems in the Problems panel: our own diagnostics collection, by target. */
export class ProblemsPanel implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(COMMAND_PREFIX);
  private readonly diagnosedFiles = new Map<string, vscode.Uri[]>();

  /**
   * Replaces the problems of target `key` with `diagnostics` (paths relative to `folder`). A TeX error with
   * plain-words help (docs/DESIGN.md#help-for-new-users) shows the help on its own line, and the error's id as
   * the problem's code.
   */
  publish(key: string, folder: vscode.Uri, diagnostics: HelpedDiagnostic[]): void {
    for (const uri of this.diagnosedFiles.get(key) ?? []) {
      this.collection.delete(uri);
    }
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnostics) {
      const line = Math.max(0, d.line - 1);
      const diag = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        problemMessage(d),
        d.severity === 'error' ? vscode.DiagnosticSeverity.Error : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
      );
      diag.source = d.source;
      if (d.help) {
        diag.code = d.help.id;
      }
      const list = byFile.get(d.file) ?? [];
      list.push(diag);
      byFile.set(d.file, list);
    }
    const uris: vscode.Uri[] = [];
    for (const [file, list] of byFile) {
      const uri = vscode.Uri.joinPath(folder, ...file.split('/'));
      this.collection.set(uri, list);
      uris.push(uri);
    }
    this.diagnosedFiles.set(key, uris);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

export interface MissingNoticesOptions {
  extraInstalled: () => boolean;
  installExtraPackages: () => Promise<void>;
  addPackageFromFile: () => Promise<void>;
}

/** One notification per new set of missing files (the Problems panel has the details for each). */
export class MissingNotices {
  /** The missing files last announced for each target, so a notification is not repeated on every keystroke. */
  private readonly announced = new Map<string, string>();

  constructor(private readonly options: MissingNoticesOptions) {}

  /** The targets whose last compile missed something (compiled again when the installed packages change). */
  keys(): IterableIterator<string> {
    return this.announced.keys();
  }

  forget(key: string): void {
    this.announced.delete(key);
  }

  announce(target: Target, scan: ScanResult): void {
    const files = scan.missing.map((m) => m.file);
    const signature = [...files].sort().join(',');
    if (!signature) {
      this.announced.delete(target.key);
      return;
    }
    if (this.announced.get(target.key) === signature) {
      return;
    }
    this.announced.set(target.key, signature);
    const text =
      files.length === 1
        ? `${target.label}: ${missingMessage(scan.missing[0])}`
        : `${target.label}: ${files.length} files are not inside the installed packages: ${files.join(', ')}. The Problems panel says what to do for each.`;
    const install = 'Install Extra Packages';
    const add = 'Add a package from a file';
    // One missing package: its CTAN page, opened only through VS Code's own link prompt (docs/DESIGN.md#engine-and-data).
    const ctan = scan.missing.length === 1 && scan.missing[0].package ? 'Open its CTAN page' : undefined;
    const buttons = [...(scan.missing.some((m) => m.offer) && !this.options.extraInstalled() ? [install] : []), add, ...(ctan ? [ctan] : [])];
    void vscode.window.showWarningMessage(text, ...buttons).then((choice) => {
      if (choice === install) {
        void this.options.installExtraPackages();
      } else if (choice === add) {
        void this.options.addPackageFromFile();
      } else if (choice && choice === ctan) {
        void vscode.env.openExternal(vscode.Uri.parse(`https://ctan.org/pkg/${encodeURIComponent(scan.missing[0].package as string)}`));
      }
    });
  }
}
