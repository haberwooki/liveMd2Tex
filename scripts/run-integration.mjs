#!/usr/bin/env node
// Runs the integration tests: builds dist/, stages the engine and the interim data into dist/ when the engine
// downloads are present (scripts/stage-engine.mjs), compiles the tests (and any private tests:
// scripts/private-tests.mjs), lays out the V0 test documents as the
// test window's workspace inside the throwaway profile folder (test/support/prepareV0Workspace.ts), runs
// @vscode/test-cli against the installed VS Code in that profile (on CI, the version the workflow names:
// scripts/lib/test-vscode.mjs), deletes the profile (and with it the copies of any private test files), and on the
// laptop confirms that no VS Code build was downloaded. A second VS Code window opens while the tests run.
// --with-latex-workshop also runs the coexistence tests beside LaTeX Workshop (M2-B). A third window runs the
// Restricted Mode test (Workspace Trust on; see runRestricted below).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testVsCode } from './lib/test-vscode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(args, env = process.env) {
  const started = Date.now();
  const r = spawnSync(node, args, { cwd: root, stdio: 'inherit', env });
  return { status: r.status ?? 1, seconds: (Date.now() - started) / 1000 };
}

if (run([path.join(root, 'scripts', 'build.mjs')]).status !== 0) {
  process.exit(1);
}
if (run([path.join(root, 'scripts', 'stage-engine.mjs'), '--data', '--if-present']).status !== 0) {
  process.exit(1);
}
if (run([path.join(root, 'scripts', 'clean-out.mjs')]).status !== 0) {
  process.exit(1);
}
if (run([path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']).status !== 0) {
  process.exit(1);
}
// Private integration tests, when .private-fixtures.json names a private test folder (docs/DESIGN.md#testing).
if (run([path.join(root, 'scripts', 'private-tests.mjs')]).status !== 0) {
  process.exit(1);
}

// While VS Code installs an update in the background (Windows), it holds a "vscode-updating" lock and refuses
// to start any new window from that installation, the test window included, until the running VS Code is
// restarted. VS Code marks that state with an "updating_version" file beside its executable.
const choice = testVsCode();
const executable = choice.download ? undefined : choice.executable;
if (executable && existsSync(path.join(path.dirname(executable), 'updating_version'))) {
  console.error(
    'VS Code is installing an update and will not start a test window until it is restarted. ' +
      'Restart VS Code (or let it finish updating), then run the integration tests again.',
  );
  process.exit(3);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-test-'));
const env = { ...process.env, LIVEMD2TEX_TEST_PROFILE_DIR: profile };
const workspace = path.join(profile, 'workspace');
const prepare = await import(pathToFileURL(path.join(root, 'out', 'test', 'support', 'prepareV0Workspace.js')).href);
const projects = await prepare.prepareV0Workspace(workspace);
if (projects) {
  env.LIVEMD2TEX_TEST_WORKSPACE = workspace;
  console.log(`V0 workspace: ${projects.map((p) => p.id).join(', ')}`);
} else {
  console.log('V0 workspace: not prepared (no staged engine); the V0 tests will skip');
}
// M6: the stand-in Extra Packages add-on as a VSIX, which the test installs into the throwaway profile.
try {
  const { buildExtraStandin } = await import(pathToFileURL(path.join(root, 'scripts', 'build-extra-standin.mjs')).href);
  const { vsix } = await buildExtraStandin();
  env.LIVEMD2TEX_TEST_EXTRA_VSIX = vsix;
  console.log(`M6: stand-in add-on ${path.basename(vsix)}`);
} catch (err) {
  console.log(`M6: no stand-in add-on (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); its tests will skip`);
}
// M2-B: LaTeX Workshop beside ours (docs/DESIGN.md#confinement-and-trust). --with-latex-workshop installs its VSIX, a pinned
// development-only download kept outside the repository, into a second throwaway profile with VS Code's own
// command line, and adds the "coexistence" tests (.vscode-test.mjs). It is never installed anywhere else.
const LATEX_WORKSHOP = {
  file: path.join(root, '..', 'engine_assets', 'dev-only', 'latex-workshop-10.19.0', 'James-Yu.latex-workshop-10.19.0.vsix'),
  sha256: '0357aac484c272966bfcb4db113c4c94560b6fb3724fb5dd9e0a0c6dc77f7a89',
  source: 'https://open-vsx.org/api/James-Yu/latex-workshop/10.19.0/file/James-Yu.latex-workshop-10.19.0.vsix',
};
const args = process.argv.slice(2).filter((a) => a !== '--with-latex-workshop');
if (process.argv.includes('--with-latex-workshop')) {
  if (!existsSync(LATEX_WORKSHOP.file) || createHash('sha256').update(readFileSync(LATEX_WORKSHOP.file)).digest('hex') !== LATEX_WORKSHOP.sha256) {
    console.error(`LaTeX Workshop's VSIX is missing or not the pinned file: ${LATEX_WORKSHOP.file} (from ${LATEX_WORKSHOP.source}).`);
    process.exit(1);
  }
  const coexist = path.join(profile, 'coexist');
  mkdirSync(path.join(coexist, 'extensions'), { recursive: true });
  const installDir = path.dirname(executable ?? '');
  const cli = [...readdirSync(installDir).map((d) => path.join(installDir, d, 'resources', 'app', 'out', 'cli.js')), path.join(installDir, 'resources', 'app', 'out', 'cli.js')].find((f) => existsSync(f));
  // No VSCODE_* variables: with them the command line would talk to the VS Code that is running.
  const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VSCODE_')));
  const installed = spawnSync(
    executable ?? '',
    [cli ?? '', '--install-extension', LATEX_WORKSHOP.file, '--extensions-dir', path.join(coexist, 'extensions'), '--user-data-dir', path.join(coexist, 'user-data')],
    { env: { ...cliEnv, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' },
  );
  if (!cli || installed.status !== 0) {
    console.error('LaTeX Workshop could not be installed into the throwaway profile.');
    process.exit(1);
  }
  env.LIVEMD2TEX_COEXIST_PROFILE_DIR = coexist;
}
const testCli = path.join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const result = run([testCli, ...args], env);

// Workspace Trust (docs/DESIGN.md#confinement-and-trust; build gate 1, G1S-15). test-cli always starts VS Code with
// --disable-workspace-trust, so the Restricted Mode test runs in a window this script starts itself, with the
// same throwaway-profile rules: Workspace Trust on and never prompting, a fresh workspace nobody trusted, and
// test-cli's own runner (runner.cjs) loading the stubs and out/test/restricted/*.test.js. A run with --grep is a
// targeted run and leaves it out.
function runRestricted(program) {
  const dir = path.join(profile, 'restricted');
  const userData = path.join(dir, 'user-data');
  const extensions = path.join(dir, 'extensions');
  const workspace = path.join(dir, 'workspace');
  for (const d of [path.join(userData, 'User'), extensions, workspace]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
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
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'never',
        'security.workspace.trust.banner': 'never',
        'security.workspace.trust.untrustedFiles': 'open',
        'security.workspace.trust.emptyWindow': false,
      },
      null,
      2,
    ),
  );
  const options = {
    mochaOpts: { ui: 'bdd', timeout: 180000 },
    files: readdirSync(path.join(root, 'out', 'test', 'restricted'))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join(root, 'out', 'test', 'restricted', f)),
    preload: [path.join(root, 'test', 'stubs', 'register-exthost.cjs')],
    colorDefault: false,
  };
  const builtins = ['json-language-features', 'typescript-language-features', 'html-language-features', 'css-language-features', 'markdown-language-features', 'git', 'github', 'npm'];
  const launch = [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--disable-extensions',
    ...builtins.flatMap((id) => ['--disable-extension', `vscode.${id}`]),
    '--disable-telemetry',
    '--disable-crash-reporter',
    `--extensionTestsPath=${path.join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'runner.cjs')}`,
    `--extensionDevelopmentPath=${root}`,
    workspace,
  ];
  // No ELECTRON_RUN_AS_NODE and no VSCODE_* variables: with them Code.exe would start as Node or talk to the
  // VS Code that is running.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && !k.startsWith('VSCODE_')));
  const started = Date.now();
  const r = spawnSync(program, launch, { cwd: root, stdio: 'inherit', env: { ...clean, VSCODE_TEST_OPTIONS: JSON.stringify(options) } });
  return { status: r.status ?? 1, seconds: (Date.now() - started) / 1000 };
}
// On CI the Restricted Mode window runs in the VS Code that test-cli has just downloaded (from its cache in
// .vscode-test/, so nothing is downloaded twice); on the laptop, in the installed one.
let restrictedProgram = executable;
if (!restrictedProgram && choice.download) {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  restrictedProgram = await downloadAndUnzipVSCode({ version: choice.version, cachePath: path.join(root, '.vscode-test') });
}
const restricted = args.includes('--grep') || args.includes('-g') || !restrictedProgram ? { status: 0, seconds: 0, skipped: true } : runRestricted(restrictedProgram);
console.log(`Restricted Mode run: ${restricted.skipped ? 'left out' : `exit ${restricted.status} after ${restricted.seconds.toFixed(1)} s`}`);
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

// On the laptop no VS Code build may be downloaded; on CI the workflow asked for one (G1E-20).
const cacheDir = path.join(root, '.vscode-test');
const downloaded = existsSync(cacheDir) && readdirSync(cacheDir).some((d) => /^vscode-/.test(d));
const forbidden = downloaded && !choice.download;
console.log(
  `integration tests: exit ${result.status} after ${result.seconds.toFixed(1)} s; throwaway profile deleted; ` +
    (choice.download
      ? `VS Code ${choice.version} downloaded by test-cli (CI).`
      : `${downloaded ? 'A VS CODE BUILD WAS DOWNLOADED into .vscode-test (this must not happen)' : 'no VS Code download'}.`),
);
process.exit(forbidden ? 1 : result.status || restricted.status);
