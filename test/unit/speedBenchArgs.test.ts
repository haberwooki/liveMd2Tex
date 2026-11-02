// The benchmark's options and start-load report (test/speed/benchArgs.ts; docs/DEVELOPING.md, "Measuring speed"):
// a flag as a value where one is due, and a clear stop on anything missing, wrong or unknown.

import * as assert from 'node:assert/strict';
import { parseBenchArgs, parseStartLoad } from '../speed/benchArgs';

describe('speed benchmark options (benchArgs.ts)', () => {
  it('takes a flag as the value of --host-arg and --ab-host, repeatedly', () => {
    const a = parseBenchArgs(['--host-arg', '--cpu-prof', '--host-arg', '--cpu-prof-dir=x', '--ab-host', '--no-liftoff']);
    assert.deepEqual(a.hostArgs, ['--cpu-prof', '--cpu-prof-dir=x']);
    assert.deepEqual(a.abHost, ['--no-liftoff']);
    assert.equal(a.abHostGiven, true);
    const none = parseBenchArgs(['--ab-host', 'none']);
    assert.deepEqual(none.abHost, []);
    assert.equal(none.abHostGiven, true);
    assert.equal(parseBenchArgs([]).abHostGiven, false);
  });

  it('stops on a missing value, or another option where a plain value is due', () => {
    assert.throws(() => parseBenchArgs(['--host-arg']), /--host-arg needs a value/);
    assert.throws(() => parseBenchArgs(['--label', '--quick', '3']), /--label needs a value/);
    assert.throws(() => parseBenchArgs(['--quick']), /--quick needs a value/);
    assert.throws(() => parseBenchArgs(['--data', '']), /--data needs a value/);
  });

  it('stops on a count that is not a whole number of at least 1, and on numbers out of range', () => {
    assert.throws(() => parseBenchArgs(['--quick', 'abc']), /--quick needs a whole number/);
    assert.throws(() => parseBenchArgs(['--quick', '0']), /--quick needs a whole number from 1/);
    assert.throws(() => parseBenchArgs(['--cold', '-3']), /--cold needs a whole number/);
    assert.throws(() => parseBenchArgs(['--save', '2.5']), /--save needs a whole number/);
    assert.throws(() => parseBenchArgs(['--max-busy', '140']), /--max-busy needs a number from 0 to 100/);
    assert.throws(() => parseBenchArgs(['--retries', '-1']), /--retries needs a whole number/);
    assert.throws(() => parseBenchArgs(['--restart-every', '0']), /--restart-every needs a whole number from 1/);
    const a = parseBenchArgs(['--quick', '16', '--pause', '0', '--retries', '1', '--min-free-mb', '1000', '--restart-every', '4']);
    assert.equal(a.reps.quick, 16);
    assert.equal(a.pauseMs, 0);
    assert.equal(a.retries, 1);
    assert.equal(a.restartEvery, 4);
  });

  it('restarts two hosts every 4 pairs and needs 3,000 MB free at the start by default', () => {
    const d = parseBenchArgs([]);
    assert.equal(d.restartEvery, 4);
    assert.equal(d.minStartFreeMB, 3000);
    assert.equal(parseBenchArgs(['--restart-every', '8', '--min-start-free-mb', '2000']).restartEvery, 8);
    assert.equal(parseBenchArgs(['--min-start-free-mb', '2000']).minStartFreeMB, 2000);
    assert.throws(() => parseBenchArgs(['--min-start-free-mb', 'lots']), /--min-start-free-mb needs a number/);
  });

  it('stops on an unknown mode, an unknown option and a malformed --ab-env', () => {
    assert.throws(() => parseBenchArgs(['--modes', 'quick,fast']), /unknown mode fast/);
    assert.throws(() => parseBenchArgs(['--quik', '3']), /unknown argument --quik/);
    assert.throws(() => parseBenchArgs(['--ab-env', 'LIVEMD2TEX_SPEED_PROBE']), /--ab-env needs KEY=VALUE/);
    assert.deepEqual(parseBenchArgs(['--ab-env', 'A=b=c']).abEnv, { A: 'b=c' });
  });
});

describe('speed benchmark start load (parseStartLoad)', () => {
  it('reads the three fields and leaves out a value the script could not read', () => {
    assert.equal(parseStartLoad(undefined), undefined);
    assert.deepEqual(parseStartLoad('{"wslLoad":0.4,"windowsCpuPct":12,"power":"mains"}'), { wslLoad: 0.4, windowsCpuPct: 12, power: 'mains' });
    // A calling script writes null when it could not read WSL's load; compare.js then says it was not reported.
    assert.deepEqual(parseStartLoad('{"wslLoad":null,"windowsCpuPct":12,"power":"mains"}'), { windowsCpuPct: 12, power: 'mains' });
  });

  it('stops on a field of the wrong type, an unknown field, or text that is not a JSON object', () => {
    assert.throws(() => parseStartLoad('{"wslLoad":"1.4"}'), /wslLoad must be a number/);
    assert.throws(() => parseStartLoad('{"windowsCpuPct":-5}'), /windowsCpuPct must be a number/);
    assert.throws(() => parseStartLoad('{"power":1}'), /power must be text/);
    assert.throws(() => parseStartLoad('{"wsl":0.4}'), /unknown field wsl/);
    assert.throws(() => parseStartLoad('[0.4]'), /must be a JSON object/);
    assert.throws(() => parseStartLoad('wsl 0.4'), /is not JSON/);
  });
});
