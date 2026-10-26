// The extension host's handle on the engine host: start it, exchange messages, stop it. Requests never start
// the process: whoever owns the host (EngineService) starts it and loads the engine, so a host that died is
// never replaced by one without the engine (build gate 1, G1E-06). Free of the vscode module so that unit tests
// run it under plain Node.

import { forkEngineHost } from './engineHostFork';
import type { CompileJob, CompileResult, EngineAssetPaths, EngineInitInfo, EngineMemory } from '../shared/engineJobs';
import type { EngineReady, FromEngine, StubReport, ToEngine } from '../shared/engineProtocol';

export interface EngineHostOptions {
  modulePath: string;
  execArgv?: readonly string[];
  execPath?: string;
  serialization?: 'advanced' | 'json';
  log?: (line: string) => void;
  /** How long start() waits for the child's 'ready' message. */
  startTimeoutMs?: number;
  /** How long a request waits for its answer. */
  requestTimeoutMs?: number;
}

type Child = ReturnType<typeof forkEngineHost>;
type Answer = Exclude<FromEngine, EngineReady | { type: 'error' }>;
interface Pending {
  resolve: (msg: Answer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class EngineHost {
  private child: Child | undefined;
  private ready: Promise<EngineReady> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private exitInfo: { code: number | null; signal: string | null } | undefined;

  constructor(private readonly options: EngineHostOptions) {}

  get running(): boolean {
    return this.child !== undefined && this.exitInfo === undefined;
  }

  /** Starts the engine host if it is not running and resolves with its 'ready' message. */
  start(): Promise<EngineReady> {
    if (this.ready && this.running) {
      return this.ready;
    }
    this.exitInfo = undefined;
    const log = this.options.log ?? (() => undefined);
    const child = forkEngineHost({
      modulePath: this.options.modulePath,
      execArgv: this.options.execArgv,
      execPath: this.options.execPath,
      serialization: this.options.serialization,
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => log(`[engine-host] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => log(`[engine-host:err] ${d.toString().trimEnd()}`));

    this.ready = new Promise<EngineReady>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The engine host did not report ready in time.')),
        this.options.startTimeoutMs ?? 20000,
      );
      child.on('message', (raw: unknown) => {
        const msg = raw as FromEngine;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        this.onAnswer(msg);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.exitInfo = { code, signal };
        reject(new Error(`The engine host exited before it was ready (code ${code}, signal ${signal}).`));
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('The engine host exited.'));
        }
        this.pending.clear();
        log(`engine host exited (code ${code}, signal ${signal})`);
      });
    });
    return this.ready;
  }

  private onAnswer(msg: FromEngine): void {
    if (msg.type === 'ready') {
      return;
    }
    if (msg.type === 'error') {
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (p && msg.id !== undefined) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.reject(new Error(msg.message));
      } else {
        this.options.log?.(`[engine-host] error: ${msg.message}`);
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
    }
  }

  private async request<T extends Answer['type']>(
    build: (id: number) => Exclude<ToEngine, { type: 'shutdown' }>,
    expect: T,
    timeoutMs = this.options.requestTimeoutMs ?? 20000,
  ): Promise<Extract<Answer, { type: T }>> {
    const child = this.child;
    if (!child || !this.ready || !this.running) {
      throw new Error('The engine host is not running.');
    }
    await this.ready;
    const id = this.nextId++;
    const answer = await new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The engine host did not answer request ${id} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send(build(id));
    });
    if (answer.type !== expect) {
      throw new Error(`Expected a '${expect}' answer, got '${answer.type}'.`);
    }
    return answer as Extract<Answer, { type: T }>;
  }

  async ping(payload: string): Promise<string> {
    return (await this.request((id) => ({ type: 'ping', id, payload }), 'pong')).payload;
  }

  async wasmCheck(): Promise<number> {
    return (await this.request((id) => ({ type: 'wasmCheck', id }), 'wasmCheck')).result;
  }

  /** Loads the engine: compiles the WebAssembly module and reads the image (once per engine host). */
  async init(assets: EngineAssetPaths, timeoutMs = 120000): Promise<EngineInitInfo> {
    return (await this.request((id) => ({ type: 'init', id, assets }), 'init', timeoutMs)).info;
  }

  async compile(job: CompileJob, timeoutMs = 600000): Promise<CompileResult> {
    return (await this.request((id) => ({ type: 'compile', id, job }), 'compile', timeoutMs)).result;
  }

  /** Cancels job `jobId`'s compile (any running compile without it). */
  async cancel(jobId?: number): Promise<boolean> {
    return (await this.request((id) => ({ type: 'cancel', id, jobId }), 'cancel')).cancelled;
  }

  async memory(): Promise<EngineMemory> {
    return (await this.request((id) => ({ type: 'memory', id }), 'memory')).memory;
  }

  /** Forgets a project's kept files in the engine host. */
  async dropProject(key: string): Promise<boolean> {
    return (await this.request((id) => ({ type: 'dropProject', id, key }), 'dropProject')).dropped;
  }

  async stubReport(): Promise<StubReport | null> {
    return (await this.request((id) => ({ type: 'stubReport', id }), 'stubReport')).report;
  }

  /** Asks the engine host to exit; kills it if it has not exited after the grace period. */
  async stop(graceMs = 3000): Promise<{ code: number | null; signal: string | null } | undefined> {
    const child = this.child;
    if (!child || this.exitInfo) {
      return this.exitInfo;
    }
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // The 'ready' promise rejects when the child exits; that is expected here.
    this.ready?.catch(() => undefined);
    if (child.connected) {
      child.send({ type: 'shutdown' } satisfies ToEngine);
    }
    const timer = setTimeout(() => child.kill(), graceMs);
    const info = await exited;
    clearTimeout(timer);
    this.child = undefined;
    this.ready = undefined;
    return info;
  }
}
