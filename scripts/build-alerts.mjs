#!/usr/bin/env node
// Builds the Discord alert feeds (RSS) from the same data the app uses:
//   - travel advisory level changes, read with the app's own parser (shared/advisoryParse.ts)
//   - entry-rule notices, straight from feed.json (what the app shows)
//
// Output (committed by the daily workflow):
//   alerts/all.xml        every country
//   alerts/<cc>.xml       one feed per country, e.g. alerts/al.xml for Albania
//   alerts/events.json    the advisory change log
//   alerts/state.json     last known levels (so the next run can spot changes)
//
// Point any RSS reader (Physalia's Social alerts, for example) at those URLs.
// Run: node --experimental-strip-types scripts/build-alerts.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_LABEL, SOURCE_NAME, aggregate, levelChanges, parseAU, parseCA, parseUK, parseUS } from '../shared/advisoryParse.ts';
import { UK_SLUG } from '../shared/advisorySnapshot.ts';
import { COUNTRIES, countryName } from '../shared/countries.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'alerts');
const UA = 'TheEscapePlan-Alerts/1.0 (+https://theescapeplan.org)';
const FEEDS = {
  US: 'https://cadataapi.state.gov/api/TravelAdvisories',
  CA: 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json',
  AU: 'https://www.smartraveller.gov.au/destinations-export',
  UK: (slug) => `https://www.gov.uk/api/content/foreign-travel-advice/${slug}`,
};
const KEEP_DAYS = 90; // how long advisory changes stay in the feeds
const MAX_ITEMS = 100;
const MASS_CHANGE = 40; // more than this many countries moving at once means a feed or parser problem, not news
const SITE = 'https://theescapeplan.org';
const RAW = 'https://raw.githubusercontent.com/JesterDemi/theescapeplan-data/main/alerts';

const now = new Date();
const today = now.toISOString().slice(0, 10);
const daysAgo = (iso) => (now - Date.parse(iso)) / 86400000;

// For tests: ALERTS_FIXTURES=dir reads us.json, ca.json, au.json and uk/<slug>.json instead of the network.
const FIX = process.env.ALERTS_FIXTURES;
async function getJSON(url) {
  if (FIX) {
    const name = url === FEEDS.US ? 'us.json' : url === FEEDS.CA ? 'ca.json' : url === FEEDS.AU ? 'au.json' : `uk/${url.split('/').pop()}.json`;
    const p = join(FIX, name);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  return null;
}

// ---------- read the four governments, exactly like the app ----------
const [us, ca, au] = await Promise.all([getJSON(FEEDS.US), getJSON(FEEDS.CA), getJSON(FEEDS.AU)]);
const ok = {
  US: Array.isArray(us) && us.length > 100,
  CA: !!ca?.data && Object.keys(ca.data).length > 100,
  AU: (Array.isArray(au) ? au : Object.values(au ?? {})).length > 100,
};

const uk = {};
{
  const queue = COUNTRIES.map((c) => c.code).filter((c) => UK_SLUG[c]);
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      uk[code] = await getJSON(FEEDS.UK(UK_SLUG[code]));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}
const ukReached = Object.values(uk).filter(Boolean).length;
ok.UK = ukReached >= Object.keys(uk).length * 0.8;

// ---------- compare with last run ----------
mkdirSync(OUT, { recursive: true });
const statePath = join(OUT, 'state.json');
const eventsPath = join(OUT, 'events.json');
const firstRun = !existsSync(statePath);
const state = firstRun ? { levels: {} } : JSON.parse(readFileSync(statePath, 'utf8'));
let events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];

const found = [];
const nextLevels = {};
for (const { code } of COUNTRIES) {
  const live = [];
  const tryParse = (id, fn) => {
    try {
      const s = fn();
      if (s && s.origin === 'live') live.push(s);
    } catch {}
  };
  if (ok.US) tryParse('US', () => parseUS(us, code));
  if (ok.CA) tryParse('CA', () => parseCA(ca, code));
  if (ok.AU) tryParse('AU', () => parseAU(au, code));
  if (ok.UK && uk[code]) tryParse('UK', () => parseUK(uk[code], code));

  const prev = state.levels[code] ?? {};
  const agg = aggregate(code, live);
  // A source that failed today must not move the overall level, so only compare
  // the overall level when every source we had last time is still here.
  const complete = ['US', 'UK', 'CA', 'AU'].every((s) => prev[s] === undefined || live.some((x) => x.source === s && x.level));
  const compareTo = complete ? prev : { ...prev, overall: undefined };
  const changes = levelChanges(compareTo, agg);

  const next = { ...prev };
  for (const s of live) if (s.level && !s.homeCountry) next[s.source] = s.level;
  if (complete && agg.level) next.overall = agg.level;
  nextLevels[code] = next;
  if (changes.length) found.push({ code, agg, changes, live });
}

const massChange = found.length > MASS_CHANGE;
if (massChange) {
  console.error(`Skipped: ${found.length} countries changed at once. That points to a feed or parser problem, so nothing was published and the saved levels were kept.`);
} else {
  if (!firstRun) {
    for (const { code, agg, changes, live } of found) {
      const name = countryName(code);
      const overall = changes.find((c) => c.source === 'overall');
      const bySource = changes.filter((c) => c.source !== 'overall');
      let title;
      if (overall) {
        const word = overall.to > overall.from ? 'raised' : 'lowered';
        title = `Travel advice ${word} for ${name}: now Level ${overall.to}, ${LEVEL_LABEL[overall.to]}`;
      } else {
        title = bySource.length === 1
          ? `${SOURCE_NAME[bySource[0].source]} changed its advice for ${name} (Level ${bySource[0].from} to ${bySource[0].to})`
          : `Travel advice updated for ${name}`;
      }
      const lines = bySource.map((c) => {
        const s = live.find((x) => x.source === c.source);
        return `${SOURCE_NAME[c.source]}: Level ${c.from} to Level ${c.to} (${s?.text ?? LEVEL_LABEL[c.to]}).${s?.detail ? ' ' + s.detail : ''}`;
      });
      const first = live.find((x) => x.source === bySource[0]?.source) ?? live[0];
      events.push({
        id: `adv-${code.toLowerCase()}-${today}-${bySource.map((c) => `${c.source}${c.to}`).join('') || `all${agg.level}`}`,
        type: 'advisory',
        code,
        date: now.toISOString(),
        title,
        body: lines.join(' ') || `Overall level is now ${agg.level}.`,
        link: first?.url ?? SITE,
      });
    }
  }
  state.levels = nextLevels;
}
// Never post the same change twice, and forget old ones.
events = events.filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).filter((e) => daysAgo(e.date) <= KEEP_DAYS);

// ---------- entry-rule notices, the same ones the app shows ----------
const feed = JSON.parse(readFileSync(join(ROOT, 'feed.json'), 'utf8'));
const notices = (feed.notices ?? [])
  .filter((n) => !n.until || n.until >= today)
  .filter((n) => !n.from || n.from <= today)
  .map((n) => ({
    id: `entry-${n.id}`,
    type: 'entry',
    codes: n.dests,
    date: new Date((n.from ?? feed.generatedAt.slice(0, 10)) + 'T08:00:00Z').toISOString(),
    title: n.title,
    body: n.body,
    link: n.source,
  }));

// ---------- write RSS ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FOOTER = 'From The Escape Plan travel data. General information, not legal advice. Always check the official source before you travel.';
function rss(title, description, selfUrl, items) {
  const list = items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${esc(title)}</title>`,
    `<link>${SITE}</link>`,
    `<description>${esc(description)}</description>`,
    '<language>en-us</language>',
    `<atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>`,
    ...list.map((e) =>
      [
        '<item>',
        `<title>${esc(e.title)}</title>`,
        `<link>${esc(e.link)}</link>`,
        `<guid isPermaLink="false">${esc(e.id)}</guid>`,
        `<pubDate>${new Date(e.date).toUTCString()}</pubDate>`,
        `<category>${e.type === 'advisory' ? 'Travel advice' : 'Entry rules'}</category>`,
        `<description>${esc(`${e.body} ${FOOTER}`)}</description>`,
        '</item>',
      ].join('')
    ),
    '</channel>',
    '</rss>',
    '',
  ].join('\n');
}

const all = [...events, ...notices];
const forCountry = (code) => all.filter((e) => e.code === code || e.codes?.includes(code));

// Only rewrite files whose content changed, so quiet days make no commit.
const write = (file, text) => {
  const p = join(OUT, file);
  if (existsSync(p) && readFileSync(p, 'utf8') === text) return false;
  writeFileSync(p, text);
  return true;
};
write('all.xml', rss('The Escape Plan: travel alerts', 'Travel advisory changes and entry-rule updates for every country.', `${RAW}/all.xml`, all));
const wanted = new Set();
for (const { code, name } of COUNTRIES) {
  const file = `${code.toLowerCase()}.xml`;
  wanted.add(file);
  write(file, rss(`The Escape Plan: ${name} travel alerts`, `Travel advisory changes and entry-rule updates for ${name}.`, `${RAW}/${file}`, forCountry(code)));
}
for (const f of readdirSync(OUT)) if (f.endsWith('.xml') && f !== 'all.xml' && !wanted.has(f)) unlinkSync(join(OUT, f));
write('events.json', JSON.stringify(events, null, 1) + '\n');
write('state.json', JSON.stringify(state) + '\n');

console.log(
  [
    `Sources: US ${ok.US ? 'ok' : 'down'}, UK ${ok.UK ? `ok (${ukReached} pages)` : `down (${ukReached} pages)`}, CA ${ok.CA ? 'ok' : 'down'}, AU ${ok.AU ? 'ok' : 'down'}`,
    firstRun ? 'First run: saved current levels, no alerts posted.' : massChange ? 'Mass change, skipped.' : `Advisory changes today: ${found.length}`,
    `Items in all.xml: ${Math.min(all.length, MAX_ITEMS)} (${events.length} advisory, ${notices.length} entry)`,
  ].join('\n')
);
