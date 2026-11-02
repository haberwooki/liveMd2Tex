// What a test does when the engine or its TeX data is missing (docs/DEVELOPING.md, "The TeX engine"): the engine
// tests, and the VS Code integration tests that compile. On a laptop it skips. On CI (CI=true) it skips with one
// notice while engine/pins.json does not pin both data packages (core-data and the Extra Packages add-on), since CI
// then has no TeX data for the engine; once both are pinned, a missing input fails the test, so a CI run never passes
// by skipping. scripts/lib/data-pins.mjs gives the same answer to the workflows.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { root } from './helpers';

/** The ids of the data packages' sources in engine/pins.json: the core data and the Extra Packages add-on. */
export const DATA_SOURCES = ['livemd2tex-core-data', 'livemd2tex-extra-data'];

/** The one line printed on CI while the data packages are not both pinned (the same as scripts/lib/data-pins.mjs's). */
export const UNPINNED_NOTICE =
  'the data packages are not pinned yet (engine/pins.json does not pin both livemd2tex-core-data and livemd2tex-extra-data), so CI has no TeX data for the engine: the engine tests, the integration tests that compile and the test-copy scan skip until both are pinned';

/** Whether a parsed engine/pins.json pins both data packages. */
export function dataPinned(pins: unknown = JSON.parse(readFileSync(path.join(root, 'engine', 'pins.json'), 'utf8'))): boolean {
  const sources = (pins as { sources?: { id?: string }[] } | null)?.sources;
  return Array.isArray(sources) && DATA_SOURCES.every((id) => sources.some((s) => s.id === id));
}

/** 'skip' on a laptop; on CI 'skip-unpinned' (with the notice) before both data pins, 'fail' after them. */
export function whenMissing(ci: boolean, pinned: boolean): 'skip' | 'skip-unpinned' | 'fail' {
  if (!ci) return 'skip';
  return pinned ? 'fail' : 'skip-unpinned';
}

let noticed = false;

/** For the unit test of the rule: the next skip on CI before the pins prints the notice again. */
export function forgetNotice(): void {
  noticed = false;
}

/**
 * The rule for a missing input, applied: throws on CI once both data packages are pinned (naming `what`), prints the
 * notice once on CI before that, and otherwise says nothing. The caller then skips.
 */
export function missingInput(what: string, env: NodeJS.ProcessEnv = process.env): void {
  const rule = whenMissing(env.CI === 'true', dataPinned());
  if (rule === 'fail') {
    throw new Error(`the tests need ${what}: on CI they fail rather than skip once the data packages are pinned`);
  }
  if (rule === 'skip-unpinned' && !noticed) {
    noticed = true;
    console.log(`      ${UNPINNED_NOTICE}`);
  }
}
