/**
 * Firestore storage module for Strava MCP server.
 * 
 * Handles OAuth token persistence, activity caching, and athlete data.
 * Uses a 15-minute cache TTL for activities to respect Strava rate limits.
 * 
 * Firestore Schema:
 * 
 * Collection: athletes
 * Document ID: {athleteId}
 * Fields:
 *   - access_token: string (protected by Google Cloud encryption at rest)
 *   - refresh_token: string (protected by Google Cloud encryption at rest)
 *   - expires_at: number (Unix timestamp)
 *   - athlete_name: string
 *   - updated_at: Timestamp
 * 
 * Collection: activity_cache
 * Document ID: {athleteId}_{activityId}
 * Fields:
 *   - activity: object (Strava activity data)
 *   - cached_at: Timestamp
 *   - expires_at: Timestamp (cached_at + 15 minutes)
 * 
 * Collection: weekly_summaries
 * Document ID: {athleteId}_{weekStart}
 * Fields:
 *   - summary: object
 *   - cached_at: Timestamp
 *   - expires_at: Timestamp
 */

import { Firestore, FieldPath, FieldValue } from '@google-cloud/firestore';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

let firestoreInstance = null;

/**
 * Get or create Firestore instance.
 * Lazy initialization for cold start optimization.
 */
function getFirestore() {
  if (!firestoreInstance) {
    firestoreInstance = new Firestore({
      ignoreUndefinedProperties: true
    });
  }
  return firestoreInstance;
}

/**
 * Store OAuth tokens for an athlete after successful authentication.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {object} tokens - Token data from Strava OAuth
 * @param {string} tokens.access_token - Access token for API calls
 * @param {string} tokens.refresh_token - Refresh token for renewal
 * @param {number} tokens.expires_at - Token expiration Unix timestamp
 * @param {string} [tokens.athlete_name] - Optional athlete display name
 * @param {string} [tokens.client_id] - Optional custom Strava client ID
 * @param {string} [tokens.client_secret] - Optional custom Strava client secret
 */
export async function storeTokens(athleteId, tokens) {
  const db = getFirestore();
  const docRef = db.collection('athletes').doc(String(athleteId));
  
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    athlete_name: tokens.athlete_name || null,
    updated_at: FieldValue.serverTimestamp()
  };
  
  // Store custom credentials if provided (for token refresh)
  if (tokens.client_id) data.client_id = tokens.client_id;
  if (tokens.client_secret) data.client_secret = tokens.client_secret;
  
  await docRef.set(data, { merge: true });
}

/**
 * Retrieve stored tokens for an athlete.
 * Returns null if athlete not found or tokens not stored.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @returns {Promise<object|null>} Token data or null
 */
export async function getTokens(athleteId) {
  const db = getFirestore();
  const docRef = db.collection('athletes').doc(String(athleteId));
  const doc = await docRef.get();
  
  if (!doc.exists) {
    return null;
  }
  
  return doc.data();
}

/**
 * Update tokens after a refresh operation.
 * Only updates access_token and expires_at, preserves refresh_token.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {string} accessToken - New access token
 * @param {number} expiresAt - New expiration timestamp
 */
export async function updateAccessToken(athleteId, accessToken, expiresAt) {
  const db = getFirestore();
  const docRef = db.collection('athletes').doc(String(athleteId));
  
  await docRef.update({
    access_token: accessToken,
    expires_at: expiresAt,
    updated_at: FieldValue.serverTimestamp()
  });
}

/**
 * Cache a Strava activity to reduce API calls.
 * Cached for 15 minutes to balance freshness with rate limit protection.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {number} activityId - Strava activity ID
 * @param {object} activity - Full activity data from Strava
 */
export async function cacheActivity(athleteId, activityId, activity) {
  const db = getFirestore();
  const docId = `${athleteId}_${activityId}`;
  const docRef = db.collection('activity_cache').doc(docId);
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  
  await docRef.set({
    activity,
    cached_at: now,
    expires_at: expiresAt
  });
}

/**
 * Retrieve a cached activity if still valid.
 * Returns null if cache miss or expired.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {number} activityId - Strava activity ID
 * @returns {Promise<object|null>} Cached activity or null
 */
export async function getCachedActivity(athleteId, activityId) {
  const db = getFirestore();
  const docId = `${athleteId}_${activityId}`;
  const docRef = db.collection('activity_cache').doc(docId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    return null;
  }
  
  const data = doc.data();
  const now = new Date();
  
  // Check if cache has expired
  if (data.expires_at.toDate() < now) {
    // Optionally delete expired cache entry
    await docRef.delete().catch(() => {}); // Fire and forget
    return null;
  }
  
  return data.activity;
}

/**
 * Cache activities list for an athlete (used for weekly summaries).
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {string} cacheKey - Unique key for this cache entry
 * @param {object[]} activities - Array of activity summaries
 */
export async function cacheActivitiesList(athleteId, cacheKey, activities) {
  const db = getFirestore();
  const docId = `${athleteId}_${cacheKey}`;
  const docRef = db.collection('activities_list_cache').doc(docId);
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  
  await docRef.set({
    activities,
    cached_at: now,
    expires_at: expiresAt
  });
}

/**
 * Retrieve cached activities list.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {string} cacheKey - Cache key used when storing
 * @returns {Promise<object[]|null>} Cached activities or null
 */
export async function getCachedActivitiesList(athleteId, cacheKey) {
  const db = getFirestore();
  const docId = `${athleteId}_${cacheKey}`;
  const docRef = db.collection('activities_list_cache').doc(docId);
  const doc = await docRef.get();
  
  if (!doc.exists) {
    return null;
  }
  
  const data = doc.data();
  const now = new Date();
  
  if (data.expires_at.toDate() < now) {
    await docRef.delete().catch(() => {});
    return null;
  }
  
  // Ensure cached data is an array
  if (!Array.isArray(data.activities)) {
    console.warn('Cached activities is not an array, invalidating cache');
    await docRef.delete().catch(() => {});
    return null;
  }
  
  return data.activities;
}

/**
 * Delete all cached data for an athlete.
 * Useful for re-authentication or data cleanup.
 * 
 * @param {string} athleteId - Strava athlete ID
 */
export async function clearAthleteCache(athleteId) {
  const db = getFirestore();
  
  // Delete athlete tokens
  await db.collection('athletes').doc(String(athleteId)).delete().catch(() => {});
  
  // Note: Cache entries will naturally expire. For full cleanup,
  // a Cloud Function with a scheduled trigger could handle batch deletion.
}

// ===========================================================================
// Garmin Connect token and cache storage
// ===========================================================================

/**
 * Store Garmin DI tokens for an athlete after successful authentication.
 *
 * garminconnect 0.3.x uses Garmin's DI (Device Intelligence) token flow:
 *   - di_token: short-lived bearer token for API calls
 *   - di_refresh_token: long-lived token used to obtain a new di_token
 *   - di_client_id: client id used during refresh
 *
 * @param {string} athleteId - Stable athlete identifier
 * @param {object} tokens - Token data
 * @param {object} tokens.tokens - DI tokens ({ di_token, di_refresh_token, di_client_id })
 * @param {string} [tokens.athlete_name] - Optional display name
 */
export async function storeGarminTokens(athleteId, tokens) {
  const db = getFirestore();
  const docRef = db.collection('garmin_athletes').doc(String(athleteId));

  await docRef.set({
    tokens: tokens.tokens,
    athlete_name: tokens.athlete_name || null,
    updated_at: FieldValue.serverTimestamp()
  }, { merge: true });
}

/**
 * Retrieve stored Garmin tokens for an athlete.
 *
 * @param {string} athleteId - Athlete identifier
 * @returns {Promise<object|null>} Token data or null
 */
export async function getGarminTokens(athleteId) {
  const db = getFirestore();
  const docRef = db.collection('garmin_athletes').doc(String(athleteId));
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  return doc.data();
}

/**
 * Update DI tokens after a refresh operation.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {object} tokens - New DI tokens
 */
export async function updateGarminTokens(athleteId, tokens) {
  const db = getFirestore();
  const docRef = db.collection('garmin_athletes').doc(String(athleteId));

  await docRef.update({
    tokens,
    updated_at: FieldValue.serverTimestamp()
  });
}

/**
 * Cache a Garmin activity to reduce API calls.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {number|string} activityId - Garmin activity ID
 * @param {object} activity - Full activity data from Garmin
 */
export async function cacheGarminActivity(athleteId, activityId, activity) {
  const db = getFirestore();
  const docId = `${athleteId}_${activityId}`;
  const docRef = db.collection('garmin_activity_cache').doc(docId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

  await docRef.set({
    activity,
    cached_at: now,
    expires_at: expiresAt
  });
}

/**
 * Retrieve a cached Garmin activity if still valid.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {number|string} activityId - Garmin activity ID
 * @returns {Promise<object|null>} Cached activity or null
 */
export async function getCachedGarminActivity(athleteId, activityId) {
  const db = getFirestore();
  const docId = `${athleteId}_${activityId}`;
  const docRef = db.collection('garmin_activity_cache').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data();
  const now = new Date();

  if (data.expires_at.toDate() < now) {
    await docRef.delete().catch(() => {});
    return null;
  }

  return data.activity;
}

/**
 * Cache a list of Garmin activities.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {string} cacheKey - Unique key for this cache entry
 * @param {object[]} activities - Array of activity summaries
 */
export async function cacheGarminActivitiesList(athleteId, cacheKey, activities) {
  const db = getFirestore();
  const docId = `${athleteId}_${cacheKey}`;
  const docRef = db.collection('garmin_activities_list_cache').doc(docId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

  await docRef.set({
    activities,
    cached_at: now,
    expires_at: expiresAt
  });
}

/**
 * Retrieve cached Garmin activities list.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {string} cacheKey - Cache key used when storing
 * @returns {Promise<object[]|null>} Cached activities or null
 */
export async function getCachedGarminActivitiesList(athleteId, cacheKey) {
  const db = getFirestore();
  const docId = `${athleteId}_${cacheKey}`;
  const docRef = db.collection('garmin_activities_list_cache').doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data();
  const now = new Date();

  if (data.expires_at.toDate() < now) {
    await docRef.delete().catch(() => {});
    return null;
  }

  if (!Array.isArray(data.activities)) {
    await docRef.delete().catch(() => {});
    return null;
  }

  return data.activities;
}

/**
 * Clear all stored Garmin data for an athlete.
 *
 * @param {string} athleteId - Athlete identifier
 */
export async function clearGarminAthleteCache(athleteId) {
  const db = getFirestore();
  await db.collection('garmin_athletes').doc(String(athleteId)).delete().catch(() => {});

  const prefix = `${athleteId}_`;
  for (const collection of ['garmin_activity_cache', 'garmin_activities_list_cache']) {
    const snapshot = await db.collection(collection)
      .where(FieldPath.documentId(), '>=', prefix)
      .where(FieldPath.documentId(), '<', `${prefix}\uf8ff`)
      .get();

    for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
      const batch = db.batch();
      snapshot.docs.slice(offset, offset + 400).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  }
}
