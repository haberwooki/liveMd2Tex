// M2-B in VS Code: a scripted keyboard path through every viewer command (docs/DESIGN.md#accessibility, #testing), with no
// mouse event: each command is run as its keybinding or the Command Palette runs it, and the viewer's state is
// read back. Then the High Contrast page colours under VS Code's own High Contrast theme, read from the first
// page's canvas as drawn (the exit criterion's "screenshot"), and jump to source. The colour mapping itself is a
// unit test (test/unit/pageColors.test.ts).

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { VIEWER_COMMANDS } from '../../src/extension/viewer/viewerCommands';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import type { ViewerCommand, ViewerState } from '../../src/shared/viewerProtocol';
import type { SourceLine } from '../../src/synctex/compose';
import type { CorpusProject } from '../support/corpusProjects';
import { CORPUS_LIST } from '../support/prepareV0Workspace';
import { activateExtension, engineStubArgs, root } from './support';

/** The darkest channel of a "#rrggbb" colour (0 to 255). */
const brightness = (hex: string) => Math.min(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));

const run = async (name: ViewerCommand) => (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.viewer.${name}`)) as ViewerState;

describe('M2-B: the viewer by keyboard', function () {
  this.timeout(180000);
  let api: TestApi;
  let projects: CorpusProject[] = [];

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!folder || !existsSync(path.join(folder, CORPUS_LIST)) || !api.engineAvailable()) {
      this.skip();
    }
    projects = JSON.parse(readFileSync(path.join(folder as string, CORPUS_LIST), 'utf8')) as CorpusProject[];
    api.setEngineExecArgv(engineStubArgs);
  });

  it('every viewer command has a key (while the preview has focus) or a Command Palette entry; F6 stays VS Code\'s', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { keybindings: { command: string; key: string }[]; menus: { commandPalette: { command: string; when?: string }[] } };
    };
    const ids = [...VIEWER_COMMANDS.map((n) => `${COMMAND_PREFIX}.viewer.${n}`), `${COMMAND_PREFIX}.syncFromPdfCentre`];
    for (const id of ids) {
      const keyed = manifest.contributes.keybindings.some((k) => k.command === id);
      const listed = manifest.contributes.menus.commandPalette.some((m) => m.command === id && m.when !== 'false');
      assert.ok(keyed || listed, `${id} has no key and no palette entry`);
    }
    assert.ok(!manifest.contributes.keybindings.some((k) => /(^|\s|\+)f6$/i.test(k.key)), 'F6 is VS Code\'s key for moving between its parts');
  });

  it('pages, zoom, fit, focus, theme colours and jump to source, all by command', async () => {
    const p = projects.find((x) => x.id === 'P2') ?? projects.find((x) => x.id === 'P1');
    assert.ok(p, 'no document');
    const uri = vscode.Uri.file(path.join(p.folder, p.main));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.One });
    const compiled = api.nextCompile(uri.fsPath);
    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.compile`);
    assert.equal((await compiled).ok, true);

    let s = await run('focus');
    assert.ok(s.focused === 'slotA' || s.focused === 'slotB', `the preview did not take focus (${s.focused})`);
    s = await run('fitWidth');
    assert.equal(s.location?.scale, 'page-width');
    assert.ok(s.pages >= 2, `${p.id} has ${s.pages} page(s)`);
    const first = s.location?.pageNumber ?? 0;
    s = await run('nextPage');
    assert.equal(s.location?.pageNumber, first + 1);
    s = await run('previousPage');
    assert.equal(s.location?.pageNumber, first);
    s = await run('zoomIn');
    const zoomed = Number(s.location?.scale);
    assert.ok(zoomed > 0, `zoom in gave scale ${s.location?.scale}`);
    s = await run('zoomOut');
    assert.ok(Number(s.location?.scale) < zoomed);
    s = await run('fitWidth');
    assert.equal(s.location?.scale, 'page-width');

    // Theme colours: nothing changes outside High Contrast; under it, the pages take the theme's colours.
    s = await run('toggleThemeColours');
    assert.equal(s.themeColours, true);
    assert.equal(s.highContrast, false);
    assert.equal(s.pageColors, null);
    // The page as drawn: the pages' own colours (a white page, dark ink).
    const key = await api.previewKeyFor(uri);
    const panel = key ? api.sync.panelOf(key) : undefined;
    assert.ok(panel, 'no preview panel');
    const plain = (await panel.state(true)).pixels;
    assert.ok(plain, 'no page canvas to read');
    assert.equal(plain.background, '#ffffff');
    // Dark ink: below half brightness. Linux draws thin glyphs at the fitted width in grey, never in black.
    assert.ok(brightness(plain.ink) < 0x80, `ink ${plain.ink} on the plain page`);
    const settings = vscode.workspace.getConfiguration('workbench');
    const theme = settings.inspect<string>('colorTheme')?.globalValue;
    await settings.update('colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global);
    try {
      const deadline = Date.now() + 20000;
      do {
        await new Promise((r) => setTimeout(r, 500));
        s = await run('fitWidth');
      } while (!(s.highContrast && s.pageColors) && Date.now() < deadline);
      assert.equal(s.highContrast, true, 'the viewer did not see the High Contrast theme');
      assert.deepEqual(s.pageColors, { background: '#000000', foreground: '#ffffff' });
      // The page as drawn takes the theme's colours: a black page, white ink.
      const contrast = (await panel.state(true)).pixels;
      assert.ok(contrast, 'no page canvas to read under High Contrast');
      assert.equal(contrast.background, '#000000');
      assert.ok(Math.max(...[1, 3, 5].map((i) => parseInt(contrast.ink.slice(i, i + 2), 16))) > 0x80, `ink ${contrast.ink} under High Contrast`);
      s = await run('toggleThemeColours');
      assert.equal(s.themeColours, false);
      assert.equal(s.pageColors, null);
    } finally {
      await settings.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    }

    const source = (await vscode.commands.executeCommand(`${COMMAND_PREFIX}.syncFromPdfCentre`)) as SourceLine | undefined;
    assert.ok(source, 'no source for the view centre');
    assert.equal(path.posix.basename(source.file), p.main);
  });
});
