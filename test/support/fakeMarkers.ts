// Made-up private markers for the tests of the marker scan (scripts/marker-scan.mjs). The real markers are never in
// the repository, in any form (build gate 2, G2S-01): they live in a git-ignored file on the laptop and in a CI
// secret. The ids match the real ones, so the allow-list rules (scripts/marker-allowlist.json) apply to them.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const FAKE_MARKERS = [
  { id: 'surname', kind: 'text', value: 'Zebrowski' },
  { id: 'laptop-user-path', kind: 'user-path', value: 'zbuser' },
  { id: 'coauthor-given-name', kind: 'word', value: 'Quill' },
  { id: 'coauthor-surname', kind: 'word', value: 'Marrow' },
  { id: 'coauthor-handle', kind: 'text', value: 'qmarrow' },
  { id: 'manuscript-name', kind: 'text', value: '_qm_draft' },
  { id: 'commit-hash', kind: 'text', value: 'f00dbab' },
];

export const fake = (id: string) => (FAKE_MARKERS.find((m) => m.id === id) as { value: string }).value;

/** A folder whose .private-markers.json holds the made-up markers (its parent folder holds none). */
export function fakeMarkerFolder(): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'livemd2tex-markers-')), 'repo');
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, '.private-markers.json'), JSON.stringify({ markers: FAKE_MARKERS }));
  return dir;
}
