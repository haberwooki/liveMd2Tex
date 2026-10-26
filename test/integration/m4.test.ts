// M4 in VS Code (docs/DESIGN.md#help-for-new-users): "New document from template" makes a new folder with a free
// name, opens the main file and shows its PDF (LaTeX, Markdown, and the paper with the example preset); each of
// the 20 TeX error fixtures (test/fixtures/tex-errors/, CC0) shows its plain-words help in the Problems panel;
// the walkthrough opens. The new folders and the fixtures' copies go into the test workspace, which
// scripts/run-integration.mjs deletes afterwards.

import * as assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { HELP_IDS } from '../../src/extension/diagnostics/errorHelp';
import { vscodeFolderOps } from '../../src/extension/templates/newDocument';
import { COMMAND_PREFIX, EXTENSION_ID } from '../../src/shared/identity';
import { CORPUS_LIST } from '../support/prepareV0Workspace';
import { activateExtension, engineStubArgs, ownAttempts, root, stubState } from './support';

describe('M4: new documents, help for TeX errors, the walkthrough', function () {
  this.timeout(300000);
  let api: TestApi;
  let ws = '';

  before(async function () {
    ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    api = await activateExtension();
    if (!ws || !existsSync(path.join(ws, CORPUS_LIST)) || !api.engineAvailable()) {
      this.skip();
    }
    api.setEngineExecArgv(engineStubArgs);
  });

  // The tests open some 25 documents with their previews; close them, and let their compiles finish, so the next
  // test file starts in a quiet window.
  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise((r) => setTimeout(r, 2000));
  });

  /** Runs the command as the walkthrough's buttons do (a template id and a folder); waits for the main file's compile. */
  async function newDocument(id: string, parent: string, expectedMain: string) {
    const done = api.nextCompile(expectedMain);
    const main = await vscode.commands.executeCommand<vscode.Uri | undefined>(`${COMMAND_PREFIX}.newDocument`, id, vscode.Uri.file(parent));
    assert.ok(main, `${id}: the command returned no file`);
    assert.equal(main.fsPath.toLowerCase(), expectedMain.toLowerCase());
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase(), expectedMain.toLowerCase(), `${id}: the main file is not open`);
    const record = await done;
    assert.equal(record.ok, true, `${id}: ${record.error ?? ''}`);
    assert.equal(record.errors, 0, `${id}: TeX errors`);
    return record;
  }

  it('makes a LaTeX article in a new folder, shows its PDF, and never reuses a folder', async () => {
    const parent = path.join(ws, 'm4-new');
    mkdirSync(parent, { recursive: true });
    const before = stubState().blocked.length;
    const first = await newDocument('tex-article', parent, path.join(parent, 'article', 'main.tex'));
    assert.ok(first.pdfWritten, 'no PDF next to main.tex');
    // A beginner's first document shows no problem at all: not even epstopdf's shell-escape note (no .eps here).
    const problems = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(parent, 'article', 'main.tex')));
    assert.deepEqual(problems.map((d) => d.message), [], 'the new article shows problems');
    assert.ok(existsSync(path.join(parent, 'article', 'references.bib')));
    // Again: a second folder, the first left as it was.
    const text = readFileSync(path.join(parent, 'article', 'main.tex'), 'utf8');
    await newDocument('tex-article', parent, path.join(parent, 'article-2', 'main.tex'));
    assert.equal(readFileSync(path.join(parent, 'article', 'main.tex'), 'utf8'), text);
    assert.deepEqual(ownAttempts(stubState(), before).map((b) => `${b.kind}: ${b.detail}`), [], 'our code tried to start a process or connect');
  });

  it('makes a Markdown article that asks to be typeset, and shows its PDF', async () => {
    const parent = path.join(ws, 'm4-markdown');
    mkdirSync(parent, { recursive: true });
    const main = path.join(parent, 'article', 'article.md');
    const record = await newDocument('md-article', parent, main);
    assert.match(readFileSync(main, 'utf8'), /^---\r?\nlatex-preview: true\r?\n/);
    assert.ok(record.bibtexRan, 'the bibliography was not built');
  });

  it('makes the paper with the example preset: its folder config names the copied preset', async () => {
    const parent = path.join(ws, 'm4-preset');
    mkdirSync(parent, { recursive: true });
    const main = path.join(parent, 'paper', 'paper.md');
    await newDocument('md-preset-paper', parent, main);
    const config = JSON.parse(readFileSync(path.join(parent, 'paper', '.latexpreview.json'), 'utf8')) as { markdown: { preset: string } };
    assert.ok(existsSync(path.join(parent, 'paper', ...config.markdown.preset.split('/'))));
    // The preset's paper mode wrote the LaTeX: two columns.
    const conversion = await api.markdown.convert(vscode.Uri.file(main));
    assert.match(conversion.latex, /twocolumn/);
    assert.equal(conversion.appendixFile, 'methods.md');
  });

  it('shows the plain-words help of each of the 20 TeX errors in the Problems panel', async () => {
    const fixtures = path.join(root, 'test', 'fixtures', 'tex-errors');
    const folder = path.join(ws, 'm4-errors');
    mkdirSync(folder, { recursive: true });
    const files = readdirSync(fixtures).filter((f) => f.endsWith('.tex'));
    assert.equal(files.length, HELP_IDS.length);
    const shown: string[] = [];
    for (const file of files) {
      const id = file.replace(/^\d+-/, '').replace(/\.tex$/, '');
      const target = path.join(folder, file);
      copyFileSync(path.join(fixtures, file), target);
      const uri = vscode.Uri.file(target);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.One });
      const done = api.nextCompile(target);
      await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
      await done;
      const problems = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'TeX' && d.severity === vscode.DiagnosticSeverity.Error);
      const helped = problems.find((d) => d.code === id);
      assert.ok(helped, `${file}: no TeX error with the help "${id}" (${problems.map((d) => `${String(d.code)}: ${d.message}`).join(' | ')})`);
      const [message, help] = helped.message.split('\n');
      assert.ok(message.length > 0 && (help ?? '').length > 20, `${file}: the help is not on its own line: ${helped.message}`);
      shown.push(id);
    }
    assert.deepEqual(shown.sort(), [...HELP_IDS].sort());
    console.log(`      the help showed for ${shown.length} of ${HELP_IDS.length} errors`);
  });

  it("VS Code's file operations: a missing parent is 'missing', and a create-only write leaves a file as it was", async () => {
    const parent = path.join(ws, 'm4-ops');
    const ops = vscodeFolderOps(vscode.Uri.file(parent));
    assert.equal(await ops.listParent(), 'missing');
    mkdirSync(parent, { recursive: true });
    writeFileSync(path.join(parent, 'keep.tex'), 'mine');
    assert.deepEqual(await ops.listParent(), ['keep.tex']);
    assert.equal(await ops.exists('keep.tex'), true);
    assert.equal(await ops.exists('other.tex'), false);
    await assert.rejects(ops.createNew('keep.tex', new TextEncoder().encode('new')), /already exists/);
    assert.equal(readFileSync(path.join(parent, 'keep.tex'), 'utf8'), 'mine');
    await ops.createNew('new.tex', new TextEncoder().encode('new'));
    assert.equal(readFileSync(path.join(parent, 'new.tex'), 'utf8'), 'new');
  });

  it('two runs at once (as two API calls could start them) take two folders', async () => {
    const parent = path.join(ws, 'm4-together');
    mkdirSync(parent, { recursive: true });
    const made = await Promise.all(
      ['tex-article', 'md-article'].map((id) => vscode.commands.executeCommand<vscode.Uri | undefined>(`${COMMAND_PREFIX}.newDocument`, id, vscode.Uri.file(parent))),
    );
    const folders = made.map((uri) => path.basename(path.dirname(uri?.fsPath ?? '')));
    assert.deepEqual([...folders].sort(), ['article', 'article-2']);
    for (const folder of ['article', 'article-2']) {
      assert.ok(existsSync(path.join(parent, folder, 'references.bib')), `${folder} has no references.bib`);
    }
    assert.ok(existsSync(path.join(parent, folders[0], 'main.tex')) && existsSync(path.join(parent, folders[1], 'article.md')));
  });

  it('opens the walkthrough', async () => {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXTENSION_ID}#gettingStarted`, false);
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
