'use strict';
// Network stub (docs/DESIGN.md#rules): any socket, server, DNS lookup, HTTP(S) or HTTP/2 request, UDP socket,
// fetch, WebSocket or EventSource throws and is recorded. net.Socket.prototype.connect is the route under
// every TCP, TLS and pipe client, so code that holds its own reference to net.connect is caught there too.
// The IPC channel of a forked child is set up by Node itself, without connect(), and keeps working.

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const dgram = require('node:dgram');
const dns = require('node:dns');
const { syncBuiltinESMExports } = require('node:module');
const state = require('./stub-state.cjs');

function describe(args) {
  const first = args[0];
  if (first === undefined) {
    return '';
  }
  if (typeof first === 'string' || typeof first === 'number') {
    return String(first);
  }
  if (first instanceof URL) {
    return first.href;
  }
  try {
    return JSON.stringify(first);
  } catch {
    return Object.prototype.toString.call(first);
  }
}

function blocker(kind) {
  return function blockedNetworkCall(...args) {
    throw state.record(kind, describe(args));
  };
}

if (!state.stubs.includes('network')) {
  net.connect = blocker('net.connect');
  net.createConnection = blocker('net.createConnection');
  net.Socket.prototype.connect = blocker('net.Socket.prototype.connect');
  net.Server.prototype.listen = blocker('net.Server.prototype.listen');
  tls.connect = blocker('tls.connect');
  http.request = blocker('http.request');
  http.get = blocker('http.get');
  https.request = blocker('https.request');
  https.get = blocker('https.get');
  http2.connect = blocker('http2.connect');
  dgram.createSocket = blocker('dgram.createSocket');
  for (const name of ['bind', 'connect', 'send']) {
    dgram.Socket.prototype[name] = blocker(`dgram.Socket.prototype.${name}`);
  }
  for (const target of [dns, dns.promises]) {
    for (const name of Object.keys(target)) {
      if (/^(lookup|lookupService|resolve\w*|reverse)$/.test(name) && typeof target[name] === 'function') {
        target[name] = blocker(`dns.${name}`);
      }
    }
  }
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
      if (/^(resolve\w*|reverse)$/.test(name)) {
        Resolver.prototype[name] = blocker(`dns.Resolver.${name}`);
      }
    }
  }

  // defineProperty, because a host may have redefined these globals (VS Code's extension host wraps fetch).
  const replaceGlobal = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  replaceGlobal('fetch', blocker('fetch'));
  for (const name of ['WebSocket', 'EventSource']) {
    if (name in globalThis) {
      replaceGlobal(
        name,
        class BlockedConstructor {
          constructor(...args) {
            throw state.record(name, describe(args));
          }
        },
      );
    }
  }

  syncBuiltinESMExports();
  state.stubs.push('network');
}

module.exports = state;
