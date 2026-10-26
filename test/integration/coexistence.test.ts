// M2-B in VS Code with LaTeX Workshop installed (docs/DESIGN.md#confinement-and-trust). Runs only in the
// "coexistence" test profile, where scripts/run-integration.mjs --with-latex-workshop installs LaTeX Workshop's
// VSIX (a pinned, development-only download) into the throwaway extensions folder; skipped everywhere else.
// In that window the stubs allow LaTeX Workshop's own MathJax worker and its viewer's loopback server
// (test/stubs/coexist.cjs), so it activates.
// Its build attempts (it runs latexmk) are blocked by the extension-host stubs like any other process start,
// and recorded: a test sees it build on save beside ours.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AUTO_BUILD_KEY, AUTO_BUILD_SECTION, keysCollide, LATEX_WORKSHOP_ID, OFFER_YES } from '../../src/extension/coexist/latexWorkshop';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX, EXTENSION_ID } from '../../src/shared/identity';
import type { CorpusProject } from '../support/corpusProjects';
import { CORPUS_LIST } from '../support/prepareV0Workspace';
import { activateExtension, engineStubArgs, ownAttempts, stubState } from './support';

interface Keybinding {
  key: string;
  mac?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M2-B: beside LaTeX Workshop (its VSIX in the throwaway profile only)', function () {
  this.timeout(180000);
  let api: TestApi;
  let projects: CorpusProject[] = [];

  before(async function () {
    if (!vscode.extensions.getExtension(LATEX_WORKSHOP_ID)) {
      this.skip(); // the ordinary test profile: LaTeX Workshop is not installed
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!folder || !existsSync(path.join(folder, CORPUS_LIST)) || !api.engineAvailable()) {
      this.skip();
    }
    projects = JSON.parse(readFileSync(path.join(folder as string, CORPUS_LIST), 'utf8')) as CorpusProject[];
    api.setEngineExecArgv(engineStubArgs);
  });

  const p1 = () => {
    const p = projects.find((x) => x.id === 'P1') as CorpusProject;
    return vscode.Uri.file(path.join(p.folder, p.main));
  };

  it('detects it and offers once to turn its auto-build off for this workspace; the yes writes the workspace setting only', async () => {
    const settings = () => vscode.workspace.getConfiguration(AUTO_BUILD_SECTION).inspect<string>(AUTO_BUILD_KEY);
    assert.notEqual(settings()?.workspaceValue, 'never', 'the setting was changed before the offer');
    api.setLatexWorkshopAnswer(OFFER_YES);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p1()), { viewColumn: vscode.ViewColumn.One });
    const deadline = Date.now() + 15000;
    while (settings()?.workspaceValue !== 'never' && Date.now() < deadline) {
      await sleep(250);
    }
    assert.equal(settings()?.workspaceValue, 'never', 'the offer did not turn its auto-build off for the workspace');
    assert.equal(settings()?.globalValue, undefined, "the user's own setting was changed");
    api.setLatexWorkshopAnswer(null);
  });

  it('compiles and writes its PDF with LaTeX Workshop installed and active', async () => {
    // The stubs of this window allow LaTeX Workshop two things it needs to activate: the MathJax worker it forks,
    // and its PDF viewer's server on the loopback address (test/stubs/coexist.cjs). Everything else stays blocked.
    const workshop = vscode.extensions.getExtension(LATEX_WORKSHOP_ID);
    await workshop?.activate();
    assert.equal(workshop?.isActive, true, 'LaTeX Workshop did not activate');
    const forks = stubState().allowedForks.map((f) => f.target.replace(/\\/g, '/'));
    assert.ok(forks.some((f) => f.endsWith('/out/src/preview/mathjax/mathjax.js')), `LaTeX Workshop's MathJax worker was not started: ${forks.join(', ')}`);
    const listens = (stubState() as unknown as { allowedListens?: { caller: string; host: string }[] }).allowedListens ?? [];
    assert.ok(listens.every((l) => /latex-workshop/i.test(l.caller) && ['127.0.0.1', '::1'].includes(l.host)), JSON.stringify(listens));
    console.log(`      LaTeX Workshop 10.19.0: installed and active (its MathJax worker running; its viewer's server on ${listens.map((l) => l.host).join(', ') || 'no address'})`);
    const done = api.nextCompile(p1().fsPath);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    const record = await done;
    assert.equal(record.ok, true, record.error);
    assert.ok(record.pdfWritten, 'no PDF next to the source');
  });

  it('is not the editor for .pdf files: opening the PDF gives LaTeX Workshop\'s or VS Code\'s, never ours', async () => {
    const pdf = vscode.Uri.file(p1().fsPath.replace(/\.tex$/i, '.pdf'));
    assert.ok(existsSync(pdf.fsPath), 'no PDF to open');
    // LaTeX Workshop's PDF editor is the default for .pdf; the open is time-limited, since its viewer may wait.
    await Promise.race([vscode.commands.executeCommand('vscode.open', pdf), sleep(5000)]);
    await sleep(500);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const viewType = input instanceof vscode.TabInputCustom ? input.viewType : input instanceof vscode.TabInputWebview ? input.viewType : undefined;
    assert.ok(!viewType || !viewType.includes(`${COMMAND_PREFIX}.viewer`), `the PDF opened in our viewer (${viewType})`);
    console.log(`      the .pdf opened in: ${viewType ?? "VS Code's own editor"}`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it("shares no keybinding with the installed LaTeX Workshop (read from its own package.json)", () => {
    const theirs = (vscode.extensions.getExtension(LATEX_WORKSHOP_ID)?.packageJSON as { contributes: { keybindings: Keybinding[] } }).contributes.keybindings;
    const ours = (vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { contributes: { keybindings: Keybinding[] } }).contributes.keybindings;
    assert.ok(theirs.length > 0 && ours.length > 0);
    for (const o of ours) {
      for (const t of theirs) {
        for (const [a, b] of [
          [o.key, t.key],
          [o.mac ?? o.key, t.mac ?? t.key],
        ]) {
          assert.ok(!keysCollide(a, b), `our "${a}" collides with LaTeX Workshop's "${b}"`);
        }
      }
    }
  });

  it('both build on save while its auto-build is on; after the offer\'s setting only ours does', async () => {
    const settings = vscode.workspace.getConfiguration(AUTO_BUILD_SECTION);
    const state = stubState();
    const doc = await vscode.workspace.openTextDocument(p1());
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    const original = doc.getText();
    /**
     * Its build attempts since `from`: process starts from a step of its build recipe (out/src/compile/step.js).
     * On Windows its cross-spawn starts each program through cmd.exe, so the record names cmd.exe, not latexmk.
     */
    const theirBuilds = (from: number) =>
      state.blocked.slice(from).filter((b) => /latex-workshop/i.test(b.stack) && /[\\/]compile[\\/]step\.js/i.test(b.stack));
    const saveOnce = async (note: string) => {
      await editor.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), `\n% ${note}\n`));
      const done = api.nextCompile(p1().fsPath);
      await doc.save();
      const record = await done;
      assert.equal(record.ok, true, record.error);
      assert.ok(record.pdfWritten, `${note}: no PDF next to the source`);
    };
    try {
      // A user who said no to the offer, or turned its build back on: LaTeX Workshop builds on save too.
      await settings.update(AUTO_BUILD_KEY, 'onSave', vscode.ConfigurationTarget.Workspace);
      let from = state.blocked.length;
      await saveOnce('saved with both building');
      const deadline = Date.now() + 15000;
      while (theirBuilds(from).length === 0 && Date.now() < deadline) {
        await sleep(250);
      }
      const builds = theirBuilds(from);
      assert.ok(
        builds.length > 0,
        `LaTeX Workshop did not try to build on save; blocked since the save: ${state.blocked
          .slice(from)
          .map((b) => `${b.kind} ${b.detail} @ ${b.stack.split('\n').slice(2, 6).join(' | ')}`)
          .join(' ;; ')}`,
      );
      console.log(`      LaTeX Workshop's build on save (blocked by the stubs): ${[...new Set(builds.map((b) => `${b.kind} ${b.detail}`))].join('; ')}`);
      assert.deepEqual(ownAttempts(state, from).map((b) => `${b.kind}: ${b.detail}`), [], 'our code tried to start a process or connect');

      // The setting the offer writes: only ours builds.
      await settings.update(AUTO_BUILD_KEY, 'never', vscode.ConfigurationTarget.Workspace);
      from = state.blocked.length;
      await saveOnce('saved with its build off');
      await sleep(3000);
      assert.deepEqual(theirBuilds(from).map((b) => b.detail), [], 'LaTeX Workshop built although its auto-build is off');
      assert.deepEqual(ownAttempts(state, from).map((b) => `${b.kind}: ${b.detail}`), [], 'our code tried to start a process or connect');
    } finally {
      await settings.update(AUTO_BUILD_KEY, 'never', vscode.ConfigurationTarget.Workspace);
      await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original));
      await doc.save();
    }
  });
});
