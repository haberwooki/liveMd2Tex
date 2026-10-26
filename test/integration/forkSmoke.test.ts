// M0 fork smoke test inside VS Code (docs/DESIGN.md#architecture, #rules): the extension, running in VS Code's extension
// host with the stubs loaded, forks the engine host with VS Code's own program in Node mode
// (ELECTRON_RUN_AS_NODE=1) and the stubs loaded there too. They exchange messages; a converter run follows.
// Both processes' records must show zero connections and zero spawns, and exactly one fork.

import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { activateExtension, engineStubArgs, ownAttempts, reportBlocked, root, stubState } from './support';

describe('fork smoke test (VS Code extension host)', () => {
  before(() => reportBlocked('before the fork smoke tests'));

  it('the stubs are loaded in the extension host before the extension activates', () => {
    const state = stubState();
    assert.equal(state.role, 'extension-host');
    assert.deepEqual([...state.stubs].sort(), ['network', 'process']);
  });

  it("forks the engine host under VS Code's own program, exchanges messages, and nothing spawns or connects", async () => {
    const state = stubState();
    const forksBefore = state.allowedForks.length;
    const blockedBefore = state.blocked.length;
    const api = await activateExtension();

    const { host, ready } = await api.startEngineHost(engineStubArgs);
    assert.equal(ready.runAsNode, true, 'ELECTRON_RUN_AS_NODE=1 reached the child');
    assert.ok(ready.electron, 'the child is Electron (VS Code) in Node mode');
    assert.equal(path.resolve(ready.execPath).toLowerCase(), path.resolve(process.execPath).toLowerCase());
    assert.equal(await host.ping('hello'), 'hello');
    assert.equal(await host.wasmCheck(), 5);
    const child = await host.stubReport();
    assert.ok(child, 'stubs loaded in the engine host');
    assert.equal(child.role, 'engine-host');
    assert.deepEqual(child.blocked, [], 'the engine host tried to spawn or connect');
    assert.deepEqual(child.allowedForks, [], 'the engine host started a process');

    // The converter run (placeholder converter; agent B replaces it in C0a).
    const { latex } = api.convert('# Title\n\nSome *text* with $x^2$.\n\n- one\n- two\n');
    assert.match(latex, /\\section\{Title\}/);
    assert.match(latex, /\\emph\{text\}/);

    const exit = await host.stop();
    assert.equal(exit?.code, 0);

    const forks = state.allowedForks.slice(forksBefore);
    assert.equal(forks.length, 1, 'exactly one fork');
    assert.equal(path.resolve(forks[0].target).toLowerCase(), path.join(root, 'dist', 'engine-host.js').toLowerCase());
    assert.equal(path.basename(forks[0].caller), 'fork.js', 'the fork came from dist/fork.js');
    assert.deepEqual(
      ownAttempts(state, blockedBefore).map((b) => `${b.kind}: ${b.detail}\n${b.stack}`),
      [],
      'the extension tried to spawn or connect',
    );
    assert.equal(state.blocked.length, blockedBefore, 'something in the extension host tried to spawn or connect');
    console.log(
      `      engine host: pid ${ready.pid}, Electron ${ready.electron}, Node ${ready.node}; ` +
        `extension host record: ${state.allowedForks.length} allowed fork(s), ${state.blocked.length} blocked attempt(s)`,
    );
  });

  it('the stubs are live in the extension host (negative control, run last)', () => {
    const state = stubState();
    const before = state.blocked.length;
    assert.throws(() => childProcess.spawn(process.execPath, ['-e', '0']), { code: 'ERR_LIVEMD2TEX_STUB_BLOCKED' });
    assert.throws(() => net.connect(9, '127.0.0.1'), { code: 'ERR_LIVEMD2TEX_STUB_BLOCKED' });
    assert.throws(() => fetch('http://127.0.0.1:9/'), { code: 'ERR_LIVEMD2TEX_STUB_BLOCKED' });
    assert.equal(state.blocked.length, before + 3);
    state.clearBlocked();
  });
});
