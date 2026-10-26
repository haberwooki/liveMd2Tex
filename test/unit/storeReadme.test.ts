// The store page (docs/DESIGN.md#store-and-packaging): vsce publishes README.md as the Marketplace and Open VSX
// page, so it is for users only. Building, testing and the notes on each part are in docs/DEVELOPING.md. The
// package's description is user text too.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { root } from '../support/helpers';

const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const headings = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
/** Milestone and gate names, which belong to the developer notes. */
const MILESTONE = /\b(C0a|C0b|S1|S3|V0|M[0-9]|M2-[AB]|G0|B1)\b/;

describe('the store page (README.md)', () => {
  it('has no developer sections: no milestone in a heading, no build or test sections', () => {
    for (const h of headings) {
      assert.doesNotMatch(h, MILESTONE, `heading "${h}"`);
      assert.doesNotMatch(h, /developers|install, build|private test|integration tests|\bCI\b|engine \(|rules the checks/i, `heading "${h}"`);
    }
    assert.doesNotMatch(readme, /^#{3,} /m, 'only top-level and second-level headings');
  });

  it('names no build or test commands', () => {
    assert.doesNotMatch(readme, /npm (ci|run|install)|node scripts\/|mocha|test-cli/);
    assert.doesNotMatch(readme, /\btest\/(unit|engine|integration|converter)\//);
  });

  it('points developers to docs/DEVELOPING.md, which holds the developer sections', () => {
    assert.match(readme, /docs\/DEVELOPING\.md/);
    const developing = path.join(root, 'docs', 'DEVELOPING.md');
    assert.ok(existsSync(developing));
    const text = readFileSync(developing, 'utf8');
    for (const h of ['## What you need', '## Install, build, check', '## The rules the checks enforce', '## The CC0 files']) {
      assert.ok(text.includes(`\n${h}\n`), `docs/DEVELOPING.md has no "${h}"`);
    }
  });

  it("keeps the package's description user text", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { description: string };
    assert.doesNotMatch(pkg.description, /npm|test|milestone|development|laptop/i);
  });
});
