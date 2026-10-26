// M2-B: the High Contrast colour mapping of the PDF viewer (src/shared/pageColors.ts, docs/DESIGN.md#accessibility).

import * as assert from 'node:assert/strict';
import { cssColorToHex, pageColorsFor } from '../../src/shared/pageColors';

describe('M2-B: High Contrast page colours', () => {
  it('reads the colour forms VS Code writes into theme variables', () => {
    assert.equal(cssColorToHex('#000000'), '#000000');
    assert.equal(cssColorToHex(' #FFF '), '#ffffff');
    assert.equal(cssColorToHex('#fffa'), '#ffffff'); // short form with alpha
    assert.equal(cssColorToHex('#0b0b0bcc'), '#0b0b0b'); // alpha dropped
    assert.equal(cssColorToHex('rgb(255, 255, 0)'), '#ffff00');
    assert.equal(cssColorToHex('rgba(0, 128, 255, 0.5)'), '#0080ff');
    assert.equal(cssColorToHex('rgb(255 0 12 / 50%)'), '#ff000c'); // the space-separated form
    assert.equal(cssColorToHex('canvastext'), undefined);
    assert.equal(cssColorToHex(''), undefined);
  });

  it('maps the High Contrast dark and light themes to pdf.js pageColors, behind the toggle', () => {
    assert.deepEqual(pageColorsFor(true, true, '#000000', '#ffffff'), { background: '#000000', foreground: '#ffffff' });
    assert.deepEqual(pageColorsFor(true, true, '#ffffff', '#292929'), { background: '#ffffff', foreground: '#292929' });
    assert.equal(pageColorsFor(true, false, '#000000', '#ffffff'), null, 'the toggle is off');
    assert.equal(pageColorsFor(false, true, '#1e1e1e', '#d4d4d4'), null, 'not a High Contrast theme');
  });

  it('keeps the pages as they are when a theme colour cannot be read, or both are the same', () => {
    assert.equal(pageColorsFor(true, true, 'var(--x)', '#ffffff'), null);
    assert.equal(pageColorsFor(true, true, '#000', '#000000'), null);
  });
});
