/**
 * Activity Analysis Tool for Ironman Athletes.
 * 
 * Provides deep dive analysis on individual workouts with Ironman-relevant
 * metrics and coaching insights. Determines effort level, highlights notable
 * aspects, and provides context for training decisions.
 * 
 * Ironman context:
 * - Run pace zones matter for marathon fueling strategy
 * - Bike power consistency is critical for 112 miles
 * - Swim technique insights from lap data
 */

import { getActivityDetail as getStravaActivityDetail } from '../strava/client.js';
import { getGarminActivityDetailForAthlete } from '../garmin/client.js';

/**
 * Map Strava activity types to simplified triathlon types.
 */
const TYPE_MAPPING = {
  'Run': 'Run',
  'VirtualRun': 'Run',
  'TrailRun': 'Run',
  'Ride': 'Ride',
  'VirtualRide': 'Ride',
  'MountainBikeRide': 'Ride',
  'GravelRide': 'Ride',
  'Swim': 'Swim',
  'OpenWaterSwim': 'Swim'
};

/**
 * Calculate pace string from distance and time.
 * Returns pace per km for runs, pace per 100m for swims.
 * 
 * @param {string} type - Activity type (Run, Swim, Ride)
 * @param {number} distance - Distance in meters
 * @param {number} movingTime - Moving time in seconds
 * @returns {string|null} Pace string or null for rides
 */
function calculatePace(type, distance, movingTime) {
  if (!distance || !movingTime) return null;

  if (type === 'Run') {
    // Pace per km (e.g., "5:30 /km")
    const paceSeconds = (movingTime / distance) * 1000;
    const minutes = Math.floor(paceSeconds / 60);
    const seconds = Math.round(paceSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')} /km`;
  }

  if (type === 'Swim') {
    // Pace per 100m (e.g., "1:45 /100m")
    const paceSeconds = (movingTime / distance) * 100;
    const minutes = Math.floor(paceSeconds / 60);
    const seconds = Math.round(paceSeconds % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')} /100m`;
  }

  // Rides use power/speed, not pace
  return null;
}

/**
 * Determine effort level based on activity metrics.
 * 
 * For Ironman training, effort classification helps ensure
 * proper periodization:
 * - Easy: Recovery, building aerobic base
 * - Moderate: Tempo work, race pace simulation
 * - Hard: Intervals, threshold work, race simulation
 * 
 * @param {object} activity - Strava activity data
 * @param {string} type - Normalized activity type
 * @returns {string} Effort level: 'easy' | 'moderate' | 'hard'
 */
function determineEffort(activity, type) {
  const avgHr = activity.average_heartrate;
  const maxHr = activity.max_heartrate;
  
  // If heart rate data available, use HR zones
  if (avgHr && maxHr) {
    const hrRatio = avgHr / maxHr;
    
    // Zone 1-2 (~50-70% max HR): Easy
    // Zone 3 (~70-80% max HR): Moderate
    // Zone 4-5 (~80%+ max HR): Hard
    if (hrRatio >= 0.80) return 'hard';
    if (hrRatio >= 0.70) return 'moderate';
    return 'easy';
  }

  // For cycling with power data
  if (type === 'Ride' && activity.weighted_average_watts) {
    // Use intensity factor (IF) if FTP is known, otherwise estimate
    // IF > 0.9 = hard, 0.75-0.9 = moderate, < 0.75 = easy
    // Without FTP, use variability index as proxy
    if (activity.average_watts && activity.weighted_average_watts) {
      const vi = activity.weighted_average_watts / activity.average_watts;
      // High variability often indicates intervals (hard)
      if (vi > 1.1) return 'hard';
      if (vi > 1.02) return 'moderate';
    }
  }

  // For runs without HR, use pace relative to duration
  if (type === 'Run' && activity.distance && activity.moving_time) {
    const paceMinKm = (activity.moving_time / 60) / (activity.distance / 1000);
    const duration = activity.moving_time / 60;
    
    // Short, fast runs are typically hard
    if (duration < 45 && paceMinKm < 5) return 'hard';
    // Long slow runs are typically easy
    if (duration > 90 && paceMinKm > 5.5) return 'easy';
    return 'moderate';
  }

  // Default based on suffer score if available
  if (activity.suffer_score) {
    if (activity.suffer_score > 150) return 'hard';
    if (activity.suffer_score > 75) return 'moderate';
    return 'easy';
  }

  return 'moderate'; // Default assumption
}

/**
 * Generate coaching notes for the activity.
 * Provides Ironman-relevant insights and observations.
 * 
 * @param {object} activity - Strava activity data
 * @param {string} type - Normalized activity type
 * @param {string} effort - Determined effort level
 * @returns {string[]} Array of coaching notes
 */
function generateNotes(activity, type, effort) {
  const notes = [];
  const duration = activity.moving_time / 60; // minutes
  const distance = activity.distance / 1000; // km

  // Duration-based notes
  if (type === 'Ride') {
    if (duration >= 240) {
      notes.push('Long ride - excellent Ironman bike prep');
    } else if (duration >= 180) {
      notes.push('Good endurance ride for IM training');
    } else if (duration < 60 && effort === 'easy') {
      notes.push('Short recovery spin');
    }

    // Power consistency for Ironman
    if (activity.average_watts && activity.weighted_average_watts) {
      const vi = activity.weighted_average_watts / activity.average_watts;
      if (vi < 1.05) {
        notes.push('Very steady power output - ideal for IM pacing');
      } else if (vi > 1.15) {
        notes.push('Variable power - practice steadier output for IM');
      }
    }
  }

  if (type === 'Run') {
    if (distance >= 25) {
      notes.push('Long run - key IM marathon preparation');
    } else if (distance >= 16) {
      notes.push('Solid medium-long run');
    }

    // Brick context (run after bike)
    // Check if there's a note about being a brick
    if (activity.description && 
        activity.description.toLowerCase().includes('brick')) {
      notes.push('Brick run - great transition practice');
    }

    // Pace consistency
    if (activity.average_speed && activity.max_speed) {
      const consistency = activity.average_speed / activity.max_speed;
      if (consistency > 0.7) {
        notes.push('Even pacing throughout');
      }
    }
  }

  if (type === 'Swim') {
    if (distance >= 3) {
      notes.push('Solid swim volume for IM prep (3.8km race)');
    }
    
    if (activity.laps && activity.laps.length > 1) {
      // Analyze lap consistency
      const lapTimes = activity.laps.map(l => l.moving_time);
      const avgLap = lapTimes.reduce((a, b) => a + b, 0) / lapTimes.length;
      const variance = lapTimes.reduce((sum, t) => sum + Math.abs(t - avgLap), 0) / lapTimes.length;
      
      if (variance / avgLap < 0.05) {
        notes.push('Consistent lap times - good pacing awareness');
      }
    }
  }

  // Heart rate notes
  if (activity.average_heartrate && activity.max_heartrate) {
    const hrReserve = activity.max_heartrate - activity.average_heartrate;
    if (hrReserve < 15 && duration > 60) {
      notes.push('High sustained HR - check recovery status');
    }
  }

  // Elevation context
  if (type === 'Ride' && activity.total_elevation_gain) {
    const elevPerKm = activity.total_elevation_gain / distance;
    if (elevPerKm > 15) {
      notes.push('Significant climbing - adjust power expectations');
    }
  }

  if (type === 'Run' && activity.total_elevation_gain) {
    const elevPerKm = activity.total_elevation_gain / distance;
    if (elevPerKm > 20) {
      notes.push('Hilly run - good strength builder');
    }
  }

  // Kudos/engagement (motivation indicator)
  if (activity.kudos_count && activity.kudos_count > 10) {
    notes.push('Well-supported workout');
  }

  // Fallback note if nothing specific
  if (notes.length === 0) {
    if (effort === 'easy') {
      notes.push('Recovery session - important for adaptation');
    } else if (effort === 'hard') {
      notes.push('Quality session - ensure adequate recovery');
    } else {
      notes.push('Solid training session');
    }
  }

  return notes;
}

/**
 * Analyze a single Strava activity for Ironman coaching.
 * 
 * @param {number} activityId - Strava activity ID
 * @param {string} athleteId - Athlete ID (required for auth)
 * @returns {Promise<object>} Activity analysis
 */
export async function analyzeActivity(activityId, athleteId, source = 'strava') {
  if (!activityId) {
    throw new Error('activityId is required');
  }
  
  if (!athleteId) {
    throw new Error('athleteId is required for authentication');
  }

  // Fetch detailed activity data from the requested source
  let activity;
  if (source === 'garmin') {
    activity = await getGarminActivityDetailForAthlete(athleteId, activityId);
  } else {
    activity = await getStravaActivityDetail(athleteId, activityId);
  }

  // Normalize type
  const type = TYPE_MAPPING[activity.type] || activity.type;

  // Calculate core metrics
  const durationMin = Math.round(activity.moving_time / 60);
  const avgHr = activity.average_heartrate 
    ? Math.round(activity.average_heartrate) 
    : null;
  const avgPower = activity.weighted_average_watts 
    ? Math.round(activity.weighted_average_watts) 
    : (activity.average_watts ? Math.round(activity.average_watts) : null);
  const pace = calculatePace(type, activity.distance, activity.moving_time);
  
  // Determine effort level
  const effort = determineEffort(activity, type);

  // Generate coaching notes
  const notes = generateNotes(activity, type, effort);

  return {
    type,
    duration_min: durationMin,
    avg_hr: avgHr,
    avg_power: avgPower,
    pace,
    effort,
    notes
  };
}
