# Data health

Checked 2026-10-22 15:00 UTC. Feed generated 2026-10-22 14:41 UTC.

- Passport dataset: 199 passports, dated 2026-02-17
- Overrides: 5, notices: 2, visa guides: 7
- Advisory feeds: US ok, UK ok, CA ok, AU error: ETIMEDOUT
- Links checked: 18

Everything looks good.

## Notes

- **passports**: Passport dataset is 247 days old (dated 2026-02-17). Upstream has not refreshed; add overrides for any known rule changes.
- **advisories**: AU advisory feed could not be reached from GitHub's servers (error: ETIMEDOUT). Phones fetch it directly, so this is usually a block on GitHub's network.
