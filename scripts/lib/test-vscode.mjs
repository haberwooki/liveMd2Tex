// Which VS Code the integration tests run in (build gate 1, G1E-20; docs/DESIGN.md#rules, #store-and-packaging).
//
// On the laptop: the VS Code that is already installed (scripts/lib/vscode-executable.mjs), and never a download.
// On CI: a VS Code that @vscode/test-cli downloads into .vscode-test/, in the version the workflow names (the
// floor test runs 1.105.0 and older versions; the other jobs run "stable"). Both conditions must hold for a
// download: GitHub's CI=true, and LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD=1, which only the workflows set. So a stray CI
// variable on the laptop does not turn downloads on.

import { findInstalledVsCode } from './vscode-executable.mjs';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ download: false, executable: string | undefined } | { download: true, version: string }}
 */
export function testVsCode(env = process.env) {
  if (env.CI === 'true' && env.LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD === '1') {
    return { download: true, version: env.LIVEMD2TEX_VSCODE_VERSION || 'stable' };
  }
  return { download: false, executable: findInstalledVsCode(env) };
}
