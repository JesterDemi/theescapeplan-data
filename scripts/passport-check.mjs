#!/usr/bin/env node
// Passport cross-check: compares the visa-free data the app uses (feed.json, plus our overrides)
// with a second, weekly-updated dataset built from Wikipedia (Riedel-David/Visa-requirements).
// Nothing in the app is changed. A summary goes to PASSPORT-CHECK.md. When the weekly data CHANGES a
// pair and then disagrees with the app, it is listed there and posted to the Discord staff channel.
//
// Why: our main passport dataset stopped updating in Feb 2026. When the weekly dataset changes and
// now disagrees with us, a rule probably changed and an override is needed.
//
//   node scripts/passport-check.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'state', 'passport-check.json');
const REPORT = join(ROOT, 'PASSPORT-CHECK.md');
const ALERTS = join(ROOT, 'state', 'visa-alerts.json');
const ALL_URL = 'https://riedel-david.github.io/Visa-requirements/all.json';
const ONE_URL = (p) => `https://raw.githubusercontent.com/Riedel-David/Visa-requirements/main/data/passports/${p}.json`;
const MAX_ALERTS = 10; // per run, so a big upstream reshuffle can't flood the channel
const today = new Date().toISOString().slice(0, 10);

// Their status -> our one-letter code (same letters as feed.json).
const THEIRS = { visa_free: 'F', visa_on_arrival: 'A', eta: 'T', evisa: 'E', visa_required: 'R', admission_refused: 'N', travel_ban: 'N' };
const WORD = { F: 'visa-free', A: 'visa on arrival', T: 'online travel authorization (ETA)', E: 'e-visa', R: 'visa required', N: 'no entry' };
// Only flag differences a traveler would feel. ETA and e-visa are both "apply online first".
const GROUP = { F: 'free', A: 'arrival', T: 'online', E: 'online', R: 'visa', N: 'no' };

const feed = JSON.parse(readFileSync(join(ROOT, 'feed.json'), 'utf8'));

// ---------- our effective data: base dataset with overrides applied ----------
function parseLine(line) {
  const out = {};
  for (const tok of (line ?? '').split(' ')) {
    const m = tok.match(/^([A-Z]{2})([FATERN])(\d*)$/);
    if (m) out[m[1]] = { code: m[2], days: m[3] ? Number(m[3]) : undefined };
  }
  return out;
}
function ours(passport, dest, base) {
  let cur = base[dest];
  for (const r of feed.overrides ?? []) {
    if (r.dest !== dest) continue;
    if (r.passports && !r.passports.includes(passport)) continue;
    if (r.from && r.from > today) continue;
    if (r.until && r.until < today) continue;
    if (r.match && (!cur || cur.code !== r.match.code || (r.match.days !== undefined && cur.days !== r.match.days))) continue;
    cur = { code: r.set.code, days: r.set.days };
  }
  return cur;
}

// ---------- their data ----------
async function getJSON(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
  return null;
}
async function loadTheirs(passports) {
  const all = await getJSON(ALL_URL);
  const list = Array.isArray(all) ? all : all?.passports ? Object.values(all.passports) : all && typeof all === 'object' ? Object.values(all) : null;
  const byP = {};
  if (list?.length && list[0]?.records) {
    for (const p of list) byP[p.passport] = p;
  } else {
    for (const p of passports) {
      const one = await getJSON(ONE_URL(p));
      if (one?.records) byP[p] = one;
    }
  }
  return byP;
}

const base = feed.passports.data;
const passports = Object.keys(base).sort();
const theirs = await loadTheirs(passports);
const got = Object.keys(theirs).length;
if (got < 100) {
  console.error(`Only ${got} passports came back from the weekly dataset. Skipping today so nothing is flagged by mistake.`);
  process.exit(0);
}

const diffs = {};
const snap = {}; // their codes per passport, "ADF90 AER ...", to spot what they changed since last run
let compared = 0;
for (const p of passports) {
  const t = theirs[p];
  if (!t) continue;
  const mine = parseLine(base[p]);
  const parts = [];
  for (const r of t.records) {
    if (r.area || r.destination === p || !/^[A-Z]{2}$/.test(r.destination ?? '')) continue;
    const tc = THEIRS[r.status];
    if (!tc) continue;
    parts.push(`${r.destination}${tc}`);
    const oc = ours(p, r.destination, mine);
    if (!oc) continue;
    compared++;
    if (GROUP[tc] === GROUP[oc.code]) continue;
    diffs[`${p}-${r.destination}`] = {
      p,
      d: r.destination,
      name: r.destination_name,
      ours: oc.code,
      oursDays: oc.days ?? null,
      theirs: tc,
      theirsDays: r.allowed_stay_days ?? null,
      raw: r.allowed_stay_raw ?? null,
      url: r.source_url ?? t.source_url,
    };
  }
  snap[p] = parts.join(' ');
}

// ---------- what changed since last run ----------
// The signal is a CHANGE on their side that leaves them disagreeing with us: that usually means
// a rule changed recently. Long-standing differences between the two sources are mostly
// classification noise (land vs air entry, "e-visa or visa on arrival", etc.) and stay in the report.
const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const firstRun = !prev?.snap;
const fresh = [];
if (!firstRun) {
  for (const [k, v] of Object.entries(diffs)) {
    const before = prev.snap[v.p]?.match(new RegExp(`(?:^| )${v.d}([FATERN])`))?.[1];
    if (prev.snap[v.p] && before && GROUP[before] !== GROUP[v.theirs]) fresh.push({ ...v, before });
  }
}
const recent = [...fresh.map((v) => ({ date: today, p: v.p, d: v.d, name: v.name, ours: v.ours, oursDays: v.oursDays, before: v.before, theirs: v.theirs, theirsDays: v.theirsDays, url: v.url })), ...(prev?.recent ?? [])]
  .filter((x) => (Date.parse(today) - Date.parse(x.date)) / 86400000 <= 60 && diffs[`${x.p}-${x.d}`]);
mkdirSync(join(ROOT, 'state'), { recursive: true });
writeFileSync(STATE, JSON.stringify({ checked: today, compared, total: Object.keys(diffs).length, recent, snap }) + '\n');

// ---------- report ----------
const desc = (code, days) => `${WORD[code]}${days ? ` (${days} days)` : ''}`;
const total = Object.keys(diffs).length;
const byPass = {};
for (const v of Object.values(diffs)) byPass[v.p] = (byPass[v.p] ?? 0) + 1;
const lines = [
  `# Passport cross-check, ${today}`,
  '',
  `Compared ${compared} passport and country pairs with the weekly Wikipedia-based dataset (Riedel-David/Visa-requirements). They disagree on ${total} (${((total / Math.max(compared, 1)) * 100).toFixed(1)}%). Most long-standing ones are differences in how the two sources label the same rule.`,
  '',
  firstRun ? 'First run: saved as the starting point. From the next run on, any pair the weekly data CHANGES, and that then disagrees with the app, is listed below and posted to Discord.' : `Changed on their side since the last check and now disagreeing with the app: ${fresh.length}.`,
  '',
  'Nothing was changed in the app. Check the official source, then add an override in `sources/overrides.json` if the app is wrong.',
  '',
  '## Recent changes (last 60 days)',
  '',
  recent.length ? '| Seen | Passport | Going to | App says | Weekly data was | Weekly data now |' : 'None yet.',
  ...(recent.length ? ['|---|---|---|---|---|---|', ...recent.map((x) => `| ${x.date} | ${x.p} | ${x.name ?? x.d} (${x.d}) | ${desc(x.ours, x.oursDays)} | ${WORD[x.before]} | ${desc(x.theirs, x.theirsDays)} |`)] : []),
  '',
  '## Passports with the most disagreements',
  '',
  Object.entries(byPass).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => `${p}: ${n}`).join(', '),
  '',
  'Weekly data: [Riedel-David/Visa-requirements](https://github.com/Riedel-David/Visa-requirements), derived from Wikipedia, CC BY-SA 4.0. Used for checking only.',
];
writeFileSync(REPORT, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');

// ---------- Discord: new disagreements only ----------
if (fresh.length) {
  const old = existsSync(ALERTS) ? JSON.parse(readFileSync(ALERTS, 'utf8')) : [];
  const add = fresh.slice(0, MAX_ALERTS).map((v) => ({
    id: `pass-${v.p}-${v.d}-${v.theirs}-${today}`,
    kind: 'difference',
    date: today,
    country: v.d,
    why: `${v.p} passport to ${v.name ?? v.d}: the weekly data changed from ${WORD[v.before]} to ${WORD[v.theirs]}. The app says ${WORD[v.ours]}`,
    where: `Passport data for ${v.p} passports (add an override in sources/overrides.json if the app is wrong)`,
    app: desc(v.ours, v.oursDays),
    page: `${desc(v.theirs, v.theirsDays)}${v.raw ? `, "${v.raw}"` : ''}`,
    url: v.url,
  }));
  if (fresh.length > MAX_ALERTS) {
    add.push({ id: `pass-more-${today}`, kind: 'difference', date: today, country: '', why: `${fresh.length - MAX_ALERTS} more new passport disagreements today`, where: 'PASSPORT-CHECK.md in the data repo', app: '-', page: '-', url: 'https://github.com/JesterDemi/theescapeplan-data/blob/main/PASSPORT-CHECK.md' });
  }
  const merged = [...old, ...add.filter((a) => !old.some((o) => o.id === a.id))];
  writeFileSync(ALERTS, JSON.stringify(merged, null, 1) + '\n');
}

console.log(`Compared ${compared} pairs across ${got} passports. Disagreements: ${total}. Changed and now disagreeing: ${fresh.length}.`);
