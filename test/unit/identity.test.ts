// The extension's identity (docs/DESIGN.md#store-and-packaging): package.json and src/shared/identity.ts agree, every contributed
// command, setting, keybinding and menu entry uses the livemd2tex prefix, and no placeholder name is left.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { COMMAND_PREFIX, CORE_DATA_NAME, DISPLAY_NAME, EXTENSION_ID, EXTENSION_NAME, EXTRA_DATA_NAME, PUBLISHER, REPOSITORY_URL } from '../../src/shared/identity';
import { root } from '../support/helpers';

interface Pkg {
  name: string;
  displayName: string;
  publisher: string;
  author?: string;
  repository?: { url: string };
  contributes: {
    commands: { command: string; category?: string }[];
    configuration: { title: string; properties: Record<string, unknown> };
    keybindings?: { command: string; when?: string }[];
    menus?: Record<string, { command: string; when?: string }[]>;
  };
}

const pkgText = readFileSync(path.join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgText) as Pkg;

describe('identity: liveMd2Tex', () => {
  it('package.json and identity.ts name the same extension', () => {
    assert.equal(pkg.publisher, PUBLISHER);
    assert.equal(pkg.name, EXTENSION_NAME);
    assert.equal(pkg.displayName, DISPLAY_NAME);
    assert.equal(EXTENSION_ID, 'haberwooki.livemd2tex');
    assert.deepEqual([CORE_DATA_NAME, EXTRA_DATA_NAME], ['livemd2tex-core-data', 'livemd2tex-extra-data']);
    assert.equal(pkg.repository?.url, 'https://github.com/haberwooki/liveMd2Tex');
    assert.equal(REPOSITORY_URL, pkg.repository?.url);
  });

  it('every command, setting, keybinding and menu entry carries the prefix; command titles show the display name', () => {
    const prefix = `${COMMAND_PREFIX}.`;
    for (const c of pkg.contributes.commands) {
      assert.ok(c.command.startsWith(prefix), c.command);
      assert.equal(c.category, DISPLAY_NAME, c.command);
    }
    for (const key of Object.keys(pkg.contributes.configuration.properties)) {
      assert.ok(key.startsWith(prefix), key);
    }
    assert.equal(pkg.contributes.configuration.title, DISPLAY_NAME);
    for (const k of pkg.contributes.keybindings ?? []) {
      assert.ok(k.command.startsWith(prefix), k.command);
    }
    for (const entries of Object.values(pkg.contributes.menus ?? {})) {
      for (const e of entries) {
        assert.ok(e.command.startsWith(prefix), e.command);
      }
    }
  });

  it('no placeholder name is left in package.json', () => {
    assert.doesNotMatch(pkgText, /tbd|placeholder/i);
  });

  it('names the copyright holder chosen by the maintainer (2026-10-16)', () => {
    assert.equal(pkg.author, 'the liveMd2Tex authors');
  });
});
