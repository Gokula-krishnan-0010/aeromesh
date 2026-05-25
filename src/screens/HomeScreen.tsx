/**
 * HomeScreen — primary dashboard screen for AeroMesh.
 *
 * Displays:
 *  - Barometric pressure in hPa (or "Sensor unavailable on this device")
 *  - Staleness warning if latest_ts is more than 5 minutes old
 *  - Threat level badge with colour coding
 *  - Mesh peer count
 *  - Gateway status indicator
 *  - Hold-to-activate SOS button (3-second press)
 *  - iOS background restriction banner (when applicable)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.8, 12.9, 12.10,
 *               5.2, 5.3, 9.5, 9.6
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  AppStateStatus,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Location from 'expo-location';

import { useStore } from '../store/index';
import { storage, STORAGE_KEYS } from '../lib/storage';
import { isBackgroundRestricted } from '../lib/backgroundTask';
import { getDB } from '../db/index';
import { sosQueue } from '../db/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staleness threshold: 5 minutes in milliseconds (Req 12.10). */
const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

/** SOS hold duration: 3 seconds (Req 12.5, 5.2). */
const SOS_HOLD_DURATION_MS = 3000;

/** Threat level colour map (Req 12.2). */
const THREAT_COLORS: Record<string, string> = {
  NORMAL:   '#22c55e',  // green
  WATCH:    '#f59e0b',  // amber
  HIGH:     '#f97316',  // orange
  CRITICAL: '#ef4444',  // red
};

// ---------------------------------------------------------------------------
// HomeScreen component
// ---------------------------------------------------------------------------

export default function HomeScreen(): React.JSX.Element {
  // ── Zustand state ──────────────────────────────────────────────────────────
  const latestPressure  = useStore((s) => s.latestPressure);
  const sensorAvailable = useStore((s) => s.sensorAvailable);
  const threatLevel     = useStore((s) => s.threatLevel);
  const peers           = useStore((s) => s.peers);
  const gatewayActive   = useStore((s) => s.gatewayActive);
  const hydrateFromMMKV = useStore((s) => s.hydrateFromMMKV);

  // ── Local state ────────────────────────────────────────────────────────────
  const [isStale, setIsStale]         = useState(false);
  const [sosActive, setSosActive]     = useState(false);
  const [sosProgress, setSosProgress] = useState(0); // 0–100 for visual feedback

  // ── Refs ───────────────────────────────────────────────────────────────────
  const sosTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sosProgressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Derived values ─────────────────────────────────────────────────────────
  const peerCount    = Object.keys(peers).length;
  const threatColor  = THREAT_COLORS[threatLevel] ?? THREAT_COLORS.NORMAL;

  // ---------------------------------------------------------------------------
  // Staleness check
  // ---------------------------------------------------------------------------

  const checkStaleness = useCallback(() => {
    const rawTs = storage.getString(STORAGE_KEYS.LATEST_TS);
    const latestTs = parseInt(rawTs ?? '0', 10);
    const diff = Date.now() - latestTs;
    setIsStale(latestTs > 0 && diff > STALENESS_THRESHOLD_MS);
  }, []);

  // ---------------------------------------------------------------------------
  // AppState listener — hydrate on foreground (Req 12.9, 11.5)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Hydrate immediately on mount
    hydrateFromMMKV();
    checkStaleness();

    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (nextState === 'active') {
          hydrateFromMMKV();
          checkStaleness();
        }
      }
    );

    return () => {
      subscription.remove();
    };
  }, [hydrateFromMMKV, checkStaleness]);

  // ---------------------------------------------------------------------------
  // SOS button handlers (Req 12.5, 5.2, 5.3)
  // ---------------------------------------------------------------------------

  const handleSosPressIn = useCallback(() => {
    setSosActive(true);
    setSosProgress(0);

    // Progress animation — update every 30 ms for smooth fill
    sosProgressRef.current = setInterval(() => {
      setSosProgress((prev) => {
        const next = prev + (30 / SOS_HOLD_DURATION_MS) * 100;
        return next > 100 ? 100 : next;
      });
    }, 30);

    // Activation timer — fires after 3 seconds (Req 5.2)
    sosTimerRef.current = setTimeout(async () => {
      clearInterval(sosProgressRef.current!);
      sosProgressRef.current = null;
      setSosProgress(100);

      try {
        // Obtain current GPS position (Req 5.2)
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        const { latitude: lat, longitude: lng } = location.coords;

        // Generate 8-char hex msgId (Req 5.5)
        const msgId = Math.random().toString(16).slice(2, 10);

        // Insert MANUAL_SOS into sos_queue (Req 5.2, 12.5)
        const db = getDB();
        await db.insert(sosQueue).values({
          msgId,
          type:     'MANUAL',
          origin:   'SELF',
          lat,
          lng,
          pressure: null,
          ts:       Date.now(),
          ttl:      6,
          uploaded: 0,
        }).onConflictDoNothing();

        console.log('[HomeScreen] MANUAL_SOS enqueued:', msgId);
      } catch (err) {
        console.error('[HomeScreen] SOS activation failed:', err);
      } finally {
        setSosActive(false);
        setSosProgress(0);
      }
    }, SOS_HOLD_DURATION_MS);
  }, []);

  const handleSosPressOut = useCallback(() => {
    // Cancel if released before 3 seconds (Req 5.3, 12.5)
    if (sosTimerRef.current !== null) {
      clearTimeout(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    if (sosProgressRef.current !== null) {
      clearInterval(sosProgressRef.current);
      sosProgressRef.current = null;
    }
    setSosActive(false);
    setSosProgress(0);
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (sosTimerRef.current)    clearTimeout(sosTimerRef.current);
      if (sosProgressRef.current) clearInterval(sosProgressRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={styles.container}>

      {/* iOS background restriction banner (Req 9.5, 9.6, 14.6) */}
      {Platform.OS === 'ios' && isBackgroundRestricted && (
        <TouchableOpacity
          style={styles.restrictionBanner}
          onPress={() => Linking.openSettings()}
          accessibilityRole="button"
          accessibilityLabel="Background App Refresh is disabled. Tap to open Settings."
        >
          <Text style={styles.restrictionBannerText}>
            ⚠️ Background App Refresh is disabled. Tap to enable.
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Pressure section (Req 12.1, 12.8, 12.10) ── */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Barometric Pressure</Text>

        {sensorAvailable ? (
          <View style={styles.pressureRow}>
            <Text style={styles.pressureValue}>
              {latestPressure !== null
                ? `${latestPressure.toFixed(1)} hPa`
                : '— hPa'}
            </Text>
            {/* Staleness warning icon (Req 12.10) */}
            {isStale && (
              <Text
                style={styles.stalenessIcon}
                accessibilityLabel="Pressure reading is stale (more than 5 minutes old)"
              >
                ⚠️
              </Text>
            )}
          </View>
        ) : (
          <Text style={styles.sensorUnavailable}>
            Sensor unavailable on this device
          </Text>
        )}

        {isStale && sensorAvailable && (
          <Text style={styles.stalenessLabel}>Reading may be outdated</Text>
        )}
      </View>

      {/* ── Threat level badge (Req 12.2) ── */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Threat Level</Text>
        <View style={[styles.threatBadge, { backgroundColor: threatColor }]}>
          <Text style={styles.threatBadgeText}>{threatLevel}</Text>
        </View>
      </View>

      {/* ── Mesh peer count (Req 12.3) ── */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Mesh Peers</Text>
        <Text style={styles.peerCount}>
          {peerCount} {peerCount === 1 ? 'peer' : 'peers'} in range
        </Text>
      </View>

      {/* ── Gateway status (Req 12.4) ── */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Gateway Status</Text>
        <View style={styles.gatewayRow}>
          <View
            style={[
              styles.gatewayDot,
              { backgroundColor: gatewayActive ? '#22c55e' : '#9ca3af' },
            ]}
          />
          <Text
            style={[
              styles.gatewayLabel,
              { color: gatewayActive ? '#22c55e' : '#9ca3af' },
            ]}
          >
            {gatewayActive ? 'Gateway Active' : 'Gateway Inactive'}
          </Text>
        </View>
      </View>

      {/* ── SOS button (Req 12.5, 5.2, 5.3) ── */}
      <View style={styles.sosSection}>
        <Pressable
          onPressIn={handleSosPressIn}
          onPressOut={handleSosPressOut}
          style={({ pressed }) => [
            styles.sosButton,
            (pressed || sosActive) && styles.sosButtonActive,
          ]}
          accessibilityRole="button"
          accessibilityLabel="SOS button. Hold for 3 seconds to send an emergency SOS."
          accessibilityHint="Hold this button for 3 seconds to activate an SOS signal."
        >
          {/* Progress fill overlay */}
          {sosActive && (
            <View
              style={[
                styles.sosProgressFill,
                { width: `${sosProgress}%` as unknown as number },
              ]}
            />
          )}
          <Text style={styles.sosButtonText}>
            {sosActive ? `Hold… ${Math.ceil((100 - sosProgress) / 100 * 3)}s` : 'SOS'}
          </Text>
        </Pressable>
        <Text style={styles.sosHint}>Hold for 3 seconds to send SOS</Text>
      </View>

    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 16,
  },

  // ── iOS restriction banner ──────────────────────────────────────────────────
  restrictionBanner: {
    backgroundColor: '#fef08a',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  restrictionBannerText: {
    color: '#713f12',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },

  // ── Cards ──────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },

  // ── Pressure ───────────────────────────────────────────────────────────────
  pressureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pressureValue: {
    color: '#f1f5f9',
    fontSize: 32,
    fontWeight: '700',
  },
  stalenessIcon: {
    fontSize: 22,
  },
  stalenessLabel: {
    color: '#f59e0b',
    fontSize: 12,
    marginTop: 4,
  },
  sensorUnavailable: {
    color: '#64748b',
    fontSize: 16,
    fontStyle: 'italic',
  },

  // ── Threat badge ───────────────────────────────────────────────────────────
  threatBadge: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 18,
  },
  threatBadgeText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // ── Peer count ─────────────────────────────────────────────────────────────
  peerCount: {
    color: '#f1f5f9',
    fontSize: 24,
    fontWeight: '600',
  },

  // ── Gateway ────────────────────────────────────────────────────────────────
  gatewayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gatewayDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  gatewayLabel: {
    fontSize: 16,
    fontWeight: '600',
  },

  // ── SOS button ─────────────────────────────────────────────────────────────
  sosSection: {
    alignItems: 'center',
    marginTop: 8,
  },
  sosButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#dc2626',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  sosButtonActive: {
    backgroundColor: '#b91c1c',
  },
  sosProgressFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  sosButtonText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 2,
  },
  sosHint: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 10,
  },
});
