/**
 * BackgroundTaskManager — registers and executes the recurring sensor collection task.
 *
 * IMPORTANT: TaskManager.defineTask() MUST be called at module load time (synchronously,
 * before any async code) so that the task is registered before registerRootComponent runs.
 * This file must be imported at the top of index.ts for that guarantee to hold.
 *
 * Requirements: 1.1, 1.3, 1.4, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 14.7
 */

import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import {
  BackgroundTaskResult,
  BackgroundTaskStatus,
} from 'expo-background-task';
import * as Location from 'expo-location';

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

/**
 * iOS internal task timeout in milliseconds (Req 9.2).
 * The iOS BGAppRefreshTask budget is 30 seconds. We use 25 seconds to ensure
 * the completion handler is always called before the OS deadline.
 */
const IOS_TASK_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// iOS background restriction flag (Req 9.5, 9.6)
// ---------------------------------------------------------------------------

/**
 * Set to true if BackgroundTaskStatus.Restricted is detected on iOS
 * (Low Power Mode or Background App Refresh disabled by user).
 * The UI layer reads this flag to display a persistent in-app banner (Req 9.5).
 */
export let isBackgroundRestricted = false;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a promise with a timeout. If the promise does not resolve within
 * timeoutMs, the timeout resolves with the fallback value.
 *
 * Used to enforce the iOS 30-second BGAppRefreshTask budget (Req 9.2).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[BackgroundTask] iOS timeout reached after ${timeoutMs}ms — returning fallback`);
      resolve(fallback);
    }, timeoutMs);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); console.error('[BackgroundTask] Task error:', err); resolve(fallback); }
    );
  });
}

/**
 * Core sensor task body — shared between Android (HeadlessJS) and iOS (BGAppRefreshTask).
 *
 * Returns BackgroundTaskResult.Success on a valid reading, Failed otherwise.
 */
async function runSensorTaskBody(): Promise<BackgroundTaskResult> {
  // -------------------------------------------------------------------------
  // Step 1: Atomic sensor + GPS read (Req 1.2, 1.3)
  // -------------------------------------------------------------------------
  const reading = await readOnce();

  if (reading === null) {
    // Sensor unavailable, timed out, or reading was invalid.
    // readOnce() has already updated MMKV (sensor_available='0').
    return BackgroundTaskResult.Failed;
  }

  // -------------------------------------------------------------------------
  // Step 2: Prune rows older than 3 hours (Req 1.4)
  // -------------------------------------------------------------------------
  const cutoff = Date.now() - THREE_HOURS_MS;
  try {
    const db = getDB();
    await db.delete(pressureReadings).where(lt(pressureReadings.ts, cutoff));
  } catch (pruneErr) {
    // Non-fatal: log and continue
    console.warn('[BackgroundTask] Prune failed:', pruneErr);
  }

  // -------------------------------------------------------------------------
  // Step 3: Run anomaly detection (Req 2.1–2.11)
  // -------------------------------------------------------------------------
  try {
    await runAnomalyDetection();
  } catch (anomalyErr) {
    // Non-fatal: anomaly detection failure should not abort the task
    console.warn('[BackgroundTask] Anomaly detection failed:', anomalyErr);
  }

  return BackgroundTaskResult.Success;
}

// ---------------------------------------------------------------------------
// Task definition — MUST be at module top-level, synchronous (Req 9.1, 8.4)
// ---------------------------------------------------------------------------

/**
 * Define the sensor collection task with expo-task-manager.
 *
 * Called synchronously at module scope so it executes before registerRootComponent()
 * and before any async code runs. The OS requires the task to be defined before
 * it can be registered or invoked.
 *
 * On iOS: the entire task body is wrapped in a 25-second timeout to ensure the
 * BGAppRefreshTask completion handler is always called before the 30-second OS
 * budget expires (Req 9.2).
 *
 * On Android: the task is invoked via HeadlessJS by ForegroundSensorService
 * every 120 seconds (Req 8.4).
 */
TaskManager.defineTask(AEROMESH_SENSOR_TASK, async () => {
  try {
    if (Platform.OS === 'ios') {
      // Req 9.2: wrap in 25-second timeout to never exceed the 30-second iOS budget
      return await withTimeout(
        runSensorTaskBody(),
        IOS_TASK_TIMEOUT_MS,
        BackgroundTaskResult.Failed
      );
    } else {
      // Android: no OS-imposed time budget — run without timeout
      return await runSensorTaskBody();
    }
  } catch (err) {
    // Catch-all — return Failed without crashing (Req 14.7)
    console.error('[BackgroundTask] Unhandled error in sensor task:', err);
    return BackgroundTaskResult.Failed;
  }
});

// ---------------------------------------------------------------------------
// requestBackgroundLocationPermission (Req 9.3)
// ---------------------------------------------------------------------------

/**
 * Requests background location permission on iOS to enable Significant Location
 * Change wakeups as a supplementary background execution mechanism (Req 9.3).
 *
 * Should be called once on app launch (see App.tsx bootstrap, Task 17).
 * No-op on Android (background location is handled by the ForegroundService).
 */
export async function requestBackgroundLocationPermission(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[BackgroundTask] Background location permission not granted on iOS');
    } else {
      console.log('[BackgroundTask] Background location permission granted');
    }
  } catch (err) {
    console.warn('[BackgroundTask] Background location permission request failed:', err);
  }
}

// ---------------------------------------------------------------------------
// registerBackgroundTask (Req 1.1, 9.1, 9.5)
// ---------------------------------------------------------------------------

/**
 * Registers the AEROMESH_SENSOR_TASK with the OS background scheduler.
 *
 * On iOS:
 *  - Checks BackgroundTaskStatus first. If Restricted (Low Power Mode or
 *    Background App Refresh disabled), sets isBackgroundRestricted=true, logs
 *    a warning, and skips registration (Req 9.5).
 *  - BGTaskSchedulerPermittedIdentifiers must include AEROMESH_SENSOR_TASK in
 *    app.json infoPlist (already configured in Task 1/9).
 *
 * On Android:
 *  - The ForegroundSensorService handles the actual scheduling via HeadlessJS.
 *    This registration provides the JS-side task definition to expo-background-task.
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
        'Please re-enable Background App Refresh in Settings → General → Background App Refresh.'
      );
      return;
    }

    await BackgroundTask.registerTaskAsync(AEROMESH_SENSOR_TASK, {
      minimumInterval: TASK_INTERVAL_SECONDS,
    });

    console.log('[BackgroundTask] Registered:', AEROMESH_SENSOR_TASK, '— interval:', TASK_INTERVAL_SECONDS, 's');
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
