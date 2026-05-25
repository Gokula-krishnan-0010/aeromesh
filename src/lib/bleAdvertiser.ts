/**
 * BLE Advertiser — peripheral mode advertising for AeroMesh.
 *
 * Native BLE peripheral advertising (BluetoothLeAdvertiser on Android,
 * CBPeripheralManager on iOS) requires custom native modules that are not
 * yet implemented. This module provides:
 *
 *  1. A clean JS interface (`startAdvertising` / `stopAdvertising`) that will
 *     delegate to native modules once they are available.
 *  2. A hackathon fallback: the current SOS payload is stored in memory so
 *     that when a scanning peer connects and reads SOS_CHAR via `connectAndSync`,
 *     the payload is available to serve. See `currentSosPayload` export.
 *  3. `broadcastPendingSOS()`: queries `sos_queue` for the most recent
 *     unuploaded SELF-origin row and calls `startAdvertising`.
 *  4. `startBroadcastPoller()` / `stopBroadcastPoller()`: manage a 30-second
 *     interval that calls `broadcastPendingSOS()` repeatedly.
 *
 * Requirements: 5.4, 3.1
 */

import { encode, MeshPayload } from './payload';
import { getDB } from '../db/index';
import { sosQueue } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AeroMesh service UUID — matches the value used in ble.ts. */
const AEROMESH_SERVICE = '4a6f2c9e-1b3d-4f7a-8e2b-5c9d1f4a3b6e';

/** Broadcast poll interval: 30 seconds (Requirement 5.4). */
const BROADCAST_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Whether advertising is currently active. */
let _advertising = false;

/** Interval handle returned by setInterval for the broadcast poller. */
let _pollerHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public: currentSosPayload
// ---------------------------------------------------------------------------

/**
 * The most recently advertised SOS payload, held in memory so that scanning
 * peers can read it via SOS_CHAR when they connect (hackathon fallback).
 *
 * `ble.ts` reads this value when serving SOS_CHAR characteristic reads.
 */
export let currentSosPayload: MeshPayload | null = null;

// ---------------------------------------------------------------------------
// startAdvertising
// ---------------------------------------------------------------------------

/**
 * Starts BLE peripheral advertising with the given SOS payload.
 *
 * Production path (not yet implemented):
 *  - Android: delegate to `BluetoothLeAdvertiser` native module, advertising
 *    `AEROMESH_SERVICE` UUID with the 18-byte encoded payload in manufacturer
 *    data. See `plugins/withAeroMeshBLEPeripheral.js` for implementation notes.
 *  - iOS: delegate to `CBPeripheralManager` Swift native module, advertising
 *    with `CBAdvertisementDataServiceUUIDsKey` set to `AEROMESH_SERVICE`.
 *
 * Hackathon fallback (current behaviour):
 *  - Stores the payload in `currentSosPayload` so that `ble.ts` can serve it
 *    when a peer connects and reads SOS_CHAR.
 *  - Sets `_advertising = true`.
 *
 * @param payload - The MeshPayload to advertise.
 */
export async function startAdvertising(payload: MeshPayload): Promise<void> {
  // Encode to verify the payload is valid (throws on bad input)
  const encoded: Buffer = encode(payload);

  // TODO: Replace this block with a native module call once the native
  // BluetoothLeAdvertiser (Android) / CBPeripheralManager (iOS) modules are
  // implemented. Example:
  //
  //   import { NativeModules } from 'react-native';
  //   const { AeroMeshBLEPeripheral } = NativeModules;
  //   if (AeroMeshBLEPeripheral) {
  //     await AeroMeshBLEPeripheral.startAdvertising(
  //       AEROMESH_SERVICE,
  //       encoded.toString('base64')
  //     );
  //     _advertising = true;
  //     currentSosPayload = payload;
  //     return;
  //   }

  // Hackathon fallback: store payload in memory for SOS_CHAR reads
  console.log(
    `[BLEAdvertiser] Native advertising unavailable — storing payload in memory ` +
    `(msgId=${payload.msgId}, ttl=${payload.ttl}, encoded=${encoded.length} bytes, ` +
    `serviceUUID=${AEROMESH_SERVICE})`
  );

  currentSosPayload = payload;
  _advertising = true;
}

// ---------------------------------------------------------------------------
// stopAdvertising
// ---------------------------------------------------------------------------

/**
 * Stops BLE peripheral advertising and clears the in-memory payload.
 *
 * Production path (not yet implemented):
 *  - Calls the native module to stop advertising.
 *
 * Hackathon fallback:
 *  - Clears `currentSosPayload` and sets `_advertising = false`.
 */
export async function stopAdvertising(): Promise<void> {
  // TODO: Replace with native module call once implemented.
  // Example:
  //   const { AeroMeshBLEPeripheral } = NativeModules;
  //   if (AeroMeshBLEPeripheral) {
  //     await AeroMeshBLEPeripheral.stopAdvertising();
  //   }

  console.log('[BLEAdvertiser] Stopping advertising');
  currentSosPayload = null;
  _advertising = false;
}

// ---------------------------------------------------------------------------
// broadcastPendingSOS
// ---------------------------------------------------------------------------

/**
 * Queries `sos_queue` for the most recent unuploaded SELF-origin row,
 * encodes it as a MeshPayload, and calls `startAdvertising`.
 *
 * If no pending SELF-origin SOS exists, stops advertising (clears payload).
 *
 * Requirements: 5.4, 3.1
 */
export async function broadcastPendingSOS(): Promise<void> {
  let db;
  try {
    db = getDB();
  } catch (err) {
    // DB not yet initialized — skip silently
    console.warn('[BLEAdvertiser] broadcastPendingSOS: DB not ready, skipping');
    return;
  }

  try {
    // Query the most recent unuploaded SELF-origin SOS row
    const rows = await db
      .select()
      .from(sosQueue)
      .where(
        and(
          eq(sosQueue.uploaded, 0),
          eq(sosQueue.origin, 'SELF')
        )
      )
      .orderBy(desc(sosQueue.ts))
      .limit(1);

    if (rows.length === 0) {
      // No pending SOS — stop advertising if currently active
      if (_advertising) {
        console.log('[BLEAdvertiser] No pending SELF SOS — stopping advertising');
        await stopAdvertising();
      }
      return;
    }

    const row = rows[0];

    // Build MeshPayload from the DB row
    const payload: MeshPayload = {
      msgId: row.msgId,
      type:  row.type as 'AUTO' | 'MANUAL',
      lat:   row.lat,
      lng:   row.lng,
      ts:    row.ts,
      ttl:   row.ttl ?? 6,
    };

    console.log(
      `[BLEAdvertiser] Broadcasting pending SOS: msgId=${payload.msgId} ` +
      `type=${payload.type} ttl=${payload.ttl}`
    );

    await startAdvertising(payload);
  } catch (err) {
    console.warn('[BLEAdvertiser] broadcastPendingSOS error:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// startBroadcastPoller
// ---------------------------------------------------------------------------

/**
 * Starts a 30-second interval that calls `broadcastPendingSOS()` repeatedly.
 * Also calls `broadcastPendingSOS()` immediately on start.
 *
 * Safe to call multiple times — a second call is a no-op if the poller is
 * already running.
 *
 * Requirement: 5.4
 */
export function startBroadcastPoller(): void {
  if (_pollerHandle !== null) {
    console.log('[BLEAdvertiser] Broadcast poller already running — skipping');
    return;
  }

  console.log('[BLEAdvertiser] Starting broadcast poller (interval=30s)');

  // Broadcast immediately on start
  broadcastPendingSOS().catch((err) =>
    console.warn('[BLEAdvertiser] Initial broadcastPendingSOS error:', err)
  );

  // Then every 30 seconds
  _pollerHandle = setInterval(() => {
    broadcastPendingSOS().catch((err) =>
      console.warn('[BLEAdvertiser] Poller broadcastPendingSOS error:', err)
    );
  }, BROADCAST_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// stopBroadcastPoller
// ---------------------------------------------------------------------------

/**
 * Clears the 30-second broadcast interval and stops advertising.
 */
export function stopBroadcastPoller(): void {
  if (_pollerHandle !== null) {
    clearInterval(_pollerHandle);
    _pollerHandle = null;
    console.log('[BLEAdvertiser] Broadcast poller stopped');
  }
  stopAdvertising().catch((err) =>
    console.warn('[BLEAdvertiser] stopAdvertising error during poller stop:', err)
  );
}

// ---------------------------------------------------------------------------
// isAdvertising (utility)
// ---------------------------------------------------------------------------

/**
 * Returns whether advertising is currently active.
 * Useful for diagnostics and UI status display.
 */
export function isAdvertising(): boolean {
  return _advertising;
}
