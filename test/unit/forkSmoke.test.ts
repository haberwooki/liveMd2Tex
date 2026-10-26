// M0 fork smoke test, unit level (docs/DESIGN.md#architecture): the fork file starts the engine host; they exchange
// messages; the stubs in both processes record no connection and no spawn. Plain Node first, then VS Code's
// own program in Node mode (ELECTRON_RUN_AS_NODE=1) when an installed VS Code is found. The integration test
// repeats this from inside VS Code's extension host.

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { EngineHost } from '../../src/extension/engineHostClient';
import { importScript, requireBuilt, root, sameFile, stubState } from '../support/helpers';

const engineStubs = ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')];

async function smoke(execPath: string, serialization?: 'advanced' | 'json') {
  const state = stubState();
  state.clearBlocked();
  const forksBefore = state.allowedForks.length;
  const host = new EngineHost({
    modulePath: requireBuilt('dist/engine-host.js'),
    execArgv: engineStubs,
    execPath,
    serialization,
  });
  const ready = await host.start();
  const echo = await host.ping('hello from the extension side');
  const sum = await host.wasmCheck();
  const childReport = await host.stubReport();
  const exit = await host.stop();
  return { state, forksBefore, ready, echo, sum, childReport, exit };
}

function assertClean(r: Awaited<ReturnType<typeof smoke>>) {
  assert.equal(r.ready.runAsNode, true, 'ELECTRON_RUN_AS_NODE=1 must reach the child');
  assert.equal(r.echo, 'hello from the extension side');
  assert.equal(r.sum, 5, 'WebAssembly runs in the engine host');
  assert.ok(r.childReport, 'the stubs are loaded in the engine host');
  assert.equal(r.childReport.role, 'engine-host');
  assert.deepEqual([...r.childReport.stubs].sort(), ['network', 'process']);
  assert.deepEqual(r.childReport.blocked, [], 'the engine host tried to spawn or connect');
  assert.deepEqual(r.childReport.allowedForks, [], 'the engine host started a process');
  assert.equal(r.exit?.code, 0);
  assert.equal(r.state.allowedForks.length, r.forksBefore + 1, 'exactly one fork, from the fork file');
  assert.deepEqual(r.state.blocked, [], 'the parent tried to spawn or connect');
}

describe('fork smoke test (unit)', () => {
  it('plain Node: fork, message exchange, WASM, zero spawns and zero connections', async () => {
    const r = await smoke(process.execPath);
    assertClean(r);
    assert.equal(r.ready.electron, null);
  });

  it("VS Code's own program in Node mode: the same, with Electron reported", async function () {
    const { findInstalledVsCode } = await importScript<{ findInstalledVsCode(): string | undefined }>(
      'scripts/lib/vscode-executable.mjs',
    );
    const code = findInstalledVsCode();
    if (!code) {
      this.skip();
    }
    // JSON, because this parent (plain Node 22) and that child (VS Code's Node) differ in V8 serialization.
    const r = await smoke(code as string, 'json');
    assertClean(r);
    assert.ok(r.ready.electron, 'the child runs inside Electron (VS Code) in Node mode');
    assert.ok(sameFile(r.ready.execPath, code as string), `child execPath ${r.ready.execPath}`);
  });
});
