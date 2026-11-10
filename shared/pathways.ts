// Schema for the full immigration dataset: every way a person can enter, stay, live,
// work, study, retire or become a citizen of a country.
// One file per country lives in sources/pathways/<CC>.json. build-feed.mjs validates
// every record against these rules, and a record without an official source or a
// checked date is rejected, so nothing unverified ever reaches the app.

export type Purpose =
  | 'tourism' | 'business' | 'transit' | 'remote_work' | 'work' | 'study'
  | 'family' | 'retirement' | 'investment' | 'entrepreneur' | 'humanitarian'
  | 'citizenship';

export type Kind =
  | 'visa_free' | 'visa_on_arrival' | 'eta' | 'evisa' | 'visa'
  | 'temporary_residence' | 'permanent_residence' | 'citizenship';

/** Who a pathway applies to. Empty or missing means every nationality. */
export type Eligibility = {
  passports?: string[]; // ISO codes, or bloc ids like "bloc:EU"
  excludePassports?: string[];
  residentOf?: string[]; // e.g. holders of a valid US, UK or Schengen visa/residence
  holdsVisaOf?: string[];
  minAge?: number;
  maxAge?: number;
  income?: Money; // minimum proof of income, with per month or year
  savings?: Money;
  investment?: Money;
  education?: string; // e.g. "bachelor's degree"
  jobOffer?: boolean;
  language?: string; // e.g. "CEFR A2 Portuguese"
  other?: string[]; // plain-English conditions that don't fit a field
};

export type Money = { amount: number; currency: string; per?: 'month' | 'year' | 'once'; note?: string };

export type Pathway = {
  id: string; // stable, e.g. "pt-d8-digital-nomad"
  country: string; // ISO code of the destination
  name: string; // official name, e.g. "D8 Digital Nomad Visa"
  kind: Kind;
  purposes: Purpose[];
  summary: string; // one or two plain sentences
  eligibility: Eligibility;
  stay?: { maxDays?: number; perDays?: number; durationMonths?: number; renewable?: boolean; note?: string };
  rights?: { work?: 'none' | 'employer' | 'any' | 'self'; family?: boolean; publicHealth?: boolean };
  leadsTo?: { pathway: string; afterYears: number }[]; // e.g. permanent residence, citizenship
  steps?: string[]; // how to apply, in order
  where?: 'online' | 'embassy' | 'on_arrival' | 'in_country' | 'employer';
  documents?: string[];
  fees?: (Money & { label: string })[];
  processing?: string; // official estimate, phrased carefully
  citizenship?: { dualAllowed?: boolean | 'conditional'; residenceYears?: number; route?: 'naturalization' | 'descent' | 'marriage' | 'investment' | 'birth'; note?: string };
  sources: { label: string; url: string }[]; // official government pages only, at least one
  checked: string; // YYYY-MM-DD, when a source was last read
  confidence: 'verified' | 'needs_review';
};

/** A group of countries whose citizens get special rights in each other (EU, Mercosur, GCC...). */
export type Bloc = {
  id: string; // "EU", "EEA", "MERCOSUR_RES", "GCC", "ECOWAS", "CTA", "TRANS_TASMAN"...
  name: string;
  members: string[];
  rights: string; // plain English: what members get in each other
  sources: { label: string; url: string }[];
  checked: string;
};

const ISO = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns a list of problems; empty means the record can ship. */
export function checkPathway(p: Pathway, today = new Date().toISOString().slice(0, 10)): string[] {
  const bad: string[] = [];
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) bad.push('id must be lowercase-with-dashes');
  if (!ISO.test(p.country)) bad.push('country must be an ISO code');
  if (!p.name) bad.push('name missing');
  if (!p.purposes?.length) bad.push('at least one purpose');
  if (!p.summary) bad.push('summary missing');
  if (!p.sources?.length) bad.push('needs an official source');
  for (const s of p.sources ?? []) if (!/^https:\/\//.test(s.url)) bad.push(`source not https: ${s.url}`);
  if (!DATE.test(p.checked ?? '')) bad.push('checked must be YYYY-MM-DD');
  else if (p.checked > today) bad.push('checked is in the future');
  for (const f of p.fees ?? []) if (!(f.amount >= 0) || !/^[A-Z]{3}$/.test(f.currency)) bad.push(`bad fee: ${f.label}`);
  if (/—/.test(JSON.stringify(p))) bad.push('no em dashes');
  return bad;
}
