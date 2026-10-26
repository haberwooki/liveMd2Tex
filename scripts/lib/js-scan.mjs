// Scan of JavaScript for network and process routes (docs/DESIGN.md#rules). Each file is parsed with acorn, so
// comments never count, and strings, templates, regular expressions and property names are told apart.
//
// Hits:
//   - module: a string or template literal equal to a watched module name, with or without "node:". This
//     catches require("x"), import ... from "x", import("x"), process.getBuiltinModule("x") and any indirect
//     use of the name.
//   - name: a reference to a watched global name (an identifier that is not a property name, a method or
//     class-member key, or a label), an access to it through globalThis, window, self or global, or a string
//     literal equal to it (as in globalThis["fetch"]). Property calls such as xref.fetch(ref) are not hits,
//     except for WATCHED_PROPERTIES, which count wherever they appear.
// A file that does not parse fails the scan: the scan cannot vouch for it.

import * as acorn from 'acorn';

/**
 * docs/DESIGN.md#rules's modules, plus http2, and (build gate 1, G1S-07) dns (queries go to the network),
 * inspector (opens a listening port), cluster (starts processes) and undici (an HTTP client).
 */
export const WATCHED_MODULES = ['child_process', 'ws', 'net', 'tls', 'http', 'https', 'dgram', 'http2', 'dns', 'inspector', 'cluster', 'undici'];
/**
 * Code that runs text as code or reaches below the module rules (G1S-07): eval, new Function (or Function(...)),
 * process.binding and process._linkedBinding, and a Worker made from source text ({ eval: true }). Kind 'code'.
 */
export const WATCHED_CODE = ['eval', 'Function', 'process.binding', 'process._linkedBinding', 'Worker eval'];
/**
 * docs/DESIGN.md#rules's names (WebSocket, fetch), plus the other browser routes to the network: a webview's
 * CSP governs XMLHttpRequest and EventSource through connect-src, but not WebRTC.
 */
export const WATCHED_NAMES = ['WebSocket', 'fetch', 'XMLHttpRequest', 'EventSource', 'RTCPeerConnection', 'WebTransport'];
/** Watched even as property names (navigator.sendBeacon). */
export const WATCHED_PROPERTIES = ['sendBeacon'];

const moduleSet = new Set(WATCHED_MODULES);
const nameSet = new Set(WATCHED_NAMES);
const propertySet = new Set(WATCHED_PROPERTIES);
const globalObjects = new Set(['globalThis', 'window', 'self', 'global']);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'raw']);

function parse(source, sourceType) {
  return acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType,
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
  });
}

/** Visits every node with its parent and the parent's field name, without recursion. */
function walk(root, visit) {
  const stack = [[root, null, null]];
  while (stack.length > 0) {
    const [node, parent, key] = stack.pop();
    visit(node, parent, key);
    for (const field of Object.keys(node)) {
      if (SKIP_KEYS.has(field)) {
        continue;
      }
      const value = node[field];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          const child = value[i];
          if (child && typeof child.type === 'string') {
            stack.push([child, node, field]);
          }
        }
      } else if (value && typeof value.type === 'string') {
        stack.push([value, node, field]);
      }
    }
  }
}

function isReference(parent, key) {
  if (!parent) {
    return true;
  }
  switch (parent.type) {
    case 'MemberExpression':
      return key !== 'property' || parent.computed;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key !== 'key' || parent.computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key !== 'label';
    case 'ExportSpecifier':
      return key !== 'exported';
    case 'ImportSpecifier':
      return key !== 'imported';
    case 'MetaProperty':
      return false;
    default:
      return true;
  }
}

/**
 * @param {string} source JavaScript text
 * @param {string} file name used in the hits (and to choose module or script parsing first)
 * @returns {{file: string, line: number, column: number, kind: 'module'|'name'|'code', match: string}[]}
 */
export function scanJavaScript(source, file) {
  let ast;
  const moduleFirst = !/\.cjs$/i.test(file);
  try {
    ast = parse(source, moduleFirst ? 'module' : 'script');
  } catch (first) {
    try {
      ast = parse(source, moduleFirst ? 'script' : 'module');
    } catch {
      throw new Error(`${file}: does not parse (${first.message}); the scan cannot vouch for this file.`);
    }
  }
  const hits = [];
  const hit = (node, kind, match) =>
    hits.push({ file, line: node.loc.start.line, column: node.loc.start.column + 1, kind, match });

  walk(ast, (node, parent, key) => {
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee.type === 'Identifier') {
      if (node.callee.name === 'eval' && node.type === 'CallExpression') {
        hit(node, 'code', 'eval');
      } else if (node.callee.name === 'Function') {
        hit(node, 'code', 'Function');
      } else if (node.callee.name === 'Worker' && node.type === 'NewExpression') {
        const options = node.arguments[1];
        if (options?.type === 'ObjectExpression' && options.properties.some((p) => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'eval')) {
          hit(node, 'code', 'Worker eval');
        }
      }
    }
    if (
      node.type === 'MemberExpression' &&
      node.object.type === 'Identifier' &&
      node.object.name === 'process' &&
      !node.computed &&
      (node.property.name === 'binding' || node.property.name === '_linkedBinding')
    ) {
      hit(node, 'code', `process.${node.property.name}`);
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const bare = node.value.startsWith('node:') ? node.value.slice(5) : node.value;
      if (moduleSet.has(bare)) {
        hit(node, 'module', bare);
      } else if (nameSet.has(node.value)) {
        hit(node, 'name', node.value);
      }
    } else if (node.type === 'TemplateElement') {
      const value = node.value.cooked ?? node.value.raw;
      const bare = value.startsWith('node:') ? value.slice(5) : value;
      if (moduleSet.has(bare)) {
        hit(node, 'module', bare);
      }
    } else if (node.type === 'Identifier' && propertySet.has(node.name)) {
      hit(node, 'name', node.name);
    } else if (node.type === 'Identifier' && nameSet.has(node.name)) {
      const viaGlobal =
        parent?.type === 'MemberExpression' &&
        key === 'property' &&
        parent.object.type === 'Identifier' &&
        globalObjects.has(parent.object.name);
      if (viaGlobal || isReference(parent, key)) {
        hit(node, 'name', node.name);
      }
    }
  });
  hits.sort((a, b) => a.line - b.line || a.column - b.column);
  return hits;
}

/** The text of one line (1-based), trimmed and shortened, for reports and allow-list checks. */
export function lineText(source, line) {
  let start = 0;
  for (let i = 1; i < line; i++) {
    start = source.indexOf('\n', start) + 1;
    if (start === 0) {
      return '';
    }
  }
  const end = source.indexOf('\n', start);
  return source.slice(start, end === -1 ? undefined : end).trim().slice(0, 200);
}
