// ESLint rules (docs/DESIGN.md#testing, #rules):
//   - child_process only in src/extension/engineHostFork.ts (the one fork file); never in src/engine-host/;
//   - no http, https, net, tls, dgram, http2, ws, undici or dns anywhere in src/, and no inspector or cluster
//     (a listening port, a started process; build gate 1, G1S-07);
//   - no eval, Function constructor or Worker from source text in src/ (G1S-07);
//   - no VS Code API that starts a program for the extension: workspace.findFiles and findTextInFiles (ripgrep),
//     tasks, ShellExecution, ProcessExecution, window.createTerminal (G1S-10);
//   - the VS Code Git extension ("vscode.git") banned: it runs git.exe;
//   - node:wasi only under src/spikes/s1c/ (the future S1c spike);
//   - no fetch, WebSocket, XMLHttpRequest, EventSource, RTCPeerConnection, WebTransport or sendBeacon in src/;
//   - no require(), dynamic import() (outside the webview), process.binding or getBuiltinModule in src/, so
//     no module can slip past the import rules;
//   - no RegExp built at run time in the code that reads presets and folder configs (G1B-S-01).
// test/ and scripts/ are development code, never shipped; they get the general rules only.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const FORK_FILE = 'src/extension/engineHostFork.ts';
// The one file that may load a module by path at run time: the patched engine glue (src/engine-host/engine/glue.ts).
const GLUE_LOADER = 'src/engine-host/engine/glue.ts';
const NETWORK_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'http2', 'ws', 'undici', 'dns'];
const PROCESS_AND_PORT_MODULES = ['inspector', 'cluster'];
const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'RTCPeerConnection', 'WebTransport'];
const both = (names) => names.flatMap((n) => [n, `node:${n}`]);

function restrictedImports({ allowChildProcess = false, allowWasi = false, allowModuleLoader = false, banNode = false, banVscode = false } = {}) {
  const paths = both(NETWORK_MODULES).map((name) => ({
    name,
    message: 'No network module anywhere in the extension (docs/DESIGN.md#rules).',
  }));
  paths.push(
    ...both(PROCESS_AND_PORT_MODULES).map((name) => ({
      name,
      message: 'inspector opens a listening port and cluster starts processes; neither is allowed (docs/DESIGN.md#rules).',
    })),
  );
  if (!allowChildProcess) {
    paths.push(
      ...both(['child_process']).map((name) => ({
        name,
        message: `child_process is allowed only in ${FORK_FILE}, the one fork file (docs/DESIGN.md#architecture).`,
      })),
    );
  }
  if (!allowWasi) {
    paths.push(
      ...both(['wasi']).map((name) => ({ name, message: 'node:wasi is allowed only in src/spikes/s1c/ (the S1c spike).' })),
    );
  }
  if (!allowModuleLoader) {
    paths.push(
      ...both(['module', 'vm']).map((name) => ({
        name,
        message: `node:module and node:vm load or run code by name; only ${GLUE_LOADER} may (the patched engine glue).`,
      })),
    );
  }
  if (banVscode) {
    paths.push({ name: 'vscode', message: 'The vscode module exists only in the extension host.' });
  }
  const patterns = [
    { group: ['ws/*', 'undici/*'], message: 'No network module anywhere in the extension (docs/DESIGN.md#rules).' },
  ];
  if (banNode) {
    patterns.push({ group: ['node:*'], message: 'The webview is a browser page; Node modules do not exist there.' });
  }
  return ['error', { paths, patterns }];
}

const syntax = (selector, message) => ({ selector, message });
const BASE_SYNTAX = [
  syntax("CallExpression[callee.name='require']", 'Use import; require() would hide a module from the import rules.'),
  syntax("CallExpression[callee.property.name='getBuiltinModule']", 'getBuiltinModule would hide a module from the import rules.'),
  syntax(
    "MemberExpression[object.name='process'][property.name=/^(binding|_linkedBinding|dlopen|execve)$/]",
    'process.binding, dlopen and execve are routes around the process and module rules.',
  ),
  syntax("CallExpression[callee.name='eval']", 'eval runs text as code (build gate 1, G1S-07).'),
  syntax("NewExpression[callee.name='Function'], CallExpression[callee.name='Function']", 'The Function constructor runs text as code (G1S-07).'),
  syntax("NewExpression[callee.name='Worker'] > ObjectExpression > Property[key.name='eval']", 'A Worker made from source text runs text as code (G1S-07).'),
  syntax(
    "MemberExpression[property.name=/^(findFiles|findTextInFiles|createTerminal)$/]",
    'This VS Code API starts a program (ripgrep, a terminal) for the extension (G1S-10).',
  ),
  syntax(
    "MemberExpression[object.name='vscode'][property.name=/^(tasks|ShellExecution|ProcessExecution)$/]",
    'This VS Code API starts a program (a task) for the extension (G1S-10).',
  ),
  syntax(
    "ImportSpecifier[imported.name=/^(tasks|ShellExecution|ProcessExecution)$/]",
    'This VS Code API starts a program (a task) for the extension (G1S-10).',
  ),
  syntax("Literal[value=/^vscode\\.git(-base)?$/]", 'The VS Code Git extension runs git.exe; use isomorphic-git (docs/DESIGN.md#architecture).'),
  syntax("TemplateElement[value.raw=/vscode\\.git/]", 'The VS Code Git extension runs git.exe; use isomorphic-git (docs/DESIGN.md#architecture).'),
  syntax(
    `MemberExpression[object.name=/^(globalThis|window|self|global)$/][property.name=/^(${NETWORK_GLOBALS.join('|')})$/]`,
    'No network API in the extension (docs/DESIGN.md#rules).',
  ),
];
const NO_DYNAMIC_IMPORT = syntax('ImportExpression', 'Dynamic import() would hide a module from the import rules.');

const networkGlobals = ['error', ...NETWORK_GLOBALS.map((name) => ({ name, message: 'No network API in the extension (docs/DESIGN.md#rules).' }))];
const sendBeacon = [
  'error',
  { object: 'navigator', property: 'sendBeacon', message: 'No network API in the extension (docs/DESIGN.md#rules).' },
];

export default defineConfig([
  { ignores: ['dist/', 'out/', 'node_modules/', '.vscode-test/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
  },

  // Shipped code: extension host, engine host, converter, shared modules, browser entry.
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports(),
      'no-restricted-syntax': ['error', ...BASE_SYNTAX, NO_DYNAMIC_IMPORT],
      'no-restricted-globals': networkGlobals,
      'no-restricted-properties': sendBeacon,
    },
  },
  {
    // Presets and folder configs come from a repository, so no regular expression is built in the code that reads
    // them (build gate 1, G1B-S-01): their patterns go through src/converter/preset/safePattern.ts, their entry
    // globs through glob.ts. Regular-expression literals written here are fixed text and stay allowed.
    files: [
      'src/converter/preset/**/*.ts',
      'src/converter/config.ts',
      'src/extension/markdown/conversion.ts',
      'src/extension/markdown/confinePaths.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...BASE_SYNTAX,
        NO_DYNAMIC_IMPORT,
        syntax(
          "NewExpression[callee.name='RegExp'], CallExpression[callee.name='RegExp']",
          'Preset and folder-config text is untrusted: match it with safePattern.ts or glob.ts, never a RegExp built at run time (G1B-S-01).',
        ),
      ],
    },
  },
  {
    files: [FORK_FILE],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ allowChildProcess: true }) },
  },
  {
    files: ['src/engine-host/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ banVscode: true }) },
  },
  {
    files: [GLUE_LOADER],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ banVscode: true, allowModuleLoader: true }) },
  },
  {
    files: ['src/spikes/s1c/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ allowWasi: true }) },
  },
  {
    // The webview page: a browser page that loads pdf.js from the extension's own URLs with import().
    files: ['src/webview/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-restricted-imports': restrictedImports({ banNode: true, banVscode: true }),
      'no-restricted-syntax': ['error', ...BASE_SYNTAX],
    },
  },
  {
    files: ['src/web/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ banNode: true }) },
  },
]);
