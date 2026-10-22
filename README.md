# The Escape Plan data feed

The app downloads `feed.json` from this repo (every 6 hours at most, plus whenever it opens).
Edits here reach every phone the same day, with no app update.

A GitHub Action runs daily. It rebuilds `feed.json`, checks every official link and the four
government advisory feeds, and writes `HEALTH.md`. If anything needs attention it opens an issue
called **Data needs attention** (GitHub emails you), and closes it again once everything passes.

## What happens with nobody touching it

- Every day the job reads the UK government's change log for all ~200 countries. Any country that changed its
  entry or visa rules in the last 45 days automatically gets a notice in the app, linked to the official page.
- If the open passport dataset publishes new data, it's pulled in automatically.
- Travel advisories are read live by the phones from 4 governments.

## Files you edit (in `sources/`)

| File | What it is |
| --- | --- |
| `overrides.json` | Corrections when a country changes its visitor rules before the passport dataset catches up. First matching rule wins. |
| `notices.json` | Short warnings shown on a country's entry card (policy ending, tourism-only, etc). |
| `visas.json` | The long-stay visa guides. Bump `reviewed` (YYYY-MM) every time you re-check one. |
| `meta.json` | Shared notes, like the Schengen EES/ETIAS line. Update `checked` when you re-check it. |
| `uk-slugs.json` | Country code to gov.uk page name, used by the automatic watch. Rarely changes. |

Every override and notice needs an `https://` source, ideally a government page. The build refuses
to publish a broken feed, so a typo can't break the app; the old feed just stays live.

### Example: a country changes its visa-free stay

```json
{
  "id": "xx-2027-change",
  "dest": "XX",
  "from": "2027-01-01",
  "match": { "code": "F", "days": 90 },
  "set": { "code": "F", "days": 30 },
  "source": "https://official.gov/page"
}
```

Add `"passports": ["US", "GB"]` to limit it to some passports, and `"until": "2027-12-31"` if it ends.
Codes: F visa free, A visa on arrival, T eTA, E e-visa, R visa required, N no admission.

After editing on github.com, the Action runs automatically and the change is live within minutes.

## Sources

- Short-stay rules: [imorte/passport-index-data](https://github.com/imorte/passport-index-data) (MIT), plus the overrides here.
- Advisories are fetched live by the app from the US, UK, Canadian and Australian governments.
