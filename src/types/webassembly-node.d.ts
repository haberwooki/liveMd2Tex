// The part of the WebAssembly API the Node-side code uses. TypeScript ships WebAssembly's types only in its
// "dom" and "webworker" libraries, which would also declare browser globals for code that runs in Node.
declare namespace WebAssembly {
  interface Module {
    readonly __wasmModuleBrand?: never;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  interface WebAssemblyInstantiatedSource {
    instance: Instance;
    module: Module;
  }
  type Imports = Record<string, Record<string, unknown>>;
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
  function instantiate(bytes: ArrayBufferView | ArrayBuffer, imports?: Imports): Promise<WebAssemblyInstantiatedSource>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
}
