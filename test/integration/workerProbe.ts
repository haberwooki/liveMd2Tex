// Test-only JavaScript that the viewer prepends to the pdf.js worker (ViewerConfig.workerProbe). It records,
// without changing behaviour, every XMLHttpRequest and fetch the worker makes and every WebAssembly compile,
// and posts the records to the page as { livemd2texProbe }, which pdf.js's message handler ignores.

export const WORKER_PROBE = String.raw`
const probeReport = (m) => { try { self.postMessage({ livemd2texProbe: m }); } catch {} };
const probeMagic = (b) => {
  try { return Array.from(new Uint8Array(b, 0, 4), (x) => x.toString(16).padStart(2, '0')).join(''); }
  catch { return ''; }
};
{
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('loadend', () => probeReport({
      kind: 'xhr', url: String(url), status: this.status,
      bytes: this.response && this.response.byteLength ? this.response.byteLength : 0,
      detail: this.responseType === 'arraybuffer' ? probeMagic(this.response) : '',
    }));
    return open.call(this, method, url, ...rest);
  };
  const realFetch = self.fetch;
  self.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    return realFetch.call(this, input, init).then(
      (r) => { probeReport({ kind: 'fetch', url, status: r.status }); return r; },
      (e) => { probeReport({ kind: 'fetch', url, ok: false, detail: String(e) }); throw e; },
    );
  };
  const RealModule = WebAssembly.Module;
  WebAssembly.Module = new Proxy(RealModule, {
    construct(target, args) {
      try {
        const m = Reflect.construct(target, args);
        probeReport({ kind: 'wasm', ok: true, detail: 'Module', bytes: args[0] && args[0].byteLength ? args[0].byteLength : 0 });
        return m;
      } catch (e) {
        probeReport({ kind: 'wasm', ok: false, detail: 'Module: ' + e });
        throw e;
      }
    },
  });
  for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
    const real = WebAssembly[name];
    if (typeof real !== 'function') continue;
    WebAssembly[name] = function (...args) {
      return real.apply(this, args).then(
        (r) => { probeReport({ kind: 'wasm', ok: true, detail: name }); return r; },
        (e) => { probeReport({ kind: 'wasm', ok: false, detail: name + ': ' + e }); throw e; },
      );
    };
  }
}
`;
