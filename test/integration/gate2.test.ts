// Build gate 2 in VS Code: "Add a package from a file" with "Only for this project" writes through the
// extension's own confined write, so a folder reached through a link (a Windows junction here) that leads outside
// the workspace gets nothing (G2S-02), while a plain project folder gets the package. Files are made in a gate2/
// folder of the test workspace and beside the workspace, inside the throwaway profile, and removed afterwards.

import * as assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { removeLink } from '../support/helpers';
import { activateExtension } from './support';

/** Whether a path exists itself (a link whose target is gone counts). */
const lstatExists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('gate 2 in VS Code: writes into the project stay in it', function () {
  this.timeout(60000);
  let api: TestApi;
  let folder = '';
  let outside = '';
  let source = '';

  before(async function () {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    api = await activateExtension();
    if (!ws) {
      this.skip();
    }
    folder = path.join(ws as string, 'gate2');
    outside = path.join(path.dirname(ws as string), 'outside-for-writes');
    mkdirSync(folder, { recursive: true });
    mkdirSync(outside, { recursive: true });
    source = path.join(path.dirname(ws as string), 'gate2pkg.sty');
    writeFileSync(source, '\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesPackage{gate2pkg}[2026/10/16 test]\n\\endinput\n');
  });

  after(() => {
    const link = folder ? path.join(folder, 'linkdir') : '';
    if (link && lstatExists(link)) {
      removeLink(link);
    }
    for (const p of [folder, outside, source]) {
      if (p) {
        rmSync(p, { recursive: true, force: true });
      }
    }
  });

  it('G2S-02: a project folder reached through a junction gets nothing; a plain one gets the package', async () => {
    symlinkSync(outside, path.join(folder, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    const refused = await api.addPackageFiles([source], path.join(folder, 'linkdir'));
    assert.deepEqual(refused.packages, []);
    assert.deepEqual(readdirSync(outside), [], 'a file was written outside the workspace');
    const added = await api.addPackageFiles([source], folder);
    assert.deepEqual(added.packages, ['gate2pkg']);
    assert.ok(existsSync(path.join(folder, 'gate2pkg.sty')));
  });
});
