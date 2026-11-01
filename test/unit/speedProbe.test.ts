// The speed probe (src/engine-host/engine/speedProbe.ts; docs/DEVELOPING.md, "Measuring speed") must never reach a
// shipped build, and must never change a compile unless it is on: every switch is read only with
// LIVEMD2TEX_SPEED_PROBE=1, and a value off its list is ignored.

import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as off from '../../src/engine-host/engine/speedProbeOff';
import { root } from '../support/helpers';

const probePath = require.resolve('../../src/engine-host/engine/speedProbe');
type Probe = typeof import('../../src/engine-host/engine/speedProbe');

// The stand-in must fit everywhere the probe is used: a type error here means their shapes have drifted apart.
const standInFits: Probe = off;

/** Every .js file under `dir`. */
function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? scripts(full) : name.endsWith('.js') ? [full] : [];
  });
}

/** A fresh copy of the probe module, loaded with `env` set (and every other LIVEMD2TEX_SPEED_ variable removed). */
function loadProbe(env: Record<string, string>): Probe {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env).filter((k) => k.startsWith('LIVEMD2TEX_SPEED_'))) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[probePath];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the probe reads its variables when it loads, so each case loads a fresh copy
    return require(probePath) as Probe;
  } finally {
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('LIVEMD2TEX_SPEED_'))) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
    delete require.cache[probePath];
  }
}

describe('speed probe', () => {
  const stackLimit = Error.stackTraceLimit;
  afterEach(() => {
    Error.stackTraceLimit = stackLimit;
  });

  it('no shipped bundle holds the probe', function () {
    const dist = path.join(root, 'dist');
    if (!existsSync(path.join(dist, 'engine-worker.js'))) {
      this.skip();
    }
    // The private planning folder's name, built from parts so that this file does not name it.
    const privateFolder = ['plan', 'ning/'].join('');
    for (const file of scripts(dist)) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('LIVEMD2TEX_SPEED'), `${path.relative(root, file)} was built with --speed-probe: rebuild with node scripts/build.mjs`);
      assert.ok(!text.includes(privateFolder), `${path.relative(root, file)} names the private planning folder`);
    }
  });

  it('the stand-in, which ships, keeps the worker as it is without a probe', () => {
    assert.equal(standInFits.PROBE, false);
    assert.equal(off.synctexValue(), '1');
    assert.equal(off.lz4Slots(2), 2);
    assert.equal(off.lz4Slots(7), 7);
    assert.deepEqual(off.probeEnv(), {});
    assert.equal(off.restoreUpper(), false);
    assert.equal(off.restoreLazy(), false);
    assert.equal(off.threadCpuMs(), 0);
    assert.deepEqual(off.fileEntries(), {});
    assert.equal(off.switchValue(), undefined);
  });

  it('the stand-in exports the same names as the probe', () => {
    assert.deepEqual(Object.keys(off).sort(), Object.keys(loadProbe({})).sort());
  });

  it('with no variable set, changes nothing: arguments, environment, cache slots, restore', () => {
    const p = loadProbe({ LIVEMD2TEX_SPEED_SYNCTEX: '-1', LIVEMD2TEX_SPEED_LZ4SLOTS: '64', LIVEMD2TEX_SPEED_RESTORE: 'lazy-upper' });
    assert.equal(p.PROBE, false);
    assert.equal(p.synctexValue(), '1');
    assert.equal(p.lz4Slots(2), 2);
    assert.equal(p.restoreUpper(), false);
    assert.equal(p.restoreLazy(), false);
    assert.deepEqual(p.probeEnv(), {});
    p.applyJobSwitches('{"synctex":"-1","restore":"lazy"}');
    assert.equal(p.synctexValue(), '1');
    assert.equal(p.restoreLazy(), false);
    assert.equal(p.threadCpuMs(), 0);
    assert.deepEqual(p.fileEntries(), {});
  });

  it('with the probe on, values off the list are ignored and never throw', () => {
    const p = loadProbe({ LIVEMD2TEX_SPEED_PROBE: '1', LIVEMD2TEX_SPEED_LZ4SLOTS: 'abc', LIVEMD2TEX_SPEED_RESTORE: 'all', LIVEMD2TEX_SPEED_SYNCTEX: '2', LIVEMD2TEX_SPEED_STACKLIMIT: '-5' });
    assert.equal(p.PROBE, true);
    assert.equal(p.lz4Slots(2), 2);
    assert.equal(p.restoreUpper(), false);
    assert.equal(p.synctexValue(), '1');
    p.applyJobSwitches('not json');
    p.applyJobSwitches('{"restore":3,"lz4slots":"64","unknown":"x"}');
    assert.equal(p.restoreUpper(), false);
    assert.equal(p.lz4Slots(2), 2, 'a job cannot set an environment-only switch');
    assert.equal(Error.stackTraceLimit, stackLimit);
  });

  it('with the probe on, a job switches only its own run', () => {
    const p = loadProbe({ LIVEMD2TEX_SPEED_PROBE: '1', LIVEMD2TEX_SPEED_LZ4SLOTS: '64' });
    assert.equal(p.lz4Slots(2), 64);
    assert.deepEqual(p.probeEnv(), { SOURCE_DATE_EPOCH: '1700000000', FORCE_SOURCE_DATE: '1' });
    p.applyJobSwitches('{"restore":"lazy-upper","synctex":"-1","stacklimit":"0"}');
    assert.equal(p.restoreLazy(), true);
    assert.equal(p.restoreUpper(), true);
    assert.equal(p.synctexValue(), '-1');
    assert.equal(Error.stackTraceLimit, 0);
    p.applyJobSwitches(null);
    assert.equal(p.restoreLazy(), false);
    assert.equal(p.synctexValue(), '1');
    assert.equal(Error.stackTraceLimit, stackLimit);
  });
});
