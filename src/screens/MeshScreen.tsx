/**
 * MeshScreen — displays the list of currently discovered BLE mesh peers.
 *
 * Each peer row shows:
 *  - Device ID (truncated to 8 chars)
 *  - RSSI value in dBm
 *  - RSSI signal strength bar (0–5 bars, mapped from -100→0 dBm)
 *  - Time since last seen (relative: Xs ago / Xm ago / Xh ago)
 *
 * Subscribes to Zustand `peers` state; list updates reactively as peers
 * are discovered or pruned.
 *
 * Shows "No peers in range" empty state when the peers map is empty.
 *
 * Requirement: 12.6
 */

import React, { useCallback } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useStore, PeerInfo } from '../store/index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total number of signal bar segments rendered per peer row. */
const TOTAL_BARS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps an RSSI value (dBm) to a bar count in [0, 5].
 * Formula: Math.round(((rssi + 100) / 100) * 5), clamped to [0, 5].
 */
function rssiBars(rssi: number | null): number {
  if (rssi === null) return 0;
  const raw = Math.round(((rssi + 100) / 100) * TOTAL_BARS);
  return Math.max(0, Math.min(TOTAL_BARS, raw));
}

/**
 * Returns a human-readable relative time string for a Unix ms timestamp.
 * Format: "Xs ago", "Xm ago", "Xh ago".
 */
function relativeTime(lastSeen: number): string {
  const diffMs = Date.now() - lastSeen;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }

  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

// ---------------------------------------------------------------------------
// SignalBars sub-component
// ---------------------------------------------------------------------------

interface SignalBarsProps {
  bars: number;
}

function SignalBars({ bars }: SignalBarsProps): React.JSX.Element {
  return (
    <View
      style={styles.signalBarsContainer}
      accessibilityLabel={`Signal strength: ${bars} out of ${TOTAL_BARS} bars`}
    >
      {Array.from({ length: TOTAL_BARS }, (_, i) => (
        <View
          key={i}
          style={[
            styles.signalBar,
            { height: 4 + i * 3 },
            i < bars ? styles.signalBarFilled : styles.signalBarEmpty,
          ]}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// PeerRow sub-component
// ---------------------------------------------------------------------------

interface PeerRowProps {
  peer: PeerInfo;
}

function PeerRow({ peer }: PeerRowProps): React.JSX.Element {
  const bars = rssiBars(peer.rssi);
  const shortId = peer.id.slice(0, 8);
  const rssiLabel = peer.rssi !== null ? `${peer.rssi} dBm` : '— dBm';
  const timeLabel = relativeTime(peer.lastSeen);

  return (
    <View
      style={styles.peerRow}
      accessibilityRole="none"
      accessibilityLabel={`Peer ${shortId}, RSSI ${rssiLabel}, last seen ${timeLabel}`}
    >
      {/* Left: device ID + last seen */}
      <View style={styles.peerInfo}>
        <Text style={styles.peerId}>{shortId}</Text>
        <Text style={styles.peerLastSeen}>{timeLabel}</Text>
      </View>

      {/* Right: signal bars + RSSI value */}
      <View style={styles.peerSignal}>
        <SignalBars bars={bars} />
        <Text style={styles.peerRssi}>{rssiLabel}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MeshScreen component
// ---------------------------------------------------------------------------

export default function MeshScreen(): React.JSX.Element {
  // Subscribe to peers map from Zustand store (reactive updates)
  const peers = useStore((s) => s.peers);
  const peerList = Object.values(peers);

  const renderItem = useCallback(
    ({ item }: { item: PeerInfo }) => <PeerRow peer={item} />,
    []
  );

  const keyExtractor = useCallback((item: PeerInfo) => item.id, []);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Mesh Peers</Text>
        <Text style={styles.headerCount}>
          {peerList.length} {peerList.length === 1 ? 'peer' : 'peers'} in range
        </Text>
      </View>

      {/* Peer list or empty state */}
      {peerList.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📡</Text>
          <Text style={styles.emptyText}>No peers in range</Text>
          <Text style={styles.emptySubtext}>
            Scanning for nearby AeroMesh devices…
          </Text>
        </View>
      ) : (
        <FlatList
          data={peerList}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          accessibilityRole="list"
          accessibilityLabel="Mesh peer list"
        />
      )}
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

  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    marginBottom: 16,
  },
  headerTitle: {
    color: '#f1f5f9',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 2,
  },
  headerCount: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '500',
  },

  // ── List ───────────────────────────────────────────────────────────────────
  listContent: {
    gap: 10,
  },

  // ── Peer row ───────────────────────────────────────────────────────────────
  peerRow: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  peerInfo: {
    flex: 1,
    gap: 4,
  },
  peerId: {
    color: '#f1f5f9',
    fontSize: 16,
    fontWeight: '600',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  peerLastSeen: {
    color: '#64748b',
    fontSize: 12,
  },
  peerSignal: {
    alignItems: 'flex-end',
    gap: 6,
  },
  peerRssi: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '500',
  },

  // ── Signal bars ────────────────────────────────────────────────────────────
  signalBarsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 20,
  },
  signalBar: {
    width: 5,
    borderRadius: 2,
  },
  signalBarFilled: {
    backgroundColor: '#22c55e',
  },
  signalBarEmpty: {
    backgroundColor: '#334155',
  },

  // ── Empty state ────────────────────────────────────────────────────────────
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyText: {
    color: '#f1f5f9',
    fontSize: 18,
    fontWeight: '600',
  },
  emptySubtext: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
  },
});
