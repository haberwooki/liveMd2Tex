// Workspace Trust in VS Code (docs/DESIGN.md#confinement-and-trust; build gate 1, G1S-15). scripts/run-integration.mjs runs this file
// in a window of its own with Workspace Trust on and a workspace nobody trusted, so the window is in Restricted
// Mode (test-cli always passes --disable-workspace-trust, so this window is started without it). In the trusted
// windows of the other runs the file skips.
//
//   - Nothing compiles by itself: not on typing, not on save, not for a Markdown file whose front matter asks.
//   - The compile command asks first. A dismissal compiles nothing and the next command asks again; a yes
//     compiles and holds for the session, and typing still compiles nothing.
//   - The workspace cannot switch on the Markdown HTML view: neither its folder config nor its settings.json
//     (livemd2tex.markdown.htmlViewPlugin is a restricted configuration).

import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import { activateExtension, engineStubArgs } from '../integration/support';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BS = '\\';

describe('Restricted Mode (Workspace Trust) in VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let ws = '';

  before(async function () {
    api = await activateExtension();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (vscode.workspace.isTrusted || !folder) {
      this.skip(); // a trusted window: the other runs
    }
    ws = folder as string;
    api.setEngineExecArgv(engineStubArgs);
  });

  after(() => {
    api?.setRestrictedAnswer(null);
  });

  async function open(name: string, text: string): Promise<vscode.TextEditor> {
    const file = path.join(ws, name);
    writeFileSync(file, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  }

  async function type(editor: vscode.TextEditor, text: string) {
    for (const ch of text) {
      const doc = editor.document;
      await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, ch));
      await sleep(40);
    }
  }

  it('is a window in Restricted Mode, with the extension active', () => {
    assert.equal(vscode.workspace.isTrusted, false);
    assert.ok(api.engineAvailable(), 'the engine is not staged (node scripts/stage-engine.mjs --data)');
  });

  it('compiles nothing by itself: typing, saving, a Markdown file that asks for typesetting', async () => {
    const before = api.compileRecords().length;
    const tex = await open('paper.tex', `${BS}documentclass{article}\n${BS}begin{document}\nRestricted text.\n${BS}end{document}\n`);
    await type(tex, '\n% typed');
    await tex.document.save();
    const md = await open('notes.md', '---\ntitle: Notes\nlatex-preview: true\n---\n\nSome notes.\n');
    await type(md, '\nMore.');
    await md.document.save();
    await sleep(3000); // longer than the pause (1 s) and the save delay
    assert.equal(api.compileRecords().length, before, 'something compiled in Restricted Mode');
  });

  it('asks before a compile command: a dismissal compiles nothing, a yes compiles and holds', async () => {
    const editor = await open('asked.tex', `${BS}documentclass{article}\n${BS}begin{document}\nAsked first.\n${BS}end{document}\n`);
    const before = api.compileRecords().length;

    api.setRestrictedAnswer(undefined); // the user closes the question
    assert.equal(await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`), undefined);
    await sleep(1500);
    assert.equal(api.compileRecords().length, before, 'a dismissed question still compiled');

    api.setRestrictedAnswer('Compile');
    const record = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`)) as { ok: boolean; error?: string; pdfBytes: number } | undefined;
    assert.ok(record, 'the compile command did not compile after a yes');
    assert.equal(record.ok, true, record.error);
    assert.ok(record.pdfBytes > 0);

    // The yes holds for the session: no question this time (a dismissal would stop it if asked).
    api.setRestrictedAnswer(undefined);
    const again = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`)) as { ok: boolean } | undefined;
    assert.ok(again?.ok, 'the second command asked again or failed');

    // Typing still compiles nothing by itself.
    const count = api.compileRecords().length;
    await type(editor, '\n% more');
    await sleep(2500);
    assert.equal(api.compileRecords().length, count, 'typing compiled in Restricted Mode');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('lets the workspace switch on the Markdown HTML view neither by folder config nor by its settings', async () => {
    const folder = path.join(ws, 'html');
    mkdirSync(path.join(ws, '.vscode'), { recursive: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, '.latexpreview.json'), JSON.stringify({ markdown: { htmlView: true } }));
    writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'livemd2tex.markdown.htmlViewPlugin': true }));
    const md = path.join(folder, 'page.md');
    writeFileSync(md, '# Page\n\n<div align="center">Centred</div>\n');
    await sleep(1500); // the settings file and the folder config are read
    const uri = vscode.Uri.file(md);
    for (let k = 0; k < 3; k++) {
      assert.equal(api.markdown.htmlViewEnabled(uri), false);
      await sleep(300);
    }
    assert.equal(vscode.workspace.getConfiguration(COMMAND_PREFIX, uri).get<boolean>('markdown.htmlViewPlugin'), false);
  });
});
