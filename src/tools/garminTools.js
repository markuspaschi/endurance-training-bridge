/**
 * Garmin-specific MCP tools.
 *
 * These tools expose raw Garmin Connect data fetching. Higher-level coaching
 * tools (`getWeeklyTrainingSummary`, `getIronmanReadiness`, `analyzeActivity`)
 * can also consume Garmin data by passing `source: 'garmin'` or
 * `source: 'combined'`.
 */

import { getGarminClientForAthlete, getGarminActivitiesForAthlete, getGarminActivityDetailForAthlete } from '../garmin/client.js';

/**
 * List Garmin Connect activities for an athlete within an optional date range.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {string} [startDate] - Start date in YYYY-MM-DD format (defaults to 4 weeks ago)
 * @param {string} [endDate] - End date in YYYY-MM-DD format (defaults to today)
 * @param {number} [limit=100] - Maximum activities to return
 * @returns {Promise<object>} Activity list result
 */
export async function getGarminActivities(athleteId, startDate, endDate, limit = 100) {
  if (!athleteId) {
    throw new Error('athleteId is required');
  }

  const end = endDate ? new Date(endDate + 'T23:59:59') : new Date();
  const start = startDate
    ? new Date(startDate + 'T00:00:00')
    : new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);

  const activities = await getGarminActivitiesForAthlete(athleteId, start, end);

  return {
    source: 'garmin',
    athleteId,
    date_range: { start: start.toISOString().split('T')[0], end: end.toISOString().split('T')[0] },
    count: activities.length,
    activities: activities.slice(0, limit)
  };
}

/**
 * Get detailed data for a single Garmin Connect activity.
 *
 * @param {string} athleteId - Athlete identifier
 * @param {number|string} activityId - Garmin activity ID
 * @returns {Promise<object>} Detailed activity
 */
export async function getGarminActivity(athleteId, activityId) {
  if (!athleteId) {
    throw new Error('athleteId is required');
  }
  if (!activityId) {
    throw new Error('activityId is required');
  }

  const activity = await getGarminActivityDetailForAthlete(athleteId, activityId);
  return {
    source: 'garmin',
    athleteId,
    activity
  };
}

/**
 * Verify that stored Garmin tokens are still valid.
 * Useful as a lightweight health check for a Garmin connection.
 *
 * @param {string} athleteId - Athlete identifier
 * @returns {Promise<object>} Profile summary
 */
export async function verifyGarminConnection(athleteId) {
  if (!athleteId) {
    throw new Error('athleteId is required');
  }

  const client = await getGarminClientForAthlete(athleteId);
  const profile = await client.getUserProfile();

  return {
    connected: true,
    athleteId,
    display_name: profile.displayName || profile.fullName || null,
    user_name: profile.userName || null
  };
}
