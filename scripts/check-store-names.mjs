#!/usr/bin/env node
// Development tool (never shipped): checks that extension IDs are free on the VS Code Marketplace and on
// Open VSX, using their public read APIs (docs/DESIGN.md#store-and-packaging). It reads the real names from package.json:
// haberwooki.livemd2tex and its two data extensions, livemd2tex-core-data and livemd2tex-extra-data.
//
//   node scripts/check-store-names.mjs                 # the IDs in package.json plus the data-package IDs
//   node scripts/check-store-names.mjs pub.name ...    # any IDs
//
// A known extension is queried first as a positive control, so "free" cannot come from a broken query.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// The store shape of docs/DESIGN.md#store-and-packaging: the code extension plus two data extensions under one publisher.
const dataNames = [`${pkg.name}-core-data`, `${pkg.name}-extra-data`];
const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [`${pkg.publisher}.${pkg.name}`, ...dataNames.map((n) => `${pkg.publisher}.${n}`)];
const CONTROL = 'james-yu.latex-workshop';

async function marketplaceHas(id) {
  const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: {
      accept: 'application/json;api-version=3.0-preview.1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: id }], pageNumber: 1, pageSize: 5, sortBy: 0, sortOrder: 0 }],
      flags: 0x1 | 0x2 | 0x80,
    }),
  });
  if (!res.ok) throw new Error(`Marketplace query for ${id} failed: HTTP ${res.status}`);
  const body = await res.json();
  const exts = body.results?.[0]?.extensions ?? [];
  return exts.some((e) => `${e.publisher?.publisherName}.${e.extensionName}`.toLowerCase() === id.toLowerCase());
}

async function marketplacePublisherHasExtensions(publisher) {
  const res = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { accept: 'application/json;api-version=3.0-preview.1', 'content-type': 'application/json' },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 10, value: `publisher:"${publisher}"` }], pageNumber: 1, pageSize: 5, sortBy: 0, sortOrder: 0 }],
      flags: 0x1 | 0x2 | 0x80,
    }),
  });
  if (!res.ok) throw new Error(`Marketplace publisher query failed: HTTP ${res.status}`);
  const body = await res.json();
  const exts = body.results?.[0]?.extensions ?? [];
  return exts.filter((e) => e.publisher?.publisherName?.toLowerCase() === publisher.toLowerCase()).length;
}

async function openVsx(pathPart) {
  const res = await fetch(`https://open-vsx.org/api/${pathPart}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Open VSX query for ${pathPart} failed: HTTP ${res.status}`);
  return true;
}

const rows = [];
const [cp, cn] = CONTROL.split('.');
const control = { id: CONTROL, marketplace: await marketplaceHas(CONTROL), openVsx: await openVsx(`${cp}/${cn}`) };
if (!control.marketplace || !control.openVsx) {
  console.error('Positive control not found; the queries are not trustworthy:', control);
  process.exit(2);
}
rows.push({ ...control, note: 'positive control (must be taken)' });
const controlPublisher = { id: `${cp} (publisher)`, marketplace: (await marketplacePublisherHasExtensions(cp)) > 0, openVsx: await openVsx(cp) };
if (!controlPublisher.marketplace || !controlPublisher.openVsx) {
  console.error('Publisher positive control not found; the queries are not trustworthy:', controlPublisher);
  process.exit(2);
}
rows.push({ ...controlPublisher, note: 'positive control (must be taken)' });

const publishers = [...new Set(ids.map((id) => id.split('.')[0]))];
for (const p of publishers) {
  rows.push({
    id: `${p} (publisher)`,
    marketplace: (await marketplacePublisherHasExtensions(p)) > 0,
    openVsx: await openVsx(p),
    note: 'Marketplace: any extension listed under this publisher; Open VSX: namespace exists',
  });
}
let taken = false;
for (const id of ids) {
  const [p, n] = id.split('.');
  const row = { id, marketplace: await marketplaceHas(id), openVsx: await openVsx(`${p}/${n}`) };
  taken ||= row.marketplace || row.openVsx;
  rows.push(row);
}
console.log(`Checked ${new Date().toISOString()}`);
for (const r of rows) {
  console.log(`${r.id.padEnd(48)} marketplace=${r.marketplace ? 'TAKEN' : 'free '} openvsx=${r.openVsx ? 'TAKEN' : 'free '} ${r.note ?? ''}`);
}
process.exit(taken ? 1 : 0);
