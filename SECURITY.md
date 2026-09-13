# Security policy

## Supported versions

Security fixes are made on the latest revision of the default branch. This project has not yet published a stable release.

## Reporting a vulnerability

Please do not open a public issue containing a vulnerability, credential, Garmin session token, athlete ID, or activity data.

Use GitHub private vulnerability reporting for the repository. Include:

- the affected route or file;
- the expected and observed behavior;
- minimal reproduction steps with all secrets removed;
- the potential impact.

If private vulnerability reporting is not enabled, open a public issue containing no exploit details and ask the maintainer to provide a private contact channel.

## Operator responsibilities

- Rotate a secret immediately if it may have been exposed.
- Restrict Firestore and Secret Manager access with least-privilege IAM.
- Use HTTPS outside localhost.
- Use a unique API key of at least 32 random bytes per deployment.
- Do not share one deployment with untrusted users.
- Avoid logging request headers, bodies, activity payloads, or Garmin tokens.

## Known upstream advisory

As of 2026-09-13, `npm audit` reports the moderate advisory `GHSA-w5hq-g745-h8pq` through `@google-cloud/functions-framework` → `cloudevents` → `uuid@8`. The affected UUID modes accept caller-provided output buffers; the installed `cloudevents@10` code calls UUID v4 without a buffer. npm's automated "fix" would downgrade the Functions Framework across a breaking major boundary, so this repository does not force an unsupported override. Dependabot is configured to track an upstream resolution.
