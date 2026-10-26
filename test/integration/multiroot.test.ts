// M2-B in VS Code: two root documents in one folder (test/corpus/multiroot, in the test workspace). Each is its
// own document; "% !TEX root" is honoured; the preview follows the active editor; a change on disk to the
// shared refs.bib recompiles only the previewed document, and the other says its preview is out of date until it
// is shown again (build gate 3, G3E-03); a preview the user put in the source's own group stays behind the source
// when the user comes back to it (G3E-01).

import * as assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import type { CorpusProject } from '../support/corpusProjects';
import { CORPUS_LIST } from '../support/prepareV0Workspace';
import { activateExtension, engineStubArgs } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M2-B: several root documents in one folder', function () {
  this.timeout(240000);
  let api: TestApi;
  let folder = '';

  before(async function () {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!ws || !existsSync(path.join(ws, CORPUS_LIST)) || !api.engineAvailable()) {
      this.skip();
    }
    const projects = JSON.parse(readFileSync(path.join(ws as string, CORPUS_LIST), 'utf8')) as CorpusProject[];
    const paper = projects.find((p) => p.id === 'MR-paper');
    if (!paper) {
      this.skip();
    }
    folder = (paper as CorpusProject).folder;
    api.setEngineExecArgv(engineStubArgs);
  });

  const file = (rel: string) => vscode.Uri.file(path.join(folder, ...rel.split('/')));
  const show = async (rel: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(rel)), { viewColumn: vscode.ViewColumn.One });

  it('finds each file\'s root: its own \\documentclass, "% !TEX root", or the root that includes it', async () => {
    const key = (rel: string) => api.previewKeyFor(file(rel));
    assert.equal(await key('paper.tex'), file('paper.tex').toString());
    assert.equal(await key('notes.tex'), file('notes.tex').toString());
    assert.equal(await key('sections/shared.tex'), file('paper.tex').toString());
    assert.equal(await key('appendix.tex'), file('notes.tex').toString());
    assert.equal(await key('sections/detail.tex'), file('notes.tex').toString());
  });

  it('the preview follows the editor, and refs.bib changed on disk recompiles only the previewed document', async () => {
    await show('paper.tex');
    const paperDone = api.nextCompile(file('paper.tex').fsPath);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    assert.equal((await paperDone).ok, true);

    // Switching to the other root, with a preview showing: it is typeset and its preview shown.
    const notesDone = api.nextCompile(file('notes.tex').fsPath);
    await show('notes.tex');
    const notes = await Promise.race([notesDone, sleep(90000).then(() => undefined)]);
    assert.ok(notes?.ok, 'the preview did not follow the editor to notes.tex');

    // The shared bibliography changes on disk: both roots read it, only the previewed one (notes) compiles.
    const seen: CompileRecord[] = [];
    const before = api.compileRecords().length;
    const next = api.nextCompile(file('notes.tex').fsPath);
    appendFileSync(file('refs.bib').fsPath, '\n% Changed by the M2-B test.\n');
    await Promise.race([next, sleep(60000)]);
    await sleep(4000); // time for a second, wrong compile to show up
    seen.push(...api.compileRecords().slice(before));
    const roots = new Set(seen.filter((r) => !r.cancelled).map((r) => vscode.Uri.parse(r.root).fsPath.toLowerCase()));
    assert.ok(roots.has(file('notes.tex').fsPath.toLowerCase()), 'the previewed document did not compile');
    assert.ok(!roots.has(file('paper.tex').fsPath.toLowerCase()), 'the document that is not previewed compiled too');
  });

  it('the document left out of that compile says its preview is out of date, and catches up when it is shown (G3E-03)', async () => {
    const paper = file('paper.tex');
    // Other previews in this window can have the same title (the corpus has another paper.tex): ask by document.
    const title = () => api.previewState(paper.fsPath)?.title;
    assert.ok(title()?.endsWith('(out of date)'), `the skipped preview does not say it is out of date (${title()})`);
    const caught = api.nextCompile(paper.fsPath);
    await show('paper.tex');
    const record = await Promise.race([caught, sleep(90000).then(() => undefined)]);
    assert.ok(record?.ok, 'the skipped document did not compile when its preview was shown');
    assert.ok(!title()?.endsWith('(out of date)'), `the preview still says it is out of date (${title()})`);
  });

  it("a preview the user put in the source's group stays behind the source when the source's tab is clicked (G3E-01)", async () => {
    const paper = file('paper.tex');
    const state = () => api.previewState(paper.fsPath);
    const focusGroup = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
    if (!api.previewOpen(paper.fsPath)) {
      await show('paper.tex');
      const done = api.nextCompile(paper.fsPath);
      await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
      await done;
    }
    // The source in the first group; the preview follows it to the front of its own group, beside it.
    await show('paper.tex');
    await sleep(1000);
    const beside = state();
    assert.ok(beside?.visible && beside.viewColumn !== undefined && beside.viewColumn > vscode.ViewColumn.One, 'the preview is not in front beside the source');
    // The user drags the preview into the source's group, as a tab: it is in front there.
    await vscode.commands.executeCommand(`workbench.action.focus${focusGroup[beside.viewColumn]}EditorGroup`);
    await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
    await sleep(500);
    const first = () => vscode.window.tabGroups.all.find((g) => g.viewColumn === vscode.ViewColumn.One);
    const sourceInFront = () => {
      const front = first()?.activeTab;
      return front?.input instanceof vscode.TabInputText && front.input.uri.toString() === paper.toString();
    };
    assert.ok(state()?.viewColumn === vscode.ViewColumn.One && state()?.visible, 'the preview did not move into the source group');
    // The user clicks the source's tab: the source comes to the front, and the preview is now hidden behind it.
    await show('paper.tex');
    await sleep(1000);
    assert.ok(sourceInFront(), `the preview covered the source (in front: ${first()?.activeTab?.label})`);
    // The user works in another group, then clicks the source again: it stays in front.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file('refs.bib')), { viewColumn: vscode.ViewColumn.Two });
    await sleep(500);
    await show('paper.tex');
    await sleep(1500);
    assert.ok(sourceInFront() && !state()?.visible, `the preview covered the source when it came back to it (in front: ${first()?.activeTab?.label})`);
    api.closePreview(paper.fsPath);
  });
});
