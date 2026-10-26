// The ESLint rules of M0 fire where they should and stay quiet where code is allowed (eslint.config.mjs).

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { root } from '../support/helpers';

interface LintMessage {
  ruleId: string | null;
  fatal?: boolean;
  message: string;
}
interface LintResult {
  messages: LintMessage[];
}
interface ESLintLike {
  lintText(code: string, options: { filePath: string }): Promise<LintResult[]>;
}

const IMPORTS = '@typescript-eslint/no-restricted-imports';
const SYNTAX = 'no-restricted-syntax';
const GLOBALS = 'no-restricted-globals';

const cases: { name: string; file: string; code: string; expect: string | null }[] = [
  { name: 'child_process in the engine host', file: 'src/engine-host/probe.ts', code: "import { fork } from 'node:child_process';\nexport const f = fork;\n", expect: IMPORTS },
  { name: 'child_process elsewhere in the extension host', file: 'src/extension/probe.ts', code: "import * as cp from 'child_process';\nexport const c = cp;\n", expect: IMPORTS },
  { name: 'child_process in the one fork file', file: 'src/extension/engineHostFork.ts', code: "import { fork } from 'node:child_process';\nexport const f = fork;\n", expect: null },
  { name: 'https', file: 'src/converter/probe.ts', code: "import * as https from 'node:https';\nexport const h = https;\n", expect: IMPORTS },
  { name: 'http', file: 'src/extension/probe.ts', code: "import * as http from 'http';\nexport const h = http;\n", expect: IMPORTS },
  { name: 'net', file: 'src/extension/probe.ts', code: "import { connect } from 'node:net';\nexport const c = connect;\n", expect: IMPORTS },
  { name: 'tls', file: 'src/engine-host/probe.ts', code: "import * as tls from 'tls';\nexport const t = tls;\n", expect: IMPORTS },
  { name: 'dgram', file: 'src/extension/probe.ts', code: "import * as dgram from 'node:dgram';\nexport const d = dgram;\n", expect: IMPORTS },
  { name: 'ws', file: 'src/extension/probe.ts', code: "import WebSocket from 'ws';\nexport const w = WebSocket;\n", expect: IMPORTS },
  { name: 'net re-exported', file: 'src/shared/probe.ts', code: "export { connect } from 'node:net';\n", expect: IMPORTS },
  { name: 'vscode.git', file: 'src/extension/probe.ts', code: "export const id = 'vscode.git';\n", expect: SYNTAX },
  { name: 'node:wasi outside the S1c folder', file: 'src/engine-host/probe.ts', code: "import { WASI } from 'node:wasi';\nexport const w = WASI;\n", expect: IMPORTS },
  { name: 'node:wasi inside the S1c folder', file: 'src/spikes/s1c/probe.ts', code: "import { WASI } from 'node:wasi';\nexport const w = WASI;\n", expect: null },
  { name: 'require()', file: 'src/extension/probe.ts', code: "export const m = () => require('child_process');\n", expect: SYNTAX },
  { name: 'dynamic import()', file: 'src/engine-host/probe.ts', code: "export const m = () => import('node:child_process');\n", expect: SYNTAX },
  { name: 'getBuiltinModule', file: 'src/extension/probe.ts', code: "export const m = () => process.getBuiltinModule('net');\n", expect: SYNTAX },
  { name: 'fetch', file: 'src/extension/probe.ts', code: "export const r = () => fetch('https://example.org');\n", expect: GLOBALS },
  { name: 'WebSocket', file: 'src/engine-host/probe.ts', code: "export const w = () => new WebSocket('ws://x');\n", expect: GLOBALS },
  { name: 'globalThis.fetch', file: 'src/converter/probe.ts', code: "export const r = () => globalThis.fetch('x');\n", expect: SYNTAX },
  { name: 'fetch in the webview page', file: 'src/webview/probe.ts', code: "export const r = () => fetch('x');\n", expect: GLOBALS },
  { name: 'a Node module in the webview page', file: 'src/webview/probe.ts', code: "import * as fs from 'node:fs';\nexport const f = fs;\n", expect: IMPORTS },
  // Build gate 1, G1S-07 and G1S-10.
  { name: 'dns', file: 'src/extension/probe.ts', code: "import { lookup } from 'node:dns';\nexport const l = lookup;\n", expect: IMPORTS },
  { name: 'inspector', file: 'src/engine-host/probe.ts', code: "import * as inspector from 'inspector';\nexport const i = inspector;\n", expect: IMPORTS },
  { name: 'cluster', file: 'src/extension/probe.ts', code: "import cluster from 'node:cluster';\nexport const c = cluster;\n", expect: IMPORTS },
  { name: 'eval', file: 'src/extension/probe.ts', code: "export const r = (s: string) => eval(s);\n", expect: SYNTAX },
  { name: 'the Function constructor', file: 'src/engine-host/probe.ts', code: "export const f = new Function('return 1');\n", expect: SYNTAX },
  { name: 'a Worker from source text', file: 'src/engine-host/probe.ts', code: "import { Worker } from 'node:worker_threads';\nexport const w = () => new Worker('1', { eval: true });\n", expect: SYNTAX },
  { name: 'workspace.findFiles (ripgrep)', file: 'src/extension/probe.ts', code: "import * as vscode from 'vscode';\nexport const f = () => vscode.workspace.findFiles('**');\n", expect: SYNTAX },
  { name: 'window.createTerminal', file: 'src/extension/probe.ts', code: "import * as vscode from 'vscode';\nexport const t = () => vscode.window.createTerminal('x');\n", expect: SYNTAX },
  { name: 'vscode.tasks', file: 'src/extension/probe.ts', code: "import * as vscode from 'vscode';\nexport const t = vscode.tasks;\n", expect: SYNTAX },
  { name: 'ShellExecution imported by name', file: 'src/extension/probe.ts', code: "import { ShellExecution } from 'vscode';\nexport const s = ShellExecution;\n", expect: SYNTAX },
  { name: 'ordinary code', file: 'src/converter/probe.ts', code: "import * as path from 'node:path';\nexport const j = path.join('a', 'b');\n", expect: null },
];

describe('ESLint rules', function () {
  this.timeout(120000);
  let eslint: ESLintLike;

  before(async () => {
    const mod = (await import('eslint')) as unknown as { ESLint: new (o: { cwd: string }) => ESLintLike };
    eslint = new mod.ESLint({ cwd: root });
  });

  for (const c of cases) {
    it(`${c.expect ? 'rejects' : 'allows'} ${c.name} (${c.file})`, async () => {
      const [result] = await eslint.lintText(c.code, { filePath: path.join(root, c.file) });
      const fatal = result.messages.filter((m) => m.fatal);
      assert.deepEqual(fatal, [], 'the probe did not parse');
      const rules = result.messages.map((m) => m.ruleId);
      if (c.expect) {
        assert.ok(rules.includes(c.expect), `expected ${c.expect}, got ${JSON.stringify(result.messages)}`);
      } else {
        assert.deepEqual(result.messages, []);
      }
    });
  }
});
