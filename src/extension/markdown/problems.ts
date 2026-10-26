// The converter's entries in the Problems panel (docs/DESIGN.md#converter): each unsupported construct as one plain
// warning on its Markdown line, and the notices (characters, fonts, the engine chosen) as information. One
// collection, shared by the Markdown views (features.ts) and the compile route (compile/runner.ts), so a
// Markdown file shows one set of converter problems whichever of them converted it last.

import * as vscode from 'vscode';
import type { Diagnostic as ConverterDiagnostic } from '../../converter/diagnostics';
import { COMMAND_PREFIX } from '../../shared/identity';

let collection: vscode.DiagnosticCollection | undefined;

/** The shared collection, created on first use. */
export function converterProblemCollection(): vscode.DiagnosticCollection {
  collection ??= vscode.languages.createDiagnosticCollection(`${COMMAND_PREFIX}.markdown`);
  return collection;
}

/** Disposes the collection (with the extension). */
export function disposeConverterProblems(): void {
  collection?.dispose();
  collection = undefined;
}

/** Shows a conversion's diagnostics for a Markdown file: each on each of its lines, at most 20 lines each. */
export function publishConverterProblems(uri: vscode.Uri, diagnostics: ConverterDiagnostic[]): void {
  const list: vscode.Diagnostic[] = [];
  for (const d of diagnostics) {
    for (const line of d.lines.slice(0, 20)) {
      const range = new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 1000);
      const diag = new vscode.Diagnostic(range, d.message, d.kind === 'notice' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      diag.source = 'Markdown to LaTeX';
      diag.code = d.code;
      list.push(diag);
    }
  }
  converterProblemCollection().set(uri, list);
}
