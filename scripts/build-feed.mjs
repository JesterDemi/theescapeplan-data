#!/usr/bin/env node
// Builds feed.json (what the app downloads) plus health.json / HEALTH.md (what a human reads).
//
//   node scripts/build-feed.mjs            full run: download passports, check links + advisory feeds
//   node scripts/build-feed.mjs --offline  reuse passports from the current feed.json, skip network checks
//
// Exit code is 0 even when checks find problems (the feed is still published). It is 1 only
// when the feed itself would be broken, in which case nothing is written.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE = process.argv.includes('--offline');
const PASSPORTS_URL = 'https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index.json';
const README_URL = 'https://raw.githubusercontent.com/imorte/passport-index-data/main/README.md';
const CODE = { 'visa free': 'F', 'visa on arrival': 'A', eta: 'T', 'e-visa': 'E', 'visa required': 'R', 'no admission': 'N' };
const ADVISORY_FEEDS = {
  US: 'https://cadataapi.state.gov/api/TravelAdvisories',
  UK: 'https://www.gov.uk/api/content/foreign-travel-advice/thailand',
  CA: 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
  AU: 'https://www.smartraveller.gov.au/destinations-export',
};
const UA = 'TheEscapePlan-DataCheck/1.0 (+https://theescapeplan.org)';

const today = new Date().toISOString().slice(0, 10);
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'sources', f), 'utf8'));
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const problems = []; // things worth an alert (opens the GitHub issue)
const notes = []; // known, slow-moving facts shown in HEALTH.md only
const flag = (level, area, message) => (level === 'note' ? notes : problems).push({ level, area, message });

// ---------- passports ----------
async function loadPassports() {
  if (OFFLINE) {
    const prev = JSON.parse(readFileSync(join(ROOT, 'feed.json'), 'utf8'));
    return prev.passports;
  }
  const res = await fetch(PASSPORTS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Passport download failed: ${res.status}`);
  const raw = await res.json();
  let date = today;
  try {
    const md = await (await fetch(README_URL)).text();
    const m = md.match(/Last updated:\s*\**([0-9]{1,2} \w+ [0-9]{4})/);
    if (m) date = new Date(m[1] + ' UTC').toISOString().slice(0, 10);
  } catch {}
  const data = {};
  for (const [passport, dests] of Object.entries(raw)) {
    const parts = [];
    for (const [dest, v] of Object.entries(dests).sort(([a], [b]) => a.localeCompare(b))) {
      const c = CODE[v.status];
      if (c) parts.push(`${dest.toUpperCase()}${c}${v.days ?? ''}`);
    }
    data[passport.toUpperCase()] = parts.join(' ');
  }
  return { date, source: 'https://github.com/imorte/passport-index-data', data };
}

// ---------- validation (hard failures) ----------
const ISO2 = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODES = /^[FATERN]$/;

function validate(feed) {
  const errs = [];
  const n = Object.keys(feed.passports.data).length;
  if (n < 150) errs.push(`only ${n} passports`);
  for (const r of feed.overrides) {
    const where = `override ${r.id}`;
    if (!r.id || !ISO2.test(r.dest)) errs.push(`${where}: bad id/dest`);
    if (r.from && !DATE.test(r.from)) errs.push(`${where}: bad from`);
    if (r.until && !DATE.test(r.until)) errs.push(`${where}: bad until`);
    if (!r.set || !CODES.test(r.set.code)) errs.push(`${where}: bad set.code`);
    if (r.passports && !r.passports.every((p) => ISO2.test(p))) errs.push(`${where}: bad passport code`);
    if (!/^https:\/\//.test(r.source || '')) errs.push(`${where}: needs an https source`);
  }
  for (const x of feed.notices) {
    const where = `notice ${x.id}`;
    if (!x.id || !Array.isArray(x.dests) || !x.dests.every((d) => ISO2.test(d))) errs.push(`${where}: bad id/dests`);
    if (!x.title || !x.body) errs.push(`${where}: needs title and body`);
    if (!['info', 'warning'].includes(x.level)) errs.push(`${where}: level must be info or warning`);
    if (!/^https:\/\//.test(x.source || '')) errs.push(`${where}: needs an https source`);
  }
  for (const v of feed.visas) {
    if (!ISO2.test(v.code) || !v.summary || !Array.isArray(v.categories)) errs.push(`visa guide ${v.code}: missing fields`);
    if (!/^\d{4}-\d{2}$/.test(v.reviewed || '')) errs.push(`visa guide ${v.code}: reviewed must be YYYY-MM`);
  }
  return errs;
}

// ---------- freshness checks (warnings) ----------
function freshness(feed) {
  const age = daysBetween(feed.passports.date, today);
  if (age > 120) flag('note', 'passports', `Passport dataset is ${age} days old (dated ${feed.passports.date}). Upstream has not refreshed; add overrides for any known rule changes.`);
  for (const v of feed.visas) {
    const months = daysBetween(`${v.reviewed}-01`, today) / 30.4;
    if (months > 4) flag('warning', 'visas', `Visa guide ${v.code} was last reviewed ${v.reviewed}. Re-check it against the official links.`);
  }
  for (const r of feed.overrides) {
    if (r.until) {
      const left = daysBetween(today, r.until);
      if (left < 0) flag('warning', 'overrides', `Override ${r.id} expired on ${r.until}. Remove it or extend it if the policy was renewed.`);
      else if (left <= 30) flag('warning', 'overrides', `Override ${r.id} ends ${r.until} (${left} days). Check whether the policy is being extended.`);
    }
  }
  for (const x of feed.notices) {
    if (x.until && daysBetween(today, x.until) < 0) flag('warning', 'notices', `Notice ${x.id} expired on ${x.until}. It is hidden in the app; remove it when convenient.`);
  }
  const checked = feed.meta?.schengen?.checked;
  if (checked && daysBetween(checked, today) > 45) flag('warning', 'meta', `Schengen/ETIAS note last checked ${checked}. ETIAS start date may have been announced.`);
}

// ---------- network checks (warnings) ----------
async function head(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.ok || method === 'GET') return res.status;
    } catch (e) {
      if (method === 'GET') return `error: ${e.cause?.code || e.message}`;
    }
  }
}

async function linkChecks(feed) {
  const urls = new Set();
  for (const v of feed.visas) for (const l of v.officialLinks ?? []) urls.add(l.url);
  for (const r of feed.overrides) urls.add(r.source);
  for (const x of feed.notices) urls.add(x.source);
  for (const s of feed.meta?.schengen?.sources ?? []) urls.add(s);
  const list = [...urls].filter(Boolean);
  const results = await Promise.all(list.map(async (u) => [u, await head(u)]));
  for (const [u, s] of results) {
    if (s === 403 || s === 429 || s === 405) continue; // bot walls on gov sites, not a dead link
    if (typeof s === 'string' && /CERT|SIGNATURE|SSL|TLS/i.test(s)) continue; // site's own TLS setup; browsers still open it
    if (typeof s !== 'number' || s >= 400) flag('warning', 'links', `Link check failed (${s}): ${u}`);
  }
  return results.length;
}

async function advisoryChecks() {
  const out = {};
  for (const [k, url] of Object.entries(ADVISORY_FEEDS)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
        const text = await res.text();
        let ok = res.ok;
        try { JSON.parse(text); } catch { ok = false; }
        out[k] = ok ? 'ok' : `HTTP ${res.status}${res.ok ? ' (not JSON)' : ''}`;
      } catch (e) {
        out[k] = `error: ${e.cause?.code || e.message}`;
      }
      if (out[k] === 'ok') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (out[k] !== 'ok') flag('warning', 'advisories', `${k} advisory feed: ${out[k]}. The app falls back to cached/bundled levels; check whether the endpoint moved.`);
  }
  return out;
}

// ---------- main ----------
const passports = await loadPassports();
const overrides = read('overrides.json').rules;
const notices = read('notices.json').notices;
const visas = read('visas.json');
const meta = read('meta.json');

const feed = { schema: 1, generatedAt: new Date().toISOString(), passports, overrides, notices, visas, meta };
const errs = validate(feed);
if (errs.length) {
  console.error('Feed NOT written. Fix these first:\n- ' + errs.join('\n- '));
  process.exit(1);
}

// Keep generatedAt stable when content did not change, so the daily commit is a no-op.
const feedPath = join(ROOT, 'feed.json');
if (existsSync(feedPath)) {
  const prev = JSON.parse(readFileSync(feedPath, 'utf8'));
  const strip = (f) => JSON.stringify({ ...f, generatedAt: '' });
  if (strip(prev) === strip(feed)) feed.generatedAt = prev.generatedAt;
}

freshness(feed);
let linksChecked = 0;
let advisories = 'skipped (offline)';
if (!OFFLINE) {
  linksChecked = await linkChecks(feed);
  advisories = await advisoryChecks();
}

writeFileSync(feedPath, JSON.stringify(feed));
const health = { checkedAt: new Date().toISOString(), feedGeneratedAt: feed.generatedAt, passportsDate: passports.date, passportCount: Object.keys(passports.data).length, overrides: overrides.length, notices: notices.length, visaGuides: visas.length, linksChecked, advisories, problems, notes };
writeFileSync(join(ROOT, 'health.json'), JSON.stringify(health, null, 2) + '\n');

const md = [
  '# Data health',
  '',
  `Checked ${health.checkedAt.slice(0, 16).replace('T', ' ')} UTC. Feed generated ${feed.generatedAt.slice(0, 16).replace('T', ' ')} UTC.`,
  '',
  `- Passport dataset: ${health.passportCount} passports, dated ${passports.date}`,
  `- Overrides: ${overrides.length}, notices: ${notices.length}, visa guides: ${visas.length}`,
  `- Advisory feeds: ${typeof advisories === 'string' ? advisories : Object.entries(advisories).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  `- Links checked: ${linksChecked}`,
  '',
  problems.length ? '## Needs attention\n\n' + problems.map((p) => `- **${p.area}**: ${p.message}`).join('\n') : 'Everything looks good.',
  '',
  notes.length ? '## Notes\n\n' + notes.map((p) => `- **${p.area}**: ${p.message}`).join('\n') + '\n' : '',
].join('\n');
writeFileSync(join(ROOT, 'HEALTH.md'), md);
console.log(md);
#!/usr/bin/env node
// Builds feed.json (what the app downloads) plus health.json / HEALTH.md (what a human reads).
//
//   node scripts/build-feed.mjs            full run: download passports, check links + advisory feeds
//   node scripts/build-feed.mjs --offline  reuse passports from the current feed.json, skip network checks
//
// Exit code is 0 even when checks find problems (the feed is still published). It is 1 only
// when the feed itself would be broken, in which case nothing is written.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE = process.argv.includes('--offline');
const PASSPORTS_URL = 'https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index.json';
const README_URL = 'https://raw.githubusercontent.com/imorte/passport-index-data/main/README.md';
const CODE = { 'visa free': 'F', 'visa on arrival': 'A', eta: 'T', 'e-visa': 'E', 'visa required': 'R', 'no admission': 'N' };
const ADVISORY_FEEDS = {
  US: 'https://cadataapi.state.gov/api/TravelAdvisories',
  UK: 'https://www.gov.uk/api/content/foreign-travel-advice/thailand',
  CA: 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
  AU: 'https://www.smartraveller.gov.au/destinations-export',
};
const UA = 'TheEscapePlan-DataCheck/1.0 (+https://theescapeplan.org)';

const today = new Date().toISOString().slice(0, 10);
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'sources', f), 'utf8'));
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const problems = []; // { level: 'error' | 'warning', area, message }
const flag = (level, area, message) => problems.push({ level, area, message });

// ---------- passports ----------
async function loadPassports() {
  if (OFFLINE) {
    const prev = JSON.parse(readFileSync(join(ROOT, 'feed.json'), 'utf8'));
    return prev.passports;
  }
  const res = await fetch(PASSPORTS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Passport download failed: ${res.status}`);
  const raw = await res.json();
  let date = today;
  try {
    const md = await (await fetch(README_URL)).text();
    const m = md.match(/Last updated:\s*\**([0-9]{1,2} \w+ [0-9]{4})/);
    if (m) date = new Date(m[1] + ' UTC').toISOString().slice(0, 10);
  } catch {}
  const data = {};
  for (const [passport, dests] of Object.entries(raw)) {
    const parts = [];
    for (const [dest, v] of Object.entries(dests).sort(([a], [b]) => a.localeCompare(b))) {
      const c = CODE[v.status];
      if (c) parts.push(`${dest.toUpperCase()}${c}${v.days ?? ''}`);
    }
    data[passport.toUpperCase()] = parts.join(' ');
  }
  return { date, source: 'https://github.com/imorte/passport-index-data', data };
}

// ---------- validation (hard failures) ----------
const ISO2 = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODES = /^[FATERN]$/;

function validate(feed) {
  const errs = [];
  const n = Object.keys(feed.passports.data).length;
  if (n < 150) errs.push(`only ${n} passports`);
  for (const r of feed.overrides) {
    const where = `override ${r.id}`;
    if (!r.id || !ISO2.test(r.dest)) errs.push(`${where}: bad id/dest`);
    if (r.from && !DATE.test(r.from)) errs.push(`${where}: bad from`);
    if (r.until && !DATE.test(r.until)) errs.push(`${where}: bad until`);
    if (!r.set || !CODES.test(r.set.code)) errs.push(`${where}: bad set.code`);
    if (r.passports && !r.passports.every((p) => ISO2.test(p))) errs.push(`${where}: bad passport code`);
    if (!/^https:\/\//.test(r.source || '')) errs.push(`${where}: needs an https source`);
  }
  for (const x of feed.notices) {
    const where = `notice ${x.id}`;
    if (!x.id || !Array.isArray(x.dests) || !x.dests.every((d) => ISO2.test(d))) errs.push(`${where}: bad id/dests`);
    if (!x.title || !x.body) errs.push(`${where}: needs title and body`);
    if (!['info', 'warning'].includes(x.level)) errs.push(`${where}: level must be info or warning`);
    if (!/^https:\/\//.test(x.source || '')) errs.push(`${where}: needs an https source`);
  }
  for (const v of feed.visas) {
    if (!ISO2.test(v.code) || !v.summary || !Array.isArray(v.categories)) errs.push(`visa guide ${v.code}: missing fields`);
    if (!/^\d{4}-\d{2}$/.test(v.reviewed || '')) errs.push(`visa guide ${v.code}: reviewed must be YYYY-MM`);
  }
  return errs;
}

// ---------- freshness checks (warnings) ----------
function freshness(feed) {
  const age = daysBetween(feed.passports.date, today);
  if (age > 120) flag('warning', 'passports', `Passport dataset is ${age} days old (dated ${feed.passports.date}). Upstream has not refreshed; add overrides for any known rule changes.`);
  for (const v of feed.visas) {
    const months = daysBetween(`${v.reviewed}-01`, today) / 30.4;
    if (months > 4) flag('warning', 'visas', `Visa guide ${v.code} was last reviewed ${v.reviewed}. Re-check it against the official links.`);
  }
  for (const r of feed.overrides) {
    if (r.until) {
      const left = daysBetween(today, r.until);
      if (left < 0) flag('warning', 'overrides', `Override ${r.id} expired on ${r.until}. Remove it or extend it if the policy was renewed.`);
      else if (left <= 30) flag('warning', 'overrides', `Override ${r.id} ends ${r.until} (${left} days). Check whether the policy is being extended.`);
    }
  }
  for (const x of feed.notices) {
    if (x.until && daysBetween(today, x.until) < 0) flag('warning', 'notices', `Notice ${x.id} expired on ${x.until}. It is hidden in the app; remove it when convenient.`);
  }
  const checked = feed.meta?.schengen?.checked;
  if (checked && daysBetween(checked, today) > 45) flag('warning', 'meta', `Schengen/ETIAS note last checked ${checked}. ETIAS start date may have been announced.`);
}

// ---------- network checks (warnings) ----------
async function head(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.ok || method === 'GET') return res.status;
    } catch (e) {
      if (method === 'GET') return `error: ${e.cause?.code || e.message}`;
    }
  }
}

async function linkChecks(feed) {
  const urls = new Set();
  for (const v of feed.visas) for (const l of v.officialLinks ?? []) urls.add(l.url);
  for (const r of feed.overrides) urls.add(r.source);
  for (const x of feed.notices) urls.add(x.source);
  for (const s of feed.meta?.schengen?.sources ?? []) urls.add(s);
  const list = [...urls].filter(Boolean);
  const results = await Promise.all(list.map(async (u) => [u, await head(u)]));
  for (const [u, s] of results) {
    if (s === 403 || s === 429 || s === 405) continue; // bot walls on gov sites, not a dead link
    if (typeof s !== 'number' || s >= 400) flag('warning', 'links', `Link check failed (${s}): ${u}`);
  }
  return results.length;
}

async function advisoryChecks() {
  const out = {};
  for (const [k, url] of Object.entries(ADVISORY_FEEDS)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let ok = res.ok;
      try { JSON.parse(text); } catch { ok = false; }
      out[k] = ok ? 'ok' : `HTTP ${res.status}${res.ok ? ' (not JSON)' : ''}`;
    } catch (e) {
      out[k] = `error: ${e.cause?.code || e.message}`;
    }
    if (out[k] !== 'ok') flag('warning', 'advisories', `${k} advisory feed: ${out[k]}. The app falls back to cached/bundled levels; check whether the endpoint moved.`);
  }
  return out;
}

// ---------- main ----------
const passports = await loadPassports();
const overrides = read('overrides.json').rules;
const notices = read('notices.json').notices;
const visas = read('visas.json');
const meta = read('meta.json');

const feed = { schema: 1, generatedAt: new Date().toISOString(), passports, overrides, notices, visas, meta };
const errs = validate(feed);
if (errs.length) {
  console.error('Feed NOT written. Fix these first:\n- ' + errs.join('\n- '));
  process.exit(1);
}

// Keep generatedAt stable when content did not change, so the daily commit is a no-op.
const feedPath = join(ROOT, 'feed.json');
if (existsSync(feedPath)) {
  const prev = JSON.parse(readFileSync(feedPath, 'utf8'));
  const strip = (f) => JSON.stringify({ ...f, generatedAt: '' });
  if (strip(prev) === strip(feed)) feed.generatedAt = prev.generatedAt;
}

freshness(feed);
let linksChecked = 0;
let advisories = 'skipped (offline)';
if (!OFFLINE) {
  linksChecked = await linkChecks(feed);
  advisories = await advisoryChecks();
}

writeFileSync(feedPath, JSON.stringify(feed));
const health = { checkedAt: new Date().toISOString(), feedGeneratedAt: feed.generatedAt, passportsDate: passports.date, passportCount: Object.keys(passports.data).length, overrides: overrides.length, notices: notices.length, visaGuides: visas.length, linksChecked, advisories, problems };
writeFileSync(join(ROOT, 'health.json'), JSON.stringify(health, null, 2) + '\n');

const md = [
  '# Data health',
  '',
  `Checked ${health.checkedAt.slice(0, 16).replace('T', ' ')} UTC. Feed generated ${feed.generatedAt.slice(0, 16).replace('T', ' ')} UTC.`,
  '',
  `- Passport dataset: ${health.passportCount} passports, dated ${passports.date}`,
  `- Overrides: ${overrides.length}, notices: ${notices.length}, visa guides: ${visas.length}`,
  `- Advisory feeds: ${typeof advisories === 'string' ? advisories : Object.entries(advisories).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  `- Links checked: ${linksChecked}`,
  '',
  problems.length ? '## Needs attention\n\n' + problems.map((p) => `- **${p.area}**: ${p.message}`).join('\n') : 'Everything looks good.',
  '',
].join('\n');
writeFileSync(join(ROOT, 'HEALTH.md'), md);
console.log(md);
