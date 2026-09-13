/**
 * Ironman Readiness Assessment Tool.
 * 
 * Provides a coach-style readiness evaluation for Ironman preparation.
 * Analyzes recent training history across all three disciplines to assess
 * athlete readiness, identify strengths/weaknesses, and recommend focus areas.
 * 
 * Ironman benchmark metrics (for a ~12-hour finisher):
 * - Swim: 3.8km open water, ~1:10-1:30
 * - Bike: 180km, ~5:30-7:00 hours
 * - Run: 42.2km, ~4:00-5:30 hours
 * 
 * Training volume guidelines (8-12 weeks out):
 * - Swim: 8-12km/week, 3-4 sessions
 * - Bike: 200-300km/week, 8-12 hours
 * - Run: 40-60km/week
 * - Total TSS: 500-800/week
 */

import { getActivities as getStravaActivities } from '../strava/client.js';
import { getGarminActivitiesForAthlete } from '../garmin/client.js';
import { deduplicateActivities } from '../garmin/normalizer.js';

/**
 * Strava activity types mapped to disciplines.
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
  'OpenWaterSwim': 'swim'
};

/**
 * Target weekly volumes for Ironman preparation.
 * These are moderate targets; elite athletes train more.
 */
const WEEKLY_TARGETS = {
  swim_km: 10,      // 10km swim per week
  swim_sessions: 3,  // Minimum 3 swims for technique maintenance
  bike_hours: 10,    // 10 hours on bike (~250km at 25km/h)
  run_km: 50,        // 50km running
  total_tss: 600     // Moderate-high training load
};

/**
 * Key workout benchmarks for Ironman readiness.
 */
const WORKOUT_BENCHMARKS = {
  long_ride_hours: 5,    // Should complete 5+ hour ride
  long_run_km: 28,       // Should complete 28+ km run (2/3 marathon)
  long_swim_km: 3,       // Should complete 3km+ continuous swim
  brick_run_km: 10       // Should do brick runs (bike-to-run)
};

/**
 * Calculate weekly training aggregates.
 */
function calculateWeeklyAggregates(activities, weeksBack = 8) {
  const now = new Date();
  const weekAggregates = [];

  for (let w = 0; w < weeksBack; w++) {
    weekAggregates.push({
      swim_km: 0,
      swim_sessions: 0,
      bike_hours: 0,
      bike_km: 0,
      run_km: 0,
      run_sessions: 0,
      total_tss: 0,
      long_ride: false,
      long_run: false,
      long_swim: false
    });
  }

  activities.forEach(activity => {
    const discipline = DISCIPLINE_MAPPING[activity.type];
    if (!discipline) return;

    const activityDate = new Date(activity.start_date);
    const weekIndex = Math.floor((now - activityDate) / (7 * 24 * 60 * 60 * 1000));
    
    if (weekIndex < 0 || weekIndex >= weeksBack) return;

    const week = weekAggregates[weekIndex];
    const durationHours = activity.moving_time / 3600;
    const distanceKm = activity.distance / 1000;

    // Estimate TSS (simplified)
    const baseTss = discipline === 'run' ? 65 : discipline === 'bike' ? 55 : 70;
    week.total_tss += Math.round(durationHours * baseTss);

    switch (discipline) {
      case 'swim':
        week.swim_km += distanceKm;
        week.swim_sessions += 1;
        if (distanceKm >= WORKOUT_BENCHMARKS.long_swim_km) {
          week.long_swim = true;
        }
        break;
      case 'bike':
        week.bike_hours += durationHours;
        week.bike_km += distanceKm;
        if (durationHours >= WORKOUT_BENCHMARKS.long_ride_hours) {
          week.long_ride = true;
        }
        break;
      case 'run':
        week.run_km += distanceKm;
        week.run_sessions += 1;
        if (distanceKm >= WORKOUT_BENCHMARKS.long_run_km) {
          week.long_run = true;
        }
        break;
    }
  });

  return weekAggregates;
}

/**
 * Calculate readiness score (0-100) based on training metrics.
 * 
 * Scoring breakdown:
 * - Volume adequacy: 40 points
 * - Workout benchmarks: 30 points
 * - Consistency: 20 points
 * - Recent load trend: 10 points
 */
function calculateReadinessScore(weeklyData) {
  let score = 0;

  // Average weekly metrics (last 4 weeks for recency)
  const recentWeeks = weeklyData.slice(0, 4);
  const avgSwimKm = recentWeeks.reduce((s, w) => s + w.swim_km, 0) / recentWeeks.length;
  const avgSwimSessions = recentWeeks.reduce((s, w) => s + w.swim_sessions, 0) / recentWeeks.length;
  const avgBikeHours = recentWeeks.reduce((s, w) => s + w.bike_hours, 0) / recentWeeks.length;
  const avgRunKm = recentWeeks.reduce((s, w) => s + w.run_km, 0) / recentWeeks.length;
  const avgTss = recentWeeks.reduce((s, w) => s + w.total_tss, 0) / recentWeeks.length;

  // Volume scoring (40 points)
  // Swim volume: 10 points
  score += Math.min(10, (avgSwimKm / WEEKLY_TARGETS.swim_km) * 10);
  // Swim frequency: 5 points
  score += Math.min(5, (avgSwimSessions / WEEKLY_TARGETS.swim_sessions) * 5);
  // Bike volume: 10 points
  score += Math.min(10, (avgBikeHours / WEEKLY_TARGETS.bike_hours) * 10);
  // Run volume: 10 points
  score += Math.min(10, (avgRunKm / WEEKLY_TARGETS.run_km) * 10);
  // Overall TSS: 5 points
  score += Math.min(5, (avgTss / WEEKLY_TARGETS.total_tss) * 5);

  // Benchmark workouts (30 points)
  // Check if key workouts completed in recent weeks
  const hasLongRide = weeklyData.slice(0, 6).some(w => w.long_ride);
  const hasLongRun = weeklyData.slice(0, 6).some(w => w.long_run);
  const hasLongSwim = weeklyData.slice(0, 6).some(w => w.long_swim);
  const multipleLongRides = weeklyData.slice(0, 8).filter(w => w.long_ride).length >= 3;
  const multipleLongRuns = weeklyData.slice(0, 8).filter(w => w.long_run).length >= 3;

  if (hasLongRide) score += 8;
  if (hasLongRun) score += 8;
  if (hasLongSwim) score += 6;
  if (multipleLongRides) score += 4;
  if (multipleLongRuns) score += 4;

  // Consistency (20 points)
  // Penalize weeks with no activity in a discipline
  const weeksWithAllDisciplines = weeklyData.slice(0, 6).filter(
    w => w.swim_sessions > 0 && w.bike_hours > 0.5 && w.run_km > 5
  ).length;
  score += Math.min(20, (weeksWithAllDisciplines / 6) * 20);

  // Load trend (10 points)
  // Recent weeks should have maintained or built load
  if (recentWeeks.length >= 3) {
    const recentAvg = (recentWeeks[0].total_tss + recentWeeks[1].total_tss) / 2;
    const priorAvg = (recentWeeks[2].total_tss + (recentWeeks[3]?.total_tss || recentWeeks[2].total_tss)) / 2;
    
    if (recentAvg >= priorAvg * 0.9) {
      score += 10; // Maintained or increased
    } else if (recentAvg >= priorAvg * 0.7) {
      score += 5; // Slight decrease (might be taper)
    }
  } else {
    score += 5; // Insufficient data, neutral
  }

  return Math.round(Math.min(100, score));
}

/**
 * Determine confidence level based on data quality.
 */
function determineConfidence(activities, weeklyData) {
  const totalActivities = activities.length;
  const weeksWithData = weeklyData.filter(w => w.total_tss > 0).length;

  if (totalActivities >= 40 && weeksWithData >= 7) {
    return 'high';
  } else if (totalActivities >= 20 && weeksWithData >= 4) {
    return 'medium';
  }
  return 'low';
}

/**
 * Identify athlete strengths based on training patterns.
 */
function identifyStrengths(weeklyData, activities) {
  const strengths = [];

  const recentWeeks = weeklyData.slice(0, 4);
  const avgSwimSessions = recentWeeks.reduce((s, w) => s + w.swim_sessions, 0) / recentWeeks.length;
  const avgBikeHours = recentWeeks.reduce((s, w) => s + w.bike_hours, 0) / recentWeeks.length;
  const avgRunKm = recentWeeks.reduce((s, w) => s + w.run_km, 0) / recentWeeks.length;

  // Strong swim program
  if (avgSwimSessions >= 3) {
    strengths.push('Consistent swim frequency');
  }

  // Strong bike endurance
  if (avgBikeHours >= 8) {
    strengths.push('Good cycling volume');
  }
  const longRideCount = weeklyData.filter(w => w.long_ride).length;
  if (longRideCount >= 4) {
    strengths.push('Regular long rides completed');
  }

  // Strong run base
  if (avgRunKm >= 45) {
    strengths.push('Solid running base');
  }
  const longRunCount = weeklyData.filter(w => w.long_run).length;
  if (longRunCount >= 4) {
    strengths.push('Regular long runs completed');
  }

  // Consistency
  const consistentWeeks = weeklyData.filter(
    w => w.swim_sessions >= 2 && w.bike_hours >= 4 && w.run_km >= 20
  ).length;
  if (consistentWeeks >= 5) {
    strengths.push('Consistent multi-sport training');
  }

  // Volume
  const avgTss = recentWeeks.reduce((s, w) => s + w.total_tss, 0) / recentWeeks.length;
  if (avgTss >= 500) {
    strengths.push('Healthy training load');
  }

  return strengths;
}

/**
 * Identify risk factors for Ironman preparation.
 */
function identifyRisks(weeklyData, activities) {
  const risks = [];

  const recentWeeks = weeklyData.slice(0, 4);
  const avgSwimSessions = recentWeeks.reduce((s, w) => s + w.swim_sessions, 0) / recentWeeks.length;
  const avgSwimKm = recentWeeks.reduce((s, w) => s + w.swim_km, 0) / recentWeeks.length;
  const avgBikeHours = recentWeeks.reduce((s, w) => s + w.bike_hours, 0) / recentWeeks.length;
  const avgRunKm = recentWeeks.reduce((s, w) => s + w.run_km, 0) / recentWeeks.length;

  // Swim risks
  if (avgSwimSessions < 2) {
    risks.push('Low swim frequency - technique may suffer');
  }
  if (avgSwimKm < 6) {
    risks.push('Swim volume below target for IM distance');
  }
  if (!weeklyData.slice(0, 6).some(w => w.long_swim)) {
    risks.push('No long swim sessions - need race distance practice');
  }

  // Bike risks
  if (avgBikeHours < 6) {
    risks.push('Bike hours below Ironman prep minimum');
  }
  if (!weeklyData.slice(0, 6).some(w => w.long_ride)) {
    risks.push('Missing long rides - crucial for IM bike endurance');
  }

  // Run risks
  if (avgRunKm < 30) {
    risks.push('Run volume low for marathon off the bike');
  }
  if (!weeklyData.slice(0, 6).some(w => w.long_run)) {
    risks.push('No long runs - need runs over 25km');
  }

  // Consistency risks
  const gapWeeks = weeklyData.slice(0, 6).filter(
    w => w.total_tss < 100
  ).length;
  if (gapWeeks >= 2) {
    risks.push('Inconsistent training - multiple low-volume weeks');
  }

  // Overtraining risk
  const avgTss = recentWeeks.reduce((s, w) => s + w.total_tss, 0) / recentWeeks.length;
  if (avgTss > 800) {
    risks.push('High training load - monitor fatigue carefully');
  }

  // Balance risk
  const hasAllDisciplines = recentWeeks.every(
    w => w.swim_sessions > 0 && w.bike_hours > 0 && w.run_km > 0
  );
  if (!hasAllDisciplines) {
    risks.push('Some weeks missing disciplines - maintain triathlon balance');
  }

  return risks;
}

/**
 * Determine recommended training focus.
 */
function determineRecommendedFocus(weeklyData, strengths, risks) {
  const recentWeeks = weeklyData.slice(0, 4);
  
  // Calculate relative discipline scores
  const avgSwim = recentWeeks.reduce((s, w) => s + w.swim_km, 0) / recentWeeks.length / WEEKLY_TARGETS.swim_km;
  const avgBike = recentWeeks.reduce((s, w) => s + w.bike_hours, 0) / recentWeeks.length / WEEKLY_TARGETS.bike_hours;
  const avgRun = recentWeeks.reduce((s, w) => s + w.run_km, 0) / recentWeeks.length / WEEKLY_TARGETS.run_km;

  // Find weakest discipline
  const scores = { swim: avgSwim, bike: avgBike, run: avgRun };
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  // Priority recommendations based on biggest gaps
  if (weakest[1] < 0.5) {
    switch (weakest[0]) {
      case 'swim':
        return 'Increase swim volume - aim for 3+ sessions and 8+ km weekly';
      case 'bike':
        return 'Build bike endurance - add volume and include 5+ hour rides';
      case 'run':
        return 'Develop run base - build to 45+ km weekly with long runs';
    }
  }

  // Check for missing key workouts
  if (!weeklyData.slice(0, 6).some(w => w.long_ride)) {
    return 'Add long bike sessions - work up to 5-6 hour rides';
  }
  if (!weeklyData.slice(0, 6).some(w => w.long_run)) {
    return 'Include long runs - build to 28+ km for marathon readiness';
  }
  if (!weeklyData.slice(0, 6).some(w => w.long_swim)) {
    return 'Practice race-distance swimming - include 3km+ continuous sets';
  }

  // Check consistency
  if (risks.includes('Inconsistent training - multiple low-volume weeks')) {
    return 'Focus on training consistency - maintain regular sessions each week';
  }

  // If well-balanced, suggest race-specific work
  if (strengths.length >= 3) {
    return 'Maintain current balance - add race-pace sessions and brick workouts';
  }

  return 'Continue building overall volume across all three disciplines';
}

/**
 * Get Ironman readiness assessment for an athlete.
 * 
 * @param {string} athleteId - Strava athlete ID
 * @returns {Promise<object>} Readiness assessment
 */
export async function getIronmanReadiness(athleteId, source = 'strava') {
  if (!athleteId) {
    throw new Error('athleteId is required');
  }

  // Fetch 8 weeks of activity data from requested source(s)
  const now = new Date();
  const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);

  let activities = [];

  if (source === 'strava' || source === 'combined') {
    const stravaActivities = await getStravaActivities(athleteId, eightWeeksAgo, now);
    activities = activities.concat(stravaActivities || []);
  }

  if (source === 'garmin' || source === 'combined') {
    const garminActivities = await getGarminActivitiesForAthlete(athleteId, eightWeeksAgo, now);
    activities = activities.concat(garminActivities || []);
  }

  if (source === 'combined') {
    activities = deduplicateActivities(activities);
  }

  // Calculate weekly aggregates
  const weeklyData = calculateWeeklyAggregates(activities, 8);

  // Calculate readiness score
  const readinessScore = calculateReadinessScore(weeklyData);

  // Determine confidence
  const confidence = determineConfidence(activities, weeklyData);

  // Identify strengths and risks
  const strengths = identifyStrengths(weeklyData, activities);
  const risks = identifyRisks(weeklyData, activities);

  // Determine recommended focus
  const recommendedFocus = determineRecommendedFocus(weeklyData, strengths, risks);

  return {
    readiness_score: readinessScore,
    confidence,
    strengths,
    risks,
    recommended_focus: recommendedFocus
  };
}
