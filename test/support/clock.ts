// Clock checks that a busy machine cannot break (the licence re-gate's timing failure, S2). A test that bounds work
// on the clock passes when the work took less than its fixed limit, as before, or less than a multiple of a
// reference: similar work, measured in the same test just before or after, which a busy machine slows down as
// much. A real slowdown, such as a pattern that backtracks or a pass that turns quadratic, fails both.

/** Milliseconds a function takes. */
export function timeOf(f: () => void): number {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
}

/**
 * Whether work that took `elapsed` ms is within the clock: under `ms`, or under `factor` times `reference`, the time
 * of similar work measured under the same load.
 */
export function withinClock(elapsed: number, ms: number, reference: number, factor: number): boolean {
  return elapsed < ms || elapsed < factor * reference;
}

/** The message of a clock check: the time, the limit and the reference. */
export function clockMessage(what: string, elapsed: number, ms: number, reference: number, factor: number): string {
  return `${what}: ${Math.round(elapsed)} ms, over ${ms} ms and over ${factor} x the reference of ${reference.toFixed(1)} ms`;
}
