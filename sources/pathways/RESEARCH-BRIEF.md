# Research brief: one country's immigration pathways

You are filling `sources/pathways/<CC>.json` for The Escape Plan app. Accuracy is the top priority. A missing route is better than a wrong one.

## Output
A JSON array of Pathway records matching `shared/pathways.ts` (read it first). Write it with the Write tool to the exact path you were given. Valid JSON, no comments.

## What to cover (every one that exists for this country)
1. Short visits: visa-free list or rule (summarize by bloc/list, link the official list), visa on arrival, eTA/eVisa, regular tourist visa, business visit, transit (incl. airside transit visa rules).
2. Long stays: every work route (general, skilled, intra-company, seasonal), self-employed/freelance, digital nomad/remote work, entrepreneur/startup, investor/golden visa, retirement/passive income, study, working holiday (list partner countries), family (spouse, partner, children, parents), humanitarian/asylum (one record pointing to the official process).
3. Permanent residence: every route and the years needed.
4. Citizenship: naturalization (years, language, test), marriage, descent (how many generations), birth, investment if it exists. State dual citizenship rules.
5. Free-movement rights (EU/EEA, GCC, Mercosur, etc.) as a record when they apply to this destination.

## Rules
- Lessons from the pilot: many immigration sites block bots. When one fails, try the same agency's other pages, the foreign ministry, an official embassy or consulate page (e.g. <country>embassy in the US/UK), or the official gazette PDF. Embassy pages are official and fine to cite.
- Income thresholds go in `eligibility.income` with `per` set to month or year.
- Web searches are limited per agent (about 10-15). Spend them on finding the right official URLs, then read pages with WebFetch. Guess well-known official URLs directly when you can.
- Always write the file, even if partial. Never finish without writing valid JSON.
- Sources: official government sites only (immigration agency, foreign ministry, embassy, official eVisa portal, official gazette). No law firms, blogs, Wikipedia, or visa agencies. Every record needs at least one source URL you actually opened.
- Numbers (fees, income thresholds, investment amounts, years): only if you read them on an official page. If an official page is unreachable or vague, leave the field out and set `confidence: "needs_review"` with a note in `eligibility.other`.
- `checked`: today's date (2026-11-10) for every source you actually read.
- `confidence`: "verified" only when every number and condition in the record came from the cited official page.
- Plain casual English, American spelling, no em dashes (use commas or periods). Short sentences.
- IDs: `<cc>-<short-slug>`, lowercase, dashes. `leadsTo` must reference ids in your own file.
- Money: original currency (EUR, THB, MXN, AED, JPY...), `per` set when it's monthly/yearly/once.
- Don't invent. If a route was announced but isn't open yet, include it with `needs_review` and say so in the summary.

## When done
Reply with: number of records, how many verified vs needs_review, and anything you couldn't confirm. Keep it under 150 words.

## Browser pass (for sites that block bots)
- Use the built-in browser tools (load with ToolSearch query "mcp__remote-devices__Claude_Browser__", max_results 20). Open your OWN tab with Claude_Browser__preview_start(url) and pass that tabId to every call. Never touch other tabs. Close your tab with tabs_close when done.
- Read pages with get_page_text (not screenshots). Navigate within your tab with navigate(tabId, url).
- Never sign in, submit forms, accept payments or click "apply". Reading only. Decline cookie banners if one blocks the text.
- Improve the existing <CC>.json: upgrade records to verified when the official page confirms every number, fix wrong facts, add missing main routes. Never downgrade a verified record without a reason from an official page.
- If a site asks for access approval and it is not granted, skip that site.
- Other agents may be using the browser at the same time. ALWAYS pass your own tabId, and before using any page text check that the URL shown in the get_page_text result is on the domain you asked for. If it is not, discard it and re-open your own tab.
