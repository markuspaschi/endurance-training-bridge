# Threat model

## Scope and trust boundary

The supported configuration is one trusted person or household per deployment. The browser UI, API, Firestore database, Google Cloud project, and local Garmin helper are controlled by that operator.

The following are outside the trust boundary:

- arbitrary websites and internet clients;
- AI services receiving a copied prompt;
- Garmin Connect and its unofficial, changeable private endpoints;
- contributors and dependencies until reviewed.

## Sensitive assets

- Garmin email, password, and MFA code
- Garmin access and refresh tokens
- server API key
- activity, health, and location data
- Strava credentials and tokens when the legacy connector is enabled

## Controls

| Threat | Current control | Residual risk |
| --- | --- | --- |
| Unauthorized API use | Bearer key on all private routes; constant-time comparison; minimum key length | A leaked key grants access to every athlete in the deployment |
| Cross-origin browser calls | Exact `CORS_ALLOWED_ORIGINS` allow-list | CORS is not authentication and does not protect non-browser clients |
| Garmin credential theft | Credentials entered only in a local, password-masked helper | The unofficial Python dependency and the local machine must be trusted |
| Token disclosure in the UI | UI never accepts or stores Garmin tokens | Firestore operators and compromised server runtimes can read tokens |
| CSRF/OAuth state tampering | Short-lived HMAC-signed Strava state and redirect allow-list | The optional legacy Strava path has less test coverage |
| Stored data after disconnect | Token and activity-cache deletion endpoint | Cloud logs and backups follow operator retention settings |
| Dependency compromise | Lock file, CI, Dependabot configuration | Python transitive dependencies are not fully locked |
| Denial of service or cost abuse | Auth before private work; request-size limit | No distributed rate limiter; operators should use platform quotas or an API gateway |

## Unsupported multi-tenant use

The shared `MCP_API_KEY` is an operator credential, not a user identity. Athlete IDs are selectors, not authorization boundaries. Do not use this version as a shared hosted service for unrelated people.

A future multi-tenant service requires, at minimum:

- user authentication with short-lived sessions;
- server-derived ownership mapping for every athlete and cache object;
- official Garmin user consent and token lifecycle APIs;
- encrypted secrets with scoped access and rotation;
- audit logging without sensitive payloads;
- per-user rate limits, deletion, export, and retention controls;
- a reviewed privacy policy, terms, incident response process, and applicable data-protection compliance.
