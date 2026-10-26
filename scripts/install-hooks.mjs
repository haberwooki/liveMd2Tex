#!/usr/bin/env node
// Installs the git hooks that run the private-marker scan before every commit (docs/DESIGN.md#store-and-packaging):
//   pre-commit  -> node scripts/marker-scan.mjs --staged
//   commit-msg  -> node scripts/marker-scan.mjs --commit-msg <file>
// The scan is Node; each hook is a two-line shim because git starts hooks through its own sh. The shim names
// the Node that ran this installer by its full path, so it works when Node is not on PATH. The hooks live in
// .git/hooks, which git never commits; run this once per clone: node scripts/install-hooks.mjs

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = path.join(root, '.git', 'hooks');
if (!existsSync(path.join(root, '.git'))) {
  console.error('No .git folder here; run git init first.');
  process.exit(1);
}
mkdirSync(hooksDir, { recursive: true });
const node = process.execPath.replace(/\\/g, '/');

const hooks = {
  'pre-commit': `#!/bin/sh\n# Installed by scripts/install-hooks.mjs: the private-marker scan of the staged files.\nexec "${node}" scripts/marker-scan.mjs --staged\n`,
  'commit-msg': `#!/bin/sh\n# Installed by scripts/install-hooks.mjs: the private-marker scan of the commit message.\nexec "${node}" scripts/marker-scan.mjs --commit-msg "$1"\n`,
};
for (const [name, body] of Object.entries(hooks)) {
  const file = path.join(hooksDir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  console.log(`installed .git/hooks/${name}`);
}
