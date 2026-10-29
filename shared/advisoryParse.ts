// Copied from the app (src/lib/advisoryParse.ts) so the Discord alerts use the exact same rules.
// Only the two import paths differ. Keep the copies in sync when the app changes.
// Pure parsing for the four government travel advisory feeds. No network or
// storage here, so it can be unit tested against real response shapes.
//
// Feed facts verified against the live feeds on 7 Oct 2026:
// - US  https://cadataapi.state.gov/api/TravelAdvisories (send Accept: application/json,
//       otherwise it returns XML). `Category` holds FIPS codes, NOT ISO (GB = Gabon), so we
//       match on the ISO alpha-3 code inside `Link` (".../destination.sau.html"), then by name.
// - UK  https://www.gov.uk/api/content/foreign-travel-advice/{slug}: details.alert_status is a
//       list of avoid_all_travel_to_whole_country, avoid_all_but_essential_travel_to_whole_country,
//       avoid_all_travel_to_parts, avoid_all_but_essential_travel_to_parts (empty = no warning).
// - CA  https://data.international.gc.ca/travel-voyage/index-alpha-eng.json: data[ISO2] with
//       advisory-state 0-3, has-regional-advisory, eng.advisory-text, eng.url-slug.
// - AU  https://www.smartraveller.gov.au/destinations-export: array, `title` is HTML-encoded,
//       field_overall_advice_level is one of four phrases or "No travel advice".

import { ADVISORY_SNAPSHOT, ADVISORY_SNAPSHOT_DATE, AU_TITLE, UK_SLUG, US_ISO3 } from './advisorySnapshot.ts';
import { countryName } from './countries.ts';

export type Level = 1 | 2 | 3 | 4;
export type SourceId = 'US' | 'UK' | 'CA' | 'AU';

export const LEVEL_LABEL: Record<Level, string> = {
  1: 'Normal precautions',
  2: 'Increased caution',
  3: 'Reconsider travel',
  4: 'Do not travel',
};

export const SOURCE_NAME: Record<SourceId, string> = {
  US: 'US State Department',
  UK: 'UK Foreign Office',
  CA: 'Government of Canada',
  AU: 'Australia Smartraveller',
};

export type SourceAdvisory = {
  source: SourceId;
  level?: Level;
  text: string; // the source's own headline wording
  detail?: string; // short summary or latest change, plain text
  regional?: boolean; // some areas have a higher level than the headline
  url: string;
  updated?: string; // YYYY-MM-DD
  origin: 'live' | 'cache' | 'snapshot' | 'none';
  homeCountry?: boolean; // this government does not advise on itself
};

export type Aggregate = {
  code: string;
  level?: Level; // most cautious headline level across sources
  regional: boolean;
  sources: SourceAdvisory[];
  checkedAt: string; // ISO timestamp of the newest data we have
  offline: boolean; // true when nothing came from the live feeds
};

const HOME: Record<SourceId, string> = { US: 'US', UK: 'GB', CA: 'CA', AU: 'AU' };

export const sourceUrl = {
  US: (iso3?: string) =>
    iso3 ? `https://travel.state.gov/content/tsg_aem/us/en/home/international-travel/travel-advisories/destination.${iso3.toLowerCase()}.html` : 'https://travel.state.gov/en/international-travel/travel-advisories.html',
  UK: (slug?: string) => (slug ? `https://www.gov.uk/foreign-travel-advice/${slug}` : 'https://www.gov.uk/foreign-travel-advice'),
  CA: (slug?: string) => (slug ? `https://travel.gc.ca/destinations/${slug}` : 'https://travel.gc.ca/travelling/advisories'),
  AU: (path?: string) => (path ? `https://www.smartraveller.gov.au/destinations/${path}` : 'https://www.smartraveller.gov.au/destinations'),
};

// ---------- helpers ----------

export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h\d)>/gi, '. ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.{2,}/g, '.')
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** First couple of sentences, capped, for a readable one-liner. */
export function brief(text: string, max = 220): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return (end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '...').trim();
}

const norm = (s: string) =>
  decodeEntities(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/^the /, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const NAME_ALIASES: Record<string, string[]> = {
  MM: ['burma'],
  CZ: ['czech republic'],
  TR: ['turkey', 'turkiye'],
  KG: ['kyrgyz republic'],
  CG: ['republic of congo', 'congo brazzaville'],
  CD: ['democratic republic of the congo', 'congo kinshasa'],
  CI: ['cote divoire', 'cote d ivoire', 'ivory coast'],
  FM: ['federated states of micronesia', 'micronesia'],
  MO: ['macau', 'macao'],
  PS: ['west bank', 'palestine'],
  DK: ['kingdom of denmark', 'denmark'],
  KR: ['south korea'],
  KP: ['north korea'],
  CV: ['cabo verde', 'cape verde'],
  BN: ['brunei', 'brunei darussalam'],
  US: ['united states', 'united states of america', 'usa'],
};
export function namesFor(code: string): string[] {
  return [norm(countryName(code)), ...(NAME_ALIASES[code] ?? []).map(norm)];
}

const isoDate = (s?: string) => {
  if (!s) return undefined;
  const m = String(s).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
};

// ---------- US ----------

export function parseUS(list: any[], code: string): SourceAdvisory | null {
  if (code === HOME.US) return homeEntry('US');
  if (!Array.isArray(list)) return null;
  const iso3 = US_ISO3[code]?.toLowerCase();
  const names = namesFor(code);
  const title = (x: any) => String(x?.Title ?? '');
  const matches = list.filter((x) => {
    const link = String(x?.Link ?? '');
    const m = link.match(/destination\.([a-z0-9]{3})\.html/i);
    if (m && iso3) return m[1].toLowerCase() === iso3;
    const name = norm(title(x).split(/ - |\s+Travel Advisory/i)[0]);
    return names.includes(name);
  });
  if (!matches.length) return null;
  // Duplicates happen (e.g. Burma appears twice): newest wins.
  const hit = matches.sort((a, b) => String(b.Updated ?? '').localeCompare(String(a.Updated ?? '')))[0];
  const lv = title(hit).match(/Level\s*([1-4])/i);
  const level = lv ? (Number(lv[1]) as Level) : undefined;
  const summary = stripHtml(String(hit.Summary ?? ''));
  const head = title(hit).match(/Level\s*[1-4]:\s*([^-]+)/i)?.[1]?.trim();
  return {
    source: 'US',
    level,
    text: head ?? (level ? LEVEL_LABEL[level] : 'See the official page'),
    detail: summary ? brief(summary) : undefined,
    regional: /some areas have increased risk|do not travel to|reconsider travel to/i.test(summary),
    url: hit.Link || sourceUrl.US(iso3),
    updated: isoDate(hit.Updated || hit.Published),
    origin: 'live',
  };
}

// ---------- UK ----------

export type UkCode = '0' | 'P3' | 'P4' | 'W3' | 'W4';

export function ukCodeFromAlerts(alerts: string[]): UkCode {
  const has = (k: string) => alerts.includes(k);
  if (has('avoid_all_travel_to_whole_country')) return 'W4';
  if (has('avoid_all_but_essential_travel_to_whole_country')) return 'W3';
  if (has('avoid_all_travel_to_parts')) return 'P4';
  if (has('avoid_all_but_essential_travel_to_parts')) return 'P3';
  return '0';
}

const UK_TEXT: Record<UkCode, string> = {
  '0': 'No advice against travel',
  P3: 'Advises against all but essential travel to parts of the country',
  P4: 'Advises against all travel to parts of the country',
  W3: 'Advises against all but essential travel to the whole country',
  W4: 'Advises against all travel to the whole country',
};
// The UK does not use levels; this maps its warnings onto the shared scale.
const UK_LEVEL: Record<UkCode, Level> = { '0': 1, P3: 2, P4: 3, W3: 3, W4: 4 };

export function ukFromCode(code: string, ukCode: UkCode, updated?: string, change?: string, origin: SourceAdvisory['origin'] = 'live'): SourceAdvisory {
  return {
    source: 'UK',
    level: UK_LEVEL[ukCode],
    text: UK_TEXT[ukCode],
    detail: change ? brief(stripHtml(change)) : undefined,
    regional: ukCode === 'P3' || ukCode === 'P4',
    url: sourceUrl.UK(UK_SLUG[code]),
    updated: isoDate(updated),
    origin,
  };
}

export function parseUK(json: any, code: string): SourceAdvisory | null {
  if (code === HOME.UK) return homeEntry('UK');
  const d = json?.details;
  if (!d) return null;
  return ukFromCode(code, ukCodeFromAlerts(d.alert_status ?? []), json.public_updated_at, d.change_description);
}

// ---------- Canada ----------

export function parseCA(index: any, code: string): SourceAdvisory | null {
  if (code === HOME.CA) return homeEntry('CA');
  const entry = index?.data?.[code === 'PS' ? 'IL' : code];
  if (!entry) return null;
  const eng = entry.eng ?? {};
  const state = Number(entry['advisory-state']);
  const level = Number.isInteger(state) && state >= 0 && state <= 3 ? ((state + 1) as Level) : undefined;
  return {
    source: 'CA',
    level,
    text: String(eng['advisory-text'] ?? (level ? LEVEL_LABEL[level] : 'See the official page')).replace(/\s*\(with regional advisories\)/i, ''),
    detail: eng['recent-updates'] ? `Latest update: ${eng['recent-updates']}` : undefined,
    regional: !!entry['has-regional-advisory'],
    url: sourceUrl.CA(eng['url-slug']),
    updated: isoDate(entry['date-published']?.date),
    origin: 'live',
  };
}

// ---------- Australia ----------

const AU_LEVEL: Record<string, Level> = {
  'exercise normal safety precautions': 1,
  'exercise a high degree of caution': 2,
  'reconsider your need to travel': 3,
  'do not travel': 4,
};

export function parseAU(list: any[], code: string): SourceAdvisory | null {
  if (code === HOME.AU) return homeEntry('AU');
  const arr = Array.isArray(list) ? list : Object.values(list ?? {});
  const want = AU_TITLE[code];
  const names = namesFor(code);
  const hit =
    arr.find((x: any) => want && decodeEntities(String(x?.title ?? '')) === want) ??
    arr.find((x: any) => names.includes(norm(String(x?.title ?? ''))));
  if (!hit) return null;
  const phrase = String(hit.field_overall_advice_level ?? '').trim();
  const level = AU_LEVEL[phrase.toLowerCase()];
  if (!level) return null; // "No travel advice"
  const regionalText = stripHtml(String(hit.field_advice_levels ?? ''));
  return {
    source: 'AU',
    level,
    text: phrase,
    detail: hit.field_last_update ? brief(stripHtml(String(hit.field_last_update))) : undefined,
    regional: (regionalText.match(/(do not travel|reconsider your need to travel|high degree of caution)/gi) ?? []).length > 1,
    url: hit.field_url || sourceUrl.AU(),
    updated: isoDate(hit.changed),
    origin: 'live',
  };
}

// ---------- snapshot + aggregate ----------

function homeEntry(source: SourceId): SourceAdvisory {
  return { source, text: 'Not issued (this is its home country)', url: sourceUrl[source](), origin: 'none', homeCountry: true };
}

export function fromSnapshot(code: string, source: SourceId): SourceAdvisory | null {
  if (HOME[source] === code) return homeEntry(source);
  const s = ADVISORY_SNAPSHOT[code];
  if (!s) return null;
  if (source === 'US' && s.us) {
    const level = s.us[0] as Level;
    return { source, level, text: LEVEL_LABEL[level], url: sourceUrl.US(US_ISO3[code]), updated: s.us[1], origin: 'snapshot' };
  }
  if (source === 'UK' && s.uk) return ukFromCode(code, s.uk[0] as UkCode, s.uk[1], undefined, 'snapshot');
  if (source === 'CA' && s.ca) {
    const level = s.ca[0] as Level;
    return { source, level, text: LEVEL_LABEL[level], regional: !!s.ca[2], url: sourceUrl.CA(s.ca[3]), updated: s.ca[1], origin: 'snapshot' };
  }
  if (source === 'AU' && s.au) {
    const level = s.au[0] as Level;
    return { source, level, text: LEVEL_LABEL[level], url: sourceUrl.AU(s.au[2]), updated: s.au[1], origin: 'snapshot' };
  }
  return null;
}

export function notCovered(source: SourceId): SourceAdvisory {
  return { source, text: 'No advisory published for this destination', url: sourceUrl[source](), origin: 'none' };
}

export function aggregate(code: string, sources: SourceAdvisory[], checkedAt = new Date().toISOString()): Aggregate {
  const levels = sources.filter((s) => s.level && !s.homeCountry).map((s) => s.level!) as Level[];
  return {
    code,
    level: levels.length ? (Math.max(...levels) as Level) : undefined,
    regional: sources.some((s) => s.regional),
    sources,
    checkedAt,
    offline: !sources.some((s) => s.origin === 'live'),
  };
}

/** Offline-only aggregate built from the bundled snapshot. */
export function snapshotAggregate(code: string): Aggregate {
  const ids: SourceId[] = ['US', 'UK', 'CA', 'AU'];
  return aggregate(
    code,
    ids.map((id) => fromSnapshot(code, id) ?? notCovered(id)),
    `${ADVISORY_SNAPSHOT_DATE}T00:00:00Z`,
  );
}

/** Which sources changed level between two checks (for alerts). */
export function levelChanges(prev: Record<string, number | undefined>, next: Aggregate) {
  const out: { source: SourceId | 'overall'; from?: number; to?: number }[] = [];
  for (const s of next.sources) {
    if (s.homeCountry || !s.level) continue;
    const before = prev[s.source];
    if (before !== undefined && before !== s.level) out.push({ source: s.source, from: before, to: s.level });
  }
  if (prev.overall !== undefined && next.level !== undefined && prev.overall !== next.level) out.push({ source: 'overall', from: prev.overall, to: next.level });
  return out;
}

export function levelsOf(a: Aggregate): Record<string, number | undefined> {
  const r: Record<string, number | undefined> = { overall: a.level };
  for (const s of a.sources) if (s.level && !s.homeCountry) r[s.source] = s.level;
  return r;
}
