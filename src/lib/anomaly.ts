/**
 * AnomalyDetector — analyzes the rolling 3-hour pressure window to detect
 * imminent severe weather.
 *
 * This is a stub implementation. The full implementation is delivered in Task 7.
 *
 * Requirements: 2.1–2.11, 14.5
 */

/**
 * Runs anomaly detection against the last 90 pressure readings in SQLite.
 *
 * Postconditions (full implementation — Task 7):
 *  - MMKV `threat_level` key updated to one of: NORMAL | WATCH | HIGH | CRITICAL
 *  - MMKV `pressure_rate` key updated with current rate as string
 *  - If threat detected: one AUTO_SOS row inserted into sos_queue (onConflictDoNothing)
 *  - Does NOT call useStore (background context — MMKV only)
 */
export async function runAnomalyDetection(): Promise<void> {
  // Full implementation delivered in Task 7.
  // Stub is intentionally a no-op so backgroundTask.ts compiles and runs.
}
