// Build gate 1 in VS Code, small documents in a gate1/ folder of the test workspace, removed afterwards:
// - a preview the user closed stays closed while typing compiles, until the compile command opens it (G1E-10);
// - two quick saves while the file watcher lags: the PDF next to the source holds the second text, and a change
//   by another program to an open, saved file compiles in "On save" mode (re-gate G1BE-01);
// - \input through a link that leads outside the workspace is refused by the extension's own file access
//   (re-gate G1B-S-02);
// - a PDF cut short is not written next to the source and does not replace the PDF in the preview;
// - an unsaved Latin-1 buffer reaches TeX in Latin-1, the document's own encoding (G1E-08).

import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import { removeLink } from '../support/helpers';
import { pdfText } from '../support/pdfText';
import { activateExtension, engineStubArgs } from './support';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms))]);
}

async function typeAtEnd(editor: vscode.TextEditor, text: string): Promise<void> {
  for (const ch of text) {
    const doc = editor.document;
    await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, ch));
    await sleep(60);
  }
}

describe('gate 1 in VS Code: previews, saves, links and encodings', function () {
  this.timeout(180000);
  let api: TestApi;
  let folder = '';

  before(async function () {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!ws || !api.engineAvailable()) {
      this.skip();
    }
    api.setEngineExecArgv(engineStubArgs);
    folder = path.join(ws as string, 'gate1');
    mkdirSync(folder, { recursive: true });
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', 'pause', vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', undefined, vscode.ConfigurationTarget.Global);
    if (folder && existsSync(folder)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('G1E-10: a preview the user closed does not come back at the next pause, only through the command', async () => {
    const main = path.join(folder, 'closing.tex');
    writeFileSync(main, '\\documentclass{article}\n\\begin{document}\nA preview that the user closes.\n\\end{document}\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    const first = api.nextCompile(main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    await withTimeout(first, 120000, 'first compile');
    assert.equal(api.previewOpen(main), true, 'the command did not open the preview');

    api.closePreview(main);
    await sleep(200);
    assert.equal(api.previewOpen(main), false);
    const live: Promise<CompileRecord> = api.nextCompile(main);
    await typeAtEnd(editor, '\n% typed');
    const record = await withTimeout(live, 60000, 'live compile');
    assert.ok(record.pdfBytes > 0, record.error);
    assert.equal(api.previewOpen(main), false, 'the preview came back at a pause in typing');

    const again = api.nextCompile(main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    await withTimeout(again, 60000, 'compile command');
    assert.equal(api.previewOpen(main), true, 'the compile command did not open the preview again');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('G1BE-01: two quick saves while the file watcher lags: the PDF next to the source holds the second text', async () => {
    const main = path.join(folder, 'twosaves.tex');
    const pdfPath = path.join(folder, 'twosaves.pdf');
    const body = (mark: string) => `\\documentclass{article}\n\\begin{document}\n${mark}\n\\end{document}\n`;
    writeFileSync(main, body('MARKZERO'));
    await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', 'save', vscode.ConfigurationTarget.Global);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
      // A first compile reads the file (and, before the fix, kept it in the read cache).
      const first = api.nextCompile(main);
      await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
      await withTimeout(first, 120000, 'first compile');
      await sleep(1500);
      // From now on, each watcher event comes 4 s late, as on a slow or remote file system.
      api.delayDiskEvents(4000);
      const replaceAll = (text: string) => editor.edit((b) => b.replace(new vscode.Range(0, 0, doc.lineCount, 0), text));
      for (const mark of ['MARKONE', 'MARKTWO']) {
        await replaceAll(body(mark));
        const saved = api.nextCompile(main);
        assert.ok(await doc.save());
        const record = await withTimeout(saved, 120000, `save compile (${mark})`);
        assert.ok(record.pdfWritten, `${mark}: no PDF written (${record.error ?? record.pdfNotWritten})`);
        const text = await pdfText(readFileSync(pdfPath));
        assert.match(text, new RegExp(mark), `${mark}: the PDF next to the source holds "${text.trim()}"`);
      }
      // Another program changes the open, saved file. In "On save" mode no edit compiles it; the watcher's event
      // does, because the disk now differs from what the last compile used.
      api.delayDiskEvents(0);
      const external = api.nextCompile(main);
      writeFileSync(main, body('MARKTHREE'));
      const record = await withTimeout(external, 60000, 'compile after the change on disk');
      assert.match(record.trigger, /file/);
      assert.ok(record.pdfBytes > 0);
    } finally {
      api.delayDiskEvents(0);
      await vscode.workspace.getConfiguration(COMMAND_PREFIX).update('compileOn', 'pause', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  it('G1B-S-02: the extension\'s own file access refuses \\input through a link that leads outside the workspace', async () => {
    const secret = 'OUTSIDE-TEXT-THROUGH-A-LINK';
    const outside = path.join(path.dirname(path.dirname(folder)), 'outside-for-links');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'key.tex'), `${secret}\n`);
    const project = path.join(folder, 'linkproj');
    mkdirSync(project, { recursive: true });
    const link = path.join(project, 'linkdir');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const main = path.join(project, 'main.tex');
    writeFileSync(main, '\\documentclass{article}\n\\begin{document}\nInside.\n\\input{linkdir/key}\n\\end{document}\n');
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
      const compiled = api.nextCompile(main);
      await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
      const record = await withTimeout(compiled, 120000, 'compile');
      assert.ok(!record.readFiles.some((f) => f.includes('linkdir')), record.readFiles.join(', '));
      const problems = vscode.languages.getDiagnostics(vscode.Uri.file(main)).map((d) => `${d.range.start.line + 1}: ${d.message}`);
      assert.ok(problems.some((p) => /^4: Not read: "linkdir\/key" is reached through a link that leads outside the project folder/.test(p)), problems.join('\n'));
      if (record.pdfWritten) {
        assert.doesNotMatch(await pdfText(readFileSync(record.pdfWritten)), new RegExp(secret));
      }
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      removeLink(link);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a PDF cut short is not written next to the source, and the preview keeps the last good PDF', async () => {
    const main = path.join(folder, 'cutshort.tex');
    const pdfPath = path.join(folder, 'cutshort.pdf');
    const good = '% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}\nA good page.\n\\end{document}\n';
    writeFileSync(main, good);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    const first = api.nextCompile(main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    const ok = await withTimeout(first, 120000, 'first compile');
    assert.ok(ok.pdfWritten, `no PDF written: ${ok.error ?? ok.pdfNotWritten}`);
    const goodBytes = readFileSync(pdfPath);

    // xdvipdfmx fails on a missing image and leaves a 15-byte PDF.
    await editor.edit((b) => b.insert(new vscode.Position(3, 0), '\\special{pdf:image (nofile.pdf)}\n'));
    const broken = api.nextCompile(main);
    assert.ok(await doc.save());
    const record = await withTimeout(broken, 60000, 'save compile');
    assert.equal(record.pdfBytes, 0, 'the cut-short PDF reached the compile loop');
    assert.equal(record.pdfWritten, null);
    assert.match(record.error ?? '', /cut short/);
    assert.ok(readFileSync(pdfPath).equals(goodBytes), 'the PDF next to the source changed');
    assert.equal(api.previewOpen(main), true, 'the preview closed');
    writeFileSync(main, good);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('G1E-08: an unsaved Latin-1 file is sent to TeX in Latin-1', async () => {
    const main = path.join(folder, 'latin1.tex');
    // pdfTeX compares the byte of "é" in the source with the byte E9. In Latin-1 they are equal; had the buffer
    // been sent as UTF-8, "é" would be the two bytes C3 A9 and the document would stop with an error.
    const text =
      '\\catcode"E9=12 \\catcode"C3=12 \\catcode"A9=12\n' +
      '\\ifnum\\pdfstrcmp{\u00e9}{^^e9}=0 \\message{LATIN1-BYTES-OK}\\else\\errmessage{the unsaved text did not arrive in Latin-1}\\fi\n' +
      '\\documentclass{article}\n\\begin{document}\nPlain text.\n\\end{document}\n';
    writeFileSync(main, Buffer.from(text, 'latin1'));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main), { encoding: 'iso88591' });
    assert.equal(doc.encoding, 'iso88591');
    assert.ok(doc.getText().includes('\u00e9'), 'the document did not open as Latin-1');
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    const first = api.nextCompile(main);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    const saved = await withTimeout(first, 120000, 'first compile');
    assert.equal(saved.errors, 0, 'the saved Latin-1 file did not compile cleanly');

    const live = api.nextCompile(main);
    await typeAtEnd(editor, '\n% \u00e9t\u00e9');
    assert.equal(editor.document.isDirty, true);
    const record = await withTimeout(live, 60000, 'live compile');
    assert.equal(record.trigger, 'edit');
    assert.equal(record.errors, 0, 'the unsaved Latin-1 text reached TeX in another encoding');
    assert.ok(record.pdfBytes > 0);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
});
