// Negative controls: the stubs really block and record every route, in this process and in a forked child.

import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as dgram from 'node:dgram';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { forkEngineHost } from '../../src/extension/engineHostFork';
import { root, stubState } from '../support/helpers';

const BLOCKED = { code: 'ERR_LIVEMD2TEX_STUB_BLOCKED' };

describe('process and network stubs (this process)', () => {
  afterEach(() => stubState().clearBlocked());

  it('are both loaded, in the unit-test role', () => {
    const state = stubState();
    assert.equal(state.role, 'unit-test');
    assert.deepEqual([...state.stubs].sort(), ['network', 'process']);
  });

  it('block spawn, spawnSync, exec, execSync, execFile, execFileSync and a fork of anything else', () => {
    const state = stubState();
    assert.throws(() => childProcess.spawn(process.execPath, ['-e', '0']), BLOCKED);
    assert.throws(() => childProcess.spawnSync(process.execPath, ['-e', '0']), BLOCKED);
    assert.throws(() => childProcess.exec('echo x'), BLOCKED);
    assert.throws(() => childProcess.execSync('echo x'), BLOCKED);
    assert.throws(() => childProcess.execFile(process.execPath, ['-e', '0']), BLOCKED);
    assert.throws(() => childProcess.execFileSync(process.execPath, ['-e', '0']), BLOCKED);
    // A fork of an allowed target, but not from the fork file:
    assert.throws(() => childProcess.fork(path.join(root, 'dist', 'engine-host.js')), BLOCKED);
    // The fork file, but a target that is not allowed:
    assert.throws(() => forkEngineHost({ modulePath: path.join(root, 'package.json') }), BLOCKED);
    // The internal method under every asynchronous child_process call:
    const internal = new childProcess.ChildProcess() as unknown as { spawn(options: object): void };
    assert.throws(() => internal.spawn({ file: process.execPath, args: [process.execPath], stdio: 'ignore' }), BLOCKED);
    assert.equal(state.blocked.length, 9);
  });

  it('block sockets, servers, TLS, HTTP(S), UDP, DNS, fetch and WebSocket', () => {
    const state = stubState();
    assert.throws(() => net.connect(9, '127.0.0.1'), BLOCKED);
    assert.throws(() => new net.Socket().connect(9, '127.0.0.1'), BLOCKED);
    assert.throws(() => net.createServer().listen(0, '127.0.0.1'), BLOCKED);
    assert.throws(() => tls.connect(9, '127.0.0.1'), BLOCKED);
    assert.throws(() => http.get('http://127.0.0.1:9/'), BLOCKED);
    assert.throws(() => https.request('https://127.0.0.1:9/'), BLOCKED);
    assert.throws(() => dgram.createSocket('udp4'), BLOCKED);
    assert.throws(() => dns.lookup('localhost', () => undefined), BLOCKED);
    assert.throws(() => fetch('http://127.0.0.1:9/'), BLOCKED);
    assert.throws(() => new WebSocket('ws://127.0.0.1:9/'), BLOCKED);
    assert.equal(state.blocked.length, 10);
  });
});

describe('process and network stubs (a forked child with the engine-host stubs)', () => {
  it('block every route in the child, and the child records each attempt', async () => {
    const child = forkEngineHost({
      modulePath: path.join(root, 'test', 'fixtures', 'stub-probe.cjs'),
      execArgv: ['--require', path.join(root, 'test', 'stubs', 'register-engine-host.cjs')],
    });
    const message = await new Promise<{
      results: Record<string, string>;
      report: { role: string; blocked: unknown[]; allowedForks: unknown[] };
    }>((resolve, reject) => {
      child.once('message', (m) => resolve(m as never));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`probe exited early (code ${code})`)));
    });
    const notBlocked = Object.entries(message.results).filter(([, v]) => v !== 'blocked');
    assert.deepEqual(notBlocked, [], `routes not blocked in the child: ${JSON.stringify(notBlocked)}`);
    assert.equal(Object.keys(message.results).length, 21);
    assert.equal(message.report.role, 'engine-host');
    assert.equal(message.report.blocked.length, 21);
    assert.deepEqual(message.report.allowedForks, []);
    stubState().clearBlocked();
  });
});
