# Privacy notice for self-hosted deployments

This repository is software, not a hosted service. The person or organization operating a deployment controls the data and is responsible for an accurate privacy notice and compliance with applicable law.

## Data processed

A deployment can process:

- Garmin session tokens and account display information;
- activity dates, types, titles, duration, distance, pace, power, heart rate, elevation, cadence, calories, and location-derived data;
- generated training summaries and coaching prompts.

Garmin credentials and MFA codes are entered into the local helper. The helper sends credentials to Garmin during sign-in; it sends only the resulting session tokens and profile identifier to the configured bridge server.

## Storage and retention

- Garmin session tokens remain in the operator's Firestore database until disconnect or manual deletion.
- Activity cache entries expire after 15 minutes and are also removed by the disconnect endpoint.
- The browser keeps the server API key in memory only. The API URL and athlete ID use session storage and are removed when the browser session ends.

Firestore and the hosting platform may retain backups or logs according to the operator's cloud configuration. Operators should document those settings and avoid request-body logging.

## Sharing

The bridge does not send activity data to an AI provider automatically. The UI builds a prompt that the user may copy. Users should review it before sharing because it may contain sensitive health and location information.

## User controls

The UI's **Delete server data** action deletes the selected athlete's stored Garmin session and activity caches. Operators remain responsible for backups, logs, and any independently exported copies.

## Garmin

This community project is not affiliated with or endorsed by Garmin. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries. Operators must review Garmin's current terms and obtain user consent appropriate to their deployment.
