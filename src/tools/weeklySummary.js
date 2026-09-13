/**
 * Weekly Training Summary Tool for Ironman Athletes.
 * 
 * Aggregates training data across all disciplines and provides detailed
 * session-by-session information including titles, descriptions, and
 * workout context that coaches often include in activity names.
 * 
 * Returns both aggregated metrics and individual session details for
 * comprehensive training analysis.
 */

import { getActivities as getStravaActivities, getActivityDetail as getStravaActivityDetail } from '../strava/client.js';
import { getGarminActivitiesForAthlete, getGarminActivityDetailForAthlete } from '../garmin/client.js';
import { deduplicateActivities } from '../garmin/normalizer.js';

/**
 * Strava activity types mapped to triathlon disciplines.
 * We track all activity types but categorize the main three.
 */
const DISCIPLINE_MAPPING = {
  'Run': 'run',
  'VirtualRun': 'run',
  'TrailRun': 'run',
  'Ride': 'bike',
  'VirtualRide': 'bike',
  'MountainBikeRide': 'bike',
  'GravelRide': 'bike',
  'Swim': 'swim',
  'OpenWaterSwim': 'swim',
  'WeightTraining': 'strength',
  'Workout': 'strength',
  'Yoga': 'recovery',
  'Walk': 'recovery',
  'Hike': 'other',
  'Crossfit': 'strength'
};

/**
 * Extract intensity hints from activity title/description.
 * Coaches often encode workout intent in the title.
 * 
 * Common patterns:
 * - "Easy run", "Recovery ride"
 * - "Tempo", "Threshold", "VO2max"
 * - "Long run", "Endurance"
 * - "Intervals", "Repeats", "400s"
 * - Zone references: "Z2", "Zone 3"
 * 
 * @param {string} title - Activity title
 * @param {string} description - Activity description
 * @returns {object} Intensity hints extracted
 */
function extractIntensityHints(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  
  const hints = {
    keywords: [],
    suggestedIntensity: null,
    workoutType: null
  };

  // Recovery/Easy indicators
  if (/\b(easy|recovery|z1|zone\s*1|regeneration|locker|entspannt)\b/.test(text)) {
    hints.keywords.push('easy');
    hints.suggestedIntensity = 'easy';
    hints.workoutType = 'recovery';
  }

  // Endurance/Base indicators
  if (/\b(endurance|z2|zone\s*2|base|aerobic|ga1|grundlage)\b/.test(text)) {
    hints.keywords.push('endurance');
    hints.suggestedIntensity = 'easy';
    hints.workoutType = 'endurance';
  }

  // Tempo/Threshold indicators
  if (/\b(tempo|threshold|z3|z4|zone\s*[34]|ftp|lt|lactate|schwelle|ga2)\b/.test(text)) {
    hints.keywords.push('tempo');
    hints.suggestedIntensity = 'moderate';
    hints.workoutType = 'tempo';
  }

  // Intervals/Hard indicators
  if (/\b(interval|vo2|z5|zone\s*5|repeats|sprints|hard|hiit|tabata|speedwork)\b/.test(text)) {
    hints.keywords.push('intervals');
    hints.suggestedIntensity = 'hard';
    hints.workoutType = 'intervals';
  }

  // Long workout indicators
  if (/\b(long|lang|marathon|ironman|race\s*pace|wettkampf)\b/.test(text)) {
    hints.keywords.push('long');
    hints.workoutType = 'long';
  }

  // Brick workout (bike-to-run transition practice)
  if (/\b(brick|koppel|transition|wechsel)\b/.test(text)) {
    hints.keywords.push('brick');
    hints.workoutType = 'brick';
  }

  // Strength/gym indicators
  if (/\b(strength|gym|weights|kraft|core|stability)\b/.test(text)) {
    hints.keywords.push('strength');
    hints.workoutType = 'strength';
  }

  // Drills/technique
  if (/\b(drill|technique|technik|form|skill)\b/.test(text)) {
    hints.keywords.push('technique');
    hints.workoutType = 'technique';
  }

  return hints;
}

/**
 * Determine effort/intensity level from activity metrics.
 * Combines HR data, pace, power, and title hints.
 * 
 * @param {object} activity - Strava activity
 * @param {object} hints - Extracted intensity hints
 * @returns {string} Effort level: 'easy' | 'moderate' | 'hard'
 */
function determineIntensity(activity, hints) {
  // If title clearly indicates intensity, trust it
  if (hints.suggestedIntensity) {
    return hints.suggestedIntensity;
  }

  const avgHr = activity.average_heartrate;
  const maxHr = activity.max_heartrate;

  // Heart rate based determination
  if (avgHr && maxHr) {
    const hrRatio = avgHr / maxHr;
    if (hrRatio >= 0.85) return 'hard';
    if (hrRatio >= 0.72) return 'moderate';
    return 'easy';
  }

  // Suffer score fallback
  if (activity.suffer_score) {
    const durationHours = activity.moving_time / 3600;
    const sufferPerHour = activity.suffer_score / durationHours;
    if (sufferPerHour > 80) return 'hard';
    if (sufferPerHour > 40) return 'moderate';
    return 'easy';
  }

  return 'moderate'; // Default
}

/**
 * Create simplified HR zone distribution.
 * Estimates zone based on typical average HR ranges.
 * 
 * @param {object} activity - Strava activity
 * @returns {object|null} HR zone info or null if no HR data
 */
function getHeartRateInfo(activity) {
  if (!activity.average_heartrate) {
    return null;
  }

  const avgHr = Math.round(activity.average_heartrate);
  
  const info = {
    average: avgHr,
    max: activity.max_heartrate ? Math.round(activity.max_heartrate) : null
  };

  // Estimate zone based on typical average HR ranges
  // These are approximate zones for most endurance athletes
  // Zone 1: <120, Zone 2: 120-135, Zone 3: 135-150, Zone 4: 150-165, Zone 5: >165
  if (avgHr < 120) info.estimated_zone = 1;
  else if (avgHr < 135) info.estimated_zone = 2;
  else if (avgHr < 150) info.estimated_zone = 3;
  else if (avgHr < 165) info.estimated_zone = 4;
  else info.estimated_zone = 5;

  return info;
}

/**
 * Format pace based on activity type.
 * 
 * @param {object} activity - Strava activity
 * @param {string} discipline - Activity discipline
 * @returns {string|null} Formatted pace string
 */
function formatPace(activity, discipline) {
  if (!activity.distance || !activity.moving_time) return null;

  const distanceKm = activity.distance / 1000;
  const timeMinutes = activity.moving_time / 60;

  if (discipline === 'run') {
    const paceMinKm = timeMinutes / distanceKm;
    const mins = Math.floor(paceMinKm);
    const secs = Math.round((paceMinKm - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /km`;
  }

  if (discipline === 'swim') {
    const pace100m = (activity.moving_time / (activity.distance / 100));
    const mins = Math.floor(pace100m / 60);
    const secs = Math.round(pace100m % 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /100m`;
  }

  if (discipline === 'bike') {
    const speedKmh = distanceKm / (activity.moving_time / 3600);
    return `${speedKmh.toFixed(1)} km/h`;
  }

  return null;
}

/**
 * Estimate TSS (Training Stress Score) from activity data.
 * 
 * @param {object} activity - Strava activity
 * @param {string} discipline - Activity discipline
 * @param {string} intensity - Determined intensity level
 * @returns {number} Estimated TSS
 */
function estimateTSS(activity, discipline, intensity) {
  // Use Garmin-computed TSS when available instead of re-estimating
  if (activity.training_stress_score) {
    return Math.round(activity.training_stress_score);
  }

  const durationHours = activity.moving_time / 3600;
  
  // Base TSS per hour by discipline
  const baseTss = {
    swim: 70,
    bike: 55,
    run: 65,
    strength: 40,
    recovery: 20,
    other: 30
  };

  // Intensity multipliers
  const intensityMult = {
    easy: 0.7,
    moderate: 1.0,
    hard: 1.4
  };

  const base = baseTss[discipline] || 50;
  const mult = intensityMult[intensity] || 1.0;

  return Math.round(durationHours * base * mult);
}

/**
 * Build detailed session object from Strava activity.
 * 
 * @param {object} activity - Strava activity
 * @returns {object} Detailed session info
 */
function buildSessionDetail(activity) {
  const discipline = DISCIPLINE_MAPPING[activity.type] || 'other';
  const hints = extractIntensityHints(activity.name, activity.description);
  const intensity = determineIntensity(activity, hints);
  const tss = estimateTSS(activity, discipline, intensity);

  const session = {
    // Identifiers
    id: activity.id,
    date: activity.start_date_local || activity.start_date,
    day_of_week: (activity.start_date_local || activity.start_date)
      ? new Date(activity.start_date_local || activity.start_date).toLocaleDateString('en-US', { weekday: 'long' })
      : 'unknown',
    
    // Activity info from title/description
    title: activity.name || 'Untitled',
    description: activity.description || null,
    
    // Type and classification
    type: activity.type,
    discipline: discipline,
    sport_type: activity.sport_type || activity.type,
    
    // Workout hints from title
    workout_hints: hints.keywords.length > 0 ? hints.keywords : null,
    workout_type: hints.workoutType,
    
    // Intensity
    intensity: intensity,
    
    // Duration
    duration_seconds: activity.moving_time,
    duration_minutes: Math.round(activity.moving_time / 60),
    elapsed_time_minutes: Math.round(activity.elapsed_time / 60),
    
    // Distance
    distance_meters: activity.distance || null,
    distance_km: activity.distance ? Math.round(activity.distance / 100) / 10 : null,
    
    // Pace/Speed
    pace: formatPace(activity, discipline),
    average_speed_kmh: activity.average_speed 
      ? Math.round(activity.average_speed * 3.6 * 10) / 10 
      : null,
    
    // Heart rate
    heart_rate: getHeartRateInfo(activity),
    
    // Elevation
    elevation_gain_m: activity.total_elevation_gain 
      ? Math.round(activity.total_elevation_gain) 
      : null,
    
    // Cadence
    cadence: activity.average_cadence 
      ? Math.round(activity.average_cadence) 
      : null,
    
    // Power data (bike)
    average_watts: activity.average_watts || null,
    max_watts: activity.max_watts || null,
    device_watts: activity.device_watts || null,
    kilojoules: activity.kilojoules 
      ? Math.round(activity.kilojoules) 
      : null,
    
    // Environment
    average_temp: activity.average_temp || null,
    elev_high: activity.elev_high 
      ? Math.round(activity.elev_high) 
      : null,
    elev_low: activity.elev_low 
      ? Math.round(activity.elev_low) 
      : null,
    
    // Activity context
    trainer: activity.trainer || null,
    athlete_count: activity.athlete_count || null,
    strava_workout_type: activity.workout_type || null,
    
    // Achievements
    pr_count: activity.pr_count || null,
    achievement_count: activity.achievement_count || null,
    
    // Detailed endpoint fields (Normalized Power, splits, laps)
    weighted_average_watts: activity.weighted_average_watts || null,
    calories: activity.calories || null,
    
    // Laps summary (if available)
    laps_count: activity.laps ? activity.laps.length : null,
    
    // Splits summary (running - per km/mile)
    splits_metric_count: activity.splits_metric ? activity.splits_metric.length : null,
    
    // Segment efforts count
    segment_efforts_count: activity.segment_efforts ? activity.segment_efforts.length : null,
    
    // Best efforts (running PRs like 1k, 1 mile, 5k, etc.)
    best_efforts: activity.best_efforts ? activity.best_efforts.map(e => ({
      name: e.name,
      elapsed_time: e.elapsed_time,
      moving_time: e.moving_time,
      pr_rank: e.pr_rank
    })) : null,
    
    // Training load estimate
    estimated_tss: tss,

    // Garmin-specific enrichments (null for Strava activities)
    vo2max: activity.vo2max || null,
    aerobic_training_effect: activity.aerobic_training_effect || null,
    anaerobic_training_effect: activity.anaerobic_training_effect || null,
    training_effect_label: activity.training_effect_label || null,
    avg_stride_length_cm: activity.avg_stride_length || null,
    avg_running_cadence_spm: activity.avg_running_cadence || null,
    source: activity.source || 'strava',

    // Time-series samples (Garmin activities)
    samples: activity.samples || null
  };

  return session;
}

/**
 * Generate coaching flags based on weekly training patterns.
 * 
 * @param {object[]} sessions - All sessions in the period
 * @param {object} totals - Aggregated totals
 * @returns {string[]} Array of flag messages
 */
function generateFlags(sessions, totals) {
  const flags = [];

  // Check swim frequency
  if (totals.swim_sessions < 2 * totals.weeks) {
    flags.push('low swim frequency');
  }

  // Check bike volume
  if (totals.bike_hours < 4 * totals.weeks) {
    flags.push('bike volume may be low for Ironman');
  }

  // Check run consistency
  if (totals.run_km < 20 * totals.weeks) {
    flags.push('consider building run volume');
  }

  // Check for long sessions
  const longBike = sessions.some(s => 
    s.discipline === 'bike' && s.duration_minutes >= 180
  );
  const longRun = sessions.some(s => 
    s.discipline === 'run' && s.distance_km >= 20
  );

  if (longBike) flags.push('long ride completed');
  if (longRun) flags.push('long run completed');

  // Check intensity distribution
  const hardSessions = sessions.filter(s => s.intensity === 'hard').length;
  const totalSessions = sessions.length;
  
  if (totalSessions > 0) {
    const hardRatio = hardSessions / totalSessions;
    if (hardRatio > 0.4) {
      flags.push('high proportion of hard sessions - watch recovery');
    } else if (hardRatio < 0.1 && totalSessions > 5) {
      flags.push('consider adding quality sessions');
    }
  }

  // Check brick workouts
  const hasBrick = sessions.some(s => 
    s.workout_hints && s.workout_hints.includes('brick')
  );
  if (hasBrick) {
    flags.push('brick workout completed - great transition practice');
  }

  // Strength training
  const strengthSessions = sessions.filter(s => s.discipline === 'strength').length;
  if (strengthSessions >= 2) {
    flags.push('consistent strength training');
  }

  // Check balance
  const hasAllDisciplines = 
    totals.swim_sessions > 0 && 
    totals.bike_hours > 0 && 
    totals.run_km > 0;
  
  if (hasAllDisciplines && totals.swim_sessions >= 2 && totals.bike_hours >= 4 && totals.run_km >= 25) {
    flags.push('solid triathlon balance');
  }

  return flags;
}

/**
 * Get detailed weekly training summary for Ironman coaching.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @param {number} [weeks=4] - Number of weeks to analyze
 * @returns {Promise<object>} Detailed training data with session breakdown
 */
export async function getWeeklyTrainingSummary(athleteId, weeks = 4, source = 'strava', days = null) {
  if (!athleteId) {
    throw new Error('athleteId is required');
  }

  // Calculate date range
  const now = new Date();
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);
  
  const startDate = new Date(now);
  
  if (days !== null && days !== undefined) {
    days = Math.min(Math.max(1, days), 84); // Limit to 1-84 days (12 weeks)
    startDate.setDate(startDate.getDate() - days);
    weeks = Math.max(1, Math.round(days / 7));
  } else {
    weeks = Math.min(Math.max(1, weeks), 12); // Limit to 1-12 weeks
    startDate.setDate(startDate.getDate() - (weeks * 7));
  }
  startDate.setHours(0, 0, 0, 0);

  // Fetch all activities (summary list) from requested source(s)
  let activitiesList = [];
  
  if (source === 'strava' || source === 'combined') {
    const stravaActivities = await getStravaActivities(athleteId, startDate, endDate);
    activitiesList = activitiesList.concat(stravaActivities || []);
  }
  
  if (source === 'garmin' || source === 'combined') {
    const garminActivities = await getGarminActivitiesForAthlete(athleteId, startDate, endDate);
    activitiesList = activitiesList.concat(garminActivities || []);
  }
  
  if (source === 'combined') {
    activitiesList = deduplicateActivities(activitiesList);
  }

  // Ensure activities is an array (defensive check for API errors or cache issues)
  if (!activitiesList || !Array.isArray(activitiesList)) {
    console.error('Activities is not an array:', typeof activitiesList, activitiesList);
    throw new Error('Failed to retrieve activities from Strava. Please try again.');
  }

  // Fetch detailed data for each activity (in parallel batches of 10)
  // The detailed endpoint returns more data like laps, segment_efforts, etc.
  const BATCH_SIZE = 10;
  const detailedActivities = [];
  
  for (let i = 0; i < activitiesList.length; i += BATCH_SIZE) {
    const batch = activitiesList.slice(i, i + BATCH_SIZE);
    const batchDetails = await Promise.all(
      batch.map(activity => {
        const activitySource = activity.source || 'strava';
        if (activitySource === 'garmin') {
          return getGarminActivityDetailForAthlete(athleteId, activity.id).catch(err => {
            console.warn(`Failed to get Garmin details for activity ${activity.id}:`, err.message);
            return activity; // Fall back to summary data
          });
        }
        return getStravaActivityDetail(athleteId, activity.id).catch(err => {
          console.warn(`Failed to get Strava details for activity ${activity.id}:`, err.message);
          return activity; // Fall back to summary data
        });
      })
    );
    detailedActivities.push(...batchDetails);
  }

  // Build detailed session list
  const sessions = detailedActivities
    .map(buildSessionDetail)
    .sort((a, b) => new Date(b.date) - new Date(a.date)); // Most recent first

  // Calculate totals
  const totals = {
    weeks,
    total_sessions: sessions.length,
    swim_sessions: 0,
    swim_km: 0,
    bike_sessions: 0,
    bike_hours: 0,
    bike_km: 0,
    run_sessions: 0,
    run_km: 0,
    strength_sessions: 0,
    other_sessions: 0,
    total_duration_hours: 0,
    total_distance_km: 0,
    total_tss: 0,
    total_elevation_m: 0
  };

  sessions.forEach(session => {
    // Duration and distance
    totals.total_duration_hours += session.duration_minutes / 60;
    if (session.distance_km) totals.total_distance_km += session.distance_km;
    totals.total_tss += session.estimated_tss;
    if (session.elevation_gain_m) totals.total_elevation_m += session.elevation_gain_m;

    // By discipline
    switch (session.discipline) {
      case 'swim':
        totals.swim_sessions++;
        if (session.distance_km) totals.swim_km += session.distance_km;
        break;
      case 'bike':
        totals.bike_sessions++;
        totals.bike_hours += session.duration_minutes / 60;
        if (session.distance_km) totals.bike_km += session.distance_km;
        break;
      case 'run':
        totals.run_sessions++;
        if (session.distance_km) totals.run_km += session.distance_km;
        break;
      case 'strength':
        totals.strength_sessions++;
        break;
      default:
        totals.other_sessions++;
    }
  });

  // Round totals
  totals.swim_km = Math.round(totals.swim_km * 10) / 10;
  totals.bike_hours = Math.round(totals.bike_hours * 10) / 10;
  totals.bike_km = Math.round(totals.bike_km * 10) / 10;
  totals.run_km = Math.round(totals.run_km * 10) / 10;
  totals.total_duration_hours = Math.round(totals.total_duration_hours * 10) / 10;
  totals.total_distance_km = Math.round(totals.total_distance_km * 10) / 10;
  totals.total_elevation_m = Math.round(totals.total_elevation_m);

  // Weekly averages
  const weeklyAverages = {
    sessions_per_week: Math.round(totals.total_sessions / weeks * 10) / 10,
    hours_per_week: Math.round(totals.total_duration_hours / weeks * 10) / 10,
    tss_per_week: Math.round(totals.total_tss / weeks),
    swim_sessions_per_week: Math.round(totals.swim_sessions / weeks * 10) / 10,
    bike_hours_per_week: Math.round(totals.bike_hours / weeks * 10) / 10,
    run_km_per_week: Math.round(totals.run_km / weeks * 10) / 10
  };

  return {
    period: {
      weeks,
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0]
    },
    totals,
    weekly_averages: weeklyAverages,
    sessions
  };
}
