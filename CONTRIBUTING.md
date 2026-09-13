# Contributing

Thank you for improving Endurance Training Bridge.

## Development

1. Create a branch from the latest default branch.
2. Install dependencies with `npm ci`.
3. Make a focused change without committing credentials or personal activity data.
4. Run `npm run check` and `npm test`.
5. Explain behavior and security implications in the pull request.

Use fixtures with synthetic athlete IDs and activity data. Never attach production logs without redacting authorization headers, tokens, email addresses, athlete IDs, locations, and health metrics.

## Pull requests

- Keep changes small enough to review.
- Add tests for security boundaries and new behavior.
- Update the README and privacy documentation when data collection, storage, or sharing changes.
- Do not add Garmin branding or assets without confirming their permitted use.

Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues.
