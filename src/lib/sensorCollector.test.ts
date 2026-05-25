/**
 * Tests for SensorCollector module (src/lib/sensorCollector.ts)
 *
 * Covers Requirements:
 *   1.2  Atomic sensor read — if either read fails, neither value is persisted
 *   1.5  Barometer timeout → sensor_available='0', return null
 *   1.6  Valid reading → write latest_pressure, latest_ts, sensor_available='1'
 *   1.7  Pressure outside [800, 1100] → sensor_available='0', return null
 *   1.8  lat/lng outside valid ranges → return null (do not persist)
 *   14.8 GPS permission denied → pressure-only reading, sensor_available='0'
 *
 * All native modules (expo-sensors, expo-location, react-native-mmkv, DB) are
 * mocked so the tests run in a pure Node environment via Jest.
 */

import { readBarometerOnce, readOnce, isBarometerAvailable, SensorReading } from './sensorCollector';

// ---------------------------------------------------------------------------
// Mock: expo-sensors (Barometer)
// ---------------------------------------------------------------------------

const mockBarometerAddListener = jest.fn();
const mockBarometerIsAvailable = jest.fn();

jest.mock('expo-sensors', () => ({
  Barometer: {
    addListener: (...args: unknown[]) => mockBarometerAddListener(...args),
    isAvailableAsync: () => mockBarometerIsAvailable(),
  },
}));

// ---------------------------------------------------------------------------
// Mock: expo-location
// ---------------------------------------------------------------------------

const mockRequestForegroundPermissions = jest.fn();
const mockGetCurrentPosition = jest.fn();

jest.mock('expo-location', () => ({
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: () => mockRequestForegroundPermissions(),
  getCurrentPositionAsync: (...args: unknown[]) => mockGetCurrentPosition(...args),
}));

// ---------------------------------------------------------------------------
// Mock: react-native-mmkv
// ---------------------------------------------------------------------------

const mmkvStore: Record<string, string> = {};

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn().mockImplementation(() => ({
    set: (key: string, value: string) => { mmkvStore[key] = value; },
    getString: (key: string) => mmkvStore[key],
    delete: (key: string) => { delete mmkvStore[key]; },
  })),
}));

// ---------------------------------------------------------------------------
// Mock: src/db/index (getDB)
// ---------------------------------------------------------------------------

const mockDbInsert = jest.fn();

jest.mock('../db/index', () => ({
  getDB: () => ({
    insert: () => ({
      values: mockDbInsert,
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Mock: src/db/schema (pressureReadings)
// ---------------------------------------------------------------------------

jest.mock('../db/schema', () => ({
  pressureReadings: 'pressure_readings',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a barometer that fires immediately with the given pressure. */
function simulateBarometerFire(pressure: number) {
  mockBarometerAddListener.mockImplementation((cb: (data: { pressure: number }) => void) => {
    // Fire synchronously in the next microtask
    Promise.resolve().then(() => cb({ pressure }));
    return { remove: jest.fn() };
  });
}

/** Simulate a barometer that never fires (timeout path). */
function simulateBarometerTimeout() {
  mockBarometerAddListener.mockImplementation(() => {
    return { remove: jest.fn() };
  });
}

/** Simulate GPS permission granted with given coordinates. */
function simulateGpsGranted(lat: number, lng: number, altitude: number | null = null) {
  mockRequestForegroundPermissions.mockResolvedValue({ status: 'granted' });
  mockGetCurrentPosition.mockResolvedValue({
    coords: { latitude: lat, longitude: lng, altitude },
  });
}

/** Simulate GPS permission denied. */
function simulateGpsDenied() {
  mockRequestForegroundPermissions.mockResolvedValue({ status: 'denied' });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Clear MMKV store
  Object.keys(mmkvStore).forEach((k) => delete mmkvStore[k]);
  // Default: barometer available
  mockBarometerIsAvailable.mockResolvedValue(true);
  // Default: DB insert succeeds
  mockDbInsert.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// readBarometerOnce — unit tests
// ---------------------------------------------------------------------------

describe('readBarometerOnce()', () => {
  test('returns pressure when sensor fires before timeout', async () => {
    simulateBarometerFire(1013.25);
    const result = await readBarometerOnce(3000);
    expect(result).toBeCloseTo(1013.25, 2);
  });

  test('returns null when sensor does not fire within timeout', async () => {
    simulateBarometerTimeout();
    const result = await readBarometerOnce(50); // short timeout for test speed
    expect(result).toBeNull();
  });

  test('cleans up subscription on success (no listener leak)', async () => {
    const mockRemove = jest.fn();
    mockBarometerAddListener.mockImplementation((cb: (data: { pressure: number }) => void) => {
      Promise.resolve().then(() => cb({ pressure: 1000 }));
      return { remove: mockRemove };
    });
    await readBarometerOnce(3000);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  test('cleans up subscription on timeout (no listener leak)', async () => {
    const mockRemove = jest.fn();
    mockBarometerAddListener.mockImplementation(() => ({ remove: mockRemove }));
    await readBarometerOnce(50);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// isBarometerAvailable — unit tests
// ---------------------------------------------------------------------------

describe('isBarometerAvailable()', () => {
  test('returns true when barometer is available', async () => {
    mockBarometerIsAvailable.mockResolvedValue(true);
    expect(await isBarometerAvailable()).toBe(true);
  });

  test('returns false when barometer is unavailable', async () => {
    mockBarometerIsAvailable.mockResolvedValue(false);
    expect(await isBarometerAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 1.5: barometer timeout
// ---------------------------------------------------------------------------

describe('readOnce() — Req 1.5: barometer timeout', () => {
  test('returns null when barometer times out', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerTimeout();
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('sets sensor_available="0" when barometer times out', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerTimeout();
    await readOnce();
    expect(mmkvStore['sensor_available']).toBe('0');
  });

  test('does not persist to DB when barometer times out', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerTimeout();
    await readOnce();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 1.7: pressure out of range
// ---------------------------------------------------------------------------

describe('readOnce() — Req 1.7: pressure out of range', () => {
  test('returns null for pressure below 800 hPa', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(799.9);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('returns null for pressure above 1100 hPa', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1100.1);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('sets sensor_available="0" for out-of-range pressure', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(500);
    await readOnce();
    expect(mmkvStore['sensor_available']).toBe('0');
  });

  test('does not persist to DB for out-of-range pressure', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1200);
    await readOnce();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  test('does not update latest_pressure for out-of-range pressure', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(799);
    await readOnce();
    expect(mmkvStore['latest_pressure']).toBeUndefined();
  });

  test('accepts pressure exactly at 800 hPa (boundary)', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(800);
    const result = await readOnce();
    expect(result).not.toBeNull();
    expect(result?.pressure).toBe(800);
  });

  test('accepts pressure exactly at 1100 hPa (boundary)', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1100);
    const result = await readOnce();
    expect(result).not.toBeNull();
    expect(result?.pressure).toBe(1100);
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 1.8: lat/lng out of range
// ---------------------------------------------------------------------------

describe('readOnce() — Req 1.8: lat/lng out of range', () => {
  test('returns null for lat below -90', async () => {
    simulateGpsGranted(-90.1, 0);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('returns null for lat above 90', async () => {
    simulateGpsGranted(90.1, 0);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('returns null for lng below -180', async () => {
    simulateGpsGranted(0, -180.1);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('returns null for lng above 180', async () => {
    simulateGpsGranted(0, 180.1);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('does not persist to DB for out-of-range lat', async () => {
    simulateGpsGranted(91, 0);
    simulateBarometerFire(1013);
    await readOnce();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  test('accepts lat exactly at -90 (boundary)', async () => {
    simulateGpsGranted(-90, 0);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).not.toBeNull();
  });

  test('accepts lng exactly at 180 (boundary)', async () => {
    simulateGpsGranted(0, 180);
    simulateBarometerFire(1013);
    const result = await readOnce();
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 1.6: valid reading MMKV update
// ---------------------------------------------------------------------------

describe('readOnce() — Req 1.6: valid reading updates MMKV', () => {
  test('writes latest_pressure to MMKV on valid reading', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mmkvStore['latest_pressure']).toBe('1013.25');
  });

  test('writes latest_ts to MMKV on valid reading', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1013.25);
    const before = Date.now();
    await readOnce();
    const after = Date.now();
    const ts = parseInt(mmkvStore['latest_ts'], 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('sets sensor_available="1" on valid reading', async () => {
    simulateGpsGranted(12.345, 77.123);
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mmkvStore['sensor_available']).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 1.3: persist to DB on valid reading
// ---------------------------------------------------------------------------

describe('readOnce() — Req 1.3: persist to DB on valid reading', () => {
  test('inserts a row into pressure_readings on valid reading', async () => {
    simulateGpsGranted(12.345, 77.123, 100);
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    const insertedRow = mockDbInsert.mock.calls[0][0];
    expect(insertedRow.pressure).toBe(1013.25);
    expect(insertedRow.lat).toBe(12.345);
    expect(insertedRow.lng).toBe(77.123);
    expect(insertedRow.altitude).toBe(100);
    expect(typeof insertedRow.ts).toBe('number');
  });

  test('returns a SensorReading with all fields on valid reading', async () => {
    simulateGpsGranted(12.345, 77.123, 50);
    simulateBarometerFire(1013.25);
    const result = await readOnce();
    expect(result).not.toBeNull();
    expect(result!.pressure).toBe(1013.25);
    expect(result!.lat).toBe(12.345);
    expect(result!.lng).toBe(77.123);
    expect(result!.altitude).toBe(50);
    expect(typeof result!.ts).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// readOnce — Requirement 14.8: GPS permission denied
// ---------------------------------------------------------------------------

describe('readOnce() — Req 14.8: GPS permission denied', () => {
  test('returns a pressure-only reading (null lat/lng) when GPS is denied', async () => {
    simulateGpsDenied();
    simulateBarometerFire(1013.25);
    const result = await readOnce();
    expect(result).not.toBeNull();
    expect(result!.pressure).toBe(1013.25);
    expect(result!.lat).toBeNull();
    expect(result!.lng).toBeNull();
  });

  test('sets sensor_available="0" when GPS is denied (Req 14.8)', async () => {
    simulateGpsDenied();
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mmkvStore['sensor_available']).toBe('0');
  });

  test('still writes latest_pressure and latest_ts when GPS is denied', async () => {
    simulateGpsDenied();
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mmkvStore['latest_pressure']).toBe('1013.25');
    expect(mmkvStore['latest_ts']).toBeDefined();
  });

  test('does not persist to DB when GPS is denied (no lat/lng for NOT NULL columns)', async () => {
    simulateGpsDenied();
    simulateBarometerFire(1013.25);
    await readOnce();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readOnce — barometer unavailable
// ---------------------------------------------------------------------------

describe('readOnce() — barometer unavailable', () => {
  test('returns null when barometer is not available on device', async () => {
    mockBarometerIsAvailable.mockResolvedValue(false);
    simulateGpsGranted(12.345, 77.123);
    const result = await readOnce();
    expect(result).toBeNull();
  });

  test('sets sensor_available="0" when barometer is not available', async () => {
    mockBarometerIsAvailable.mockResolvedValue(false);
    simulateGpsGranted(12.345, 77.123);
    await readOnce();
    expect(mmkvStore['sensor_available']).toBe('0');
  });
});
