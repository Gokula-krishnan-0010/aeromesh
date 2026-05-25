/**
 * foregroundService.ts — React Native bridge for the Android ForegroundSensorService.
 *
 * Wraps @supersami/rn-foreground-service with:
 *  - An idempotency guard: checks is_running() before calling start() (Req 8.1)
 *  - A typed start/stop API aligned with the ForegroundServiceConfig design interface
 *
 * This module is Android-only. All calls are no-ops on iOS (Platform.OS guard
 * is the caller's responsibility — see App.tsx bootstrap, Task 17).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import ReactNativeForegroundService from '@supersami/rn-foreground-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Notification ID for the persistent foreground notification (must match Java: 1001). */
const NOTIFICATION_ID = 1001;

/** Notification channel ID (must match Java: "aeromesh_sensor"). */
const CHANNEL_ID = 'aeromesh_sensor';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the Android foreground service with a persistent notification.
 *
 * Idempotent: if the service is already running (is_running() returns true),
 * this function returns immediately without starting a second instance (Req 8.1).
 *
 * The @supersami/rn-foreground-service library manages the internal counter
 * so multiple start() calls without matching stop() calls are safe, but we
 * guard explicitly to avoid unnecessary native calls.
 */
export async function startForegroundService(): Promise<void> {
  // Idempotency guard — do not start if already running (Req 8.1)
  if (ReactNativeForegroundService.is_running()) {
    console.log('[ForegroundService] Already running — skipping start');
    return;
  }

  try {
    // Register the error callback before starting
    ReactNativeForegroundService.register({
      config: {
        alert: false,
        onServiceErrorCallBack: () => {
          console.error('[ForegroundService] Service error reported by native layer');
        },
      },
    });

    await ReactNativeForegroundService.start({
      id: NOTIFICATION_ID,
      title: 'AeroMesh Active',
      message: 'Monitoring barometric pressure and mesh network',
      // ServiceType is required on Android 14+ for foreground services that
      // access location. Must match the foregroundServiceType in the manifest.
      ServiceType: 'location',
      icon: 'ic_notification',
      importance: 'low',
      visibility: 'public',
      vibration: false,
      ongoing: true,
    } as any);

    console.log('[ForegroundService] Started successfully');
  } catch (err) {
    console.error('[ForegroundService] Failed to start:', err);
    throw err;
  }
}

/**
 * Stops the Android foreground service.
 *
 * Safe to call even if the service is not running — the underlying library
 * handles the no-op case gracefully.
 */
export async function stopForegroundService(): Promise<void> {
  if (!ReactNativeForegroundService.is_running()) {
    console.log('[ForegroundService] Not running — skipping stop');
    return;
  }

  try {
    await ReactNativeForegroundService.stop();
    console.log('[ForegroundService] Stopped successfully');
  } catch (err) {
    console.error('[ForegroundService] Failed to stop:', err);
    throw err;
  }
}

/**
 * Returns true if the foreground service is currently running.
 *
 * This is a synchronous check against the JS-side state maintained by
 * @supersami/rn-foreground-service. It reflects whether start() has been
 * called without a matching stop() in the current JS runtime session.
 */
export function isForegroundServiceRunning(): boolean {
  return ReactNativeForegroundService.is_running();
}
