/**
 * Native Node.js Garmin Connect client using DI (Device Intelligence) tokens.
 *
 * This implementation matches the authentication flow used by
 * `garminconnect` 0.3.x (the same library used by garmin_mcp):
 *  - Login is performed externally (by the Python helper) because Garmin's
 *    web login flow requires browser impersonation and MFA handling.
 *  - The server receives and stores DI tokens: di_token, di_refresh_token,
 *    di_client_id.
 *  - API calls use `Authorization: Bearer {di_token}` plus Garmin native
 *    mobile-app headers.
 *  - Tokens are refreshed via POST to diauth.garmin.com.
 *
 * Tokens are persisted in Firestore by the caller (see storage/firestore.js).
 */

import crypto from 'crypto';
import {
  getGarminTokens,
  updateGarminTokens,
  cacheGarminActivity,
  getCachedGarminActivity,
  cacheGarminActivitiesList,
  getCachedGarminActivitiesList
} from '../storage/firestore.js';
import { normalizeGarminSummary, normalizeGarminActivity } from './normalizer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN = 'garmin.com';
const CONNECT_URL = `https://connect.${DOMAIN}`;
const CONNECT_API = `https://connectapi.${DOMAIN}`;
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';

const NATIVE_API_USER_AGENT = 'GCM-Android-5.23';
const NATIVE_X_GARMIN_USER_AGENT =
  'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; ' +
  'Android/33; Dalvik/2.1.0';

const ACTIVITIES_URL = `${CONNECT_API}/activitylist-service/activities/search/activities`;
const ACTIVITY_URL = `${CONNECT_API}/activity-service/activity/`;
const USER_PROFILE_URL = `${CONNECT_API}/userprofile-service/socialProfile`;
const USER_SETTINGS_URL = `${CONNECT_API}/userprofile-service/userprofile/user-settings/`;
const ACTIVITY_DETAILS_URL = (id) => `${CONNECT_API}/activity-service/activity/${id}/details`;

// Bump this to invalidate cached Garmin data after normalizer/schema changes.
const CACHE_VERSION = 'v3';

// ---------------------------------------------------------------------------
// Http helpers
// ---------------------------------------------------------------------------

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildQueryString(params) {
  if (!params) return '';
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      parts.push(`${percentEncode(key)}=${percentEncode(String(value))}`);
    }
  }
  return parts.join('&');
}

function getNativeHeaders(extra = {}) {
  return {
    'User-Agent': NATIVE_API_USER_AGENT,
    'X-Garmin-User-Agent': NATIVE_X_GARMIN_USER_AGENT,
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'application/json',
    ...extra
  };
}

function buildBasicAuth(clientId) {
  return 'Basic ' + Buffer.from(`${clientId}:`).toString('base64');
}

async function requestJson(url, options = {}) {
  const init = {
    method: options.method || 'GET',
    redirect: 'follow',
    headers: { ...(options.headers || {}) }
  };

  if (options.body) {
    if (typeof options.body === 'string' || options.body instanceof URLSearchParams) {
      init.body = options.body;
    } else {
      init.body = JSON.stringify(options.body);
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    }
  }

  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Garmin HTTP error ${response.status}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payloadB64 = parts[1] + '='.repeat((-parts[1].length) % 4);
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function tokenExpiresSoon(token, bufferSeconds = 900) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  return Math.floor(Date.now() / 1000) > (parseInt(payload.exp, 10) - bufferSeconds);
}

// ---------------------------------------------------------------------------
// GarminConnect client
// ---------------------------------------------------------------------------

export class GarminConnectClient {
  constructor() {
    this.tokens = null;
  }

  loadTokens(tokens) {
    if (!tokens || !tokens.di_token) {
      throw new Error('Invalid Garmin DI tokens');
    }
    this.tokens = { ...tokens };
  }

  exportTokens() {
    if (!this.tokens) {
      throw new Error('No tokens to export - authenticate first');
    }
    return { ...this.tokens };
  }

  async refreshToken() {
    if (!this.tokens || !this.tokens.di_refresh_token || !this.tokens.di_client_id) {
      throw new Error('Cannot refresh: missing DI refresh token or client id');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.tokens.di_client_id,
      refresh_token: this.tokens.di_refresh_token
    });

    const data = await requestJson(DI_TOKEN_URL, {
      method: 'POST',
      body,
      headers: getNativeHeaders({
        Authorization: buildBasicAuth(this.tokens.di_client_id),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache'
      })
    });

    this.tokens = {
      di_token: data.access_token,
      di_refresh_token: data.refresh_token || this.tokens.di_refresh_token,
      di_client_id: this.extractClientIdFromJwt(data.access_token) || this.tokens.di_client_id
    };
  }

  extractClientIdFromJwt(token) {
    const payload = decodeJwtPayload(token);
    if (payload && payload.client_id) {
      return String(payload.client_id);
    }
    return null;
  }

  async ensureValidToken() {
    if (!this.tokens || !this.tokens.di_token) {
      throw new Error('Not authenticated with Garmin');
    }
    if (tokenExpiresSoon(this.tokens.di_token)) {
      await this.refreshToken();
    }
  }

  async apiGet(url, params = {}) {
    await this.ensureValidToken();
    const qs = buildQueryString(params);
    const fullUrl = qs ? `${url}?${qs}` : url;
    return requestJson(fullUrl, {
      headers: getNativeHeaders({
        Authorization: `Bearer ${this.tokens.di_token}`
      })
    });
  }

  async getUserProfile() {
    return this.apiGet(USER_PROFILE_URL);
  }

  async getUserSettings() {
    return this.apiGet(USER_SETTINGS_URL);
  }

  async getActivities(start = 0, limit = 100, activityType) {
    const params = { start, limit };
    if (activityType) params.activityType = activityType;
    return this.apiGet(ACTIVITIES_URL, params);
  }

  async getActivitiesByDate(startDate, endDate, start = 0, limit = 100) {
    const all = [];
    const pageSize = 100;
    let page = 0;
    const after = new Date(startDate + 'T00:00:00').getTime();
    const before = new Date(endDate + 'T23:59:59').getTime();
    const maxPages = 20;

    while (all.length < limit && page < maxPages) {
      const batch = await this.getActivities(page * pageSize, pageSize);
      if (!batch || batch.length === 0) break;

      for (const activity of batch) {
        const startTime = new Date(activity.startTimeLocal || activity.startTimeGMT).getTime();
        if (startTime >= after && startTime <= before) {
          all.push(activity);
          if (all.length >= limit) break;
        }
      }

      const lastStart = new Date(batch[batch.length - 1].startTimeLocal || batch[batch.length - 1].startTimeGMT).getTime();
      if (lastStart < after) break;
      page++;
    }

    return all;
  }

  async getActivity(activityId) {
    return this.apiGet(`${ACTIVITY_URL}${activityId}`);
  }

  async getActivityDetails(activityId, maxChartSize = 200) {
    return this.apiGet(ACTIVITY_DETAILS_URL(activityId), { maxChartSize });
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers for the rest of the app
// ---------------------------------------------------------------------------

export async function createGarminClientFromTokens(tokenData) {
  const client = new GarminConnectClient();
  client.loadTokens(tokenData.tokens || tokenData);
  await client.ensureValidToken();
  return client;
}

export async function getGarminClientForAthlete(athleteId) {
  const tokenData = await getGarminTokens(athleteId);
  if (!tokenData || !tokenData.tokens) {
    throw new Error(`Athlete ${athleteId} has no stored Garmin tokens. Authenticate first.`);
  }

  const client = new GarminConnectClient();
  client.loadTokens(tokenData.tokens);
  await client.ensureValidToken();

  if (JSON.stringify(tokenData.tokens) !== JSON.stringify(client.exportTokens())) {
    await updateGarminTokens(athleteId, client.exportTokens());
  }

  return client;
}

export async function getGarminActivitiesForAthlete(athleteId, after, before) {
  const cacheKey = `${CACHE_VERSION}_garmin_activities_${dateToDay(after)}_${dateToDay(before)}`;
  const cached = await getCachedGarminActivitiesList(athleteId, cacheKey);
  if (cached) return cached;

  const client = await getGarminClientForAthlete(athleteId);
  const startDate = toISODate(after);
  const endDate = toISODate(before);

  const activities = await client.getActivitiesByDate(startDate, endDate, 0, 200);
  const normalized = (activities || []).map(normalizeGarminSummary);

  await cacheGarminActivitiesList(athleteId, cacheKey, normalized);
  return normalized;
}

export async function getGarminActivityDetailForAthlete(athleteId, activityId) {
  const cacheKey = `${CACHE_VERSION}_${activityId}`;
  const cached = await getCachedGarminActivity(athleteId, cacheKey);
  if (cached) return cached;

  const client = await getGarminClientForAthlete(athleteId);
  const [activity, detailMetrics] = await Promise.all([
    client.getActivity(activityId),
    client.getActivityDetails(activityId, 200).catch(() => null)
  ]);
  const normalized = normalizeGarminActivity(activity, detailMetrics);

  await cacheGarminActivity(athleteId, cacheKey, normalized);
  return normalized;
}

function dateToDay(date) {
  return Math.floor(date.getTime() / 86400000);
}

function toISODate(date) {
  return date.toISOString().split('T')[0];
}
