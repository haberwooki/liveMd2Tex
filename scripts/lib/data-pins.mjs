#!/usr/bin/env node
// Whether engine/pins.json pins both data packages (the livemd2tex-core-data and livemd2tex-extra-data sources).
// Until both are pinned, CI has no TeX data for the engine: the engine tests (test/engine/support.ts), the VS Code
// integration tests that compile (test/integration/, test/restricted/) and the test-copy scan
// (.github/workflows/test-runner.yml) skip there with one notice that says so. Once both are pinned, a missing input
// fails them, as on CI it always should (docs/DEVELOPING.md, "The TeX engine").
//
// Ours (the liveMd2Tex authors), GPL-3.0-or-later.
//
//   node scripts/lib/data-pins.mjs    exit 0 when both data packages are pinned; otherwise print the notice (as a
//                                     GitHub ::notice:: line on CI) and exit 1

import { readFileSync } from 'node:fs';
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pinned = dataPinned(JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8')));
  if (!pinned) console.log(process.env.GITHUB_ACTIONS === 'true' ? `::notice::${UNPINNED_NOTICE}` : UNPINNED_NOTICE);
  process.exitCode = pinned ? 0 : 1;
}
