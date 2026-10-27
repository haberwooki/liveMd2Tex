// The clock checks the timed tests share (test/support/clock.ts): under the fixed limit, or within a multiple of a
// reference measured under the same load; a real slowdown fails both.

import * as assert from 'node:assert/strict';
import { clockMessage, timeOf, withinClock } from '../support/clock';

describe('clock checks that a busy machine cannot break (test/support/clock.ts)', () => {
  it('passes under the fixed limit, or within the multiple of the reference, and fails past both', () => {
    assert.equal(withinClock(150, 200, 1, 10), true, 'under the fixed limit');
    assert.equal(withinClock(900, 200, 100, 10), true, 'a busy machine: over the limit, but the reference slowed too');
    assert.equal(withinClock(5000, 200, 100, 10), false, 'a real slowdown: past both');
    assert.equal(withinClock(200, 200, 20, 10), false, 'both bounds are strict');
    assert.equal(clockMessage('x', 5000.4, 200, 100, 10), 'x: 5000 ms, over 200 ms and over 10 x the reference of 100.0 ms');
  });

  it('times a function', () => {
    let ran = false;
    const ms = timeOf(() => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.ok(ms >= 0 && ms < 1000, String(ms));
  });
});
