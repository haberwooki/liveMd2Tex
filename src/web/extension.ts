// Browser entry point (VS Code for the Web). Built on every build so that nothing Node-only creeps into the
// shared code, but not yet declared in package.json ("browser"): the web version comes after v1.0
// (docs/DESIGN.md#architecture). CI loads it once in @vscode/test-web from G0; the laptop only builds it.
// The converter is pure JavaScript, so "web lite" (v1.1) can show the generated LaTeX here too.

import * as vscode from 'vscode';
import { convertMarkdown } from '../converter/markdownToLatex';
import { COMMAND_PREFIX } from '../shared/identity';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.showGeneratedLatex`, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        void vscode.window.showWarningMessage('Open a Markdown file first.');
        return;
      }
      const { latex } = convertMarkdown(editor.document.getText());
      const doc = await vscode.workspace.openTextDocument({ language: 'latex', content: latex });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }),
    vscode.commands.registerCommand(`${COMMAND_PREFIX}.engineHostCheck`, () => {
      void vscode.window.showInformationMessage('The TeX engine is not available in the browser yet.');
    }),
  );
}

export function deactivate(): void {}
