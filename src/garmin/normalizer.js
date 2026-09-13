/**
 * Garmin → Strava activity schema normalizer.
 *
 * The existing Ironman coaching tools (`weeklySummary.js`, `analyzeActivity.js`,
 * `ironmanReadiness.js`) were written against the Strava activity schema. This
 * module maps Garmin Connect payloads to a compatible shape so that those tools
 * can consume Garmin data with minimal changes.
 *
 * Garmin field names are taken from the `python-garminconnect` / garmin_mcp
 * payloads, in particular:
 *   - activityType.typeKey  (running, cycling, swimming, ...)
 *   - summaryDTO.*            (detailed metrics)
 *   - laps[]                  (lap data)
 */

/**
 * Map Garmin activity type keys to Strava-style types.
 */
const GARMIN_TO_STRAVA_TYPE = {
  running: 'Run',
  run: 'Run',
  trail_running: 'TrailRun',
  treadmill_running: 'Run',
  track_running: 'Run',
  cycling: 'Ride',
  road_biking: 'Ride',
  mountain_biking: 'MountainBikeRide',
  gravel_cycling: 'GravelRide',
  indoor_cycling: 'VirtualRide',
  trainer: 'VirtualRide',
  e_biking: 'Ride',
  swimming: 'Swim',
  open_water_swimming: 'OpenWaterSwim',
  pool_swimming: 'Swim',
  lap_swimming: 'Swim',
  strength_training: 'WeightTraining',
  strength: 'WeightTraining',
  crossfit: 'Crossfit',
  yoga: 'Yoga',
  pilates: 'Yoga',
  walking: 'Walk',
  hiking: 'Hike',
  snowshoe: 'Hike',
  elliptical: 'Workout',
  rowing: 'Workout',
  other: 'Workout'
};

/**
* Infer activity type from the title when Garmin's typeKey is vague.
*/
function inferTypeFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(run|running|jog|5k|10k|half marathon|marathon|tempo run|interval|easy run|long run)\b/.test(t)) return 'Run';
  if (/\b(ride|cycling|bike|biking|trainer|zwift|peloton|road bike|mountain bike|gravel)\b/.test(t)) return 'Ride';
  if (/\b(swim|swimming|pool|open water)\b/.test(t)) return 'Swim';
  if (/\b(strength|gym|weights|kraft|core|lifting)\b/.test(t)) return 'WeightTraining';
  if (/\b(yoga|stretch|recovery)\b/.test(t)) return 'Yoga';
  if (/\b(walk|walking|hike|hiking)\b/.test(t)) return 'Walk';
  return null;
}

/**
 * Normalize a Garmin activity summary (from activitylist-service) into a
 * Strava-compatible summary object.
 *
 * @param {object} g - Raw Garmin activity
 * @returns {object} Normalized activity summary
 */
export function normalizeGarminSummary(g) {
  const activityType = g.activityType || g.activityTypeDTO || {};
  let typeKey = activityType.typeKey || 'other';
  let eventTypeKey = (g.eventType && g.eventType.typeKey) || (g.eventTypeDTO && g.eventTypeDTO.typeKey);
  const summary = g.summaryDTO || g;

  let type = GARMIN_TO_STRAVA_TYPE[typeKey];
  if (!type || type === 'Workout') {
    const inferred = inferTypeFromTitle(g.activityName);
    if (inferred) type = inferred;
  }
  if (!type) type = 'Workout';

  // Garmin activities may have start times in several places depending on the
  // endpoint (list vs detail). Try the most common ones.
  const startTimeLocal = g.startTimeLocal || summary.startTimeLocal || g.startTimeGMT || summary.startTimeGMT;
  const startTimeGMT = g.startTimeGMT || summary.startTimeGMT || g.startTimeLocal || summary.startTimeLocal;

  return {
    id: g.activityId,
    garmin_activity_id: g.activityId,
    source: 'garmin',
    name: g.activityName || 'Untitled Garmin activity',
    type,
    garmin_type: typeKey,
    event_type: eventTypeKey,
    start_date: toIsoUtc(startTimeGMT),
    start_date_local: startTimeLocal,
    timezone: g.timeZone,
    distance: toNumber(summary.distance),
    moving_time: toNumber(summary.movingDuration || summary.duration),
    elapsed_time: toNumber(summary.elapsedDuration || summary.duration),
    total_elevation_gain: toNumber(summary.elevationGain),
    total_elevation_loss: toNumber(summary.elevationLoss),
    average_speed: toNumber(summary.averageSpeed),
    max_speed: toNumber(summary.maxSpeed),
    average_heartrate: toNumber(summary.averageHR),
    max_heartrate: toNumber(summary.maxHR),
    average_watts: toNumber(summary.averagePower),
    weighted_average_watts: toNumber(summary.normalizedPower),
    max_watts: toNumber(summary.maxPower),
    average_cadence: toNumber(summary.averageCadence),
    max_cadence: toNumber(summary.maxCadence),
    calories: toNumber(summary.calories),
    suffer_score: null, // Garmin does not expose Strava suffer score
    training_stress_score: toNumber(summary.trainingStressScore),
    intensity_factor: toNumber(summary.intensityFactor),
    steps: toNumber(summary.steps),
    laps_count: toNumber(summary.lapCount),
    vo2max: toNumber(g.vO2MaxValue),
    aerobic_training_effect: toNumber(g.aerobicTrainingEffect || summary.aerobicTrainingEffect),
    anaerobic_training_effect: toNumber(g.anaerobicTrainingEffect || summary.anaerobicTrainingEffect),
    training_effect_label: g.trainingEffectLabel || null,
    avg_stride_length: toNumber(g.avgStrideLength || summary.avgStrideLength),
    avg_running_cadence: toNumber(g.averageRunningCadenceInStepsPerMinute || summary.averageRunningCadenceInStepsPerMinute),
    avg_swim_cadence: toNumber(g.averageSwimCadenceInStrokesPerMinute || summary.averageSwimCadenceInStrokesPerMinute),
    avg_stroke_distance: toNumber(g.avgStrokeDistance || summary.avgStrokeDistance),
    avg_stress: toNumber(g.avgStress || summary.avgStress),
    moderate_intensity_minutes: toNumber(g.moderateIntensityMinutes),
    vigorous_intensity_minutes: toNumber(g.vigorousIntensityMinutes),
    min_heartrate: toNumber(summary.minHR || g.minHR),
    lactate_threshold: toNumber(g.lactateThreshold),
    max_run_cadence: toNumber(summary.maxRunningCadenceInStepsPerMinute || g.maxRunningCadenceInStepsPerMinute),
    description: g.description || null
  };
}

/**
 * Normalize a detailed Garmin activity (from activity-service) into a
 * Strava-compatible detailed object.
 *
 * @param {object} g - Raw Garmin detailed activity
 * @returns {object} Normalized detailed activity
 */
export function normalizeGarminActivity(g, detailMetrics) {
  const summary = normalizeGarminSummary(g);
  const detailSummary = g.summaryDTO || {};

  // Ensure we keep the best available local date even if summary didn't have it
  if (!summary.start_date_local && (g.startTimeLocal || detailSummary.startTimeLocal)) {
    summary.start_date_local = g.startTimeLocal || detailSummary.startTimeLocal;
  }

  return {
    ...summary,
    // Override with more precise detail fields when present
    // Use nullish coalescing (??) so that 0 values are preserved.
    moving_time: toNumber(detailSummary.movingDuration ?? summary.moving_time),
    elapsed_time: toNumber(detailSummary.elapsedDuration ?? summary.elapsed_time),
    average_speed: toNumber(detailSummary.averageSpeed ?? summary.average_speed),
    max_speed: toNumber(detailSummary.maxSpeed ?? summary.max_speed),
    average_heartrate: toNumber(detailSummary.averageHR ?? summary.average_heartrate),
    max_heartrate: toNumber(detailSummary.maxHR ?? summary.max_heartrate),
    average_watts: toNumber(detailSummary.averagePower ?? summary.average_watts),
    weighted_average_watts: toNumber(detailSummary.normalizedPower ?? summary.weighted_average_watts),
    max_watts: toNumber(detailSummary.maxPower ?? summary.max_watts),
    average_cadence: toNumber(detailSummary.averageCadence ?? summary.average_cadence),
    max_cadence: toNumber(detailSummary.maxCadence ?? summary.max_cadence),
    total_elevation_gain: toNumber(detailSummary.elevationGain ?? summary.total_elevation_gain),
    total_elevation_loss: toNumber(detailSummary.elevationLoss ?? summary.total_elevation_loss),
    calories: toNumber(detailSummary.calories ?? summary.calories),
    training_stress_score: toNumber(detailSummary.trainingStressScore ?? summary.training_stress_score),
    intensity_factor: toNumber(detailSummary.intensityFactor ?? summary.intensity_factor),
    heart_rate_zones: normalizeHrZones(g.heartRateZones || detailSummary.heartRateZones),
    laps: normalizeLaps(g.laps || detailSummary.laps),
    splits: normalizeSplits(g.splits),
    samples: normalizeTimeSeries(detailMetrics),
    metadata: {
      normalized_at: new Date().toISOString()
    }
  };
}

/**
 * Normalize Garmin heart-rate zone data.
 *
 * @param {Array} zones - Raw HR zone array from Garmin
 * @returns {Array|null} Normalized zones or null
 */
function normalizeHrZones(zones) {
  if (!Array.isArray(zones) || zones.length === 0) return null;

  return zones.map((z) => ({
    zone: z.zoneNumber,
    seconds: z.secsInZone,
    low_bpm: z.zoneLowBoundary
  }));
}

/**
 * Normalize Garmin detail metrics (time-series data) into compact arrays.
 *
 * The detail metrics payload contains `metricDescriptors` (describing which
 * index in each metrics array corresponds to which field) and
 * `activityDetailMetrics` (the actual sample rows).
 *
 * Returns compact arrays of numeric values rather than per-sample objects,
 * since timestamps are evenly distributed and an AI agent can infer timing
 * from the activity duration.
 *
 * @param {object} detailMetrics - Raw detail metrics object from Garmin
 * @returns {object|null} Normalized time-series data or null
 */
function normalizeTimeSeries(detailMetrics) {
  if (
    !detailMetrics ||
    !Array.isArray(detailMetrics.metricDescriptors) ||
    !Array.isArray(detailMetrics.activityDetailMetrics)
  ) {
    return null;
  }

  // Build an index: key -> metricsIndex
  const indexMap = {};
  for (const desc of detailMetrics.metricDescriptors) {
    if (desc.key != null && desc.metricsIndex != null) {
      indexMap[desc.key] = desc.metricsIndex;
    }
  }

  const hrIndex = indexMap.directHeartRate;
  const speedIndex = indexMap.directSpeed;
  const elevIndex = indexMap.directElevation;

  const hrArray = [];
  const speedArray = [];
  const elevationArray = [];

  for (const entry of detailMetrics.activityDetailMetrics) {
    const metrics = entry.metrics;
    if (!Array.isArray(metrics)) continue;

    if (hrIndex != null) {
      const v = metrics[hrIndex];
      if (v != null && Number.isFinite(v)) hrArray.push(v);
    }
    if (speedIndex != null) {
      const v = metrics[speedIndex];
      if (v != null && Number.isFinite(v)) speedArray.push(v);
    }
    if (elevIndex != null) {
      const v = metrics[elevIndex];
      if (v != null && Number.isFinite(v)) elevationArray.push(v);
    }
  }

  const hasHr = hrArray.length > 0;
  const hasSpeed = speedArray.length > 0;
  const hasElevation = elevationArray.length > 0;

  if (!hasHr && !hasSpeed && !hasElevation) return null;

  const sampleCount = Math.max(hrArray.length, speedArray.length, elevationArray.length);

  return {
    sample_count: sampleCount,
    heart_rate: hasHr ? hrArray : null,
    speed: hasSpeed ? speedArray : null,
    elevation: hasElevation ? elevationArray : null
  };
}

/**
 * Normalize Garmin lap data.
 */
function normalizeLaps(laps) {
  if (!Array.isArray(laps)) return [];

  return laps.map((lap, index) => ({
    id: lap.lapId || index + 1,
    lap_index: lap.lapIndex || index + 1,
    elapsed_time: toNumber(lap.elapsedDuration),
    moving_time: toNumber(lap.movingDuration),
    start_date_local: lap.startTimeLocal,
    distance: toNumber(lap.distance),
    average_speed: toNumber(lap.averageSpeed),
    max_speed: toNumber(lap.maxSpeed),
    average_heartrate: toNumber(lap.averageHR),
    max_heartrate: toNumber(lap.maxHR),
    average_cadence: toNumber(lap.averageCadence),
    average_watts: toNumber(lap.averagePower)
  }));
}

/**
 * Normalize Garmin split data (km/mile splits if present).
 */
function normalizeSplits(splits) {
  if (!splits) return null;

  const result = {};
  for (const [key, items] of Object.entries(splits)) {
    if (Array.isArray(items)) {
      result[key] = items.map((s, index) => ({
        split: index + 1,
        distance: toNumber(s.distance),
        elapsed_time: toNumber(s.elapsedDuration),
        moving_time: toNumber(s.movingDuration),
        elevation_difference: toNumber(s.elevationGain),
        average_speed: toNumber(s.averageSpeed),
        average_heartrate: toNumber(s.averageHR),
        pace_zone: s.paceZone
      }));
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Convert Garmin's ISO-ish local timestamp to a proper ISO 8601 UTC string.
 * Garmin sometimes returns values like "2024-01-15T07:30:00.0" without a Z;
 * treat those as UTC because the API returns startTimeGMT.
 */
function toIsoUtc(value) {
  if (!value) return null;
  try {
    // Garmin sometimes returns local timestamps like "2024-01-15T07:30:00.0"
    // without a timezone. Treat them as-is; toISOString will convert to UTC,
    // which is fine for date extraction.
    let clean = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d$/.test(clean)) {
      clean += '00';
    }
    const d = new Date(clean);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Utility to merge activities from multiple sources (Strava + Garmin) and
 * deduplicate by start time. Useful for combined weekly summaries.
 *
 * @param {object[]} activities - Activities already in a common schema
 * @param {number} [toleranceMinutes=5] - Window for considering two activities the same
 * @returns {object[]} Deduplicated activities
 */
export function deduplicateActivities(activities, toleranceMinutes = 5) {
  const sorted = [...activities].sort((a, b) =>
    new Date(a.start_date || 0) - new Date(b.start_date || 0)
  );

  const result = [];
  const toleranceMs = toleranceMinutes * 60 * 1000;

  for (const activity of sorted) {
    const start = new Date(activity.start_date || 0).getTime();
    const duplicate = result.find((existing) => {
      const existingStart = new Date(existing.start_date || 0).getTime();
      const typeMatch = existing.type === activity.type;
      return typeMatch && Math.abs(existingStart - start) <= toleranceMs;
    });

    if (!duplicate) {
      result.push(activity);
    }
  }

  return result;
}
