// M2-A in VS Code: SyncTeX both ways through the real preview panel and webview, on the V0 workspace (P1, a
// .tex paper, and P10, a Markdown paper). Forward search from the cursor scrolls the viewer and draws the
// highlight; "Go to the source of the PDF preview's centre" asks the viewer for the centre point and opens the
// source line. The Node-level accuracy checks (ten random clicks each way) are test/engine/synctex.test.ts.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import type { ViewerRevealed } from '../../src/shared/viewerProtocol';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import type { SourceLine } from '../../src/synctex/compose';
import type { CorpusProject } from '../support/corpusProjects';
import { CORPUS_LIST } from '../support/prepareV0Workspace';
import { activateExtension, engineStubArgs } from './support';

describe('M2-A: SyncTeX both ways in VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let projects: CorpusProject[] = [];

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!folder || !existsSync(path.join(folder, CORPUS_LIST)) || !api.engineAvailable()) {
      this.skip();
    }
    projects = JSON.parse(readFileSync(path.join(folder as string, CORPUS_LIST), 'utf8')) as CorpusProject[];
    api.setEngineExecArgv(engineStubArgs);
  });

  async function openAndCompile(id: string, command: string) {
    const p = projects.find((x) => x.id === id);
    assert.ok(p, `${id} is not in the workspace`);
    const uri = vscode.Uri.file(path.join(p.folder, p.main));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const compiled = api.nextCompile(uri.fsPath);
    await vscode.commands.executeCommand(command);
    const record = await compiled;
    assert.equal(record.ok, true, record.error);
    return { doc, editor };
  }

  async function forwardFrom(editor: vscode.TextEditor, text: string): Promise<ViewerRevealed> {
    const line = editor.document.getText().split(/\r?\n/).findIndex((l) => l.includes(text));
    assert.ok(line >= 0, `no line with "${text}"`);
    const col = editor.document.lineAt(line).text.indexOf(text);
    editor.selection = new vscode.Selection(line, col + 1, line, col + 1);
    const shown = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.syncToPdf`)) as ViewerRevealed | undefined;
    assert.ok(shown && shown.page >= 1, 'forward search showed no page');
    assert.ok(shown.boxes >= 1, 'no highlight drawn');
    return shown;
  }

  it('P1 (.tex): forward search highlights the line; the view centre goes back to the source', async () => {
    const { editor } = await openAndCompile('P1', `${COMMAND_PREFIX}.compile`);
    await forwardFrom(editor, 'ring-down');
    const source = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.syncFromPdfCentre`)) as SourceLine | undefined;
    assert.ok(source, 'no source for the view centre');
    // Source paths are relative to the project folder, the workspace folder.
    assert.equal(path.posix.basename(source.file), 'paper.tex');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, editor.document.uri.fsPath);
    assert.equal(api.sync.lastJump?.kind, 'inverse');
  });

  it('P10 (Markdown): forward search through the line map, and back to a Markdown line', async () => {
    const { editor } = await openAndCompile('P10', `${COMMAND_PREFIX}.openLatexPreview`);
    await forwardFrom(editor, 'Umklapp scattering');
    const source = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.syncFromPdfCentre`)) as SourceLine | undefined;
    assert.ok(source, 'no source for the view centre');
    assert.equal(path.posix.basename(source.file), 'P10-paper.md');
    assert.ok(source.line >= 1 && source.line <= editor.document.lineCount);
  });
});
