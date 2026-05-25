/**
 * SensorCollector — reads barometric pressure and GPS coordinates atomically.
 *
 * Responsibilities:
 *  - One-shot barometer read with a 3-second timeout fallback (Req 1.5)
 *  - GPS read via expo-location with permission handling (Req 1.2, 14.8)
 *  - Input validation: pressure [800, 1100] hPa, lat [-90, 90], lng [-180, 180]
 *    (Req 1.7, 1.8)
 *  - Persist valid readings to SQLite pressure_readings table (Req 1.3)
 *  - Update MMKV cache on valid reading (Req 1.6)
 *  - Set sensor_available='0' on timeout, invalid pressure, or GPS denial (Req 1.5,
 *    1.7, 14.8)
 *
 * Requirements: 1.2, 1.5, 1.6, 1.7, 1.8, 14.8
 */

import { Barometer } from 'expo-sensors';
import * as Location from 'expo-location';
import { storage, STORAGE_KEYS } from './storage';
import { getDB } from '../db/index';
import { pressureReadings } from '../db/schema';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SensorReading {
  /** Barometric pressure in hPa. */
  pressure: number;
  /** Latitude in decimal degrees, or null when GPS is unavailable/denied. */
  lat: number | null;
  /** Longitude in decimal degrees, or null when GPS is unavailable/denied. */
  lng: number | null;
  /** Altitude in metres, or null when unavailable. */
  altitude: number | null;
  /** Unix timestamp in milliseconds. */
  ts: number;
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

const PRESSURE_MIN = 800;   // hPa
const PRESSURE_MAX = 1100;  // hPa
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

// ---------------------------------------------------------------------------
// isBarometerAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true if the device has a barometric pressure sensor.
 *
 * Uses the expo-sensors `Barometer.isAvailableAsync()` API.
 */
export async function isBarometerAvailable(): Promise<boolean> {
  return Barometer.isAvailableAsync();
}

// ---------------------------------------------------------------------------
// readBarometerOnce (internal helper, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Reads a single barometric pressure value using the one-shot addListener pattern.
 *
 * Preconditions:
 *  - timeoutMs > 0
 *  - Barometer module is imported and available
 *
 * Postconditions:
 *  - Returns a pressure value in hPa if the sensor fires within timeoutMs
 *  - Returns null if the sensor does not fire within timeoutMs
 *  - The subscription is always cleaned up (no listener leak)
 *  - No mutations to any external state
 *
 * @param timeoutMs - Maximum wait time in milliseconds (default 3000).
 */
export function readBarometerOnce(timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(null);
    }, timeoutMs);

    const sub = Barometer.addListener(({ pressure }) => {
      clearTimeout(timer);
      sub.remove();
      resolve(pressure);
    });
  });
}

// ---------------------------------------------------------------------------
// readOnce — main public API
// ---------------------------------------------------------------------------

/**
 * Performs a single atomic sensor read: GPS + barometer.
 *
 * Flow:
 *  1. Check barometer availability.
 *  2. Request GPS with Location.getCurrentPositionAsync (Accuracy.Balanced).
 *     - If permission is DENIED, skip GPS and continue with null coordinates.
 *  3. Read barometer with 3-second timeout.
 *     - If timeout (null), set sensor_available='0' and return null.
 *  4. Validate pressure [800, 1100] hPa.
 *     - If invalid, set sensor_available='0' and return null.
 *  5. Validate lat/lng ranges (only when GPS was obtained).
 *     - If invalid, return null (do not persist).
 *  6. Persist valid reading to SQLite pressure_readings.
 *  7. Update MMKV: latest_pressure, latest_ts, sensor_available.
 *     - sensor_available='1' on success, '0' on GPS-denied path (Req 14.8).
 *
 * Returns the SensorReading on success, or null on any failure path.
 */
export async function readOnce(): Promise<SensorReading | null> {
  // -------------------------------------------------------------------------
  // Step 1: Check barometer availability
  // -------------------------------------------------------------------------
  const barometerAvailable = await isBarometerAvailable();
  if (!barometerAvailable) {
    storage.set(STORAGE_KEYS.SENSOR_AVAILABLE, '0');
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 2: Read GPS coordinates
  // -------------------------------------------------------------------------
  let lat: number | null = null;
  let lng: number | null = null;
  let altitude: number | null = null;
  let gpsPermissionDenied = false;

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();

    if (status === Location.PermissionStatus.DENIED) {
      // Req 14.8: skip GPS, continue with null coordinates
      gpsPermissionDenied = true;
    } else {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      lat = location.coords.latitude;
      lng = location.coords.longitude;
      altitude = location.coords.altitude ?? null;
    }
  } catch {
    // Any location error (e.g. timeout, unavailable) — treat as GPS unavailable
    gpsPermissionDenied = true;
  }

  // -------------------------------------------------------------------------
  // Step 3: Read barometer with 3-second timeout
  // -------------------------------------------------------------------------
  const pressure = await readBarometerOnce(3000);

  if (pressure === null) {
    // Req 1.5: sensor did not respond within timeout
    storage.set(STORAGE_KEYS.SENSOR_AVAILABLE, '0');
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 4: Validate pressure range [800, 1100] hPa
  // -------------------------------------------------------------------------
  if (pressure < PRESSURE_MIN || pressure > PRESSURE_MAX) {
    // Req 1.7: discard out-of-range pressure
    storage.set(STORAGE_KEYS.SENSOR_AVAILABLE, '0');
    return null;
  }

  // -------------------------------------------------------------------------
  // Step 5: Validate lat/lng ranges (only when GPS was obtained)
  // -------------------------------------------------------------------------
  if (!gpsPermissionDenied && lat !== null && lng !== null) {
    if (lat < LAT_MIN || lat > LAT_MAX || lng < LNG_MIN || lng > LNG_MAX) {
      // Req 1.8: discard reading with out-of-range coordinates
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Persist valid reading to SQLite
  // -------------------------------------------------------------------------
  const ts = Date.now();

  // Only persist to DB when we have valid coordinates (or GPS was denied and
  // we have a pressure-only reading). Per Req 1.2, if GPS read fails (not
  // permission denial but actual failure), we still persist the pressure-only
  // reading as per Req 14.8 (GPS denial → pressure-only with null coords).
  //
  // For the pressure_readings schema, lat/lng are NOT NULL, so we only insert
  // when we have coordinates. When GPS is denied, we skip DB persistence but
  // still return the reading and update MMKV.
  if (!gpsPermissionDenied && lat !== null && lng !== null) {
    try {
      const db = getDB();
      await db.insert(pressureReadings).values({
        pressure,
        lat,
        lng,
        altitude,
        ts,
      });
    } catch (err) {
      // Log but don't fail — MMKV update still proceeds
      console.warn('[SensorCollector] DB insert failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Update MMKV cache
  // -------------------------------------------------------------------------
  const reading: SensorReading = {
    pressure,
    lat,
    lng,
    altitude,
    ts,
  };

  if (gpsPermissionDenied) {
    // Req 14.8: GPS denied → pressure-only reading, sensor_available='0'
    storage.set(STORAGE_KEYS.LATEST_PRESSURE, pressure.toString());
    storage.set(STORAGE_KEYS.LATEST_TS, ts.toString());
    storage.set(STORAGE_KEYS.SENSOR_AVAILABLE, '0');
  } else {
    // Req 1.6: valid reading → update latest_pressure, latest_ts, sensor_available='1'
    storage.set(STORAGE_KEYS.LATEST_PRESSURE, pressure.toString());
    storage.set(STORAGE_KEYS.LATEST_TS, ts.toString());
    storage.set(STORAGE_KEYS.SENSOR_AVAILABLE, '1');
  }

  return reading;
}
