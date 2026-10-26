// The documents the extension works on, in one place (build gate 1, G1E-18): a LaTeX file by its language or its
// .tex name, a Markdown file by its language or its .md or .markdown name.

import type * as vscode from 'vscode';

export function isTexDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'latex' || /\.tex$/i.test(doc.uri.path);
}

export function isMarkdownDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' || /\.(md|markdown)$/i.test(doc.uri.path);
}
