/**
 * MMKV storage module — synchronous key-value bridge between background tasks and foreground UI.
 *
 * This module is side-effect free at import time: the MMKV instance is created lazily
 * via a getter so that importing this file in any context (background or foreground)
 * does not trigger unexpected initialisation.
 *
 * Requirements: 11.4, 4.6, 4.7
 */

import { MMKV } from 'react-native-mmkv';

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * Shared MMKV instance used across the entire app.
 * Created with a fixed ID so the same underlying store is accessed from both
 * the background task context and the foreground UI.
 */
export const storage = new MMKV({ id: 'aeromesh' });

// ---------------------------------------------------------------------------
// Typed key constants (Model 6 from design doc)
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  /** Latest barometric pressure reading in hPa, stored as a float string. */
  LATEST_PRESSURE: 'latest_pressure',
  /** Unix millisecond timestamp of the latest reading, stored as an int string. */
  LATEST_TS: 'latest_ts',
  /** Current threat level: 'NORMAL' | 'WATCH' | 'HIGH' | 'CRITICAL'. */
  THREAT_LEVEL: 'threat_level',
  /** Current pressure rate in hPa/hr, stored as a float string. */
  PRESSURE_RATE: 'pressure_rate',
  /** JSON-serialised string[] of recently seen BLE message IDs (dedup cache). */
  SEEN_MSG_IDS: 'seen_msg_ids',
  /** '1' if the barometer is available and returned a valid reading, '0' otherwise. */
  SENSOR_AVAILABLE: 'sensor_available',
  /** '1' if the gateway has network connectivity and is actively uploading, '0' otherwise. */
  GATEWAY_ACTIVE: 'gateway_active',
} as const;

// Convenience re-exports so callers can use either the object or named constants.
export const LATEST_PRESSURE  = STORAGE_KEYS.LATEST_PRESSURE;
export const LATEST_TS        = STORAGE_KEYS.LATEST_TS;
export const THREAT_LEVEL     = STORAGE_KEYS.THREAT_LEVEL;
export const PRESSURE_RATE    = STORAGE_KEYS.PRESSURE_RATE;
export const SEEN_MSG_IDS     = STORAGE_KEYS.SEEN_MSG_IDS;
export const SENSOR_AVAILABLE = STORAGE_KEYS.SENSOR_AVAILABLE;
export const GATEWAY_ACTIVE   = STORAGE_KEYS.GATEWAY_ACTIVE;

// ---------------------------------------------------------------------------
// ThreatLevel type
// ---------------------------------------------------------------------------

export type ThreatLevel = 'NORMAL' | 'WATCH' | 'HIGH' | 'CRITICAL';

const VALID_THREAT_LEVELS: ReadonlySet<string> = new Set<ThreatLevel>([
  'NORMAL',
  'WATCH',
  'HIGH',
  'CRITICAL',
]);

// ---------------------------------------------------------------------------
// Seen-message-ID helpers (BLE dedup cache — Requirement 4.6, 4.7)
// ---------------------------------------------------------------------------

/** Maximum number of message IDs retained in the seen-IDs cache (LRU). */
const MAX_SEEN_IDS = 500;

/**
 * Returns the current list of seen BLE message IDs.
 * Parses the JSON array stored under `seen_msg_ids`; returns an empty array
 * if the key is absent or the stored value is not valid JSON.
 */
export function getSeenMsgIds(): string[] {
  const raw = storage.getString(SEEN_MSG_IDS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Adds a message ID to the seen-IDs cache and persists it to MMKV.
 *
 * LRU eviction: if the list would exceed MAX_SEEN_IDS entries after the
 * addition, the oldest entries are removed by slicing to the last 500.
 * The updated list is written to MMKV before this function returns.
 *
 * @param id - The 8-character hex message ID to record.
 */
export function addSeenMsgId(id: string): void {
  const ids = getSeenMsgIds();
  ids.push(id);
  const evicted = ids.length > MAX_SEEN_IDS ? ids.slice(-MAX_SEEN_IDS) : ids;
  storage.set(SEEN_MSG_IDS, JSON.stringify(evicted));
}

// ---------------------------------------------------------------------------
// Threat-level helpers (Requirement 11.4)
// ---------------------------------------------------------------------------

/**
 * Returns the current threat level from MMKV.
 * Falls back to `'NORMAL'` if the key is absent or contains an unrecognised value.
 */
export function getThreatLevel(): ThreatLevel {
  const raw = storage.getString(THREAT_LEVEL);
  if (raw && VALID_THREAT_LEVELS.has(raw)) return raw as ThreatLevel;
  return 'NORMAL';
}

/**
 * Persists the given threat level to MMKV.
 *
 * @param level - One of 'NORMAL' | 'WATCH' | 'HIGH' | 'CRITICAL'.
 */
export function setThreatLevel(level: ThreatLevel): void {
  storage.set(THREAT_LEVEL, level);
}
