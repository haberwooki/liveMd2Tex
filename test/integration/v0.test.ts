// V0 in VS Code (docs/DESIGN.md#testing): each test document is opened, edited and saved in the editor;
// the save compiles it with the engine inside the extension, the PDF appears beside the editor, lands next to
// the source, and the log's problems reach the Problems panel. The stubs are loaded in the extension host and
// in the engine host. scripts/run-integration.mjs prepares the workspace (test/support/prepareV0Workspace.ts)
// and opens it in the test window; without the staged engine and data these tests skip.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileRecord } from '../../src/extension/compile/controller';
import type { TestApi } from '../../src/extension/extension';
import type { CorpusProject } from '../support/corpusProjects';
import { activateExtension, engineStubArgs, ownAttempts, reportBlocked, stubState } from './support';

const CORPUS_LIST = 'v0-corpus.json';

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no result after ${ms} ms`)), ms))]);
}

/**
 * Opens the file, adds a comment line at its end (a real edit), and saves; resolves with the compile the save
 * starts. (Opening it may first make the preview follow the editor with a compile of its own, M2-B.)
 */
async function editAndSave(api: TestApi, file: string, rootFile: string): Promise<CompileRecord> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
  const compiled = api.nextCompile(rootFile, { accept: (r) => r.trigger.split('+').includes('save') });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  await editor.edit((b) => b.insert(end, `\n% saved by the V0 test at ${new Date().toISOString()}\n`));
  assert.ok(await doc.save(), `could not save ${path.basename(file)}`);
  return withTimeout(compiled, 110000, `compile of ${path.basename(rootFile)}`);
}

describe('V0: compile on save in VS Code', function () {
  this.timeout(120000);
  let api: TestApi;
  let projects: CorpusProject[] = [];
  const blockedBefore = { count: 0 };

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!folder || !existsSync(path.join(folder, CORPUS_LIST)) || !api.engineAvailable()) {
      console.log('      V0 workspace or engine not prepared (run through scripts/run-integration.mjs with the engine staged); skipped');
      this.skip();
    }
    projects = JSON.parse(readFileSync(path.join(folder as string, CORPUS_LIST), 'utf8')) as CorpusProject[];
    api.setEngineExecArgv(engineStubArgs);
    blockedBefore.count = stubState().blocked.length;
    reportBlocked('before the V0 tests');
  });

  after(() => {
    if (projects.length > 0) {
      reportBlocked('after the V0 tests');
    }
  });

  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'T1', 'T2', 'T3', 'T4', 'T5']) {
    it(`${id}: a save gives a PDF beside the editor and next to the source`, async function () {
      const project = projects.find((p) => p.id === id);
      if (!project) {
        this.skip();
      }
      const p = project as CorpusProject;
      const main = path.join(p.folder, p.main);
      const pdf = main.replace(/\.tex$/i, '.pdf');
      const before = existsSync(pdf) ? statSync(pdf).mtimeMs : 0;
      const record = await editAndSave(api, main, main);
      assert.equal(record.ok, true, `${id}: ${record.error ?? 'no PDF'}`);
      assert.equal(record.main, p.main);
      assert.ok(record.pdfWritten, `${id}: the PDF was not written next to the source`);
      assert.equal(path.resolve(record.pdfWritten).toLowerCase(), path.resolve(pdf).toLowerCase());
      assert.ok(statSync(pdf).mtimeMs > before && statSync(pdf).size === record.pdfBytes);
      assert.notEqual(record.saveToPreviewMs, null, `${id}: the viewer did not show the PDF`);
      assert.ok(record.engineStubs, 'the engine host runs without the stubs');
      assert.deepEqual(record.engineStubs.blocked, [], `${id}: the engine tried to spawn or connect`);
      assert.deepEqual(record.engineStubs.allowedForks, [], `${id}: the engine host started a process`);
      assert.deepEqual(ownAttempts(stubState(), blockedBefore.count), [], 'the extension tried to spawn or connect');
      console.log(
        `      ${id}: ${record.engine} (${record.engineReason}); ${record.passes} pass(es)${record.bibtexRan ? ' + bibtex8' : ''}; ` +
          `${record.errors} error(s); save to PDF ${record.saveToDoneMs} ms, save to preview ${record.saveToPreviewMs} ms ` +
          `[collect ${record.collectMs}, engine start ${record.engineStartMs}, worker ${record.workerMs}, TeX ${record.texMs}]`,
      );
    });
  }

  it('P1: a second save reuses the state (one pass, no bibtex8) and updates the viewer in place', async function () {
    const p = projects.find((x) => x.id === 'P1');
    if (!p) {
      this.skip();
    }
    const main = path.join((p as CorpusProject).folder, (p as CorpusProject).main);
    const record = await editAndSave(api, main, main);
    assert.equal(record.ok, true);
    assert.equal(record.bibtexRan, false);
    assert.equal(record.passes, 1);
    assert.equal(record.engineStartMs, 0, 'the engine host was started again');
    assert.notEqual(record.saveToPreviewMs, null);
    console.log(`      P1 second save: save to PDF ${record.saveToDoneMs} ms, save to preview ${record.saveToPreviewMs} ms`);
  });

  it('P2: the errors reach the Problems panel with their line, and the PDF is still made', async function () {
    const p = projects.find((x) => x.id === 'P2');
    if (!p) {
      this.skip();
    }
    const main = vscode.Uri.file(path.join((p as CorpusProject).folder, (p as CorpusProject).main));
    const errors = vscode.languages.getDiagnostics(main).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    // REVTeX's sample includes .eps figures, which need Ghostscript; the engine has none (S1 note).
    assert.ok(errors.length >= 1, 'no error in the Problems panel');
    assert.ok(errors.every((d) => d.range.start.line > 0 && /eps-converted-to\.pdf/.test(d.message)), errors.map((d) => d.message).join('\n'));
    assert.ok(existsSync(main.fsPath.replace(/\.tex$/i, '.pdf')));
  });

  describe('converted Markdown', () => {
    const md = (id: string) => {
      const p = projects.find((x) => x.id === id);
      return p ? { uri: vscode.Uri.file(path.join(p.folder, p.main)), folder: p.folder, main: p.main } : undefined;
    };
    const sourceOk = (record: CompileRecord, file: string) => {
      assert.equal(record.source, 'markdown');
      assert.equal(record.ok, true, record.error ?? 'no PDF');
      const pdf = file.replace(/\.md$/i, '.pdf');
      assert.equal(path.resolve(record.pdfWritten ?? '').toLowerCase(), path.resolve(pdf).toLowerCase());
      assert.ok(existsSync(pdf));
      assert.notEqual(record.saveToPreviewMs, null, 'the viewer did not show the PDF');
      assert.deepEqual(record.engineStubs?.blocked, []);
    };

    it('P9: a plain save of a Markdown file does not typeset it', async function () {
      const p = md('P9');
      if (!p) {
        this.skip();
      }
      const target = p as NonNullable<typeof p>;
      const count = api.compileRecords().length;
      const doc = await vscode.workspace.openTextDocument(target.uri);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      await editor.edit((b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, '\nOne more line.\n'));
      await doc.save();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.equal(api.compileRecords().length, count, 'a Markdown file was typeset without being asked');
    });

    it('P10: "Open LaTeX preview" typesets it, and later saves typeset it again', async function () {
      const p = md('P10');
      if (!p) {
        this.skip();
      }
      const target = p as NonNullable<typeof p>;
      const doc = await vscode.workspace.openTextDocument(target.uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      const first = api.nextCompile(target.uri.fsPath);
      await vscode.commands.executeCommand('livemd2tex.openLatexPreview');
      const record = await withTimeout(first, 110000, 'P10 command');
      sourceOk(record, target.uri.fsPath);
      assert.equal(record.bibtexRan, true);
      console.log(`      P10 (command): ${record.passes} pass(es) + bibtex8; command to preview ${record.saveToPreviewMs} ms`);
      const again = await editAndSave(api, target.uri.fsPath, target.uri.fsPath);
      sourceOk(again, target.uri.fsPath);
      console.log(`      P10 (save): ${again.passes} pass(es); save to preview ${again.saveToPreviewMs} ms`);
    });

    it('P17: "latex-preview: true" in the front matter typesets it on save', async function () {
      const p = md('P17');
      if (!p) {
        this.skip();
      }
      const target = p as NonNullable<typeof p>;
      const doc = await vscode.workspace.openTextDocument(target.uri);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      const compiled = api.nextCompile(target.uri.fsPath);
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'latex-preview: true\n'));
      await doc.save();
      const record = await withTimeout(compiled, 110000, 'P17 save');
      sourceOk(record, target.uri.fsPath);
      console.log(`      P17 (front matter): ${record.passes} pass(es); save to preview ${record.saveToPreviewMs} ms`);
    });

    it('P16: "latexPreview": true in the folder config typesets it on save', async function () {
      const p = md('P16');
      if (!p) {
        this.skip();
      }
      const target = p as NonNullable<typeof p>;
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(target.folder, '.latexpreview.json')),
        new TextEncoder().encode('{ "latexPreview": true }\n'),
      );
      const record = await editAndSave(api, target.uri.fsPath, target.uri.fsPath);
      sourceOk(record, target.uri.fsPath);
      console.log(`      P16 (folder config): ${record.passes} pass(es); save to preview ${record.saveToPreviewMs} ms`);
    });

    /** Opens a Markdown project's file and runs "Open LaTeX preview"; resolves with the compile record. */
    const openPreview = async (id: string) => {
      const p = md(id);
      if (!p) {
        return undefined;
      }
      const doc = await vscode.workspace.openTextDocument(p.uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      const compiled = api.nextCompile(p.uri.fsPath);
      await vscode.commands.executeCommand('livemd2tex.openLatexPreview');
      return { p, doc, record: await withTimeout(compiled, 110000, `${id} command`) };
    };

    it('P9 (M1): box drawing takes the XeTeX notes template; no TeX error, the engine notice on its line', async function () {
      const run = await openPreview('P9');
      if (!run) {
        this.skip();
      }
      const { p, record } = run as NonNullable<typeof run>;
      sourceOk(record, path.join(p.folder, p.main));
      assert.equal(record.engine, 'xelatex');
      const problems = vscode.languages.getDiagnostics(p.uri);
      assert.deepEqual(problems.filter((d) => d.source === 'TeX' && d.severity === vscode.DiagnosticSeverity.Error).map((d) => d.message), []);
      assert.ok(problems.some((d) => d.source === 'Markdown to LaTeX' && d.code === 'engine'), 'no notice of the engine chosen');
    });

    it('M1: one plain warning per unsupported construct in the Problems panel, on its line', async function () {
      const run = await openPreview('M1-unsupported');
      if (!run) {
        this.skip();
      }
      const { p, record } = run as NonNullable<typeof run>;
      assert.equal(record.ok, true);
      const warnings = vscode.languages
        .getDiagnostics(p.uri)
        .filter((d) => d.source === 'Markdown to LaTeX' && d.severity === vscode.DiagnosticSeverity.Warning)
        .map((d) => `${String(d.code)}@${d.range.start.line + 1}`)
        .sort();
      assert.deepEqual(warnings, ['div-class:sidebar@22', 'example-list@12', 'fancy-list@15', 'grid-table@28', 'grid-table@6', 'html:video@26', 'simple-table@19']);
      assert.deepEqual(vscode.languages.getDiagnostics(p.uri).filter((d) => d.source === 'TeX' && d.severity === vscode.DiagnosticSeverity.Error), []);
    });

    it('TeX problems are shown on Markdown lines', async function () {
      const run = await openPreview('M1-tex-error');
      if (!run) {
        this.skip();
      }
      const { p, record } = run as NonNullable<typeof run>;
      assert.equal(record.ok, true, 'no PDF despite the error');
      const tex = vscode.languages.getDiagnostics(p.uri).filter((d) => d.source === 'TeX' && d.severity === vscode.DiagnosticSeverity.Error);
      assert.ok(tex.length > 0, 'no TeX problem on the Markdown file');
      assert.ok(tex.every((d) => d.range.start.line === 6), `not on line 7: ${tex.map((d) => d.range.start.line + 1).join(', ')}`);
    });
  });

  it('a saved file that is included by another compiles its root document', async function () {
    const p = projects.find((x) => x.id === 'P7');
    if (!p) {
      this.skip();
    }
    const folder = (p as CorpusProject).folder;
    const record = await editAndSave(api, path.join(folder, 'chap1.tex'), path.join(folder, (p as CorpusProject).main));
    assert.equal(record.main, (p as CorpusProject).main);
    assert.equal(record.ok, true);
  });
});
