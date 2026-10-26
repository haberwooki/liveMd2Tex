'use strict';
// Process stub (docs/DESIGN.md#rules): spawn, spawnSync, exec, execSync, execFile, execFileSync and every fork
// except the one allowed throw, and are recorded. The one allowed fork is the engine host
// (an allowed target) started from the fork file (an allowed caller), or an allowed (target, caller) pair; see
// stub-state.cjs.
// Also closed: ChildProcess.prototype.spawn (the route under every async call), process.binding for the
// process and socket bindings, process.execve, and, where configured, process.dlopen (native addons).

const cp = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const state = require('./stub-state.cjs');

if (!state.stubs.includes('process')) {
  const { allowForkTargets, allowForkCallers, allowForkPairs = [], blockNativeAddons } = state.config;
  let allowedSpawnDepth = 0;

  /** The file of the first JavaScript frame above `fn` (V8 call sites, independent of stack formatting). */
  const callerFile = (fn) => {
    const original = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = (_error, frames) => frames;
      const holder = {};
      Error.captureStackTrace(holder, fn);
      for (const frame of holder.stack) {
        const file = frame.getFileName();
        if (file && !file.startsWith('node:')) {
          return file.startsWith('file:') ? fileURLToPath(file) : file;
        }
      }
      return null;
    } finally {
      Error.prepareStackTrace = original;
    }
  };

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    cp[name] = function blockedProcessCall(command) {
      throw state.record(`child_process.${name}`, command);
    };
  }

  const realFork = cp.fork;
  cp.fork = function fork(modulePath, ...rest) {
    const caller = callerFile(fork);
    const target = state.normalize(modulePath);
    const from = caller ? state.normalize(caller) : null;
    const listed = from !== null && allowForkTargets.includes(target) && allowForkCallers.includes(from);
    const paired = from !== null && allowForkPairs.some((pair) => pair.target === target && pair.caller === from);
    if (listed || paired) {
      state.allowedForks.push({ target: String(modulePath), caller });
      allowedSpawnDepth++;
      try {
        return realFork.call(this, modulePath, ...rest);
      } finally {
        allowedSpawnDepth--;
      }
    }
    throw state.record('child_process.fork', `${modulePath} (called from ${caller ?? 'unknown'})`);
  };

  const proto = cp.ChildProcess.prototype;
  const realProtoSpawn = proto.spawn;
  proto.spawn = function spawn(options) {
    if (allowedSpawnDepth > 0) {
      return realProtoSpawn.call(this, options);
    }
    throw state.record('ChildProcess.prototype.spawn', options && options.file);
  };

  const blockedBindings = new Set([
    'spawn_sync',
    'process_wrap',
    'tcp_wrap',
    'udp_wrap',
    'pipe_wrap',
    'tls_wrap',
    'cares_wrap',
    'stream_wrap',
  ]);
  const realBinding = process.binding;
  process.binding = function binding(name) {
    if (blockedBindings.has(name)) {
      throw state.record('process.binding', name);
    }
    return realBinding.call(this, name);
  };

  if (typeof process.execve === 'function') {
    process.execve = function execve(file) {
      throw state.record('process.execve', file);
    };
  }

  if (blockNativeAddons) {
    process.dlopen = function dlopen(_module, filename) {
      throw state.record('process.dlopen', filename);
    };
  }

  syncBuiltinESMExports();
  state.stubs.push('process');
}

module.exports = state;
