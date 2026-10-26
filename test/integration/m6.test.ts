// M6 in VS Code (docs/DESIGN.md#testing): a corpus document with a missing class (P2, the REVTeX sample,
// without the REVTeX files) is told what is missing before it compiles, then reaches a PDF through "Add a package
// from a file" (the CTAN ZIP, and a .dtx with its .ins built by docstrip) and through the Extra Packages route,
// with the stand-in add-on installed from a local VSIX into the throwaway profile. The compile command answers
// with its own compile, never an older one still running. Uses the V0 workspace and the stand-in VSIX that
// scripts/run-integration.mjs prepares; skips without them.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX, DISPLAY_NAME, EXTRA_DATA_NAME, PUBLISHER } from '../../src/shared/identity';
import type { CorpusProject } from '../support/corpusProjects';
import { activateExtension, engineStubArgs, ownAttempts, root, stubState } from './support';

const assets = path.resolve(root, '..', 'engine_assets');
const EXTRA_ID = `${PUBLISHER}.${EXTRA_DATA_NAME}`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms))]);
}

describe('M6: package help in VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let workspace = '';
  let p2: CorpusProject | undefined;
  let blockedBefore = 0;

  /** A copy of P2 without the REVTeX files, under `name` in the workspace. */
  function bareP2(name: string): string {
    const folder = path.join(workspace, name);
    mkdirSync(folder, { recursive: true });
    for (const f of readdirSync((p2 as CorpusProject).folder)) {
      if (!/\.(cls|rtx|sty|bst|pdf)$/i.test(f)) {
        cpSync(path.join((p2 as CorpusProject).folder, f), path.join(folder, f));
      }
    }
    return path.join(folder, 'apssamp.tex');
  }

  /**
   * The compile command's own answer: the compile it asked for. (The next finished compile of the document can be
   * an older one. A document with no PDF yet keeps every compile, and the preview following the editor can start
   * one before the add-on is installed that ends after it.)
   */
  async function compile(main: string): Promise<CompileRecord> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const compiled = vscode.commands.executeCommand<CompileRecord | undefined>(`${COMMAND_PREFIX}.compile`);
    const record = await withTimeout(Promise.resolve(compiled), 120000, `compile of ${path.basename(main)}`);
    assert.ok(record, 'the compile command gave no answer');
    return record;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Waits until the compile of `main` is running. */
  async function running(main: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const key = api.runningCompile();
      if (key && vscode.Uri.parse(key).fsPath.toLowerCase() === main.toLowerCase()) {
        return;
      }
      assert.ok(Date.now() - started < 60000, `the compile of ${path.basename(main)} did not start`);
      await sleep(20);
    }
  }

  before(async function () {
    workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    api = await activateExtension();
    if (!workspace || !existsSync(path.join(workspace, 'v0-corpus.json')) || !api.engineAvailable()) {
      this.skip();
    }
    const projects = JSON.parse(readFileSync(path.join(workspace, 'v0-corpus.json'), 'utf8')) as CorpusProject[];
    p2 = projects.find((p) => p.id === 'P2');
    if (!p2) {
      this.skip();
    }
    api.setEngineExecArgv(engineStubArgs);
    blockedBefore = stubState().blocked.length;
  });

  it('P2 without REVTeX: the missing class is named before the compile, with the add-on offered', async () => {
    const main = bareP2('M6-P2-before');
    const record = await compile(main);
    assert.deepEqual(record.missingPackages, ['revtex4-2.cls']);
    const ours = vscode.languages.getDiagnostics(vscode.Uri.file(main)).filter((d) => d.source === DISPLAY_NAME);
    assert.equal(ours.length, 1);
    assert.match(ours[0].message, /"revtex4-2\.cls" \(class revtex\) is not inside the installed packages\. The Extra Packages add-on has it/);
    const classLine = readFileSync(main, 'utf8')
      .split(/\r?\n/)
      .findIndex((l) => l.startsWith('\\documentclass'));
    assert.equal(ours[0].range.start.line, classLine, 'not on the \\documentclass line');
  });

  it('"Add a package from a file" with the CTAN ZIP: the same document reaches a PDF', async function () {
    const zip = path.join(assets, 'ctan-revtex', 'revtex.tds.zip');
    if (!existsSync(zip)) {
      this.skip();
    }
    const main = bareP2('M6-P2-file');
    const added = await api.addPackageFiles([zip]);
    assert.deepEqual(added.packages, ['revtex']);
    const record = await compile(main);
    assert.deepEqual(record.missingPackages, []);
    assert.ok(record.pdfBytes > 0, record.error);
    console.log(`      P2 through the file command: ${record.passes} pass(es), PDF ${record.pdfBytes} bytes`);
  });

  it('a .dtx and .ins package from CTAN (tensor): built by docstrip on the bundled engine, then loaded', async function () {
    const dir = path.join(assets, 'ctan-tensor');
    if (!existsSync(path.join(dir, 'tensor.dtx'))) {
      this.skip();
    }
    const added = await api.addPackageFiles([path.join(dir, 'tensor.dtx'), path.join(dir, 'tensor.ins')]);
    assert.deepEqual(added.built, ['tensor.sty']);
    const folder = path.join(workspace, 'M6-tensor');
    mkdirSync(folder, { recursive: true });
    const main = path.join(folder, 'main.tex');
    writeFileSync(main, '\\documentclass{article}\n\\usepackage{tensor}\n\\begin{document}\n$\\tensor{T}{^a_b^c}$\n\\end{document}\n');
    const record = await compile(main);
    assert.deepEqual(record.missingPackages, []);
    assert.equal(record.errors, 0);
    assert.ok(record.pdfBytes > 0);
  });

  it('the compile command answers with its own compile, not with an older one still running', async () => {
    // A new document's compiles are never cancelled until it has shown a PDF, so the first one runs to its end
    // while the text changes and the command comes again. The second answer must be the second compile.
    const folder = path.join(workspace, 'M6-own-answer');
    mkdirSync(folder, { recursive: true });
    const main = path.join(folder, 'main.tex');
    writeFileSync(
      main,
      '\\documentclass{article}\n\\newcount\\slowcount\n\\begin{document}\n' +
        '\\loop\\advance\\slowcount by 1 \\ifnum\\slowcount<400000 \\repeat\nSlow.\\undefinedcommandforthistest\n\\end{document}\n',
    );
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(main));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const firstAnswer = Promise.resolve(vscode.commands.executeCommand<CompileRecord | undefined>(`${COMMAND_PREFIX}.compile`));
    await running(main);
    // Let it read the first text, then change the text while the engine works.
    await sleep(150);
    await editor.edit((b) => b.replace(new vscode.Range(0, 0, doc.lineCount, 0), '\\documentclass{article}\n\\begin{document}\nFixed.\n\\end{document}\n'));
    const key = api.runningCompile();
    assert.ok(key && vscode.Uri.parse(key).fsPath.toLowerCase() === main.toLowerCase(), 'the first compile ended too soon for this test');
    const secondAnswer = Promise.resolve(vscode.commands.executeCommand<CompileRecord | undefined>(`${COMMAND_PREFIX}.compile`));
    const first = await withTimeout(firstAnswer, 120000, 'the first answer');
    const second = await withTimeout(secondAnswer, 120000, 'the second answer');
    assert.ok(first && second);
    assert.ok(first.errors >= 1, 'the first compile read the first text');
    assert.ok(second.generation > first.generation, `the second answer is the first compile again (generation ${second.generation})`);
    assert.equal(second.errors, 0, 'the second answer did not read the changed text');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('the Extra Packages route: the button opens the Extensions view; with the stand-in add-on installed, P2 reaches a PDF', async function () {
    const vsix = process.env.LIVEMD2TEX_TEST_EXTRA_VSIX;
    if (!vsix || !existsSync(vsix)) {
      this.skip();
    }
    // The user folder from the previous test has REVTeX too; this test needs it to come from the add-on.
    await api.removeUserPackage('revtex');
    const before = await api.dataSets();
    assert.equal(before.extraInstalled, false);
    const main = bareP2('M6-P2-extra');
    assert.deepEqual((await compile(main)).missingPackages, ['revtex4-2.cls']);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.installExtraPackages`);
    // What the user does in the Extensions view, here from the local VSIX (the add-on is not on a store yet).
    const changed = new Promise<void>((resolve) => {
      const sub = vscode.extensions.onDidChange(() => {
        if (vscode.extensions.getExtension(EXTRA_ID)) {
          sub.dispose();
          resolve();
        }
      });
    });
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsix));
    await withTimeout(changed, 60000, 'the add-on to appear');
    const after = await api.dataSets();
    assert.equal(after.extraInstalled, true);
    assert.ok((after.sets[EXTRA_DATA_NAME] ?? 0) >= 1, JSON.stringify(after.sets));
    const record = await compile(main);
    assert.deepEqual(record.missingPackages, []);
    assert.ok(record.pdfBytes > 0, record.error);
    assert.deepEqual(ownAttempts(stubState(), blockedBefore), [], 'the extension tried to spawn or connect');
    console.log(`      P2 through the add-on: PDF ${record.pdfBytes} bytes; data sets ${JSON.stringify(after.sets)}`);
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', EXTRA_ID);
  });
});
