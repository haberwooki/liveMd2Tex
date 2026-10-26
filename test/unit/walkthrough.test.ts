// The getting-started walkthrough (package.json contributes.walkthroughs, walkthrough/*.md;
// docs/DESIGN.md#help-for-new-users): its five steps in the planned order, every page ships in the VSIX, every
// button runs a command the extension contributes (with a template the catalog has), each page's "Click **...**"
// is the label of its step's button, and the keys the pages name are the extension's own.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { TEMPLATES } from '../../src/extension/templates/catalog';
import { importScript, root } from '../support/helpers';

interface Step {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string };
  completionEvents?: string[];
}
interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings: { command: string; key: string }[];
    walkthroughs: { id: string; title: string; steps: Step[] }[];
  };
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const commands = new Set(pkg.contributes.commands.map((c) => c.command));

describe('the getting-started walkthrough', () => {
  const walkthrough = pkg.contributes.walkthroughs?.[0];

  it('has the five steps in order: a sample, the preview, Markdown, a missing package, LaTeX Workshop', () => {
    assert.ok(walkthrough);
    assert.equal(pkg.contributes.walkthroughs.length, 1);
    assert.deepEqual(
      walkthrough.steps.map((s) => s.id),
      ['openSample', 'seePreview', 'tryMarkdown', 'missingPackage', 'latexWorkshop'],
    );
  });

  it('ships every page in the VSIX', async () => {
    type Vsce = { listFiles(o: { cwd: string; packageManager: number }): Promise<string[]>; PackageManager: { None: number } };
    const vsce = await importScript<Vsce>('node_modules/@vscode/vsce/out/api.js');
    const listed = new Set((await vsce.listFiles({ cwd: root, packageManager: vsce.PackageManager.None })).map((f) => f.replace(/\\/g, '/')));
    for (const step of walkthrough.steps) {
      const page = step.media.markdown ?? '';
      assert.ok(existsSync(path.join(root, ...page.split('/'))), `${step.id}: ${page} is missing`);
      assert.ok(listed.has(page), `${step.id}: ${page} is not in the VSIX`);
    }
  });

  it('runs only contributed commands, with templates the catalog has; each page names its button', () => {
    const ids = new Set(TEMPLATES.map((t) => t.id));
    for (const step of walkthrough.steps) {
      const links = [...step.description.matchAll(/\[([^\]]+)\]\(command:([\w.]+)(?:\?([^)]*))?\)/g)];
      for (const [, , command, args] of links) {
        assert.ok(commands.has(command), `${step.id}: ${command} is not a contributed command`);
        if (args) {
          const parsed = JSON.parse(decodeURIComponent(args)) as unknown[];
          assert.ok(typeof parsed[0] === 'string' && ids.has(parsed[0]), `${step.id}: no template ${String(parsed[0])}`);
        }
      }
      for (const event of step.completionEvents ?? []) {
        const command = /^onCommand:(.+)$/.exec(event)?.[1];
        assert.ok(!command || commands.has(command), `${step.id}: ${event} names no contributed command`);
      }
      const page = readFileSync(path.join(root, ...(step.media.markdown ?? '').split('/')), 'utf8');
      const clicks = [...page.matchAll(/Click \*\*([^*]+)\*\*/g)].map((m) => m[1]).filter((label) => label !== 'Live');
      const labels = links.map((l) => l[1]);
      for (const label of clicks) {
        assert.ok(labels.includes(label), `${step.id}: the page says "Click ${label}", but the step's button is ${labels.join(', ') || 'missing'}`);
      }
    }
  });

  it('names the extension\'s own keys and commands', () => {
    const keys = new Set(pkg.contributes.keybindings.map((k) => k.key.toLowerCase()));
    const titles = new Set(pkg.contributes.commands.map((c) => c.title));
    const pages = walkthrough.steps.map((s) => readFileSync(path.join(root, ...(s.media.markdown ?? '').split('/')), 'utf8')).join('\n');
    for (const key of ['Shift+Alt+J', 'Alt+PageDown', 'Alt+PageUp', 'Ctrl+=', 'Ctrl+-']) {
      if (pages.includes(key)) {
        assert.ok(keys.has(key.toLowerCase()), `${key} is not one of the extension's keys`);
      }
    }
    for (const title of ['New document from template', 'Open LaTeX preview', 'Show generated LaTeX', 'Export LaTeX', 'Install Extra Packages', 'Add a package from a file']) {
      assert.ok(pages.includes(`**${title}**`), `the pages do not name "${title}"`);
      assert.ok(titles.has(title), `"${title}" is not a command title`);
    }
  });
});
