// Where the patched engine glue lives outside the repository: <engine_assets>/derived/<first 16 hex digits of its
// SHA-256>/busytex.patched.js. The folder is keyed by the glue's own hash, which engine/pins.json pins
// (patchedGlue.sha256), so worktrees with different patches never share one file: scripts/engine-patch.mjs writes
// each glue into its own folder, and stage-engine, the engine tests and the bundle builder read only the folder of
// the glue their pins name. The one assets folder is shared by every worktree; nothing in it is ever overwritten
// with other bytes.

import path from 'node:path';

/** The folder name for a glue with this SHA-256. */
export const glueKey = (sha256) => {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
    throw new Error(`the patched glue's SHA-256 "${sha256}" is not a SHA-256`);
  }
  return sha256.slice(0, 16);
};

/** The path, relative to the assets folder, of the glue with this SHA-256. */
export const derivedGlueFile = (sha256) => `derived/${glueKey(sha256)}/busytex.patched.js`;

/** The pinned patched glue's path in the assets folder, from engine/pins.json's contents. */
export function pinnedGluePath(assetsRoot, pins) {
  const sha256 = pins.sources.find((s) => s.id === 'texlyre-busytex')?.patchedGlue?.sha256;
  return path.join(assetsRoot, ...derivedGlueFile(sha256).split('/'));
}
