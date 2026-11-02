// M6 in VS Code (docs/DESIGN.md#testing): a corpus document whose packages are in the Extra Packages add-on (P7:
// memoir and biblatex) is told what is missing before it compiles, then reaches a PDF through the Extra Packages
// route, with the add-on installed from its VSIX into the throwaway profile. "Add a package from a file" takes the
// CTAN ZIP (REVTeX, for P2 without its own copies) and a .dtx with its .ins built by docstrip. The compile command
// answers with its own compile, never an older one still running. Uses the V0 workspace and the add-on VSIX that
// scripts/run-integration.mjs prepares (LIVEMD2TEX_EXTRA_DATA); the add-on route skips without the add-on.

import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX, DISPLAY_NAME, EXTRA_DATA_NAME } from '../../src/shared/identity';
import type { CorpusProject } from '../support/corpusProjects';
import { missingInput } from '../support/missingData';
import { activateExtension, engineStubArgs, installAddOn, ownAttempts, root, stubState, uninstallAddOn } from './support';

const assets = path.resolve(root, '..', 'engine_assets');

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms))]);
}

describe('M6: package help in VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let workspace = '';
  let p2: CorpusProject | undefined;
  let p7: CorpusProject | undefined;
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
    if (!workspace || !existsSync(path.join(workspace, 'v0-corpus.json'))) {
      this.skip();
    }
    if (!api.engineAvailable()) {
      missingInput('the staged engine and core data (node scripts/stage-engine.mjs --data)');
      this.skip();
    }
    const projects = JSON.parse(readFileSync(path.join(workspace, 'v0-corpus.json'), 'utf8')) as CorpusProject[];
    p2 = projects.find((p) => p.id === 'P2');
    p7 = projects.find((p) => p.id === 'P7');
    if (!p2 || !p7) {
      this.skip();
    }
    await uninstallAddOn();
    api.setEngineExecArgv(engineStubArgs);
    blockedBefore = stubState().blocked.length;
  });

  /** A copy of P7 under `name` in the workspace, so each test compiles a document of its own. */
  function copyP7(name: string): string {
    const folder = path.join(workspace, name);
    cpSync((p7 as CorpusProject).folder, folder, { recursive: true });
    return path.join(folder, (p7 as CorpusProject).main);
  }

  it('P7 without the add-on: biblatex is named before the compile and memoir by TeX\'s "not found", each with the add-on', async () => {
    const main = copyP7('M6-P7-before');
    const record = await compile(main);
    // The document asks for biblatex; memoir is its own class's base class, which the scan does not read.
    assert.deepEqual(record.missingPackages, ['biblatex.sty']);
    const all = vscode.languages.getDiagnostics(vscode.Uri.file(main));
    const ours = all.filter((d) => d.source === DISPLAY_NAME);
    assert.equal(ours.length, 1);
    assert.match(ours[0].message, /"biblatex\.sty" \(package biblatex\) is not inside the installed packages\. The Extra Packages add-on has it/);
    const useLine = readFileSync(main, 'utf8')
      .split(/\r?\n/)
      .findIndex((l) => /\\usepackage(\[[^\]]*\])?\{biblatex\}/.test(l));
    assert.equal(ours[0].range.start.line, useLine, 'not on the \\usepackage line');
    // TeX's own "not found" names memoir and the add-on, in the project's files.
    const tex = Object.values(Object.fromEntries(vscode.languages.getDiagnostics().map(([uri, d]) => [uri.toString(), d]))).flat();
    assert.ok(tex.some((d) => d.source === 'TeX' && /memoir\.cls is in package memoir, in the Extra Packages add-on/.test(d.message)), tex.map((d) => d.message).join('\n'));
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

  it('the Extra Packages route: the button opens the Extensions view; with the add-on installed, P7 reaches a PDF', async function () {
    const vsix = process.env.LIVEMD2TEX_TEST_EXTRA_VSIX;
    if (!vsix || !existsSync(vsix)) {
      console.log('      no Extra Packages add-on given (LIVEMD2TEX_EXTRA_DATA, for scripts/run-integration.mjs); skipped');
      this.skip();
    }
    const before = await api.dataSets();
    assert.equal(before.extraInstalled, false);
    const main = copyP7('M6-P7-extra');
    assert.deepEqual((await compile(main)).missingPackages, ['biblatex.sty']);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.installExtraPackages`);
    // What the user does in the Extensions view, here from the local VSIX (the add-on is not on a store yet).
    assert.ok(await installAddOn());
    const after = await api.dataSets();
    assert.equal(after.extraInstalled, true);
    assert.ok((after.sets[EXTRA_DATA_NAME] ?? 0) >= 1, JSON.stringify(after.sets));
    const record = await compile(main);
    assert.deepEqual(record.missingPackages, []);
    assert.ok(record.pdfBytes > 0, record.error);
    assert.deepEqual(ownAttempts(stubState(), blockedBefore), [], 'the extension tried to spawn or connect');
    console.log(`      P7 through the add-on: PDF ${record.pdfBytes} bytes; data sets ${JSON.stringify(after.sets)}`);
    await uninstallAddOn();
  });
});
