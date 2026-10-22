# Data health

Checked 2026-10-22 14:41 UTC. Feed generated 2026-10-22 14:41 UTC.

- Passport dataset: 199 passports, dated 2026-02-17
- Overrides: 5, notices: 2, visa guides: 7
- Advisory feeds: US ok, UK ok, CA ok, AU error: The operation was aborted due to timeout
- Links checked: 18

## Needs attention

- **passports**: Passport dataset is 247 days old (dated 2026-02-17). Upstream has not refreshed; add overrides for any known rule changes.
- **links**: Link check failed (error: UNABLE_TO_VERIFY_LEAF_SIGNATURE): https://aima.gov.pt
- **advisories**: AU advisory feed: error: The operation was aborted due to timeout. The app falls back to cached/bundled levels; check whether the endpoint moved.
