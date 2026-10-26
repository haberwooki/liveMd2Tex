'use strict';
// Negative control for the stubs in a child process. Forked by test/unit/stubs.test.ts with the engine-host
// stubs loaded (--require test/stubs/register-engine-host.cjs). It tries every blocked route once, catches
// the stub's error, and reports which attempts the stubs blocked. Nothing here can reach the network or start
// a program unless a stub is missing, in which case the attempt targets this machine only and the test fails.

const attempts = {
  spawn: () => require('node:child_process').spawn(process.execPath, ['-e', '0']),
  spawnSync: () => require('node:child_process').spawnSync(process.execPath, ['-e', '0']),
  exec: () => require('node:child_process').exec('echo x'),
  execSync: () => require('node:child_process').execSync('echo x'),
  execFile: () => require('node:child_process').execFile(process.execPath, ['-e', '0']),
  execFileSync: () => require('node:child_process').execFileSync(process.execPath, ['-e', '0']),
  fork: () => require('node:child_process').fork(__filename),
  childProcessProto: () => {
    const { ChildProcess } = require('node:child_process');
    new ChildProcess().spawn({ file: process.execPath, args: [process.execPath, '-e', '0'], stdio: 'ignore' });
  },
  bindingSpawnSync: () => process.binding('spawn_sync'),
  netConnect: () => require('node:net').connect(9, '127.0.0.1'),
  socketConnect: () => new (require('node:net').Socket)().connect(9, '127.0.0.1'),
  serverListen: () => require('node:net').createServer().listen(0, '127.0.0.1'),
  tlsConnect: () => require('node:tls').connect(9, '127.0.0.1'),
  httpGet: () => require('node:http').get('http://127.0.0.1:9/'),
  httpsRequest: () => require('node:https').request('https://127.0.0.1:9/'),
  http2Connect: () => require('node:http2').connect('http://127.0.0.1:9'),
  dgram: () => require('node:dgram').createSocket('udp4'),
  dnsLookup: () => require('node:dns').lookup('localhost', () => undefined),
  fetch: () => fetch('http://127.0.0.1:9/'),
  webSocket: () => new WebSocket('ws://127.0.0.1:9/'),
  nativeAddon: () => process.dlopen({ exports: {} }, 'nonexistent.node'),
};

const results = {};
for (const [name, attempt] of Object.entries(attempts)) {
  try {
    const value = attempt();
    // A promise (fetch) that was not blocked synchronously: report it as not blocked.
    if (value && typeof value.catch === 'function') {
      value.catch(() => undefined);
    }
    results[name] = 'NOT BLOCKED';
  } catch (err) {
    results[name] = err && err.code === 'ERR_LIVEMD2TEX_STUB_BLOCKED' ? 'blocked' : `other error: ${err && err.message}`;
  }
}

const state = globalThis[Symbol.for('livemd2tex.stubs')];
process.send({ results, report: state ? state.report() : null }, () => process.exit(0));
