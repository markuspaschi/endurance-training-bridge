# Endurance Training Bridge

A privacy-conscious, self-hosted bridge that reads your Garmin Connect activities, summarizes endurance training, and builds structured context for an AI coach.

> [!IMPORTANT]
> The included Garmin connector is an **unofficial community integration**. It signs into Garmin Connect with a user-owned account and stores session tokens; it does not use a public "Garmin API key." It is not affiliated with or endorsed by Garmin. For a broadly hosted or commercial product, apply to the official [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/) and replace this connector with Garmin's consent-based Activity API.

## Intended deployment model

This version is designed for **one person or one trusted household per deployment**. Each operator supplies:

- their own Google Cloud project and Firestore database;
- a randomly generated server API key;
- their own Garmin Connect session, created locally by the helper.

Do not run one shared instance for unrelated users. The current server key grants access to every athlete stored in that deployment. See [Threat model](docs/THREAT_MODEL.md).

## Features

- Recent Garmin activity retrieval and normalization
- Weekly swim, bike, run, and general endurance summaries
- Single-activity analysis and Ironman readiness heuristics
- Responsive setup and coaching-prompt UI
- Automatic Garmin session refresh
- Firestore-backed tokens and short-lived activity cache
- Authenticated token upload, status, deletion, and tool calls
- Signed OAuth state for the optional legacy Strava connector

`POST /mcp` is a small tool-call HTTP API retained for compatibility with this project. It is not a complete implementation of the official MCP JSON-RPC transport.

## Quick start

Requirements: Node.js 22+, Python 3.11+, a Google Cloud project with Firestore, and Google Application Default Credentials.

```bash
npm ci
```

Generate a strong API key:

```bash
openssl rand -hex 32
```

Set the values described in `.env.example` in your shell, then start the API:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export MCP_API_KEY="your-generated-key"
export CORS_ALLOWED_ORIGINS="http://localhost:8081"
npm start
```

In another terminal, authenticate with Garmin and upload the session directly to your local API:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-garmin.txt
python scripts/garmin-mcp-tokens.py \
  --upload-url http://localhost:8080/auth/garmin/tokens
```

The helper prompts for the server API key, Garmin email, password, and MFA code without placing them in shell history. It prints the athlete ID after a successful upload.

Serve the static UI:

```bash
python3 -m http.server 8081 --directory web
```

Open `http://localhost:8081`, enter the local API URL, server key, and athlete ID, then verify the connection.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `MCP_API_KEY` | Yes | Protects every route that reads or changes private data. Use at least 32 random bytes. |
| `GOOGLE_CLOUD_PROJECT` | Yes | Google Cloud project containing Firestore. |
| `CORS_ALLOWED_ORIGINS` | For browser UI | Comma-separated exact origins allowed to call the API. Never use `*`. |
| `ENABLE_STRAVA` | No | Set to `true` only to expose the legacy Strava OAuth routes. |
| `PUBLIC_BASE_URL` | Strava only | Canonical HTTPS API origin used for the OAuth callback. |
| `STRAVA_CLIENT_ID` | Strava only | Legacy Strava OAuth client ID. |

The optional Strava client secret must be stored in Secret Manager as `strava-client-secret`; it must never be supplied by a browser. Strava routes are disabled by default.

## API

Public endpoints:

- `GET /health`
- `GET /tools`

Private API endpoints require `Authorization: Bearer <MCP_API_KEY>`:

- `POST /mcp`
- `POST /auth/garmin/tokens`
- `GET /auth/garmin/status?athleteId=...`
- `POST /auth/garmin/disconnect`
- `GET /auth/strava/init`

The Strava callback uses a short-lived signed OAuth state instead of the bearer header.

Example tool call:

```bash
curl -X POST "https://your-api.example.com/mcp" \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "getWeeklyTrainingSummary",
    "arguments": {
      "athleteId": "your-athlete-id",
      "source": "garmin",
      "weeks": 2
    }
  }'
```

Available tools are documented by `GET /tools`.

## Deploy to Google Cloud Functions

Create a Firestore database and an API-key secret in your own project. The commands below deliberately use placeholders; review them before running.

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  --project="your-project-id"

openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets create mcp-api-key \
    --data-file=- \
    --project="your-project-id"

gcloud functions deploy endurance-training-bridge \
  --gen2 \
  --runtime=nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=mcpHandler \
  --source=. \
  --region=us-central1 \
  --project="your-project-id" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=your-project-id,CORS_ALLOWED_ORIGINS=https://your-ui.example.com" \
  --set-secrets="MCP_API_KEY=mcp-api-key:latest" \
  --memory=256MB \
  --timeout=60s
```

`--allow-unauthenticated` makes the HTTP function reachable; application routes still enforce `MCP_API_KEY`. For defense in depth, add platform-level access controls, quotas, logging, and budget alerts.

To deploy the UI with Firebase Hosting:

```bash
cp .firebaserc.example .firebaserc
# Replace the placeholder project ID.
firebase deploy --only hosting
```

Add the final Hosting origin to `CORS_ALLOWED_ORIGINS` before using the UI.

## Security and privacy

- Garmin credentials are entered only in the local Python helper.
- The web UI never accepts Garmin credentials or tokens.
- The server API key stays in browser memory and is cleared when the tab closes.
- Garmin session tokens are stored in Firestore, protected by Google Cloud encryption at rest and IAM. They are not application-layer encrypted.
- Cached activities expire after 15 minutes. The disconnect route deletes stored Garmin tokens and cached activities for that athlete.
- Training data can include health and location information. Review generated prompts before sharing them with any AI service.

Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before exposing a deployment publicly.

## Before publishing a fork

1. Rotate every API key or token that has ever appeared in source, logs, browser assets, or shell history.
2. Run `npm test`, `npm run check`, `npm audit`, and a secret scan.
3. Replace `.firebaserc` locally; it is ignored by Git.
4. Confirm that all images and brand assets have redistribution rights.
5. Enable GitHub secret scanning, push protection, Dependabot, and private vulnerability reporting.
6. Review Garmin's current program terms and branding requirements for your use case.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE). Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries.
