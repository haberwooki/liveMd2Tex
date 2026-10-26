#!/usr/bin/env node
// Development tool: packages the stand-in for the Extra Packages add-on (scripts/lib/extra-standin.mjs) as a
// VSIX, out/vsix/livemd2tex-extra-data-<version>-standin.vsix, for the "Install Extra Packages" test in a
// throwaway profile (docs/DESIGN.md#testing; the add-on is installed from a local VSIX until it is on a store). It is a
// data-only extension: no code, so the VSIX-wide scan has nothing to check but its file kinds. Never published.
//
//   node scripts/build-extra-standin.mjs

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STANDIN_VERSION, writeStandinFolder } from './lib/extra-standin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildExtraStandin() {
  const work = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-extra-standin-'));
  try {
    const { files } = writeStandinFolder(root, work);
    mkdirSync(path.join(root, 'out', 'vsix'), { recursive: true });
    const vsix = path.join(root, 'out', 'vsix', `livemd2tex-extra-data-${STANDIN_VERSION}-standin.vsix`);
    const vsce = await import('@vscode/vsce');
    await vsce.createVSIX({ cwd: work, packagePath: vsix, dependencies: false, allowMissingRepository: true });
    return { vsix, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { vsix, files } = await buildExtraStandin();
  console.log(`${path.relative(root, vsix)}: ${files} REVTeX files in one data image (data/extra.data)`);
}
