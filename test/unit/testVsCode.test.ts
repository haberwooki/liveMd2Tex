// Which VS Code the integration tests use (scripts/lib/test-vscode.mjs; build gate 1, G1E-20): the installed one
// on the laptop, never a download; a downloaded one on CI only when the workflow allows it.

import * as assert from 'node:assert/strict';
import { importScript } from '../support/helpers';

type Choice = { download: false; executable: string | undefined } | { download: true; version: string };

describe('the VS Code of the integration tests (G1E-20)', () => {
  let testVsCode: (env: Record<string, string | undefined>) => Choice;
  before(async () => {
    ({ testVsCode } = await importScript<{ testVsCode: typeof testVsCode }>('scripts/lib/test-vscode.mjs'));
  });

  it('downloads only when CI=true and the workflow allows it, in the version it names', () => {
    assert.deepEqual(testVsCode({ CI: 'true', LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD: '1', LIVEMD2TEX_VSCODE_VERSION: '1.105.0' }), { download: true, version: '1.105.0' });
    assert.deepEqual(testVsCode({ CI: 'true', LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD: '1' }), { download: true, version: 'stable' });
  });

  it('never downloads on the laptop, even with one of the two variables set', () => {
    for (const env of [{}, { CI: 'true' }, { LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD: '1' }, { CI: '1', LIVEMD2TEX_ALLOW_VSCODE_DOWNLOAD: '1' }]) {
      assert.equal(testVsCode({ ...env, VSCODE_TEST_EXECUTABLE: __filename }).download, false, JSON.stringify(env));
    }
    assert.deepEqual(testVsCode({ VSCODE_TEST_EXECUTABLE: __filename }), { download: false, executable: __filename });
  });
});
