// C0a in VS Code (docs/DESIGN.md#converter): the generated-LaTeX view follows the Markdown, Export LaTeX writes the
// .tex beside it and asks before overwriting uncommitted work (Git reader on workspace.fs, CRLF rule), the
// committed .tex can be read for the comparison, and the HTML view plugin stays off unless a folder config or
// the setting turns it on. Runs with the network and process stubs loaded; nothing may spawn or connect.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import * as vscode from 'vscode';
import type { MarkdownTestApi } from '../../src/extension/markdown/features';
import { activateExtension, ownAttempts, stubState } from './support';

const author = { name: 'Test Author', email: 'test@example.org', timestamp: 1760000000, timezoneOffset: 0 };

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 10000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value as T;
    }
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Markdown features (C0a) in VS Code', () => {
  let tmp: string;
  let api: MarkdownTestApi;
  let blockedBefore = 0;
  const notes = () => vscode.Uri.file(path.join(tmp, 'paper', 'notes.md'));

  before(async () => {
    blockedBefore = stubState().blocked.length;
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'livemd2tex-c0a-it-'));
    const dir = path.join(tmp, 'paper');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes.md'), '---\ntitle: Notes\n---\n# Results\n\nSee [@fig:a] and \\ref{x}.\n\n![Plot](fig.png){#fig:a}\n');
    await fsp.writeFile(path.join(dir, 'fig.png'), 'png');
    await fsp.writeFile(path.join(dir, 'fig.pdf'), 'pdf');
    await fsp.writeFile(path.join(dir, '.latexpreview.json'), JSON.stringify({ markdown: { exportName: 'build-{name}.tex', htmlView: true } }));
    await git.init({ fs, dir, defaultBranch: 'main' });
    api = (await activateExtension()).markdown;
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('converts with the folder config and the .pdf beside the .png', async () => {
    const result = await api.convert(notes());
    assert.match(result.latex, /\\mdincludegraphics\{fig\.pdf\}/);
    assert.match(result.latex, /See fig\.~\\ref\{fig:a\} and \\ref\{x\}\./);
    assert.equal(path.basename(result.exportUri.fsPath), 'build-notes.tex');
    assert.deepEqual(result.configProblems, []);
  });

  it('shows the generated LaTeX beside the Markdown and updates it as the Markdown changes', async () => {
    // The files before this one leave documents, previews and preview-mode tabs in the window. The Markdown file
    // opens pinned, in a window cleared of them: a preview-mode tab is replaced (and its document closed) by the
    // next editor that opens in its group, and the command reads the active editor.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const doc = await vscode.workspace.openTextDocument(notes());
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    // The command answers with the document it shows, so the test does not search the window for it.
    const view = await vscode.commands.executeCommand<vscode.TextDocument | undefined>('livemd2tex.showGeneratedLatex');
    assert.ok(view, `the command found no Markdown editor (active: ${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'})`);
    assert.equal(view.uri.toString(), api.generatedUri(notes()).toString());
    assert.match(view.getText(), /\\section\{Results\}\\label\{results\}/);
    assert.equal(view.languageId, 'latex');
    // The edit goes to the document, not to an editor that another tab might hide. The view's change is waited
    // for as an event, subscribed before the edit so it cannot be missed.
    const followed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === view.uri.toString() && e.document.getText().includes('Added \\hl{line}.')) {
          sub.dispose();
          resolve();
        }
      });
    });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(notes(), new vscode.Position(doc.lineCount - 1, 0), '\nAdded ==line==.\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await Promise.race([followed, new Promise((_, reject) => setTimeout(() => reject(new Error('the view did not follow the edit')), 10000))]);
  });

  it('exports the .tex beside the Markdown, and asks before overwriting uncommitted work', async () => {
    const target = path.join(tmp, 'paper', 'build-notes.tex');
    let asked = 0;
    const no = async () => {
      asked++;
      return false;
    };
    const first = await api.exportLatex(notes(), no);
    assert.equal(first.written, true);
    assert.equal(asked, 0, 'a new file needs no question');
    const exported = await fsp.readFile(target, 'utf8');
    assert.match(exported, /\\begin\{document\}/);

    // Not committed yet: overwriting would lose it, so the user is asked.
    assert.equal(await api.fileStatus(vscode.Uri.file(target)), 'new');
    assert.equal((await api.exportLatex(notes(), no)).written, false);
    assert.equal(asked, 1);

    // Committed and unchanged (CRLF on disk counts as unchanged): no question.
    const dir = path.join(tmp, 'paper');
    await git.add({ fs, dir, filepath: 'build-notes.tex' });
    await git.commit({ fs, dir, author, committer: author, message: 'export' });
    await fsp.writeFile(target, exported.replace(/\n/g, '\r\n'));
    assert.equal(await api.fileStatus(vscode.Uri.file(target)), 'unmodified');
    assert.equal((await api.exportLatex(notes(), no)).written, true);
    assert.equal(asked, 1);

    // Edited by hand after the commit: asked again.
    await fsp.writeFile(target, `${exported}% a hand edit\n`);
    assert.equal(await api.fileStatus(vscode.Uri.file(target)), 'modified');
    const declined = await api.exportLatex(notes(), no);
    assert.equal(declined.written, false);
    assert.equal(declined.status, 'modified');
    assert.equal((await api.exportLatex(notes(), async () => true)).written, true);
    assert.equal(await api.committedText(vscode.Uri.file(target)), exported);
  });

  it('opens the comparison with the committed .tex', async () => {
    await vscode.commands.executeCommand('livemd2tex.compareWithCommittedTex', notes());
    await waitFor('a diff editor', () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'livemd2tex-committed'),
    );
  });

  it('switches the HTML view plugin on only where a folder config or the setting asks', async () => {
    await waitFor('the folder config to switch the plugin on', () => api.htmlViewEnabled(notes()));
    // VS Code's preview parses with env.currentDocument undefined: the gate finds the open document by its text.
    const open = await vscode.workspace.openTextDocument(notes());
    assert.equal(api.htmlViewEnabled(notes(), open.getText()), true);
    assert.equal(api.htmlViewEnabled(notes(), `${open.getText()} (not this text)`), false);
    const elsewhere = vscode.Uri.file(path.join(tmp, 'other', 'readme.md'));
    await fsp.mkdir(path.join(tmp, 'other'));
    await fsp.writeFile(elsewhere.fsPath, '# Other\n');
    assert.equal(api.htmlViewEnabled(elsewhere), false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.htmlViewEnabled(elsewhere), false);
    const config = vscode.workspace.getConfiguration('livemd2tex');
    await config.update('markdown.htmlViewPlugin', true, vscode.ConfigurationTarget.Global);
    try {
      assert.equal(api.htmlViewEnabled(elsewhere), true);
    } finally {
      await config.update('markdown.htmlViewPlugin', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(api.htmlViewEnabled(elsewhere), false);
  });

  it('creates a folder config from a document', async () => {
    const readme = vscode.Uri.file(path.join(tmp, 'other', 'readme.md'));
    await vscode.commands.executeCommand('livemd2tex.createFolderConfig', readme);
    const written = JSON.parse(await fsp.readFile(path.join(tmp, 'other', '.latexpreview.json'), 'utf8'));
    assert.equal(written.markdown.citations, 'natbib');
    assert.equal(written.markdown.htmlView, false);
    assert.equal(written.markdown.exportName, '{name}.tex');
  });

  it('converts with a preset named by the folder config, choosing the mode by file name', async () => {
    const dir = path.join(tmp, 'preset-folder');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(path.join(__dirname, '..', '..', '..', 'examples', 'presets'), path.join(dir, 'presets'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.latexpreview.json'), JSON.stringify({ markdown: { preset: 'presets/two-column-paper/preset.json' } }));
    const source = path.join(__dirname, '..', '..', '..', 'test', 'converter', 'preset');
    // The example preset's paper mode takes paper.md (its entry), with methods.md as the appendix.
    await fsp.copyFile(path.join(source, 'manuscript.md'), path.join(dir, 'paper.md'));
    await fsp.copyFile(path.join(source, 'methods.md'), path.join(dir, 'methods.md'));
    const result = await api.convert(vscode.Uri.file(path.join(dir, 'paper.md')));
    assert.deepEqual(result.configProblems, []);
    assert.match(result.latex, /\\twocolumn\[\{%/);
    assert.match(result.latex, /\\section\*\{Methods\}/);
  });

  it('started no process and opened no connection', () => {
    const state = stubState();
    assert.deepEqual(
      ownAttempts(state, blockedBefore).map((b) => `${b.kind}: ${b.detail}`),
      [],
    );
  });
});
