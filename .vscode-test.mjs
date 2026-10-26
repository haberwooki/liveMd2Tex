// @vscode/test-cli configuration (docs/DESIGN.md#testing). On the laptop the integration tests run in the
// VS Code that is already installed, in a throwaway profile, and test-cli never downloads a VS Code build. On CI
// (CI=true and LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD=1, set only by the workflows) test-cli downloads the version
// in LIVEMD2TEX_VSCODE_VERSION (scripts/lib/test-vscode.mjs; build gate 1, G1E-20).
//
//   - useInstallation.fromPath: the installed VS Code (scripts/lib/vscode-executable.mjs), or an error; on CI,
//     version instead.
//   - skipExtensionDependencies: test-cli would otherwise download VS Code to install extensionDependencies.
//   - --user-data-dir and --extensions-dir: a fresh folder under the system temp folder (LIVEMD2TEX_TEST_PROFILE_DIR
//     when scripts/run-integration.mjs sets it, so it can delete the folder afterwards).
//   - a second configuration, "coexistence", only when scripts/run-integration.mjs --with-latex-workshop has put
//     LaTeX Workshop into a second throwaway profile (LIVEMD2TEX_COEXIST_PROFILE_DIR): extensions not disabled,
//     so LaTeX Workshop runs beside ours (M2-B, docs/DESIGN.md#confinement-and-trust). Its preload, written into
//     that profile, loads test/stubs/coexist.cjs: the same stubs, with LaTeX Workshop's own MathJax worker and
//     its viewer's loopback server allowed, so that it activates and builds on save beside ours.
//   - workspaceFolder: the V0 test documents, when scripts/run-integration.mjs prepared them (LIVEMD2TEX_TEST_WORKSPACE).
//   - files: the integration tests, and the private ones when .private-fixtures.json names a private test folder
//     (scripts/lib/private-tests.cjs).
//   - ELECTRON_RUN_AS_NODE and VSCODE_* are removed from the environment: when this runs from a terminal or
//     tool inside VS Code they are inherited, and Code.exe would then start as plain Node or talk to the
//     running window.

import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import privateTests from './scripts/lib/private-tests.cjs';
import { testVsCode } from './scripts/lib/test-vscode.mjs';

for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_') && key !== 'VSCODE_TEST_EXECUTABLE') {
    delete process.env[key];
  }
}

const choice = testVsCode();
if (!choice.download && !choice.executable) {
  throw new Error(
    'No installed VS Code was found. Set VSCODE_TEST_EXECUTABLE to its executable. This project never downloads VS Code outside CI.',
  );
}

const profile = process.env.LIVEMD2TEX_TEST_PROFILE_DIR ?? mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-test-'));
const userData = path.join(profile, 'user-data');
const extensions = path.join(profile, 'extensions');
mkdirSync(path.join(userData, 'User'), { recursive: true });
mkdirSync(extensions, { recursive: true });
// The test windows' own settings: no telemetry, no update or extension checks, no experiments.
function writeSettings(dir) {
  mkdirSync(path.join(dir, 'User'), { recursive: true });
  writeFileSync(
    path.join(dir, 'User', 'settings.json'),
    JSON.stringify(
      {
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'workbench.enableExperiments': false,
        'workbench.startupEditor': 'none',
        'npm.fetchOnlinePackageInfo': false,
        'json.schemaDownload.enable': false,
        'chat.disableAIFeatures': true,
        'security.workspace.trust.enabled': false,
      },
      null,
      2,
    ),
  );
}
writeSettings(userData);

const main = {
  label: 'integration',
  files: ['out/test/integration/**/*.test.js', ...privateTests.privateSpecs(['integration'])],
  ...(choice.download ? { version: choice.version } : { useInstallation: { fromPath: choice.executable } }),
  ...(process.env.LIVEMD2TEX_TEST_WORKSPACE ? { workspaceFolder: process.env.LIVEMD2TEX_TEST_WORKSPACE } : {}),
  skipExtensionDependencies: true,
  launchArgs: [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    // No --disable-extensions: the extensions folder is the throwaway profile's, empty except for what a test
    // installs there (M6 installs the stand-in Extra Packages add-on and needs it enabled). VS Code's built-in
    // extensions that start language servers or git are switched off one by one. The built-in JSON extension
    // still starts in VS Code 1.141 and tries to fork its language server; the extension-host stub blocks that
    // and the tests report it as VS Code's own attempt, not the extension's.
    ...['json-language-features', 'typescript-language-features', 'html-language-features', 'css-language-features', 'markdown-language-features', 'git', 'github', 'npm'].flatMap((id) => ['--disable-extension', `vscode.${id}`]),
    '--disable-telemetry',
    '--disable-crash-reporter',
  ],
  mocha: {
    ui: 'bdd',
    timeout: 120000,
    preload: ['./test/stubs/register-exthost.cjs'],
  },
};

const coexist = process.env.LIVEMD2TEX_COEXIST_PROFILE_DIR;
const configs = [main];
if (coexist) {
  writeSettings(path.join(coexist, 'user-data'));
  const workshop = readdirSync(path.join(coexist, 'extensions')).find((d) => d.toLowerCase().startsWith('james-yu.latex-workshop-'));
  if (!workshop) {
    throw new Error('LaTeX Workshop is not in the coexistence profile.');
  }
  const stubs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test', 'stubs', 'coexist.cjs');
  const preload = path.join(coexist, 'register-exthost-coexist.cjs');
  writeFileSync(preload, `require(${JSON.stringify(stubs)}).register(${JSON.stringify(path.join(coexist, 'extensions', workshop))});\n`);
  configs.push({
    ...main,
    label: 'coexistence',
    files: 'out/test/integration/coexistence.test.js',
    launchArgs: [
      `--user-data-dir=${path.join(coexist, 'user-data')}`,
      `--extensions-dir=${path.join(coexist, 'extensions')}`,
      // No --disable-extensions: LaTeX Workshop, the one extension in this folder, runs beside ours.
      ...['json-language-features', 'typescript-language-features', 'html-language-features', 'css-language-features', 'markdown-language-features', 'git', 'github', 'npm'].flatMap((id) => ['--disable-extension', `vscode.${id}`]),
      '--disable-telemetry',
      '--disable-crash-reporter',
    ],
    mocha: { ...main.mocha, preload: [preload] },
  });
}

export default defineConfig(configs);
