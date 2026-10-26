// The public Markdown corpus (docs/DESIGN.md#testing): P9, P10, P16 and P17 convert with zero unsupported-construct
// warnings and match hand-written expected structures; every emitted line maps to a source line. The Manubot
// rootstock fixture (P10's second fixture, CC BY 4.0) uses constructs outside the converter's dialect on purpose; its
// expected warnings are listed exactly. No pandoc anywhere: expected.json is written by hand.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { convertMarkdown } from '../../src/converter/markdownToLatex';
import { extractStructure, type Structure } from '../../src/converter/structure';
import { stubState } from '../support/helpers';
import { lineMapProblems, testDir } from './support';

interface Expected extends Structure {
  licence: string;
  unsupported: string[];
  contains?: string[];
  excludes?: string[];
}

const corpusDir = path.join(testDir, 'corpus');
const expected = JSON.parse(readFileSync(path.join(corpusDir, 'expected.json'), 'utf8')).documents as Record<string, Expected>;
const KEYS: (keyof Structure)[] = ['sections', 'figures', 'tables', 'tableCaptions', 'citations', 'footnotes', 'equations', 'labels', 'refs'];

describe('public Markdown corpus', () => {
  it('lists P9, P10, P16 and P17 (and P10b, the Manubot fixture)', () => {
    assert.deepEqual(Object.keys(expected).sort(), [
      'P10-paper.md',
      'P10b-manubot-rootstock.md',
      'P16-github-readme.md',
      'P17-obsidian-note.md',
      'P9-notes.md',
    ]);
  });

  for (const [file, want] of Object.entries(expected)) {
    describe(file, () => {
      const markdown = readFileSync(path.join(corpusDir, file), 'utf8');
      const result = convertMarkdown(markdown, { sourceName: file });
      const got = extractStructure(result.latex);

      for (const key of KEYS) {
        it(`matches the expected ${key}`, () => {
          assert.deepEqual(got[key], want[key]);
        });
      }

      it(want.unsupported.length === 0 ? 'converts with zero unsupported-construct warnings' : 'gives exactly the expected unsupported-construct warnings', () => {
        const codes = result.diagnostics
          .filter((d) => d.kind === 'unsupported')
          .map((d) => d.code)
          .sort();
        assert.deepEqual(codes, want.unsupported);
      });

      it('contains the expected LaTeX fragments', () => {
        for (const fragment of want.contains ?? []) {
          assert.ok(result.latex.includes(fragment), `missing: ${fragment}`);
        }
        for (const fragment of want.excludes ?? []) {
          assert.ok(!result.latex.includes(fragment), `should not appear: ${fragment}`);
        }
      });

      it('maps every emitted LaTeX line to a Markdown source line', () => {
        assert.deepEqual(lineMapProblems(result.latex, result.lineMap, markdown), []);
      });

      it('keeps the body in source order, one LaTeX line per Markdown line where the construct allows', () => {
        // Body lines map to non-decreasing source lines, except the few constructs that move text: a table
        // caption written after its table, and the bibliography.
        const body = result.lineMap.slice(result.bodyStartLine - 1);
        let backwards = 0;
        for (let i = 1; i < body.length; i++) {
          if (body[i] < body[i - 1]) {
            backwards++;
          }
        }
        assert.ok(backwards <= 6, `${backwards} backward steps in the body's line map`);
      });
    });
  }

  it('converts the whole corpus under the stubs, with no process started and no connection opened', () => {
    const state = stubState();
    state.clearBlocked();
    for (const file of Object.keys(expected)) {
      convertMarkdown(readFileSync(path.join(corpusDir, file), 'utf8'));
    }
    assert.deepEqual(state.blocked, []);
  });
});
