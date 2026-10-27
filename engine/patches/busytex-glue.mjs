// Patches to TeXlyre's Emscripten glue file busytex.js (docs/DESIGN.md#rules, #engine-and-data), applied by
// scripts/engine-patch.mjs from the very first run. Each `find` must occur exactly `count` times in the pinned
// input, or the patch step fails, so a new glue version cannot slip through unreviewed.
//
// What this glue can reach outside the WebAssembly sandbox (its 85 imports, read 2026-10-15):
//   - shell_escape_dispatch_js: TeXlyre's \write18 / system() route, which dispatches a command to JavaScript
//     "shell handlers" that any code in the process may register through a global function. There is no
//     system(), fork() or execve() import, and no child_process anywhere in the glue.
//   - kpse_remote_fetch_js: TeXlyre's kpathsea fallback that fetches a missing file from
//     TEXLIVE_REMOTE_ENDPOINT with a synchronous XMLHttpRequest.
//   - the socket syscalls (socket, connect, bind, listen, accept4, sendto, recvfrom, ...), served by
//     Emscripten's SOCKFS, which under Node requires the "ws" package and opens WebSocket clients or servers.
// The three patches below close those routes. getaddrinfo and _emscripten_lookup_name stay: they answer from
// an in-memory table (DNS.lookup_name) and never query the network.

export const input = {
  file: 'busytex.js',
  sha256: '875b87795162cb26b15bd93cffa2e8739bcb900d623ab904029b39402508a1a4',
};

/**
 * The notice of the change that heads the patched glue and the diff (AGPL-3.0 section 5(a) and (b): "prominent
 * notices stating that you modified it, and giving a relevant date", and that it is released under the licence;
 * sections 4 and 5 also keep TeXlyre's copyright notice). `date` is the day the patches below last changed, and
 * `patchesSha256` the SHA-256 of their id, count, find and replace (as JSON): test/unit/engineNotices.test.ts fails
 * when the patches change and these two do not.
 */
export const notice = {
  patchesSha256: '34c8412ca9c4baddc6d81e070c681c1b20369a644d4ed08a551f439cbb3fba3c',
  original: "busytex.js of TeXlyre-BusyTeX, release build_wasm_46ebb6216a5c1fe63dd1dc885831d1a8cef2dc86_31802832436_1 (https://github.com/TeXlyre/texlyre-busytex-build); TeXlyre-BusyTeX: Copyright (c) 2026 Fares Abawi (https://abawi.me), AGPL-3.0; based on BusyTeX (https://github.com/busytex/busytex) by Vadim Kantorov, MIT",
  date: '2026-10-16',
  by: 'the liveMd2Tex authors',
  licence: 'This modified file is released under the GNU Affero General Public License version 3 (AGPL-3.0), as the original is',
  patches: 'engine/patches/busytex-glue.mjs and engine/patches/busytex.js.diff at https://github.com/haberwooki/liveMd2Tex (the release tag of the version that ships it)',
};

export const patches = [
  {
    id: 'no-shell',
    why: 'Patch 1 of docs/DESIGN.md#rules: system() and \\write18 get "no shell" (-1) and nothing is dispatched.',
    count: 1,
    find: `  function _shell_escape_dispatch_js(cmdPtr, cwdPtr) {
          return KPSE_REMOTE.shellDispatch(UTF8ToString(cmdPtr), UTF8ToString(cwdPtr));
      }`,
    replace: `  function _shell_escape_dispatch_js(cmdPtr, cwdPtr) {
          return -1; // PATCHED (no-shell): no shell and no shell handler, ever.
      }`,
  },
  {
    id: 'no-shell-registration',
    why: 'The shell-handler registry is not exposed on globalThis, so no other code can add a handler.',
    count: 1,
    find: `              var scope = typeof self !== 'undefined' ? self : globalThis;
              scope.register_shell_handler = function (command, handler) {`,
    replace: `              var scope = {}; // PATCHED (no-shell-registration): keep the registry private.
              scope.register_shell_handler = function (command, handler) {`,
  },
  {
    id: 'no-shell-registry-global',
    why: 'Same: the handler table is not published as globalThis.__busytex_shell_handlers.',
    count: 1,
    find: `              if (typeof globalThis !== 'undefined')
                  globalThis.__busytex_shell_handlers = KPSE_REMOTE.shellHandlers;`,
    replace: `              // PATCHED (no-shell-registry-global): the handler table stays private.`,
  },
  {
    id: 'no-remote-fetch',
    why: 'No network: kpathsea never fetches a missing file; a missing file is reported as missing.',
    count: 1,
    find: `  function _kpse_remote_fetch_js(namePtr, format) {
          var name = UTF8ToString(namePtr);`,
    replace: `  function _kpse_remote_fetch_js(namePtr, format) {
          return 0; // PATCHED (no-remote-fetch): files come only from the bundle and the project.
          var name = UTF8ToString(namePtr);`,
  },
  {
    id: 'no-remote-fetch-xhr',
    why: 'Same, at the XMLHttpRequest itself, whatever TEXLIVE_REMOTE_ENDPOINT says.',
    count: 1,
    find: `              var endpoint = Module.ENV['TEXLIVE_REMOTE_ENDPOINT'];
              if (!endpoint) return null;`,
    replace: `              return null; // PATCHED (no-remote-fetch-xhr): never fetch.
              var endpoint = Module.ENV['TEXLIVE_REMOTE_ENDPOINT'];`,
  },
  {
    id: 'no-sockets',
    why: 'Patch 2 of docs/DESIGN.md#rules: every socket() fails with EACCES (2 in this glue), so connect, bind and listen never run; LuaTeX\'s socket library gets a plain error.',
    count: 1,
    find: `  createSocket(family, type, protocol) {
        // Emscripten only supports AF_INET`,
    replace: `  createSocket(family, type, protocol) {
        throw new FS.ErrnoError(2); // PATCHED (no-sockets): EACCES for every socket.
        // Emscripten only supports AF_INET`,
  },
  {
    id: 'no-ws-client',
    why: 'The "ws" package is never loaded for a WebSocket client.',
    count: 1,
    find: `WebSocketConstructor = /** @type{(typeof WebSocket)} */(require('ws'));`,
    replace: `throw new FS.ErrnoError(2); // PATCHED (no-ws-client)`,
  },
  {
    id: 'no-ws-server',
    why: 'The "ws" package is never loaded for a WebSocket server.',
    count: 1,
    find: `          var WebSocketServer = require('ws').Server;`,
    replace: `          throw new FS.ErrnoError(2); // PATCHED (no-ws-server)`,
  },
];
