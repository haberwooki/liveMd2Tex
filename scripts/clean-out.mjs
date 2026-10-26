#!/usr/bin/env node
// Removes tsc's output (out/src and out/test) before each compile, so that a test whose source was deleted or
// moved (for example into the private test overlay, docs/DESIGN.md#testing) cannot still run from a stale file in
// out/. tsc compiles everything here on each run (no incremental build), so this costs no time. out/private is
// emptied by scripts/private-tests.mjs; out/vsix (the stand-in add-on) is rebuilt by the integration runner.

import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['src', 'test']) {
  rmSync(path.join(root, 'out', dir), { recursive: true, force: true });
}
