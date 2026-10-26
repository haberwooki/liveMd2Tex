// Build gate 1 in VS Code, through the real preview panel and webview:
//   - G1E-07: a click is answered from the SyncTeX data of the PDF it was on. A compile whose PDF the viewer
//     cannot show (here xdvipdfmx stops on a bad special, so its PDF is cut short) leaves the old PDF and its
//     data in place; once the viewer shows a newer PDF, a point on the old one finds no source rather than a
//     wrong one.
//   - G1E-22: a click on a web link in the PDF is stopped in the page and opened through VS Code
//     (env.openExternal, recorded here instead of opening a browser); a link of another kind is not opened.
// Each test writes its own small document into a new folder of the test workspace.

import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import { activateExtension, engineStubArgs } from './support';

const BS = '\\';

describe('build gate 1: SyncTeX data goes with its PDF, and links open through VS Code', function () {
  this.timeout(180000);
  let api: TestApi;
  let ws = '';

  before(async function () {
    api = await activateExtension();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder || !api.engineAvailable()) {
      this.skip();
    }
    ws = folder as string;
    api.setEngineExecArgv(engineStubArgs);
  });

  /** Writes `text` as main.tex in a new folder of the workspace, opens it and compiles it. */
  async function compileNew(name: string, text: string) {
    const folder = path.join(ws, name);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'main.tex');
    writeFileSync(file, text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    return { file, editor, record: await compileOpen(file) };
  }

  async function compileOpen(file: string) {
    const done = api.nextCompile(file);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    return done;
  }

  /** Replaces the editor's whole text (unsaved; the compile reads the open buffer). */
  async function replaceText(editor: vscode.TextEditor, text: string) {
    const doc = editor.document;
    await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), text));
  }

  const paragraphs = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} paragraph number ${i + 1}, with some words to fill the line.`).join('\n\n');
  const xetexDoc = (before: string, extra = '') =>
    `% !TEX program = xelatex\n${BS}documentclass{article}\n${BS}begin{document}\n${before}${paragraphs('Original', 30)}\n${extra}${BS}end{document}\n`;

  it('G1E-07: a point on the shown PDF is answered from that PDF\'s SyncTeX data, never from a newer one', async () => {
    const { file, editor, record } = await compileNew('sync-tags', xetexDoc(''));
    assert.equal(record.ok, true, record.error);
    const first = api.sync.lastUpdate;
    assert.ok(first, 'no SyncTeX data after the first compile');
    const panel = api.sync.panelOf(first.key);
    assert.ok(panel, 'no preview panel');
    assert.equal(panel.shownTag, first.tag, 'the viewer does not report the first PDF as shown');

    // A point in the middle of the view; the word and the text run are left out so the answer is SyncTeX's alone.
    const centre = await panel.centre();
    assert.ok(centre.point, 'no point at the view centre');
    assert.equal(centre.point.tag, first.tag, 'the viewer does not report which PDF the point is on');
    const point = { ...centre.point, word: undefined, context: undefined };
    const before = await api.sync.inverse(first.key, point);
    assert.ok(before, 'no source for the view centre');

    // Sixty new lines above, and a special that stops xdvipdfmx: the new PDF cannot be shown, its SyncTeX can be read.
    await replaceText(editor, xetexDoc(`${paragraphs('Inserted', 30)}\n\n`, `${BS}special{pdf:image (no-such-file.pdf)}\n`));
    await compileOpen(file);
    assert.equal(panel.shownTag, first.tag, 'the viewer should still show the first PDF');
    assert.ok(api.sync.keptTags(first.key).includes(first.tag), "the shown PDF's SyncTeX data was dropped");
    const again = await api.sync.inverse(first.key, point);
    assert.deepEqual(again && { file: again.file, line: again.line }, { file: before.file, line: before.line });

    // A good compile: the viewer shows it, and the first PDF's data goes.
    await replaceText(editor, xetexDoc(`${paragraphs('Inserted', 30)}\n\n`));
    const third = await compileOpen(file);
    assert.equal(third.ok, true, third.error);
    const latest = api.sync.lastUpdate;
    assert.ok(latest && latest.tag !== first.tag);
    assert.equal(panel.shownTag, latest.tag);
    assert.deepEqual(api.sync.keptTags(first.key), [latest.tag]);
    assert.equal(await api.sync.inverse(first.key, point), undefined, 'a point on a PDF no longer shown found a source');
    const now = await api.sync.inverse(first.key, { ...point, tag: latest.tag });
    assert.ok(now && now.line !== before.line, 'the new PDF should map the same point to another line');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('G1E-22: a web link in the PDF opens through VS Code; other links do not open', async () => {
    const opened: string[] = [];
    api.setLinkOpener(async (uri) => {
      opened.push(uri.toString(true));
      return true;
    });
    try {
      const url = 'https://example.invalid/livemd2tex-link-test?a=1';
      const doc = (target: string) =>
        `${BS}documentclass{article}\n${BS}usepackage{hyperref}\n${BS}begin{document}\nSee ${BS}href{${target}}{the test link} here.\n${BS}end{document}\n`;
      const { file, editor, record } = await compileNew('pdf-links', doc(url));
      assert.equal(record.ok, true, record.error);
      const update = api.sync.lastUpdate;
      assert.ok(update);
      const panel = api.sync.panelOf(update.key);
      assert.ok(panel);
      const clicked = await panel.clickLinkForTests();
      assert.equal(clicked.url, url);
      assert.equal(clicked.prevented, true, "the page did not stop the browser's own handling of the click");
      for (let i = 0; i < 50 && opened.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(opened, [url]);

      // pdf.js keeps ftp: links; the panel opens web and e-mail links only.
      await replaceText(editor, doc('ftp://example.invalid/file.txt'));
      const second = await compileOpen(file);
      assert.equal(second.ok, true, second.error);
      const ftp = await panel.clickLinkForTests();
      assert.equal(ftp.url, 'ftp://example.invalid/file.txt');
      assert.equal(ftp.prevented, true);
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(opened, [url], 'a link that is not a web or e-mail address was opened');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } finally {
      api.setLinkOpener((uri) => vscode.env.openExternal(uri));
    }
  });

  it('G1S-06 follow-up: a click on the contents list goes to the heading, on the bibliography to the .bib entry', async () => {
    const folder = path.join(ws, 'sync-lists');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'refs.bib'), '% CC0 test data\n@article{lattice1959,\n  author = {A. Author},\n  title = {Lattice},\n  journal = {J},\n  year = {1959}\n}\n');
    // The contents on page 1, the sections on page 2, the bibliography on page 3: a hit on page 1 that names a
    // heading line, or on page 3 that names refs.bib, came through the list lookup.
    const doc = [
      `${BS}documentclass{article}`,
      `${BS}begin{document}`,
      `${BS}tableofcontents`,
      `${BS}newpage`,
      `${BS}section{Thermal transport}`,
      `Text that cites ${BS}cite{lattice1959}.`,
      `${BS}section{Open questions}`,
      'More text.',
      `${BS}newpage`,
      `${BS}bibliographystyle{plain}`,
      `${BS}bibliography{refs}`,
      `${BS}end{document}`,
      '',
    ].join('\n');
    const { file, record } = await compileNew('sync-lists', doc);
    assert.equal(record.ok, true, record.error);
    // The lookup reads the auxiliary files the compile was given: those of the compile before.
    const second = await compileOpen(file);
    assert.equal(second.ok, true, second.error);
    const update = api.sync.lastUpdate;
    assert.ok(update);
    const found = new Map<number, { file: string; line: number }>();
    for (const page of [1, 3]) {
      for (let y = 60; y <= 400 && !found.has(page); y += 6) {
        const source = await api.sync.inverse(update.key, { page, x: 200, y, tag: update.tag });
        // Page 1: a contents entry, not the "Contents" title (line 3). Page 3: an entry, not the heading.
        if (source && (page === 1 ? /main\.tex$/.test(source.file) && [5, 7].includes(source.line) : /refs\.bib$/.test(source.file))) {
          found.set(page, source);
        }
      }
    }
    assert.deepEqual(found.get(1) && { file: path.posix.basename(found.get(1)?.file ?? ''), line: found.get(1)?.line }, { file: 'main.tex', line: 5 });
    assert.deepEqual(found.get(3) && { file: path.posix.basename(found.get(3)?.file ?? ''), line: found.get(3)?.line }, { file: 'refs.bib', line: 2 });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
