#!/usr/bin/env node
// Builds the published immigration routes from sources/pathways/<CC>.json:
//   pathways/<CC>.json   one file per country, what the app downloads when you open that country
//   pathways/index.json  which countries have routes, how many, and how many are verified
// Every record is checked first. A record that fails (no official source, bad date, bad fee,
// broken leadsTo) is left out and listed in pathways/problems.json, so bad data never ships.
// Needs-review records ship too, but the app hides their numbers and shows the official link instead.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'sources', 'pathways');
const OUT = join(ROOT, 'pathways');
const today = new Date().toISOString().slice(0, 10);

const KINDS = new Set(['visa_free', 'visa_on_arrival', 'eta', 'evisa', 'visa', 'temporary_residence', 'permanent_residence', 'citizenship']);
const PURPOSES = new Set(['tourism', 'business', 'transit', 'remote_work', 'work', 'study', 'family', 'retirement', 'investment', 'entrepreneur', 'humanitarian', 'citizenship']);
const OLD_DAYS = 180; // a source not re-read in this long gets flagged for a re-check

function check(p, cc, ids) {
  const bad = [];
  if (!p || typeof p !== 'object') return ['not an object'];
  if (!/^[a-z0-9-]+$/.test(p.id ?? '')) bad.push('id must be lowercase-with-dashes');
  if (p.country !== cc) bad.push(`country is ${p.country}, file is ${cc}`);
  if (!p.name) bad.push('name missing');
  if (!KINDS.has(p.kind)) bad.push(`unknown kind ${p.kind}`);
  if (!Array.isArray(p.purposes) || !p.purposes.length || p.purposes.some((x) => !PURPOSES.has(x))) bad.push('purposes missing or unknown');
  if (!p.summary) bad.push('summary missing');
  if (!Array.isArray(p.sources) || !p.sources.length) bad.push('needs an official source');
  for (const s of p.sources ?? []) if (!/^https?:\/\/[^/]+\.[^/]+/.test(s?.url ?? '')) bad.push(`source is not a web link: ${s?.url}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.checked ?? '')) bad.push('checked must be YYYY-MM-DD');
  else if (p.checked > today) bad.push('checked is in the future');
  if (!['verified', 'needs_review'].includes(p.confidence)) bad.push('confidence must be verified or needs_review');
  for (const f of p.fees ?? []) if (!(f.amount >= 0) || !/^[A-Z]{3}$/.test(f.currency ?? '')) bad.push(`bad fee: ${f.label}`);
  for (const l of p.leadsTo ?? []) if (!ids.has(l.pathway)) bad.push(`leadsTo unknown id ${l.pathway}`);
  if (/—/.test(JSON.stringify(p))) bad.push('em dash');
  return bad;
}

mkdirSync(OUT, { recursive: true });
const index = { generatedAt: new Date().toISOString(), countries: {} };
const problems = [];
const wanted = new Set(['index.json', 'problems.json']);

for (const file of (existsSync(SRC) ? readdirSync(SRC) : []).filter((f) => /^[A-Z]{2}\.json$/.test(f)).sort()) {
  const cc = file.slice(0, 2);
  let list;
  try {
    list = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
  } catch (e) {
    problems.push({ country: cc, id: '*', problems: [`file is not valid JSON: ${e.message}`] });
    continue;
  }
  if (!Array.isArray(list)) list = [];
  const ids = new Set(list.map((p) => p?.id));
  const good = [];
  for (const p of list) {
    const bad = check(p, cc, ids);
    if (bad.length) problems.push({ country: cc, id: p?.id ?? '?', problems: bad });
    else good.push(p);
  }
  // leadsTo can point at a record that was just dropped; trim those links rather than ship dead ones.
  const kept = new Set(good.map((p) => p.id));
  for (const p of good) if (p.leadsTo) p.leadsTo = p.leadsTo.filter((l) => kept.has(l.pathway));
  if (!good.length) continue;
  const verified = good.filter((p) => p.confidence === 'verified').length;
  const oldest = good.map((p) => p.checked).sort()[0];
  index.countries[cc] = { routes: good.length, verified, checked: oldest };
  if ((Date.parse(today) - Date.parse(oldest)) / 86400000 > OLD_DAYS) problems.push({ country: cc, id: '*', problems: [`oldest source read on ${oldest}, re-check this country`] });
  const name = `${cc}.json`;
  wanted.add(name);
  const text = JSON.stringify({ country: cc, generatedAt: index.generatedAt, routes: good });
  const p = join(OUT, name);
  if (!existsSync(p) || readFileSync(p, 'utf8') !== text) writeFileSync(p, text);
}

for (const f of readdirSync(OUT)) if (!wanted.has(f)) unlinkSync(join(OUT, f));
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
writeFileSync(join(OUT, 'problems.json'), JSON.stringify(problems, null, 1) + '\n');

const n = Object.keys(index.countries).length;
const routes = Object.values(index.countries).reduce((a, c) => a + c.routes, 0);
const ver = Object.values(index.countries).reduce((a, c) => a + c.verified, 0);
console.log(`Pathways: ${n} countries, ${routes} routes (${ver} verified), ${problems.length} problems`);
export const pathwaysSummary = { countries: n, routes, verified: ver, problems: problems.length };
