'use strict';
// Loaded into the engine-host child with execArgv ['--require', <this file>] during tests. The engine host
// starts nothing and connects nowhere, so no fork is allowed and native addons are blocked too.

const state = require('./stub-state.cjs');

state.configure({ role: 'engine-host', allowForkTargets: [], allowForkCallers: [], blockNativeAddons: true });
require('./process-stub.cjs');
require('./network-stub.cjs');
