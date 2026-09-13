/**
 * Strava API client with OAuth token management.
 * 
 * Handles authentication flow, automatic token refresh, and API requests.
 * Designed for stateless Cloud Function execution with Firestore-backed tokens.
 * 
 * Strava API rate limits: 100 requests per 15 minutes, 1000 per day.
 * We use caching aggressively to stay well under these limits.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  getTokens,
  storeTokens,
  updateAccessToken,
  cacheActivity,
  getCachedActivity,
  cacheActivitiesList,
  getCachedActivitiesList
} from '../storage/firestore.js';

const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/token';

// Secret Manager client (lazy init)
let secretManagerClient = null;

// Cached secrets to avoid repeated Secret Manager calls
let cachedClientId = null;
let cachedClientSecret = null;

/**
 * Get Secret Manager client instance.
 */
function getSecretManager() {
  if (!secretManagerClient) {
    secretManagerClient = new SecretManagerServiceClient();
  }
  return secretManagerClient;
}

/**
 * Retrieve Strava client secret from Google Secret Manager.
 * Caches the secret in memory for the function instance lifetime.
 * 
 * @param {string} [overrideClientSecret] - Optional client secret override
 * @returns {Promise<string>} Strava client secret
 */
async function getStravaClientSecret(overrideClientSecret = null) {
  if (overrideClientSecret) {
    return overrideClientSecret;
  }
  
  if (cachedClientSecret) {
    return cachedClientSecret;
  }

  const client = getSecretManager();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  const secretName = `projects/${projectId}/secrets/strava-client-secret/versions/latest`;

  const [version] = await client.accessSecretVersion({ name: secretName });
  cachedClientSecret = version.payload.data.toString('utf8');
  return cachedClientSecret;
}

/**
 * Get Strava client ID from environment or Secret Manager.
 * Client ID is typically less sensitive and can be in env vars.
 * 
 * @param {string} [overrideClientId] - Optional client ID override
 * @returns {Promise<string>} Strava client ID
 */
async function getStravaClientId(overrideClientId = null) {
  if (overrideClientId) {
    return overrideClientId;
  }
  
  if (cachedClientId) {
    return cachedClientId;
  }

  // First try environment variable
  if (process.env.STRAVA_CLIENT_ID) {
    cachedClientId = process.env.STRAVA_CLIENT_ID;
    return cachedClientId;
  }

  // Fall back to Secret Manager
  const client = getSecretManager();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  const secretName = `projects/${projectId}/secrets/strava-client-id/versions/latest`;

  const [version] = await client.accessSecretVersion({ name: secretName });
  cachedClientId = version.payload.data.toString('utf8');
  return cachedClientId;
}

/**
 * Check if a token is expired or about to expire.
 * Adds a 5-minute buffer to handle request timing.
 * 
 * @param {number} expiresAt - Unix timestamp of token expiration
 * @returns {boolean} True if token needs refresh
 */
function isTokenExpired(expiresAt) {
  const bufferSeconds = 300; // 5 minutes
  const now = Math.floor(Date.now() / 1000);
  return expiresAt < (now + bufferSeconds);
}

/**
 * Refresh an expired Strava access token.
 * 
 * @param {string} refreshToken - Current refresh token
 * @param {object} [credentials] - Optional Strava app credentials
 * @param {string} [credentials.clientId] - Strava client ID
 * @param {string} [credentials.clientSecret] - Strava client secret
 * @returns {Promise<object>} New token data
 */
async function refreshAccessToken(refreshToken, credentials = {}) {
  const clientId = await getStravaClientId(credentials.clientId);
  const clientSecret = await getStravaClientSecret(credentials.clientSecret);

  const response = await fetch(STRAVA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}

/**
 * Get a valid access token for an athlete, refreshing if necessary.
 * This is the main entry point for getting auth tokens.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {object} [credentials] - Optional Strava app credentials for refresh
 * @param {string} [credentials.clientId] - Strava client ID
 * @param {string} [credentials.clientSecret] - Strava client secret
 * @returns {Promise<string>} Valid access token
 * @throws {Error} If athlete not found or refresh fails
 */
export async function getValidAccessToken(athleteId, credentials = {}) {
  const tokenData = await getTokens(athleteId);
  
  if (!tokenData) {
    throw new Error(`Athlete ${athleteId} not authenticated. Please complete OAuth flow.`);
  }

  // Check if token needs refresh
  if (isTokenExpired(tokenData.expires_at)) {
    // Use stored credentials if available, otherwise use provided/default
    const refreshCredentials = {
      clientId: credentials.clientId || tokenData.client_id,
      clientSecret: credentials.clientSecret || tokenData.client_secret
    };
    
    const newTokens = await refreshAccessToken(tokenData.refresh_token, refreshCredentials);
    
    // Update stored tokens
    await updateAccessToken(athleteId, newTokens.access_token, newTokens.expires_at);
    
    return newTokens.access_token;
  }

  return tokenData.access_token;
}

/**
 * Exchange OAuth authorization code for tokens.
 * Called from the OAuth callback endpoint.
 * 
 * @param {string} code - Authorization code from Strava
 * @param {object} [credentials] - Optional Strava app credentials
 * @param {string} [credentials.clientId] - Strava client ID
 * @param {string} [credentials.clientSecret] - Strava client secret
 * @returns {Promise<object>} Token data including athlete info
 */
export async function exchangeAuthCode(code, credentials = {}) {
  const clientId = await getStravaClientId(credentials.clientId);
  const clientSecret = await getStravaClientSecret(credentials.clientSecret);

  const response = await fetch(STRAVA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OAuth token exchange failed: ${error}`);
  }

  const data = await response.json();

  // Store tokens in Firestore (include credentials if custom app)
  const tokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_name: `${data.athlete.firstname} ${data.athlete.lastname}`
  };
  
  // Store custom credentials for future token refreshes
  if (credentials.clientId) tokenData.client_id = credentials.clientId;
  if (credentials.clientSecret) tokenData.client_secret = credentials.clientSecret;
  
  await storeTokens(data.athlete.id, tokenData);

  return {
    athleteId: data.athlete.id,
    athleteName: `${data.athlete.firstname} ${data.athlete.lastname}`
  };
}

/**
 * Make an authenticated request to the Strava API.
 * 
 * @param {string} athleteId - Athlete ID for token lookup
 * @param {string} endpoint - API endpoint (e.g., '/athlete/activities')
 * @param {object} [params] - Query parameters
 * @returns {Promise<object>} API response data
 */
async function stravaRequest(athleteId, endpoint, params = {}) {
  const accessToken = await getValidAccessToken(athleteId);
  
  const url = new URL(`${STRAVA_API_BASE}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Strava API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Fetch activities for an athlete within a date range.
 * Uses caching to minimize API calls.
 * 
 * For Ironman training analysis, we typically need:
 * - Run, Ride, and Swim activities
 * - Duration, distance, heart rate data
 * - Pace/power when available
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {Date} after - Start date (inclusive)
 * @param {Date} before - End date (inclusive)
 * @returns {Promise<object[]>} Array of activity summaries
 */
export async function getActivities(athleteId, after, before) {
  // Create cache key based on date range (day granularity)
  const cacheKey = `activities_${Math.floor(after.getTime() / 86400000)}_${Math.floor(before.getTime() / 86400000)}`;
  
  // Check cache first
  const cached = await getCachedActivitiesList(athleteId, cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch from Strava API
  // Note: Strava uses Unix timestamps for after/before
  const activities = await stravaRequest(athleteId, '/athlete/activities', {
    after: Math.floor(after.getTime() / 1000),
    before: Math.floor(before.getTime() / 1000),
    per_page: 200 // Max allowed by Strava
  });

  // Ensure we got an array back (API might return error object)
  if (!Array.isArray(activities)) {
    console.error('Strava API did not return an array:', activities);
    throw new Error('Unexpected response from Strava API');
  }

  // Cache the results
  await cacheActivitiesList(athleteId, cacheKey, activities);

  return activities;
}

/**
 * Fetch detailed data for a single activity.
 * Includes segment efforts, laps, and full metrics.
 * 
 * @param {string} athleteId - Strava athlete ID (for token lookup)
 * @param {number} activityId - Strava activity ID
 * @returns {Promise<object>} Detailed activity data
 */
export async function getActivityDetail(athleteId, activityId) {
  // Check cache first
  const cached = await getCachedActivity(athleteId, activityId);
  if (cached) {
    return cached;
  }

  // Fetch from Strava with all segment efforts included
  const activity = await stravaRequest(athleteId, `/activities/${activityId}`, {
    include_all_efforts: true
  });

  // Cache the result
  await cacheActivity(athleteId, activityId, activity);

  return activity;
}

/**
 * Get the authenticated athlete's profile.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @returns {Promise<object>} Athlete profile data
 */
export async function getAthlete(athleteId) {
  return stravaRequest(athleteId, '/athlete');
}

/**
 * Get athlete's stats (YTD and all-time totals).
 * Useful for understanding overall training background.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @returns {Promise<object>} Athlete stats
 */
export async function getAthleteStats(athleteId) {
  return stravaRequest(athleteId, `/athletes/${athleteId}/stats`);
}

/**
 * Get athlete's heart rate and power zones.
 * Returns the zones configured in the athlete's Strava profile.
 * 
 * Heart rate zones include the max HR used for zone calculation.
 * This is essential for accurate training zone analysis.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @returns {Promise<object>} Athlete zones including heart_rate.zones array
 */
export async function getAthleteZones(athleteId) {
  return stravaRequest(athleteId, '/athlete/zones');
}

/**
 * Generate OAuth authorization URL for initial athlete authentication.
 * 
 * @param {string} redirectUri - Callback URL after authorization
 * @param {string} [state] - Optional state parameter for CSRF protection
 * @param {object} [credentials] - Optional Strava app credentials
 * @param {string} [credentials.clientId] - Strava client ID
 * @returns {Promise<string>} Authorization URL
 */
export async function getAuthorizationUrl(redirectUri, state = '', credentials = {}) {
  const clientId = await getStravaClientId(credentials.clientId);
  
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read,activity:read_all,profile:read_all',
    state: state
  });

  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}
