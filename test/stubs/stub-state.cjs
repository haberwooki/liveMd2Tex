'use strict';
// Shared record of the test stubs in one process (docs/DESIGN.md#rules). The stubs block and record every
// attempt to start a process or open a connection; tests read the record to prove there were none.
//
// The record lives on a global symbol so that the engine host can report it (src/shared/engineProtocol.ts,
// STUB_STATE_KEY) without importing test code. Configuration comes from the register-*.cjs file that loads
// the stubs, never from environment variables: a forked child inherits its parent's environment, and the
// engine host must not inherit the extension host's fork permission.

const path = require('node:path');

const KEY = Symbol.for('livemd2tex.stubs');

function normalize(p) {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

if (!globalThis[KEY]) {
  const state = {
    role: 'unconfigured',
    stubs: [],
    blocked: [],
    allowedForks: [],
    config: { allowForkTargets: [], allowForkCallers: [], allowForkPairs: [], blockNativeAddons: false },
    /**
     * allowForkTargets and allowForkCallers: a fork of any listed target from any listed caller. allowForkPairs:
     * a fork of exactly that target from exactly that caller ({ target, caller }), and no crossed pair.
     */
    configure({ role, allowForkTargets = [], allowForkCallers = [], allowForkPairs = [], blockNativeAddons = false }) {
      if (state.stubs.length > 0) {
        throw new Error('[stubs] configure() must run before the stubs load.');
      }
      state.role = role;
      state.config = {
        allowForkTargets: allowForkTargets.map(normalize),
        allowForkCallers: allowForkCallers.map(normalize),
        allowForkPairs: allowForkPairs.map((p) => ({ target: normalize(p.target), caller: normalize(p.caller) })),
        blockNativeAddons,
      };
    },
    record(kind, detail) {
      state.blocked.push({ kind, detail: String(detail).slice(0, 400), stack: new Error().stack });
      const err = new Error(`[stub] ${kind} is blocked in this process (${state.role}): ${detail}`);
      err.code = 'ERR_LIVEMD2TEX_STUB_BLOCKED';
      return err;
    },
    /** A plain, serialisable copy of the record. */
    report() {
      return {
        role: state.role,
        stubs: state.stubs.slice(),
        blocked: state.blocked.map(({ kind, detail }) => ({ kind, detail })),
        allowedForks: state.allowedForks.map(({ target }) => ({ target })),
      };
    },
    /** Forgets earlier attempts; used after the negative controls, which make attempts on purpose. */
    clearBlocked() {
      state.blocked.length = 0;
    },
    normalize,
  };
  globalThis[KEY] = state;
}

module.exports = globalThis[KEY];
