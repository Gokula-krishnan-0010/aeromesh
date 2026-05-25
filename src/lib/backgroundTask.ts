/**
 * BackgroundTaskManager — registers and executes the recurring sensor collection task.
 *
 * IMPORTANT: TaskManager.defineTask() MUST be called at module load time (synchronously,
 * before any async code) so that the task is registered before registerRootComponent runs.
 * This file must be imported at the top of index.ts for that guarantee to hold.
 *
 * Requirements: 1.1, 1.3, 1.4, 8.4, 9.2, 14.7
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import {
  BackgroundTaskResult,
  BackgroundTaskStatus,
} from 'expo-background-task';

import { readOnce } from './sensorCollector';
import { getDB } from '../db/index';
import { pressureReadings } from '../db/schema';
import { lt } from 'drizzle-orm';
import { runAnomalyDetection } from './anomaly';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task name constant — must match the identifier used in TaskManager.defineTask(). */
export const AEROMESH_SENSOR_TASK = 'AEROMESH_SENSOR_TASK';

/**
 * Minimum interval between background task invocations, in seconds (Req 1.1).
 * expo-background-task treats this as a minimum delay; the OS may run the task
 * less frequently depending on battery and system conditions.
 */
const TASK_INTERVAL_SECONDS = 120;

/** Three hours in milliseconds — the rolling window for pressure readings (Req 1.4). */
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// iOS background restriction flag (Req 9.5)
// ---------------------------------------------------------------------------

/**
 * Set to true if BackgroundTaskStatus.Restricted is detected on iOS.
 * The UI layer reads this flag to display a persistent in-app banner.
 */
export let isBackgroundRestricted = false;

// ---------------------------------------------------------------------------
// Task definition — MUST be at module top-level, synchronous (Req 9.1, 8.4)
// ---------------------------------------------------------------------------

/**
 * Define the sensor collection task with expo-task-manager.
 *
 * This call is intentionally at module scope so it executes synchronously
 * when the module is first imported — before registerRootComponent() and
 * before any async code runs. The OS requires the task to be defined before
 * it can be registered or invoked.
 *
 * Task body (Req 1.3, 1.4, 8.4, 9.2, 14.7):
 *  1. Call SensorCollector.readOnce() — atomic GPS + barometer read.
 *     If null → return BackgroundTaskResult.Failed (no-data path).
 *  2. Prune pressure_readings rows older than 3 hours (Req 1.4).
 *  3. Run anomaly detection (Req 2.1–2.11).
 *  4. Return BackgroundTaskResult.Success on success.
 *  5. Return BackgroundTaskResult.Failed on any unhandled error (Req 14.7).
 */
TaskManager.defineTask(AEROMESH_SENSOR_TASK, async () => {
  try {
    // -----------------------------------------------------------------------
    // Step 1: Atomic sensor + GPS read (Req 1.2, 1.3)
    // -----------------------------------------------------------------------
    const reading = await readOnce();

    if (reading === null) {
      // Sensor unavailable, timed out, or reading was invalid — readOnce()
      // has already updated MMKV (sensor_available='0').
      // expo-background-task has no NoData result; Failed signals the OS
      // that no new data was collected this cycle.
      return BackgroundTaskResult.Failed;
    }

    // -----------------------------------------------------------------------
    // Step 2: Prune rows older than 3 hours (Req 1.4)
    // -----------------------------------------------------------------------
    const cutoff = Date.now() - THREE_HOURS_MS;

    try {
      const db = getDB();
      await db
        .delete(pressureReadings)
        .where(lt(pressureReadings.ts, cutoff));
    } catch (pruneErr) {
      // Non-fatal: log and continue — a prune failure should not abort the task
      console.warn('[BackgroundTask] Prune failed:', pruneErr);
    }

    // -----------------------------------------------------------------------
    // Step 3: Run anomaly detection (Req 2.1–2.11)
    // -----------------------------------------------------------------------
    try {
      await runAnomalyDetection();
    } catch (anomalyErr) {
      // Non-fatal: anomaly detection failure should not abort the task
      console.warn('[BackgroundTask] Anomaly detection failed:', anomalyErr);
    }

    // -----------------------------------------------------------------------
    // Step 4: Success
    // -----------------------------------------------------------------------
    return BackgroundTaskResult.Success;

  } catch (err) {
    // -----------------------------------------------------------------------
    // Step 5: Catch-all — return Failed without crashing (Req 14.7)
    // -----------------------------------------------------------------------
    console.error('[BackgroundTask] Unhandled error in sensor task:', err);
    return BackgroundTaskResult.Failed;
  }
});

// ---------------------------------------------------------------------------
// registerBackgroundTask (Req 1.1, 9.1)
// ---------------------------------------------------------------------------

/**
 * Registers the AEROMESH_SENSOR_TASK with the OS background scheduler.
 *
 * Options:
 *  - minimumInterval: 120 seconds (Req 1.1)
 *
 * Note: expo-background-task does not expose stopOnTerminate / startOnBoot
 * options directly — those behaviours are controlled by the native
 * ForegroundSensorService (Android, Task 8) and BGTaskScheduler (iOS, Task 9).
 * The minimumInterval here sets the OS-level scheduling hint.
 *
 * On iOS, checks BackgroundTaskStatus first. If Restricted (Low Power Mode or
 * Background App Refresh disabled), sets isBackgroundRestricted=true, logs a
 * warning, and skips registration (Req 9.5).
 */
export async function registerBackgroundTask(): Promise<void> {
  try {
    // iOS restriction check (Req 9.5)
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTaskStatus.Restricted) {
      isBackgroundRestricted = true;
      console.warn(
        '[BackgroundTask] Background App Refresh is restricted (Low Power Mode or ' +
        'disabled by user). Skipping task registration. ' +
        'Please re-enable Background App Refresh in Settings.'
      );
      return;
    }

    await BackgroundTask.registerTaskAsync(AEROMESH_SENSOR_TASK, {
      minimumInterval: TASK_INTERVAL_SECONDS,
    });

    console.log('[BackgroundTask] Registered:', AEROMESH_SENSOR_TASK);
  } catch (err) {
    console.error('[BackgroundTask] Registration failed:', err);
  }
}

// ---------------------------------------------------------------------------
// unregisterBackgroundTask
// ---------------------------------------------------------------------------

/**
 * Unregisters the AEROMESH_SENSOR_TASK from the OS background scheduler.
 * Safe to call even if the task is not currently registered.
 */
export async function unregisterBackgroundTask(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(AEROMESH_SENSOR_TASK);
    console.log('[BackgroundTask] Unregistered:', AEROMESH_SENSOR_TASK);
  } catch (err) {
    console.error('[BackgroundTask] Unregistration failed:', err);
  }
}
