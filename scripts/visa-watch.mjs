#!/usr/bin/env node
// Visa watch: notices when an official page behind a visa guide or immigration route changes,
// then has Claude compare that page with what the app says. Nothing is ever edited or published
// automatically. Findings go to VISA-CHECK.md and a GitHub issue for a person to review.
//
// - Every source page is checked once a week (1/7 of them each day).
// - A page is only sent to Claude when its text changed since the last check.
// - The first time a page is seen, its text is only saved (no Claude call).
// - Hard cap on Claude calls per run, so a site redesign can't run up a bill.
//
//   node scripts/visa-watch.mjs            normal daily run
//   node scripts/visa-watch.mjs --all      check every page today (still capped)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, askClaude, hasClaude, htmlToText, parseJSON } from './claude.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'state', 'visa-watch.json');
const REPORT = join(ROOT, 'VISA-CHECK.md');
const UA = 'TheEscapePlan-VisaWatch/1.0 (+https://theescapeplan.org)';
const MAX_CLAUDE_CALLS = Number(process.env.VISA_WATCH_MAX_CALLS || 20);
const PAGE_CHARS = 40000; // about 10k tokens of page text at most
const ALL = process.argv.includes('--all');

const today = new Date().toISOString().slice(0, 10);
const dayNo = Math.floor(Date.now() / 86400000);
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------- what to watch: url -> what the app says that relies on it ----------
const watch = new Map();
const add = (url, item) => {
  if (!/^https:\/\//.test(url ?? '')) return;
  if (!watch.has(url)) watch.set(url, []);
  watch.get(url).push(item);
};
const visas = JSON.parse(readFileSync(join(ROOT, 'sources', 'visas.json'), 'utf8'));
for (const v of visas) {
  const guide = { type: 'visa guide', ref: `sources/visas.json (${v.code})`, country: v.code, says: { summary: v.summary, categories: v.categories, generalDocuments: v.generalDocuments } };
  for (const l of v.officialLinks ?? []) add(l.url, guide);
}
const pdir = join(ROOT, 'sources', 'pathways');
for (const f of readdirSync(pdir).filter((f) => f.endsWith('.json'))) {
  for (const r of JSON.parse(readFileSync(join(pdir, f), 'utf8'))) {
    const { sources, checked, confidence, ...says } = r;
    for (const s of sources ?? []) add(s.url, { type: 'route', ref: `sources/pathways/${f} (${r.id})`, country: r.country, says });
  }
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { pages: {} };
state.pending = (state.pending ?? []).filter((u) => watch.has(u)); // changed pages still waiting for a comparison
const scheduled = [...watch.keys()].filter((u) => ALL || parseInt(hash(u).slice(0, 8), 16) % 7 === dayNo % 7);
const urls = [...new Set([...state.pending, ...scheduled])];

async function getPage(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/html|text\/plain/.test(type)) return null; // PDFs and files: the link checker covers those
    const text = htmlToText(await res.text());
    return text.length >= 400 ? text : null; // empty shells and bot walls are not worth comparing
  } catch {
    return null;
  }
}

// Numbers and dates that change on every page load (counters, "updated 3 minutes ago") would
// cause false alarms, so the fingerprint ignores digits inside obvious timestamps.
const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const fingerprint = (text) =>
  hash(
    text
      .toLowerCase()
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '') // clock times
      .replace(new RegExp(`\\b\\d{1,2}(st|nd|rd|th)? ${MONTHS},? \\d{4}\\b|\\b${MONTHS} \\d{1,2},? \\d{4}\\b`, 'g'), '') // "14 November 2026"
      .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, '') // 2026-11-14, 14/11/2026
      .replace(/(last (updated|modified|reviewed)|page updated|updated)[^\n]{0,40}/g, '')
      .replace(/\s+/g, ' ')
  );

const SYSTEM = [
  'You check a relocation app\'s visa information against an official government page.',
  'Only report a difference when the page clearly says something different from the app about a rule, amount, fee, income or savings requirement, document, time limit, processing time, eligibility, or whether the route still exists.',
  'Ignore wording, layout, missing detail the app never claimed, and anything the page does not cover.',
  'Never guess. Every finding must quote the page word for word (under 30 words).',
  'Reply with JSON only: {"status":"ok"|"differs"|"unrelated","findings":[{"ref":"<ref of the app item>","app":"<what the app says>","page":"<exact quote from the page>","why":"<one short sentence>"}]}.',
  'Use "unrelated" when the page is not about these routes (a moved page, a login wall, an error page).',
].join(' ');

// Quick health check of the key, so a revoked key or a hit spending limit gets noticed.
const keyOk = hasClaude() ? !!(await askClaude({ model: MODELS.quick, system: 'Reply with OK.', prompt: 'ping', maxTokens: 5 })) : null;

let calls = 0;
const findings = [];
const unrelated = [];
let fetched = 0;
let changed = 0;
let skippedCap = 0;

// Download pages 8 at a time (some government sites are slow), then compare one by one.
const pages = new Map();
{
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      pages.set(u, await getPage(u));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

for (const url of urls) {
  const text = pages.get(url);
  if (!text) continue;
  fetched++;
  const fp = fingerprint(text);
  const prev = state.pages[url];
  state.pages[url] = { fp, seen: today, checked: prev?.checked };
  const waiting = state.pending.includes(url);
  if (!prev || (prev.fp === fp && !waiting)) continue; // first sighting, or nothing changed
  changed++;
  if (!keyOk) {
    if (keyOk === false && !waiting) state.pending.push(url); // compare once the key works again
    continue;
  }
  if (calls >= MAX_CLAUDE_CALLS) {
    if (!waiting) state.pending.push(url); // compared first thing tomorrow
    skippedCap++;
    continue;
  }
  calls++;
  const items = watch.get(url).slice(0, 8);
  const prompt = `Official page: ${url}\n\nWhat the app says (JSON, one entry per item that cites this page):\n${JSON.stringify(items.map(({ ref, type, says }) => ({ ref, type, says })), null, 1).slice(0, 30000)}\n\nPage text:\n${text.slice(0, PAGE_CHARS)}`;
  const out = parseJSON(await askClaude({ model: MODELS.check, system: SYSTEM, prompt, maxTokens: 1500 }));
  if (!out) {
    if (!waiting) state.pending.push(url); // could not check: try again tomorrow
    continue;
  }
  state.pages[url].checked = today;
  state.pending = state.pending.filter((u) => u !== url);
  if (out.status === 'differs' && Array.isArray(out.findings) && out.findings.length) {
    for (const f of out.findings) if (f?.page && f?.app) findings.push({ url, country: items[0].country, ...f });
  } else if (out.status === 'unrelated') {
    unrelated.push({ url, country: items[0].country });
  }
}

mkdirSync(join(ROOT, 'state'), { recursive: true });
writeFileSync(STATE, JSON.stringify(state) + '\n');

const lines = [
  `# Visa watch, ${today}`,
  '',
  `Pages checked today: ${fetched} (${watch.size} watched in total, each one weekly). Changed since their last check: ${changed}. Compared by Claude: ${calls}.`,
  keyOk === null ? '\nThe ANTHROPIC_API_KEY secret is not set, so changed pages were noted but not compared.' : keyOk ? '\nClaude key: working.' : '\n**The Claude key is not working** (revoked, expired, or the monthly spending limit was reached). Changed pages were noted but not compared. Make a new key at platform.claude.com and update the ANTHROPIC_API_KEY secret.',
  skippedCap ? `\n${skippedCap} changed page(s) will be compared first thing tomorrow (daily limit of ${MAX_CLAUDE_CALLS} comparisons).` : '',
  '',
];
if (findings.length) {
  lines.push('## Possible differences to review', '', 'Nothing was changed. Open each page, confirm, then fix the file named in **Where** if the app is wrong.', '');
  for (const f of findings) {
    lines.push(`### ${f.country}: ${f.why ?? 'Possible difference'}`, `- **Where:** ${f.ref}`, `- **App says:** ${f.app}`, `- **Page says:** "${f.page}"`, `- **Page:** ${f.url}`, '');
  }
} else {
  lines.push('No differences found in the pages compared today.');
}
if (unrelated.length) {
  lines.push('', '## Pages that no longer look right', '', 'These links now show something else (moved page, error or login). Find the new official page and update the link.', '');
  for (const u of unrelated) lines.push(`- ${u.country}: ${u.url}`);
}
writeFileSync(REPORT, lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');

// Alert list for Discord: the Escape Plan Advisories bot posts each new entry in the staff channel.
// Kept for 30 days; ids are stable so a finding is never posted twice.
const ALERTS = join(ROOT, 'state', 'visa-alerts.json');
const oldAlerts = existsSync(ALERTS) ? JSON.parse(readFileSync(ALERTS, 'utf8')) : [];
const newAlerts = [
  ...findings.map((f) => ({ id: `diff-${hash(f.url + f.ref + f.page)}`, kind: 'difference', date: today, country: f.country, why: f.why ?? 'Possible difference', where: f.ref, app: f.app, page: f.page, url: f.url })),
  ...unrelated.map((u) => ({ id: `moved-${hash(u.url)}-${today.slice(0, 7)}`, kind: 'moved', date: today, country: u.country, url: u.url })),
  ...(keyOk === false ? [{ id: `key-${today}`, kind: 'key', date: today }] : []),
];
const keep = [...oldAlerts, ...newAlerts.filter((a) => !oldAlerts.some((o) => o.id === a.id))].filter((a) => (Date.parse(today) - Date.parse(a.date)) / 86400000 <= 30);
writeFileSync(ALERTS, JSON.stringify(keep, null, 1) + '\n');

// For the workflow: how many things need a person.
writeFileSync(join(ROOT, 'state', 'visa-watch-count.txt'), String(findings.length + unrelated.length + (keyOk === false ? 1 : 0)));
console.log(lines.slice(0, 3).join('\n'));
console.log(`Findings: ${findings.length}, pages that look wrong: ${unrelated.length}`);
