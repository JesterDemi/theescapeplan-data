// Cost of living and take-home pay, from official statistics that publish on their own:
//   - World Bank: consumer price level vs the US for (almost) every country, from the
//     household-consumption PPP (PA.NUS.PRVT.PP) and the official exchange rate (PA.NUS.FCRF).
//   - Eurostat: price levels by category for Europe (EU, EFTA and candidate countries), EU27 = 100.
//   - OECD Taxing Wages: share of pay a single person on the average wage keeps after income tax
//     and employee social security (100 minus the net personal average tax rate), 38 countries.
// All three update about once a year. If a source is down, the last good copy is kept.

import { COUNTRIES } from '../shared/countries.ts';

const UA = 'TheEscapePlan-Data/1.0 (+https://theescapeplan.org)';
const CODES = new Set(COUNTRIES.map((c) => c.code));
const FIRST_YEAR = new Date().getUTCFullYear() - 8; // older figures are too stale to show

async function get(url, as = 'json') {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/csv' }, signal: AbortSignal.timeout(90000) });
      if (res.ok) return as === 'json' ? await res.json() : await res.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 4000 * i));
  }
  return null;
}

// ---------- World Bank ----------
async function worldBank() {
  const one = async (ind) => {
    const j = await get(`https://api.worldbank.org/v2/country/all/indicator/${ind}?format=json&per_page=20000&date=${FIRST_YEAR}:${new Date().getUTCFullYear()}`);
    if (!Array.isArray(j) || !Array.isArray(j[1])) return null;
    const out = {};
    for (const r of j[1]) {
      const code = r?.country?.id;
      if (!CODES.has(code) || typeof r.value !== 'number' || !(r.value > 0)) continue;
      (out[code] ??= {})[r.date] = r.value;
    }
    return out;
  };
  const [ppp, fx] = await Promise.all([one('PA.NUS.PRVT.PP'), one('PA.NUS.FCRF')]);
  if (!ppp || !fx) return null;
  const res = {};
  for (const code of Object.keys(ppp)) {
    // Latest year that has both numbers.
    const year = Object.keys(ppp[code]).filter((y) => fx[code]?.[y]).sort().pop();
    if (!year) continue;
    const level = Math.round((ppp[code][year] / fx[code][year]) * 100); // US = 100
    if (level >= 10 && level <= 300) res[code] = { level, year: Number(year) };
  }
  return Object.keys(res).length > 120 ? res : null;
}

// ---------- Eurostat ----------
const CATS = { all: 'A01', food: 'A0101', housing: 'A0104', transport: 'A0107', eatingOut: 'A0111', health: 'A0106', alcohol: 'A0102', clothes: 'A0103' };
const EU_GEO = { EL: 'GR', UK: 'GB' }; // Eurostat uses EL for Greece
async function eurostat() {
  const qs = Object.values(CATS).map((c) => `ppp_cat=${c}`).join('&');
  const j = await get(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_ppp_ind?format=JSON&lang=en&na_item=PLI_EU27_2020&${qs}&lastTimePeriod=1`);
  if (!j?.value || !j.dimension) return null;
  const order = j.id; // e.g. freq, na_item, ppp_cat, geo, time
  const size = j.size;
  const idx = (dim, key) => j.dimension[dim].category.index[key];
  const year = Number(Object.keys(j.dimension.time.category.index)[0]);
  const res = {};
  for (const geo of Object.keys(j.dimension.geo.category.index)) {
    const code = EU_GEO[geo] ?? geo;
    if (!CODES.has(code)) continue;
    const row = {};
    for (const [name, cat] of Object.entries(CATS)) {
      const at = { freq: 0, na_item: 0, ppp_cat: idx('ppp_cat', cat), geo: idx('geo', geo), time: 0 };
      if (at.ppp_cat === undefined) continue;
      let flat = 0;
      for (let k = 0; k < order.length; k++) flat = flat * size[k] + (at[order[k]] ?? 0);
      const v = j.value[flat];
      if (typeof v === 'number') row[name] = Math.round(v);
    }
    if (row.all) res[code] = { ...row, year };
  }
  return Object.keys(res).length > 25 ? res : null;
}

// ---------- OECD ----------
async function oecd() {
  const csv = await get(
    `https://sdmx.oecd.org/public/rest/data/OECD.CTP.TPS,DSD_TAX_WAGES_COMP@DF_TW_COMP,/.NPATR.PT_WG_EARN_G.S_C0.AW100..A?startPeriod=${FIRST_YEAR}&format=csv`,
    'csv'
  );
  if (!csv) return null;
  const lines = csv.trim().split('\n');
  const head = lines.shift().split(',');
  const col = (n) => head.indexOf(n);
  const [cA, cT, cV] = [col('REF_AREA'), col('TIME_PERIOD'), col('OBS_VALUE')];
  if (cA < 0 || cT < 0 || cV < 0) return null;
  const iso3 = await isoMap();
  const res = {};
  for (const l of lines) {
    const c = l.split(',');
    const code = iso3[c[cA]];
    const v = Number(c[cV]);
    const y = Number(c[cT]);
    if (!code || !CODES.has(code) || !isFinite(v)) continue;
    if (!res[code] || res[code].year < y) res[code] = { keep: Math.round(100 - v), year: y };
  }
  return Object.keys(res).length > 25 ? res : null;
}
// ISO3 -> ISO2, from the World Bank country list (same source, no extra dependency).
async function isoMap() {
  const j = await get('https://api.worldbank.org/v2/country?format=json&per_page=400');
  const m = {};
  for (const c of j?.[1] ?? []) if (c.iso2Code && c.id) m[c.id] = c.iso2Code;
  return m;
}

/** Builds the costs block for feed.json. `prev` is the last published block, kept for any source that fails. */
export async function loadCosts(prev) {
  const [wb, es, oe] = await Promise.all([worldBank(), eurostat(), oecd()]);
  const ok = { worldBank: !!wb, eurostat: !!es, oecd: !!oe };
  const level = wb ?? prev?.level ?? {};
  const cats = es ?? prev?.cats ?? {};
  const takeHome = oe ?? prev?.takeHome ?? {};
  return {
    costs: {
      level,
      cats,
      takeHome,
      sources: {
        level: 'World Bank: PPP conversion factor for household consumption (PA.NUS.PRVT.PP) / official exchange rate (PA.NUS.FCRF). US = 100.',
        cats: 'Eurostat: price level indices by category (prc_ppp_ind), EU27 = 100.',
        takeHome: 'OECD Taxing Wages: single person, no children, average wage. 100 minus the net personal average tax rate.',
      },
      checked: new Date().toISOString().slice(0, 10),
    },
    ok,
  };
}
