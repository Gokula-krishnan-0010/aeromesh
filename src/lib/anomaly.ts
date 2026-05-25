/**
 * AnomalyDetector — analyzes the rolling 3-hour pressure window to detect
 * imminent severe weather.
 *
 * Uses MMKV for all state persistence (no Zustand / useStore calls).
 * Safe to call from background task context where React is unavailable.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 14.5
 */

import { desc } from 'drizzle-orm';
import { getDB } from '../db/index';
import { pressureReadings, sosQueue } from '../db/schema';
import { storage, STORAGE_KEYS, type ThreatLevel } from './storage';

// ---------------------------------------------------------------------------
// Re-export ThreatLevel for consumers
// ---------------------------------------------------------------------------

export type { ThreatLevel };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of readings required to run detection (Req 2.2). */
const MIN_READINGS = 5;

/** Maximum number of readings to query (3 hrs × 2-min intervals = 90). */
const MAX_READINGS = 90;

/**
 * Minimum elapsed time (hours) between oldest and newest reading.
 * If elapsed < 0.1 hrs, return rate=0 and NORMAL (Req 2.10).
 */
const MIN_ELAPSED_HOURS = 0.1;

/** Rate threshold (hPa/hr) above which a threat is declared (Req 2.4). */
const RATE_THRESHOLD = 2.0;

/** TFLite probability threshold above which a threat is declared (Req 2.3). */
const TFLITE_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// classifyThreat (exported for testing — Req 2.7)
// ---------------------------------------------------------------------------

/**
 * Classifies a pressure drop rate into a ThreatLevel.
 *
 * Ranges are mutually exclusive and exhaustive (Req 2.7):
 *   rate ≤ 1.0          → NORMAL
 *   1.0 < rate ≤ 2.0    → WATCH
 *   2.0 < rate ≤ 3.0    → HIGH
 *   rate > 3.0           → CRITICAL
 *
 * @param rate - Pressure drop rate in hPa/hr (positive = dropping).
 */
export function classifyThreat(rate: number): ThreatLevel {
  if (rate <= 1.0) return 'NORMAL';
  if (rate <= 2.0) return 'WATCH';
  if (rate <= 3.0) return 'HIGH';
  return 'CRITICAL';
}

// ---------------------------------------------------------------------------
// TFLite inference stub (Req 2.3, 14.5)
// ---------------------------------------------------------------------------

/**
 * Attempts TFLite inference on the given pressure window.
 *
 * Returns a probability in [0, 1] if the model is available, or -1 if the
 * model is unavailable or fails to load. The caller falls back to rule-based
 * analysis when -1 is returned (Req 14.5).
 *
 * This is a stub that always returns -1 (model not bundled in this build).
 * A real implementation would load the .tflite asset and run inference.
 */
function tfliteInference(_pressures: number[]): number {
  // Stub: TFLite model not available — signal fallback to rule-based.
  return -1;
}

// ---------------------------------------------------------------------------
// runAnomalyDetection
// ---------------------------------------------------------------------------

/**
 * Runs anomaly detection against the last 90 pressure readings in SQLite.
 *
 * Algorithm (Design Doc Algorithm 2):
 *  1. Query last 90 rows from pressure_readings ordered by ts DESC.
 *  2. If fewer than 5 readings, return early (Req 2.2).
 *  3. Try TFLite inference; if unavailable (returns -1), use rule-based (Req 2.3, 2.4, 14.5).
 *  4. Compute rate = (oldest.pressure − newest.pressure) / elapsedHours.
 *  5. If elapsed < 0.1 hrs, return rate=0 and NORMAL (Req 2.10).
 *  6. classifyThreat(rate) → write threat_level and pressure_rate to MMKV (Req 2.7, 2.8).
 *  7. If threat detected: insert AUTO_SOS with onConflictDoNothing (Req 2.5, 2.11).
 *  8. Never calls useStore (Req 2.9).
 *
 * Postconditions:
 *  - MMKV `threat_level` updated to NORMAL | WATCH | HIGH | CRITICAL.
 *  - MMKV `pressure_rate` updated with current rate as string.
 *  - If threat detected: one AUTO_SOS row inserted (or silently skipped on conflict).
 */
export async function runAnomalyDetection(): Promise<void> {
  // -------------------------------------------------------------------------
  // Step 1: Query last 90 readings ordered by ts DESC (Req 2.1)
  // -------------------------------------------------------------------------
  const db = getDB();
  const readings = await db
    .select()
    .from(pressureReadings)
    .orderBy(desc(pressureReadings.ts))
    .limit(MAX_READINGS);

  // -------------------------------------------------------------------------
  // Step 2: Require at least MIN_READINGS (Req 2.2)
  // -------------------------------------------------------------------------
  if (readings.length < MIN_READINGS) {
    return;
  }

  // readings[0] is newest (highest ts), readings[last] is oldest (lowest ts)
  const newest = readings[0];
  const oldest = readings[readings.length - 1];

  // -------------------------------------------------------------------------
  // Step 3: Attempt TFLite inference (Req 2.3, 14.5)
  // -------------------------------------------------------------------------
  const pressures = readings.map((r) => r.pressure);
  const tfliteProb = tfliteInference(pressures);

  // -------------------------------------------------------------------------
  // Step 4 & 5: Compute rate; guard on elapsed time (Req 2.4, 2.10)
  // -------------------------------------------------------------------------
  const elapsedHours = (newest.ts - oldest.ts) / 3_600_000;

  let rate: number;
  let isThreaten: boolean;

  if (tfliteProb >= 0) {
    // TFLite path (Req 2.3)
    isThreaten = tfliteProb > TFLITE_THRESHOLD;
    // Still compute rate for classifyThreat and MMKV write
    if (elapsedHours < MIN_ELAPSED_HOURS) {
      rate = 0;
      isThreaten = false;
    } else {
      rate = (oldest.pressure - newest.pressure) / elapsedHours;
    }
  } else {
    // Rule-based fallback (Req 2.4, 14.5)
    if (elapsedHours < MIN_ELAPSED_HOURS) {
      // Req 2.10: elapsed too short — return NORMAL without enqueuing SOS
      storage.set(STORAGE_KEYS.THREAT_LEVEL, 'NORMAL');
      storage.set(STORAGE_KEYS.PRESSURE_RATE, '0');
      return;
    }
    rate = (oldest.pressure - newest.pressure) / elapsedHours;
    isThreaten = rate > RATE_THRESHOLD;
  }

  // -------------------------------------------------------------------------
  // Step 6: Classify threat and write to MMKV (Req 2.7, 2.8, 2.9)
  // -------------------------------------------------------------------------
  const threatLevel = classifyThreat(rate);
  storage.set(STORAGE_KEYS.THREAT_LEVEL, threatLevel);
  storage.set(STORAGE_KEYS.PRESSURE_RATE, rate.toString());

  // -------------------------------------------------------------------------
  // Step 7: Enqueue AUTO_SOS if threat detected (Req 2.5, 2.6, 2.11)
  // -------------------------------------------------------------------------
  if (!isThreaten) {
    return;
  }

  // Generate a fresh msgId for each threat detection cycle (Req 2.11)
  const msgId = Math.random().toString(16).slice(2, 10);

  // Use lat/lng/pressure from the most recent reading (Req 2.5)
  await db
    .insert(sosQueue)
    .values({
      msgId,
      type: 'AUTO',
      origin: 'SELF',
      lat: newest.lat,
      lng: newest.lng,
      pressure: newest.pressure,
      ts: Date.now(),
      ttl: 6,
    })
    .onConflictDoNothing();

  console.log(
    `[ANOMALY] THREAT DETECTED — rate: ${rate.toFixed(2)} hPa/hr, ` +
    `level: ${threatLevel}, msgId: ${msgId}`
  );
}
