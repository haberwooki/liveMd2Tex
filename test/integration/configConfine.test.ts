// Build gate 1, G1S-03 and the config part of G1E-04, in VS Code: a folder config and a preset that name files
// outside the workspace folder (by "..", and through a link) get a warning on the Markdown file, and the outside
// text never reaches the generated LaTeX. The outside files are written next to the workspace, inside the
// throwaway test profile.

import * as assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension/extension';
import { activateExtension } from './support';

const SECRET = 'TOP-SECRET-TEXT-OUTSIDE-THE-WORKSPACE';

describe('build gate 1: config and preset paths stay in the workspace folder', function () {
  this.timeout(60000);
  let api: TestApi;
  let ws = '';
  let outside = '';

  before(async function () {
    api = await activateExtension();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      this.skip();
    }
    ws = folder as string;
    outside = path.join(path.dirname(ws), 'outside-the-workspace');
    mkdirSync(outside, { recursive: true });
    const preset = { name: 'outside', modes: { paper: { entry: 'paper.md', appendixEntry: 'appendix.md', appendix: { heading: 'Methods' } } } };
    writeFileSync(path.join(outside, 'preset.json'), JSON.stringify(preset));
    writeFileSync(path.join(outside, 'secret.md'), `${SECRET}\n`);
    writeFileSync(path.join(outside, 'appendix.md'), `${SECRET}\n`);
  });

  async function convert(folder: string) {
    const md = path.join(folder, 'paper.md');
    writeFileSync(md, '# Paper\n\nBody text.\n');
    const result = await api.markdown.convert(vscode.Uri.file(md));
    const refused = result.diagnostics.filter((d) => d.code === 'config-path');
    return { result, refused };
  }

  it('refuses a preset named with ".." outside the workspace folder', async () => {
    const folder = path.join(ws, 'confine-dotdot');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, '.latexpreview.json'), JSON.stringify({ markdown: { preset: '../../outside-the-workspace/preset.json' } }));
    const { result, refused } = await convert(folder);
    assert.equal(refused.length, 1, result.diagnostics.map((d) => d.message).join(' | '));
    assert.match(refused[0].message, /outside the project folder/);
    assert.doesNotMatch(result.latex, new RegExp(SECRET));
  });

  it("refuses a preset's appendix and preamble files outside the workspace folder", async () => {
    const folder = path.join(ws, 'confine-preset');
    mkdirSync(folder, { recursive: true });
    const preset = {
      name: 'inside',
      modes: { paper: { entry: 'paper.md', preambleFile: '../../outside-the-workspace/secret.md', appendixEntry: '../../outside-the-workspace/appendix.md', appendix: { heading: 'Methods' } } },
    };
    writeFileSync(path.join(folder, 'preset.json'), JSON.stringify(preset));
    writeFileSync(path.join(folder, '.latexpreview.json'), JSON.stringify({ markdown: { preset: 'preset.json' } }));
    const { result, refused } = await convert(folder);
    assert.equal(refused.length, 2, result.diagnostics.map((d) => d.message).join(' | '));
    assert.doesNotMatch(result.latex, new RegExp(SECRET));
  });

  it('refuses a folder config reached through a link, and never quotes a file that is not JSON (G1B-S-03)', async () => {
    const outsideConfig = path.join(path.dirname(ws), 'outside-config');
    mkdirSync(outsideConfig, { recursive: true });
    writeFileSync(path.join(outsideConfig, '.latexpreview.json'), 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ not json');
    const folder = path.join(ws, 'confine-config-link');
    mkdirSync(folder, { recursive: true });
    symlinkSync(outsideConfig, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const { result } = await convert(path.join(folder, 'linked'));
    assert.ok(!result.configUri?.path.includes('/linked/'), result.configUri?.path);
    assert.ok(result.configProblems.some((p) => /through a link/.test(p)), result.configProblems.join(' | '));
    assert.ok(!result.configProblems.some((p) => /ssh-rsa/.test(p)));
    // In the folder itself, a config that is not JSON is reported without its text.
    writeFileSync(path.join(folder, '.latexpreview.json'), 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ not json');
    const own = await convert(folder);
    assert.ok(own.result.configProblems.some((p) => /not valid JSON/.test(p)));
    assert.ok(!own.result.configProblems.some((p) => /ssh-rsa/.test(p)));
  });

  it('refuses a preset reached through a link that leads out of the workspace folder', async () => {
    const folder = path.join(ws, 'confine-link');
    mkdirSync(folder, { recursive: true });
    symlinkSync(outside, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(path.join(folder, '.latexpreview.json'), JSON.stringify({ markdown: { preset: 'linked/preset.json' } }));
    const { result, refused } = await convert(folder);
    assert.equal(refused.length, 1, result.diagnostics.map((d) => d.message).join(' | '));
    assert.match(refused[0].message, /through a link/);
    assert.doesNotMatch(result.latex, new RegExp(SECRET));
  });
});
