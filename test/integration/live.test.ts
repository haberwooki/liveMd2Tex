// M2-A in VS Code (docs/DESIGN.md#testing): typing in an editor compiles the unsaved text after a pause
// (a quick pass, no PDF written), the status bar switch turns that off, a file the last compile read changing on
// disk recompiles, and a reference outside the project folder is refused with a plain message in the Problems
// panel. Uses the V0 workspace that scripts/run-integration.mjs prepares; skips without it.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX, DISPLAY_NAME } from '../../src/shared/identity';
import type { CorpusProject } from '../support/corpusProjects';
import { responseFigure } from '../support/corpusProjects';
import { activateExtension, engineStubArgs, ownAttempts, stubState } from './support';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms))]);
}

/** Reverts the active editor to the saved text; the change compiles once more, which this waits for. */
async function revert(api: TestApi, main: string): Promise<void> {
  const settled = api.nextCompile(main);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await withTimeout(settled, 60000, 'compile after the revert');
}

async function type(editor: vscode.TextEditor, text: string, gapMs = 80): Promise<void> {
  for (const ch of text) {
    const doc = editor.document;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit((b) => b.insert(end, ch));
    await sleep(gapMs);
  }
}

describe('M2-A: live preview in VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let projects: CorpusProject[] = [];
  let p1: CorpusProject | undefined;
  let blockedBefore = 0;

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!folder || !existsSync(path.join(folder, 'v0-corpus.json')) || !api.engineAvailable()) {
      this.skip();
    }
    projects = JSON.parse(readFileSync(path.join(folder as string, 'v0-corpus.json'), 'utf8')) as CorpusProject[];
    p1 = projects.find((p) => p.id === 'P1');
    api.setEngineExecArgv(engineStubArgs);
    blockedBefore = stubState().blocked.length;
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', 'pause', vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', undefined, vscode.ConfigurationTarget.Global);
  });

  it('P1: a pause in typing compiles the unsaved text (a quick pass), shows it, and writes no PDF', async function () {
    if (!p1) {
      this.skip();
    }
    const main = path.join(p1.folder, p1.main);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    // A first compile (the command) gives the document its auxiliary state.
    const first = api.nextCompile(main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    await withTimeout(first, 120000, 'first compile');
    const pdf = main.replace(/\.tex$/i, '.pdf');
    const before = existsSync(pdf) ? readFileSync(pdf).length : 0;

    const compiled = api.nextCompile(main);
    await type(editor, '\n% typed live', 90);
    const record: CompileRecord = await withTimeout(compiled, 60000, 'live compile');
    assert.equal(record.trigger, 'edit');
    assert.equal(record.pass, 'quick');
    assert.equal(record.passes, 1);
    assert.equal(record.pdfWritten, null, 'a quick pass wrote the PDF');
    assert.ok(doc.isDirty, 'the document was saved');
    assert.notEqual(record.keystrokeToPreviewMs, null, 'the viewer did not show the PDF');
    assert.equal(existsSync(pdf) ? readFileSync(pdf).length : 0, before);
    assert.deepEqual(record.engineStubs?.blocked, []);
    console.log(`      P1 live: last keystroke to preview ${record.keystrokeToPreviewMs} ms (TeX ${record.texMs} ms, worker ${record.warmWorker ? 'warm' : `${record.workerMs} ms`})`);
    await revert(api, main);
  });

  it('typing again while a compile runs cancels it; the compile after the last pause holds every keystroke', async function () {
    if (!p1) {
      this.skip();
    }
    const main = path.join(p1.folder, p1.main);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const seen: CompileRecord[] = [];
    const count = api.compileRecords().length;
    await type(editor, '\n% a', 50);
    await sleep(1150); // the pause has started a compile
    await type(editor, 'bc', 50);
    const last = await withTimeout(api.nextCompile(main), 60000, 'compile after the last pause');
    seen.push(...api.compileRecords().slice(count));
    assert.ok(seen.some((r) => r.cancelled), `no compile was cancelled: ${seen.map((r) => `${r.generation}${r.cancelled ? 'x' : ''}`).join(' ')}`);
    assert.equal(last.cancelled, false);
    assert.equal(last.generation, Math.max(...seen.map((r) => r.generation)));
    await revert(api, main);
  });

  it('the status bar switch: "on save" ignores typing; saving still compiles', async function () {
    if (!p1) {
      this.skip();
    }
    const main = path.join(p1.folder, p1.main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.toggleLive`);
    assert.equal(vscode.workspace.getConfiguration(COMMAND_PREFIX).get('compileOn'), 'save');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const count = api.compileRecords().length;
    await type(editor, '\n% on save only', 40);
    await sleep(2500);
    assert.equal(api.compileRecords().length, count, 'typing compiled in "on save" mode');
    const saved = api.nextCompile(main);
    await doc.save();
    const record = await withTimeout(saved, 60000, 'save compile');
    assert.equal(record.trigger, 'save');
    assert.equal(record.pass, 'full');
    assert.ok(record.pdfWritten);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.toggleLive`);
    assert.equal(vscode.workspace.getConfiguration(COMMAND_PREFIX).get('compileOn'), 'pause');
  });

  it('a figure the last compile read changes on disk: a full pass follows', async function () {
    if (!p1) {
      this.skip();
    }
    const main = path.join(p1.folder, p1.main);
    // Close the text editors, so the change reaches the extension as a file change. The preview stays open: a
    // document with neither a preview nor an editor is forgotten and no longer compiles (build gate 1, G1E-12).
    assert.equal(api.previewOpen(main), true, 'P1 has no preview open');
    const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText);
    await vscode.window.tabGroups.close(textTabs);
    const compiled = api.nextCompile(main);
    writeFileSync(path.join(p1.folder, 'fig-response.pdf'), await responseFigure());
    const record = await withTimeout(compiled, 60000, 'compile after the figure changed');
    assert.equal(record.trigger, 'file');
    assert.equal(record.pass, 'full');
    // Read files are relative to the project folder (the workspace folder).
    assert.ok(record.readFiles.some((f) => f.endsWith('fig-response.pdf')), record.readFiles.join(', '));
  });

  it('confinement: \\input{../../.ssh/id_rsa} is refused with a plain message on its line', async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      this.skip();
    }
    const file = vscode.Uri.joinPath(folder as vscode.Uri, 'confine', 'main.tex');
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode('\\documentclass{article}\n\\begin{document}\nText.\n\\input{../../.ssh/id_rsa}\n\\end{document}\n'),
    );
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    const compiled = api.nextCompile(file.fsPath);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    await withTimeout(compiled, 60000, 'confinement compile');
    const refused = vscode.languages.getDiagnostics(file).filter((d) => d.source === DISPLAY_NAME);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].range.start.line, 3);
    assert.match(refused[0].message, /outside the project folder/);
    assert.deepEqual(ownAttempts(stubState(), blockedBefore), [], 'the extension tried to spawn or connect');
  });
});
