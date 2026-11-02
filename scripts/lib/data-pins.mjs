#!/usr/bin/env node
// The data packages' pins in engine/pins.json (the livemd2tex-core-data and livemd2tex-extra-data sources), and the
// one rule for using them (docs/DEVELOPING.md, "The TeX engine"):
// - Until both are pinned, CI has no TeX data for the engine: the engine tests (test/engine/support.ts), the VS Code
//   integration tests that compile (test/integration/, test/restricted/) and the test-copy scan
//   (.github/workflows/test-runner.yml) skip there with one notice that says so.
// - Once both are pinned, each package is taken from its pin, checked against the pinned size and SHA-256
//   (checkedDataPackage): scripts/engine-assets.mjs downloads it with the engine, scripts/stage-engine.mjs stages the
//   core data from it, and the engine tests and scripts/run-integration.mjs mount the add-on from it. A file of
//   another size or SHA-256 fails on any machine. A missing file skips on a laptop, and fails on CI (CI=true), so a
//   CI run never passes by skipping.
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/lib/data-pins.mjs    exit 0 when both data packages are pinned; otherwise print the notice (as a
//                                     GitHub ::notice:: line on CI) and exit 1

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The ids of the data packages' sources in engine/pins.json: the core data and the Extra Packages add-on. */
export const DATA_SOURCES = ['livemd2tex-core-data', 'livemd2tex-extra-data'];

/** The one line CI prints while the data packages are not both pinned. */
export const UNPINNED_NOTICE =
  'the data packages are not pinned yet (engine/pins.json does not pin both livemd2tex-core-data and livemd2tex-extra-data), so CI has no TeX data for the engine: the engine tests, the integration tests that compile and the test-copy scan skip until both are pinned';

/** Whether a parsed engine/pins.json pins both data packages. */
export function dataPinned(pins) {
  const sources = pins?.sources;
  return Array.isArray(sources) && DATA_SOURCES.every((id) => sources.some((s) => s.id === id));
}

/**
 * A pinned data package (`id`: livemd2tex-core-data or livemd2tex-extra-data), checked, for every user of a data pin:
 * - null when engine/pins.json does not pin `id`;
 * - { path, missing: true } when it is pinned but its .vsix is not at <assetsRoot>/<folder>/<name>, where
 *   scripts/engine-assets.mjs puts it: the caller skips, as for any missing input;
 * - { path, missing: false } when the file is there with the pinned size and SHA-256.
 * It throws when the pin names no .vsix in a folder, when the file is there with another size or SHA-256 (a stale or
 * broken download is a mistake, not a missing input), and when the file is missing on CI (env.CI === 'true') once
 * both data packages are pinned.
 * @returns {{ path: string, missing: boolean } | null}
 */
export function checkedDataPackage(pins, id, assetsRoot, env = process.env) {
  const source = pins?.sources?.find((s) => s.id === id);
  if (!source) return null;
  const pin = (source.files ?? []).find((f) => /\.vsix$/.test(f.name));
  if (!pin || !source.folder) throw new Error(`engine/pins.json's ${id} names no .vsix in a folder`);
  const file = path.join(assetsRoot, source.folder, pin.name);
  if (!existsSync(file)) {
    if (env.CI === 'true' && dataPinned(pins)) {
      throw new Error(`${pin.name}, the pinned ${id} package, is not downloaded: on CI that fails once both data packages are pinned (node scripts/engine-assets.mjs downloads it)`);
    }
    return { path: file, missing: true };
  }
  const size = statSync(file).size;
  if (size !== pin.size) {
    throw new Error(`${pin.name} has ${size} bytes, not the pinned ${pin.size}: run node scripts/engine-assets.mjs`);
  }
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== pin.sha256) {
    throw new Error(`${pin.name} is not the pinned file (SHA-256 ${pin.sha256}): run node scripts/engine-assets.mjs`);
  }
  return { path: file, missing: false };
}

/**
 * The Extra Packages add-on for the tests: the path LIVEMD2TEX_EXTRA_DATA names (a .vsix, or the data builder's
 * unpacked <out>/extra-data/ folder), else the pinned package (checkedDataPackage). Null when there is neither. A path
 * that names nothing throws on any machine, since a wrong path is a mistake, not a missing input; the pinned package
 * throws as checkedDataPackage says.
 * @returns {string | null}
 */
export function extraDataPackage(pins, assetsRoot, env = process.env) {
  const given = env.LIVEMD2TEX_EXTRA_DATA;
  if (given) {
    if (!existsSync(given)) throw new Error(`LIVEMD2TEX_EXTRA_DATA names nothing: ${given}`);
    return path.resolve(given);
  }
  const pinned = checkedDataPackage(pins, 'livemd2tex-extra-data', assetsRoot, env);
  return pinned && !pinned.missing ? pinned.path : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pinned = dataPinned(JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')));
  if (!pinned) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::notice::${UNPINNED_NOTICE}` : UNPINNED_NOTICE);
  process.exitCode = pinned ? 0 : 1;
}
