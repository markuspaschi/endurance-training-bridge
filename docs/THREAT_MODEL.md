# Threat model

## Scope and trust boundary

The browser UI and API can be self-hosted for one trusted household or configured as a small community service. The Google Cloud project and Firestore database remain controlled by the operator. Each Garmin athlete has a separate private connection key.

The following are outside the trust boundary:

- arbitrary websites and internet clients;
- AI services receiving a copied prompt;
- Garmin Connect and its unofficial, changeable private endpoints;
- contributors and dependencies until reviewed.

## Sensitive assets

- Garmin email, password, and MFA code
- Garmin access and refresh tokens
- operator API key and per-athlete private connection keys
- activity, health, and location data
- Strava credentials and tokens when the legacy connector is enabled

## Controls

| Threat | Current control | Residual risk |
| --- | --- | --- |
| Unauthorized API use | Random per-athlete bearer keys; only SHA-256 hashes stored; constant-time comparison; admin fallback | A leaked athlete key grants access to that athlete; a leaked admin key grants access to all athletes |
| Cross-origin browser calls | Exact `CORS_ALLOWED_ORIGINS` allow-list | CORS is not authentication and does not protect non-browser clients |
| Garmin credential theft | Credentials entered only in a local, password-masked helper | The unofficial Python dependency and the local machine must be trusted |
| Token disclosure in the UI | UI never accepts or stores Garmin tokens | Firestore operators and compromised server runtimes can read tokens |
| CSRF/OAuth state tampering | Short-lived HMAC-signed Strava state and redirect allow-list | The optional legacy Strava path has less test coverage |
| Stored data after disconnect | Token and activity-cache deletion endpoint | Cloud logs and backups follow operator retention settings |
| Dependency compromise | Lock file, CI, Dependabot configuration | Python transitive dependencies are not fully locked |
| Denial of service or cost abuse | Auth before data reads; request-size limit; public registration off by default | Registration must contact Garmin before a new key can be stored; no distributed rate limiter exists, so public operators need gateway/platform controls |

## Public-service limits

Per-athlete keys provide basic data separation for a small community deployment. They are long-lived bearer credentials, not full user accounts, and recovery is intentionally impossible if a key is lost. A production or commercial multi-tenant service still requires, at minimum:

- user authentication with short-lived sessions;
- server-derived ownership mapping for every athlete and cache object;
- official Garmin user consent and token lifecycle APIs;
- encrypted secrets with scoped access and rotation;
- audit logging without sensitive payloads;
- per-user rate limits, deletion, export, and retention controls;
- a reviewed privacy policy, terms, incident response process, and applicable data-protection compliance.
