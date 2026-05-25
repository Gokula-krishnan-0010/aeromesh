/**
 * AppStateStore — Zustand reactive in-memory state for the UI layer.
 *
 * IMPORTANT: This module MUST NOT be imported from background task files
 * (backgroundTask.ts, anomaly.ts, bridge.ts). Background tasks have no React
 * context and must use MMKV directly via src/lib/storage.ts.
 *
 * On app foreground, call `hydrateFromMMKV()` to sync the store with the
 * latest values written by background tasks.
 *
 * Requirements: 11.5, 12.9
 */

import { create } from 'zustand';
import { storage, STORAGE_KEYS, ThreatLevel, getThreatLevel } from '../lib/storage';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface PeerInfo {
  id: string;
  rssi: number | null;
  lastSeen: number;
  hasSOS: boolean;
  lat: number | null;
  lng: number | null;
}

export interface SOSStatus {
  msgId: string;
  uploaded: boolean;
  ackFrom: string | null;
  ackTs: number | null;
}

export type AppMode = 'STANDBY' | 'ALERT' | 'SOS';

// ---------------------------------------------------------------------------
// AppState interface
// ---------------------------------------------------------------------------

export interface AppState {
  // Sensor state
  latestPressure: number | null;
  pressureRate: number;
  sensorAvailable: boolean;

  // Threat state
  threatLevel: ThreatLevel;
  mode: AppMode;

  // Mesh state
  peers: Record<string, PeerInfo>;
  queuedSOS: number;
  sosStatuses: Record<string, SOSStatus>;

  // Gateway state
  gatewayActive: boolean;

  // Actions
  setLatestPressure(p: number): void;
  setPressureRate(r: number): void;
  setSensorAvailable(v: boolean): void;
  setThreatLevel(l: ThreatLevel): void;
  setMode(m: AppMode): void;
  updatePeer(peer: PeerInfo): void;
  pruneOldPeers(cutoff: number): void;
  incrementQueuedSOS(): void;
  updateSosAck(msgId: string, from: string): void;
  markUploaded(msgIds: string[]): void;
  setGatewayActive(v: boolean): void;
  hydrateFromMMKV(): void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useStore = create<AppState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────

  latestPressure: null,
  pressureRate: 0,
  sensorAvailable: true,
  threatLevel: 'NORMAL',
  mode: 'STANDBY',
  peers: {},
  queuedSOS: 0,
  sosStatuses: {},
  gatewayActive: false,

  // ── Sensor setters ─────────────────────────────────────────────────────────

  setLatestPressure: (p) => set({ latestPressure: p }),

  setPressureRate: (r) => set({ pressureRate: r }),

  setSensorAvailable: (v) => set({ sensorAvailable: v }),

  // ── Threat setters ─────────────────────────────────────────────────────────

  setThreatLevel: (l) => set({ threatLevel: l }),

  setMode: (m) => set({ mode: m }),

  // ── Mesh setters ───────────────────────────────────────────────────────────

  /**
   * Upserts a peer into the peers map, keyed by peer.id.
   */
  updatePeer: (peer) =>
    set((state) => ({
      peers: { ...state.peers, [peer.id]: peer },
    })),

  /**
   * Removes all peers whose lastSeen timestamp is strictly less than cutoff.
   * cutoff is a Unix millisecond timestamp.
   */
  pruneOldPeers: (cutoff) =>
    set((state) => {
      const pruned: Record<string, PeerInfo> = {};
      for (const [id, peer] of Object.entries(state.peers)) {
        if (peer.lastSeen >= cutoff) {
          pruned[id] = peer;
        }
      }
      return { peers: pruned };
    }),

  /**
   * Increments the count of queued SOS messages by 1.
   */
  incrementQueuedSOS: () =>
    set((state) => ({ queuedSOS: state.queuedSOS + 1 })),

  /**
   * Records an ACK for the given SOS message.
   * If the SOSStatus entry does not yet exist, it is created with sensible defaults.
   */
  updateSosAck: (msgId, from) =>
    set((state) => {
      const existing = state.sosStatuses[msgId] ?? {
        msgId,
        uploaded: false,
        ackFrom: null,
        ackTs: null,
      };
      return {
        sosStatuses: {
          ...state.sosStatuses,
          [msgId]: {
            ...existing,
            ackFrom: from,
            ackTs: Date.now(),
          },
        },
      };
    }),

  /**
   * Marks each msgId in the provided array as uploaded.
   * Entries that do not yet exist in sosStatuses are created.
   */
  markUploaded: (msgIds) =>
    set((state) => {
      const updated = { ...state.sosStatuses };
      for (const msgId of msgIds) {
        const existing = updated[msgId] ?? {
          msgId,
          uploaded: false,
          ackFrom: null,
          ackTs: null,
        };
        updated[msgId] = { ...existing, uploaded: true };
      }
      return { sosStatuses: updated };
    }),

  // ── Gateway setters ────────────────────────────────────────────────────────

  setGatewayActive: (v) => set({ gatewayActive: v }),

  // ── MMKV hydration ─────────────────────────────────────────────────────────

  /**
   * Reads all MMKV keys written by background tasks and populates the store.
   * Call this whenever the app returns to the foreground (Requirement 11.5, 12.9).
   *
   * Keys read:
   *   latest_pressure   → latestPressure  (parseFloat; null if absent)
   *   pressure_rate     → pressureRate    (parseFloat; 0 if absent)
   *   sensor_available  → sensorAvailable ('1' → true, anything else → false)
   *   threat_level      → threatLevel     (via getThreatLevel() helper)
   *   gateway_active    → gatewayActive   ('1' → true, anything else → false)
   */
  hydrateFromMMKV: () => {
    const rawPressure  = storage.getString(STORAGE_KEYS.LATEST_PRESSURE);
    const rawRate      = storage.getString(STORAGE_KEYS.PRESSURE_RATE);
    const rawSensor    = storage.getString(STORAGE_KEYS.SENSOR_AVAILABLE);
    const rawGateway   = storage.getString(STORAGE_KEYS.GATEWAY_ACTIVE);

    const latestPressure   = rawPressure  ? parseFloat(rawPressure)  : null;
    const pressureRate     = rawRate      ? parseFloat(rawRate)      : 0;
    const sensorAvailable  = rawSensor    === '1';
    const gatewayActive    = rawGateway   === '1';
    const threatLevel      = getThreatLevel();

    set({
      latestPressure:  Number.isFinite(latestPressure) ? latestPressure : null,
      pressureRate:    Number.isFinite(pressureRate)   ? pressureRate   : 0,
      sensorAvailable,
      threatLevel,
      gatewayActive,
    });
  },
}));
