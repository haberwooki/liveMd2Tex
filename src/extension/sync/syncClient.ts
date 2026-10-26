// The extension host's handle on the SyncTeX worker (src/synctex/worker.ts): started on first use, one thread
// for every preview, stopped with the extension. No VS Code API here, so Node tests drive it too.

import { Worker } from 'node:worker_threads';
import type { ForwardResult } from '../../synctex/parser';
import type { InverseAnswer, LoadResult, SyncRequest, SyncResponse, SyncResult } from '../../synctex/protocol';

type Body<T extends SyncRequest['type']> = Omit<Extract<SyncRequest, { type: T }>, 'id'>;

export class SyncClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: SyncResult) => void; reject: (e: Error) => void }>();

  /** `workerFile`: dist/synctex-worker.js inside the extension. */
  constructor(private readonly workerFile: string) {}

  private start(): Worker {
    if (!this.worker) {
      const worker = new Worker(this.workerFile);
      worker.on('message', (msg: SyncResponse) => {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.ok) {
            p.resolve(msg.result);
          } else {
            p.reject(new Error(msg.error));
          }
        }
      });
      const fail = (err: Error) => {
        for (const [, p] of this.pending) {
          p.reject(err);
        }
        this.pending.clear();
        if (this.worker === worker) {
          this.worker = undefined;
        }
      };
      worker.on('error', fail);
      worker.on('exit', (code) => fail(new Error(`the SyncTeX worker stopped (exit code ${code})`)));
      this.worker = worker;
    }
    return this.worker;
  }

  private send<T extends SyncRequest['type']>(body: Body<T>): Promise<SyncResult> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise<SyncResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...body, id } as SyncRequest);
    });
  }

  /** Parses a compile's .synctex(.gz) bytes for the preview `key`, replacing the previous one. */
  async load(key: string, data: Uint8Array): Promise<LoadResult> {
    return (await this.send<'load'>({ type: 'load', key, data })) as LoadResult;
  }

  /** The source of a point on a page (PDF points, top-left origin). */
  async inverse(key: string, page: number, x: number, y: number): Promise<InverseAnswer | null> {
    return (await this.send<'inverse'>({ type: 'inverse', key, page, x, y })) as InverseAnswer | null;
  }

  /** The PDF lines of a source line; `file` relative to the project folder. */
  async forward(key: string, file: string, line: number): Promise<ForwardResult | null> {
    return (await this.send<'forward'>({ type: 'forward', key, file, line })) as ForwardResult | null;
  }

  async drop(key: string): Promise<void> {
    if (this.worker) {
      await this.send<'drop'>({ type: 'drop', key });
    }
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
