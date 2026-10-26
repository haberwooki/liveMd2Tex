// The live preview's scheduler (src/extension/compile/scheduler.ts) with a scripted runner: when compiles start,
// which pass they run, the cancel rule and its exception for the first compile, merging, on-save mode and the
// watchdog. The scheduler runs on a fake clock, so the tests do not depend on the machine's speed (G1E-17).

import * as assert from 'node:assert/strict';
import { CompileScheduler, type CompileOutcome, type CompileRequest } from '../../src/extension/compile/scheduler';

/** Lets the promise callbacks that are ready run (the scheduler's own continuations). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fake clock: time moves only in advance(), which fires the due timers in order. */
class FakeClock {
  private t = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  readonly now = () => this.t;
  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  readonly clear = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) {
        break;
      }
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
    await flush();
  }
}

interface Harness {
  clock: FakeClock;
  logs: string[];
  watchdogs: [string, number][];
  scheduler: CompileScheduler;
  started: CompileRequest[];
  cancels: number;
  /** Finishes the running compile with `outcome` (default: a PDF). */
  finish(outcome?: Partial<CompileOutcome>): void;
  mode: 'pause' | 'save';
  withState: Set<string>;
}

function harness(pauseMs = 40, watchdogMs?: number): Harness {
  let resolveRunning: ((o: CompileOutcome) => void) | null = null;
  const clock = new FakeClock();
  const h: Harness = {
    clock,
    logs: [],
    watchdogs: [],
    started: [],
    cancels: 0,
    mode: 'pause',
    withState: new Set(),
    finish(outcome = {}) {
      const r = resolveRunning;
      resolveRunning = null;
      r?.({ cancelled: false, pdf: true, wantsFullPass: false, ...outcome });
    },
    scheduler: undefined as unknown as CompileScheduler,
  };
  h.scheduler = new CompileScheduler({
    pauseMs: () => pauseMs,
    mode: () => h.mode,
    hasState: (key) => h.withState.has(key),
    run: (request) =>
      new Promise<CompileOutcome>((resolve) => {
        h.started.push(request);
        resolveRunning = (o) => {
          if (!o.cancelled && o.pdf) {
            h.withState.add(request.key);
          }
          resolve(o);
        };
      }),
    cancelRunning: () => {
      h.cancels++;
      // The engine answers a cancel by settling the running compile as cancelled.
      const r = resolveRunning;
      resolveRunning = null;
      r?.({ cancelled: true, pdf: false, wantsFullPass: false });
    },
    now: clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    watchdogMs: watchdogMs === undefined ? undefined : () => watchdogMs,
    log: (line) => h.logs.push(line),
    onWatchdog: (key, ms) => h.watchdogs.push([key, ms]),
  });
  return h;
}

describe('scheduler: when the live preview compiles', () => {
  it('waits for a pause: a burst of edits makes one compile, after the last edit', async () => {
    const h = harness(40);
    h.withState.add('a');
    for (let i = 0; i < 5; i++) {
      h.scheduler.edit('a');
      await h.clock.advance(10);
    }
    assert.equal(h.started.length, 0, 'compiled during the burst');
    await h.clock.advance(60);
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].kind, 'quick');
    assert.equal(h.started[0].save, false);
    assert.equal(h.started[0].generation, 5);
    assert.ok(h.started[0].lastEditAt !== null);
    h.finish();
    h.scheduler.dispose();
  });

  it('a document without auxiliary state gets a full pass even for an edit', async () => {
    const h = harness(20);
    h.scheduler.edit('fresh');
    await h.clock.advance(40);
    assert.equal(h.started[0].kind, 'full');
    assert.equal(h.started[0].first, true);
    h.finish();
    h.scheduler.dispose();
  });

  it('never cancels the first compile; a newer edit then waits for it', async () => {
    const h = harness(20);
    h.scheduler.edit('a');
    await h.clock.advance(40);
    assert.equal(h.started.length, 1);
    h.scheduler.edit('a');
    await h.clock.advance(40);
    assert.equal(h.cancels, 0, 'the first compile was cancelled');
    assert.equal(h.started.length, 1, 'a second compile started while the first ran');
    h.finish();
    await h.clock.advance(5);
    assert.equal(h.started.length, 2, 'the newer edit did not compile after the first finished');
    assert.equal(h.started[1].first, false);
    h.finish();
    h.scheduler.dispose();
  });

  it('a newer edit cancels a later compile, and its replacement inherits the pass kind and the save', async () => {
    const h = harness(20);
    h.withState.add('a');
    h.scheduler.request('a', true);
    await h.clock.advance(5);
    h.finish();
    h.scheduler.save('a');
    await h.clock.advance(200);
    assert.equal(h.started.length, 2);
    assert.equal(h.started[1].kind, 'full');
    assert.equal(h.started[1].save, true);
    assert.equal(h.started[1].superseded(), false);
    h.scheduler.edit('a');
    assert.equal(h.started[1].superseded(), true);
    assert.equal(h.cancels, 1, 'the running compile was not cancelled');
    await h.clock.advance(40);
    assert.equal(h.started.length, 3);
    assert.equal(h.started[2].kind, 'full', 'the cancelled full pass was lost');
    assert.equal(h.started[2].save, true, 'the cancelled save was lost');
    assert.deepEqual(h.started[2].triggers.sort(), ['edit', 'save']);
    h.finish();
    h.scheduler.dispose();
  });

  it('an edit of another document does not cancel the running compile', async () => {
    const h = harness(20);
    h.withState.add('a');
    h.withState.add('b');
    h.scheduler.request('a');
    await h.clock.advance(5);
    h.finish();
    h.scheduler.edit('a');
    await h.clock.advance(40);
    assert.equal(h.started.length, 2);
    h.scheduler.edit('b');
    await h.clock.advance(40);
    assert.equal(h.cancels, 0);
    assert.equal(h.started.length, 2, 'two compiles ran at once');
    h.finish();
    await h.clock.advance(5);
    assert.equal(h.started[2].key, 'b');
    h.finish();
    h.scheduler.dispose();
  });

  it('a quick pass whose log asks for a rerun or for bibtex8 is followed by a full pass; a full pass is not', async () => {
    const h = harness(20);
    h.withState.add('a');
    h.scheduler.edit('a');
    await h.clock.advance(40);
    h.finish({ wantsFullPass: true });
    await h.clock.advance(5);
    assert.equal(h.started.length, 2);
    assert.equal(h.started[1].kind, 'full');
    assert.deepEqual(h.started[1].triggers, ['rerun']);
    h.finish({ wantsFullPass: true });
    await h.clock.advance(20);
    assert.equal(h.started.length, 2, 'a full pass was followed by another');
    h.scheduler.dispose();
  });

  it('a save asks for a full pass that writes the PDF; a changed .bib or figure asks for a full pass', async () => {
    const h = harness(1000);
    h.withState.add('a');
    h.scheduler.save('a');
    await h.clock.advance(200);
    assert.deepEqual([h.started[0].kind, h.started[0].save], ['full', true]);
    h.finish();
    h.scheduler.fileChanged('a', 'full');
    await h.clock.advance(350);
    assert.deepEqual([h.started[1].kind, h.started[1].save, h.started[1].triggers], ['full', false, ['file']]);
    h.finish();
    h.scheduler.dispose();
  });

  it('"on save" mode ignores edits but still compiles saves', async () => {
    const h = harness(20);
    h.mode = 'save';
    h.scheduler.edit('a');
    await h.clock.advance(40);
    assert.equal(h.started.length, 0);
    h.scheduler.save('a');
    await h.clock.advance(200);
    assert.equal(h.started.length, 1);
    h.finish();
    h.scheduler.dispose();
  });

  it('generation numbers rise with every event, per document', () => {
    const h = harness(1000);
    h.scheduler.edit('a');
    h.scheduler.edit('a');
    h.scheduler.save('b');
    assert.equal(h.scheduler.generation('a'), 2);
    assert.equal(h.scheduler.generation('b'), 1);
    h.scheduler.dispose();
  });

  it('a compile that never finishes is cancelled and released by the watchdog; the next one runs (G1E-09)', async () => {
    const h = harness(20, 5000);
    h.withState.add('a');
    h.withState.add('b');
    h.scheduler.edit('a');
    await h.clock.advance(20);
    assert.equal(h.started.length, 1);
    // Compile a never finishes (a viewer that never answers, say); an edit of b waits behind it.
    const cancelsBefore = h.cancels;
    h.scheduler.edit('b');
    await h.clock.advance(4000);
    assert.equal(h.started.length, 1, 'b started while a was running');
    await h.clock.advance(1000);
    assert.equal(h.cancels, cancelsBefore + 1, 'the watchdog did not cancel the stuck compile');
    assert.ok(h.logs.some((l) => /did not finish in 5 s; cancelled and released/.test(l)), JSON.stringify(h.logs));
    assert.deepEqual(h.watchdogs, [['a', 5000]]);
    assert.equal(h.started.length, 2, 'the next compile did not start after the watchdog');
    assert.equal(h.started[1].key, 'b');
    h.finish();
    h.scheduler.dispose();
  });

  it('a tool job (a package build) and a live compile never cancel each other (G2E-01)', async () => {
    const h = harness(20);
    h.withState.add('a');
    // A compile runs; then a package build is asked for: it waits for the slot, and the compile is not cancelled.
    h.scheduler.edit('a');
    await h.clock.advance(20);
    assert.equal(h.started.length, 1);
    let toolStarted = false;
    let toolDone: (v: string) => void = () => undefined;
    const tool = h.scheduler.runTool('docstrip x.ins', () => {
      toolStarted = true;
      return new Promise<string>((resolve) => (toolDone = resolve));
    });
    await h.clock.advance(5);
    assert.equal(toolStarted, false, 'the tool job started while a compile ran');
    assert.equal(h.cancels, 0);
    h.finish();
    await h.clock.advance(1);
    assert.equal(toolStarted, true);
    // Typing while the build runs: the edit's compile waits for the build, and nothing is cancelled.
    h.scheduler.edit('a');
    await h.clock.advance(40);
    assert.equal(h.cancels, 0, 'an edit cancelled the tool job');
    assert.equal(h.started.length, 1, 'a compile started while the tool job ran');
    toolDone('built');
    assert.equal(await tool, 'built');
    await h.clock.advance(1);
    assert.equal(h.started.length, 2, 'the waiting compile did not run after the tool job');
    h.finish();
    h.scheduler.dispose();
  });

  it('tool jobs go before waiting compiles, and a stopped scheduler refuses them', async () => {
    const h = harness(20);
    h.withState.add('a');
    h.scheduler.edit('a');
    const order: string[] = [];
    void h.scheduler.runTool('t', async () => {
      order.push('tool');
    });
    await h.clock.advance(1);
    assert.deepEqual(order, ['tool']);
    await h.clock.advance(20);
    assert.equal(h.started.length, 1);
    h.finish();
    h.scheduler.dispose();
    await assert.rejects(h.scheduler.runTool('late', async () => 1), /stopped/);
  });
});
