// M2-B: the LaTeX Workshop coexistence rules (docs/DESIGN.md#confinement-and-trust) and the Workspace Trust
// declaration, checked without VS Code: the offer with a fake extension host, and the manifest and sources
// against LaTeX Workshop 10.19.0's own keybindings and PDF editor (test/unit/fixtures, data only).

import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { chords, keysCollide, offerAutoBuildOff, OFFER_NO, OFFER_YES, type CoexistenceHost } from '../../src/extension/coexist/latexWorkshop';
import { COMMAND_PREFIX } from '../../src/shared/identity';
import { root } from '../support/helpers';

interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  activationEvents: string[];
  capabilities: { untrustedWorkspaces: { supported: string | boolean; restrictedConfigurations?: string[] } };
  contributes: Record<string, unknown> & {
    commands: { command: string }[];
    keybindings: Keybinding[];
    configuration: { properties: Record<string, { type: string; default?: unknown }> };
  };
};
const workshop = JSON.parse(readFileSync(path.join(root, 'test', 'unit', 'fixtures', 'latex-workshop-10.19.0.json'), 'utf8')) as {
  keybindings: Keybinding[];
  pdfCustomEditors: unknown[];
  commandPrefix: string;
};

/** A fake VS Code for the offer: LaTeX Workshop present or not, a workspace, its state, the user's answer. */
function fakeHost(options: { installed?: boolean; workspace?: boolean; autoBuild?: string; answer?: string }) {
  const calls: string[] = [];
  let offered = false;
  let autoBuild = options.autoBuild ?? 'onFileChange';
  const host: CoexistenceHost = {
    installed: () => options.installed ?? true,
    hasWorkspace: () => options.workspace ?? true,
    offered: () => offered,
    markOffered: async () => {
      offered = true;
      calls.push('mark');
    },
    autoBuild: () => autoBuild,
    ask: async () => {
      calls.push('ask');
      return options.answer;
    },
    turnOffAutoBuildInWorkspace: async () => {
      autoBuild = 'never';
      calls.push('write workspace setting');
    },
  };
  return { host, calls, autoBuild: () => autoBuild };
}

describe('M2-B: LaTeX Workshop coexistence', () => {
  it('offers once per workspace to turn its auto-build off, and writes the setting only after a yes', async () => {
    const yes = fakeHost({ answer: OFFER_YES });
    assert.equal(await offerAutoBuildOff(yes.host), 'turned-off');
    assert.deepEqual(yes.calls, ['mark', 'ask', 'write workspace setting']);
    assert.equal(yes.autoBuild(), 'never');
    assert.equal(await offerAutoBuildOff(yes.host), 'already-offered');
    assert.equal(yes.calls.length, 3, 'asked twice');

    for (const answer of [OFFER_NO, undefined]) {
      const no = fakeHost({ answer });
      assert.equal(await offerAutoBuildOff(no.host), 'declined');
      assert.deepEqual(no.calls, ['mark', 'ask'], 'a setting changed without a yes');
      assert.equal(no.autoBuild(), 'onFileChange');
      assert.equal(await offerAutoBuildOff(no.host), 'already-offered', 'a dismissed question came back');
    }
  });

  it('says nothing when LaTeX Workshop is absent, no folder is open, or its auto-build is already off', async () => {
    for (const [options, outcome] of [
      [{ installed: false }, 'not-installed'],
      [{ workspace: false }, 'no-workspace'],
      [{ autoBuild: 'never' }, 'already-off'],
    ] as const) {
      const f = fakeHost(options);
      assert.equal(await offerAutoBuildOff(f.host), outcome);
      assert.deepEqual(f.calls, []);
    }
  });

  it('compares keybindings by chord, modifiers in any order, a single key against a chord it starts', () => {
    assert.deepEqual(chords('Ctrl+Alt+J'), ['alt+ctrl+j']);
    assert.equal(keysCollide('ctrl+alt+j', 'alt+ctrl+j'), true);
    assert.equal(keysCollide('ctrl+l', 'ctrl+l alt+m'), true);
    assert.equal(keysCollide('shift+alt+j', 'ctrl+alt+j'), false);
    assert.equal(keysCollide('ctrl+l ctrl+b', 'ctrl+l ctrl+i'), false);
  });

  it("avoids every one of LaTeX Workshop's keybindings (Windows/Linux and macOS keys)", () => {
    assert.ok(workshop.keybindings.length >= 40);
    const theirs = workshop.keybindings.flatMap((k) => [k.key, k.mac ?? k.key]);
    for (const ours of manifest.contributes.keybindings) {
      for (const key of [ours.key, ours.mac ?? ours.key]) {
        const hit = theirs.find((t) => keysCollide(key, t));
        assert.equal(hit, undefined, `${ours.command} on "${key}" collides with LaTeX Workshop's "${hit}"`);
      }
    }
  });

  it('registers no PDF custom editor and no activation on PDFs: our viewer is never the default for .pdf files', () => {
    assert.ok(workshop.pdfCustomEditors.length > 0, 'the fixture lost LaTeX Workshop\'s PDF editor');
    assert.equal(manifest.contributes.customEditors, undefined);
    assert.ok(!manifest.activationEvents.some((e) => /customEditor|pdf/i.test(e)), manifest.activationEvents.join(', '));
  });

  it('uses its own prefix for every command and setting, never LaTeX Workshop\'s', () => {
    const ids = [...manifest.contributes.commands.map((c) => c.command), ...Object.keys(manifest.contributes.configuration.properties)];
    for (const id of ids) {
      assert.ok(id.startsWith(`${COMMAND_PREFIX}.`), id);
      assert.ok(!id.startsWith(workshop.commandPrefix), id);
    }
  });

  it('reports problems in its own diagnostics collections, and its viewer has its own view type', () => {
    const names: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const file = path.join(dir, entry);
        if (statSync(file).isDirectory()) {
          walk(file);
        } else if (file.endsWith('.ts')) {
          for (const m of readFileSync(file, 'utf8').matchAll(/createDiagnosticCollection\(([^)]*)\)/g)) {
            names.push(m[1].trim());
          }
        }
      }
    };
    walk(path.join(root, 'src'));
    assert.ok(names.length >= 2, names.join(', '));
    for (const name of names) {
      assert.match(name, /^`?\$\{COMMAND_PREFIX\}|^COMMAND_PREFIX$/, `a diagnostics collection without our prefix: ${name}`);
    }
    assert.match(readFileSync(path.join(root, 'src', 'extension', 'viewer', 'previewPanel.ts'), 'utf8'), /createWebviewPanel\(\s*`\$\{COMMAND_PREFIX\}\.viewer`/);
  });
});

describe('M2-B: Workspace Trust', () => {
  it('declares limited support, and restricts every setting that names a file path', () => {
    const trust = manifest.capabilities.untrustedWorkspaces;
    assert.equal(trust.supported, 'limited');
    assert.ok(Array.isArray(trust.restrictedConfigurations), 'no restrictedConfigurations list');
    const restricted = new Set(trust.restrictedConfigurations);
    for (const [id, spec] of Object.entries(manifest.contributes.configuration.properties)) {
      const namesPath = spec.type === 'string' && (/(path|file|folder|dir|root)$/i.test(id) || (typeof spec.default === 'string' && /[\\/]/.test(spec.default)));
      if (namesPath) {
        assert.ok(restricted.has(id), `${id} names a file path but is not a restricted configuration`);
      }
    }
    for (const id of restricted) {
      assert.ok(id in manifest.contributes.configuration.properties, `${id} is restricted but is not a setting`);
    }
    // The workspace cannot switch on the Markdown HTML view (its own value of the setting is ignored).
    assert.ok(restricted.has('livemd2tex.markdown.htmlViewPlugin'));
  });
});
