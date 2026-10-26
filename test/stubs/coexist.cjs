'use strict';
// The extension-host stubs of the coexistence window only (scripts/run-integration.mjs --with-latex-workshop;
// docs/DESIGN.md#confinement-and-trust, #testing). As register-exthost.cjs, with two things allowed to LaTeX
// Workshop's own code, because it cannot activate without them:
//   - one fork: its MathJax worker process, which its workerpool forks from
//     node_modules/workerpool/src/WorkerHandler.js;
//   - one server: the local server of its PDF viewer, which out/src/preview/server.js starts on the loopback
//     address (127.0.0.1, a port the system picks) when it loads. Only a loopback address is allowed, and only to
//     that file.
// With them LaTeX Workshop activates, and the tests meet it building on save beside ours. Its builds (latexmk)
// and every other process start or connection stay blocked and recorded, so a test can see that it tried to
// build. This window is a throwaway profile that holds LaTeX Workshop and nothing else; nothing is allowed
// anywhere else. The forks are allowed as exact (target, caller) pairs: our fork file may start only our engine
// host, and LaTeX Workshop's workerpool only its MathJax worker. The record names every fork and server that ran
// (state.allowedForks, state.allowedListens).
//
// .vscode-test.mjs writes the window's preload, which calls register() with the folder VS Code installed LaTeX
// Workshop into. As for every stub, the configuration comes from the preload file, never from the environment.

const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const state = require('./stub-state.cjs');

const root = path.resolve(__dirname, '..', '..');
const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** The file of the first JavaScript frame above `fn`. */
function callerFile(fn) {
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
}

/** The host a listen() call names: listen(port, host, ...) or listen({ port, host }). */
function hostOf(args) {
  if (typeof args[1] === 'string') {
    return args[1];
  }
  return args[0] && typeof args[0] === 'object' && typeof args[0].host === 'string' ? args[0].host : undefined;
}

/** Loads the extension-host stubs with LaTeX Workshop's MathJax worker and viewer server allowed. */
function register(latexWorkshopFolder) {
  state.configure({
    role: 'extension-host',
    allowForkPairs: [
      { target: path.join(root, 'dist', 'engine-host.js'), caller: path.join(root, 'dist', 'fork.js') },
      {
        target: path.join(latexWorkshopFolder, 'out', 'src', 'preview', 'mathjax', 'mathjax.js'),
        caller: path.join(latexWorkshopFolder, 'node_modules', 'workerpool', 'src', 'WorkerHandler.js'),
      },
    ],
  });
  const realListen = net.Server.prototype.listen;
  const realLookup = dns.lookup;
  require('./process-stub.cjs');
  require('./network-stub.cjs');
  const blockedListen = net.Server.prototype.listen;
  const server = state.normalize(path.join(latexWorkshopFolder, 'out', 'src', 'preview', 'server.js'));
  state.allowedListens = [];
  net.Server.prototype.listen = function listen(...args) {
    const caller = callerFile(listen);
    const host = hostOf(args);
    if (caller && state.normalize(caller) === server && host !== undefined && LOOPBACK.has(host)) {
      state.allowedListens.push({ caller, host });
      // listen() looks the host up with dns.lookup, synchronously, even for an address; for this one call it is
      // the real lookup of a loopback address, which never leaves the machine.
      const blockedLookup = dns.lookup;
      dns.lookup = realLookup;
      try {
        return realListen.apply(this, args);
      } finally {
        dns.lookup = blockedLookup;
      }
    }
    return blockedListen.apply(this, args);
  };
}

module.exports = { register };
