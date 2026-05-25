/**
 * SOSHistoryScreen — displays the full SOS event history from the local
 * SQLite database.
 *
 * Each row shows:
 *  - Type badge: AUTO (blue #3b82f6) | MANUAL (purple #8b5cf6)
 *  - Origin badge: SELF (teal #14b8a6) | RELAY (orange #f97316)
 *  - Coordinates: lat, lng to 4 decimal places
 *  - Relative timestamp (Xs ago / Xm ago / Xh ago / Xd ago)
 *  - ACK status: ✓ green if ackFrom is set, ⏳ gray if pending
 *  - Upload status: ✓ green if uploaded=1, ⏳ gray if pending
 *
 * Queries sos_queue on mount and whenever the app returns to the foreground.
 * Handles the case where getDB() throws (DB not yet initialized) by showing
 * an empty state.
 *
 * Requirement: 12.7
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  AppStateStatus,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { desc } from 'drizzle-orm';

import { getDB } from '../db/index';
import { sosQueue } from '../db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row from the sos_queue table. */
interface SOSEvent {
  msgId: string;
  type: string;       // 'AUTO' | 'MANUAL'
  origin: string;     // 'SELF' | 'RELAY'
  lat: number;
  lng: number;
  ts: number;         // Unix ms
  uploaded: number | null;  // 0 | 1
  ackFrom: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable relative time string for a Unix ms timestamp.
 * Format: "Xs ago", "Xm ago", "Xh ago", "Xd ago".
 */
function relativeTime(tsMs: number): string {
  const diffMs = Date.now() - tsMs;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// SOSRow sub-component
// ---------------------------------------------------------------------------

interface SOSRowProps {
  item: SOSEvent;
}

function SOSRow({ item }: SOSRowProps): React.JSX.Element {
  const isAcked    = item.ackFrom !== null && item.ackFrom !== undefined;
  const isUploaded = item.uploaded === 1;

  const typeBadgeColor   = item.type === 'AUTO' ? '#3b82f6' : '#8b5cf6';
  const originBadgeColor = item.origin === 'SELF' ? '#14b8a6' : '#f97316';

  const latStr = item.lat.toFixed(4);
  const lngStr = item.lng.toFixed(4);
  const timeStr = relativeTime(item.ts);

  return (
    <View
      style={styles.row}
      accessibilityRole="none"
      accessibilityLabel={
        `SOS event: ${item.type} from ${item.origin}, ` +
        `coordinates ${latStr}, ${lngStr}, ${timeStr}, ` +
        `ACK ${isAcked ? 'received' : 'pending'}, ` +
        `upload ${isUploaded ? 'complete' : 'pending'}`
      }
    >
      {/* ── Top row: badges + status icons ── */}
      <View style={styles.rowTop}>
        {/* Type badge */}
        <View style={[styles.badge, { backgroundColor: typeBadgeColor }]}>
          <Text style={styles.badgeText}>{item.type}</Text>
        </View>

        {/* Origin badge */}
        <View style={[styles.badge, { backgroundColor: originBadgeColor }]}>
          <Text style={styles.badgeText}>{item.origin}</Text>
        </View>

        {/* Spacer */}
        <View style={styles.badgeSpacer} />

        {/* ACK status */}
        <View style={styles.statusIcon}>
          <Text
            style={[
              styles.statusIconText,
              { color: isAcked ? '#22c55e' : '#64748b' },
            ]}
            accessibilityLabel={isAcked ? 'ACK received' : 'ACK pending'}
          >
            {isAcked ? '✓' : '⏳'}
          </Text>
          <Text style={styles.statusLabel}>ACK</Text>
        </View>

        {/* Upload status */}
        <View style={styles.statusIcon}>
          <Text
            style={[
              styles.statusIconText,
              { color: isUploaded ? '#22c55e' : '#64748b' },
            ]}
            accessibilityLabel={isUploaded ? 'Uploaded' : 'Upload pending'}
          >
            {isUploaded ? '✓' : '⏳'}
          </Text>
          <Text style={styles.statusLabel}>SMS</Text>
        </View>
      </View>

      {/* ── Bottom row: coordinates + timestamp ── */}
      <View style={styles.rowBottom}>
        <Text style={styles.coords}>
          {latStr}, {lngStr}
        </Text>
        <Text style={styles.timestamp}>{timeStr}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SOSHistoryScreen component
// ---------------------------------------------------------------------------

export default function SOSHistoryScreen(): React.JSX.Element {
  const [events, setEvents] = useState<SOSEvent[]>([]);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    try {
      const db = getDB();
      const rows = await db
        .select({
          msgId:    sosQueue.msgId,
          type:     sosQueue.type,
          origin:   sosQueue.origin,
          lat:      sosQueue.lat,
          lng:      sosQueue.lng,
          ts:       sosQueue.ts,
          uploaded: sosQueue.uploaded,
          ackFrom:  sosQueue.ackFrom,
        })
        .from(sosQueue)
        .orderBy(desc(sosQueue.ts));

      setEvents(rows as SOSEvent[]);
    } catch (err) {
      // DB not initialized yet or other error — show empty state
      console.warn('[SOSHistoryScreen] Could not query sos_queue:', err);
      setEvents([]);
    }
  }, []);

  // ── Mount: initial fetch ───────────────────────────────────────────────────

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // ── AppState listener: refresh on foreground (Req 12.7) ───────────────────

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        if (
          appStateRef.current !== 'active' &&
          nextState === 'active'
        ) {
          fetchEvents();
        }
        appStateRef.current = nextState;
      }
    );

    return () => {
      subscription.remove();
    };
  }, [fetchEvents]);

  // ── Render helpers ─────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item }: { item: SOSEvent }) => <SOSRow item={item} />,
    []
  );

  const keyExtractor = useCallback((item: SOSEvent) => item.msgId, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>SOS History</Text>
        <Text style={styles.headerCount}>
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </Text>
      </View>

      {/* Event list or empty state */}
      {events.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyText}>No SOS events recorded</Text>
          <Text style={styles.emptySubtext}>
            SOS events will appear here once triggered or relayed.
          </Text>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          accessibilityRole="list"
          accessibilityLabel="SOS event history list"
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

  // ── Event row ──────────────────────────────────────────────────────────────
  row: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  // ── Badges ─────────────────────────────────────────────────────────────────
  badge: {
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  badgeSpacer: {
    flex: 1,
  },

  // ── Status icons ───────────────────────────────────────────────────────────
  statusIcon: {
    alignItems: 'center',
    gap: 1,
  },
  statusIconText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
  },
  statusLabel: {
    color: '#475569',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  // ── Coordinates + timestamp ────────────────────────────────────────────────
  coords: {
    color: '#cbd5e1',
    fontSize: 13,
    fontFamily: 'monospace',
    letterSpacing: 0.3,
  },
  timestamp: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '500',
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
    paddingHorizontal: 32,
  },
});
