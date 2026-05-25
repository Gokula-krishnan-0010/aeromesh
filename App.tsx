/**
 * App.tsx — AeroMesh root component.
 *
 * Bootstrap sequence (runs once on mount):
 *   1. initDB()
 *   2. startForegroundService()  — Android only
 *   3. registerBackgroundTask()
 *   4. startScanning()
 *   5. startBroadcastPoller()
 *   6. startGatewayPoller()
 *   7. hydrateFromMMKV()
 *
 * Also:
 *  - Requests all required permissions on first launch
 *  - Sets up AppState change listener to call hydrateFromMMKV() on 'active'
 *  - Provides simple state-based tab navigation (Home / Mesh / SOS History)
 *
 * Requirements: 1.1, 8.1, 9.1, 9.3, 11.5, 14.1, 14.2
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';

// ── Data layer ──────────────────────────────────────────────────────────────
import { initDB } from './src/db/index';

// ── Native services ─────────────────────────────────────────────────────────
import { startForegroundService } from './src/lib/foregroundService';

// ── Background task ─────────────────────────────────────────────────────────
import {
  registerBackgroundTask,
  requestBackgroundLocationPermission,
} from './src/lib/backgroundTask';

// ── BLE ─────────────────────────────────────────────────────────────────────
import { startScanning } from './src/lib/ble';

// ── BLE advertiser ──────────────────────────────────────────────────────────
import { startBroadcastPoller } from './src/lib/bleAdvertiser';

// ── Gateway bridge ──────────────────────────────────────────────────────────
import { startGatewayPoller } from './src/lib/bridge';

// ── State store ─────────────────────────────────────────────────────────────
import { useStore } from './src/store/index';

// ── Screens ─────────────────────────────────────────────────────────────────
import HomeScreen from './src/screens/HomeScreen';
import MeshScreen from './src/screens/MeshScreen';
import SOSHistoryScreen from './src/screens/SOSHistoryScreen';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabName = 'Home' | 'Mesh' | 'SOSHistory';

interface Tab {
  name: TabName;
  label: string;
  icon: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: Tab[] = [
  { name: 'Home',       label: 'Home',        icon: '🏠' },
  { name: 'Mesh',       label: 'Mesh',        icon: '📡' },
  { name: 'SOSHistory', label: 'SOS History', icon: '📋' },
];

const ACTIVE_TAB_COLOR   = '#3b82f6';
const INACTIVE_TAB_COLOR = '#64748b';
const BG_COLOR           = '#0f172a';
const TAB_BAR_COLOR      = '#1e293b';

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Requests foreground and background location permissions.
 * On iOS, also requests background location for Significant Location Change
 * wakeups (Req 9.3).
 */
async function requestLocationPermissions(): Promise<void> {
  try {
    const { status: fgStatus } =
      await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      console.warn('[App] Foreground location permission not granted');
    }

    const { status: bgStatus } =
      await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      console.warn('[App] Background location permission not granted');
    }
  } catch (err) {
    console.warn('[App] Location permission request failed:', err);
  }
}

/**
 * Requests Bluetooth permissions on Android 12+ (API 31+).
 * No-op on iOS or older Android versions (Req 14.2).
 */
async function requestBluetoothPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;

  // Only required on Android 12+ (API level 31+)
  const apiLevel = Platform.Version as number;
  if (apiLevel < 31) return;

  try {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ]);

    const allGranted = Object.values(granted).every(
      (result) => result === PermissionsAndroid.RESULTS.GRANTED
    );

    if (!allGranted) {
      console.warn('[App] Some Bluetooth permissions were not granted:', granted);
    } else {
      console.log('[App] All Bluetooth permissions granted');
    }
  } catch (err) {
    console.warn('[App] Bluetooth permission request failed:', err);
  }
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export default function App(): React.JSX.Element {
  const [activeTab, setActiveTab]     = useState<TabName>('Home');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const hydrateFromMMKV = useStore((s) => s.hydrateFromMMKV);

  // Track previous AppState to detect foreground transitions
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // ── Bootstrap sequence ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Step 0: Request all required permissions on first launch (Req 14.2)
        await requestLocationPermissions();
        await requestBluetoothPermissions();

        // Step 1: Initialize SQLite database (Req 11.1, 11.2, 11.3)
        // initDB() is synchronous (expo-sqlite v16 + drizzle sync adapter)
        initDB();
        console.log('[App] DB initialized');

        // Step 2: Start Android foreground service (Req 8.1)
        if (Platform.OS === 'android') {
          await startForegroundService();
          console.log('[App] Foreground service started');
        }

        // Step 3: Register background task (Req 1.1, 9.1)
        await registerBackgroundTask();
        console.log('[App] Background task registered');

        // Step 4: iOS — request background location for Significant Location
        //         Change wakeups (Req 9.3)
        if (Platform.OS === 'ios') {
          await requestBackgroundLocationPermission();
        }

        // Step 5: Start BLE scanning (Req 3.1)
        await startScanning();
        console.log('[App] BLE scanning started');

        // Step 6: Start BLE broadcast poller (Req 5.4)
        startBroadcastPoller();
        console.log('[App] Broadcast poller started');

        // Step 7: Start gateway poller (Req 6.8)
        startGatewayPoller();
        console.log('[App] Gateway poller started');

        // Step 8: Hydrate Zustand store from MMKV (Req 11.5)
        hydrateFromMMKV();
        console.log('[App] Store hydrated from MMKV');

        if (!cancelled) {
          setBootstrapping(false);
        }
      } catch (err) {
        console.error('[App] Bootstrap error:', err);
        if (!cancelled) {
          setBootstrapError((err as Error).message ?? 'Unknown bootstrap error');
          setBootstrapping(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── AppState listener — hydrate on foreground (Req 11.5, 12.9) ───────────

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (
          appStateRef.current !== 'active' &&
          nextState === 'active'
        ) {
          hydrateFromMMKV();
        }
        appStateRef.current = nextState;
      }
    );

    return () => {
      subscription.remove();
    };
  }, [hydrateFromMMKV]);

  // ── Tab press handler ─────────────────────────────────────────────────────

  const handleTabPress = useCallback((tab: TabName) => {
    setActiveTab(tab);
  }, []);

  // ── Loading state ─────────────────────────────────────────────────────────

  if (bootstrapping) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={ACTIVE_TAB_COLOR} />
        <Text style={styles.loadingText}>Starting AeroMesh…</Text>
      </View>
    );
  }

  // ── Bootstrap error state (non-fatal — still render the app) ─────────────

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />

      {/* Bootstrap error banner (non-fatal) */}
      {bootstrapError !== null && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>
            ⚠️ Bootstrap warning: {bootstrapError}
          </Text>
        </View>
      )}

      {/* Screen content */}
      <View style={styles.screenContainer}>
        {activeTab === 'Home'       && <HomeScreen />}
        {activeTab === 'Mesh'       && <MeshScreen />}
        {activeTab === 'SOSHistory' && <SOSHistoryScreen />}
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.name;
          return (
            <TouchableOpacity
              key={tab.name}
              style={styles.tabItem}
              onPress={() => handleTabPress(tab.name)}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: isActive }}
            >
              <Text style={styles.tabIcon}>{tab.icon}</Text>
              <Text
                style={[
                  styles.tabLabel,
                  { color: isActive ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR },
                ]}
              >
                {tab.label}
              </Text>
              {/* Active indicator underline */}
              {isActive && <View style={styles.tabActiveIndicator} />}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // ── Safe area wrapper ──────────────────────────────────────────────────────
  safeArea: {
    flex: 1,
    backgroundColor: BG_COLOR,
  },

  // ── Loading screen ─────────────────────────────────────────────────────────
  loadingContainer: {
    flex: 1,
    backgroundColor: BG_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '500',
  },

  // ── Error banner ───────────────────────────────────────────────────────────
  errorBanner: {
    backgroundColor: '#7f1d1d',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  errorBannerText: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },

  // ── Screen container ───────────────────────────────────────────────────────
  screenContainer: {
    flex: 1,
  },

  // ── Tab bar ────────────────────────────────────────────────────────────────
  tabBar: {
    flexDirection: 'row',
    backgroundColor: TAB_BAR_COLOR,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingBottom: 4,
    paddingTop: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 4,
    position: 'relative',
  },
  tabIcon: {
    fontSize: 20,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tabActiveIndicator: {
    position: 'absolute',
    top: 0,
    left: '20%',
    right: '20%',
    height: 2,
    backgroundColor: ACTIVE_TAB_COLOR,
    borderRadius: 1,
  },
});
