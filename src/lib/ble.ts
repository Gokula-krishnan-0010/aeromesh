/**
 * BLE Mesh Layer — central scanning, peer discovery, SOS relay, and ACK.
 *
 * Responsibilities:
 *  - Scan for AeroMesh peers advertising AEROMESH_SERVICE UUID
 *  - Upsert discovered peers into the `peers` SQLite table
 *  - Prune stale peers (lastSeen > 30 s) once per scan cycle
 *  - Auto-restart scanning when Bluetooth transitions to PoweredOn
 *  - GATT connect + read SOS_CHAR → decode → onReceiveSOS
 *  - Deduplicate received SOS messages via MMKV seen_msg_ids
 *  - Persist relay rows with origin='RELAY', ttl-1, onConflictDoNothing
 *  - Send ACK to originating peer via ACK_CHAR
 *  - Rebroadcast if TTL > 1
 *
 * Requirements: 3.1–3.8, 4.1–4.10, 14.4
 */

import { BleManager, Device, State } from 'react-native-ble-plx';
import { eq, lt } from 'drizzle-orm';
import { getDB } from '../db/index';
import { peers, sosQueue } from '../db/schema';
import { decode, MeshPayload } from './payload';
import { getSeenMsgIds, addSeenMsgId } from './storage';

// ---------------------------------------------------------------------------
// UUIDs (from design doc — Component 5: BLEMeshLayer)
// ---------------------------------------------------------------------------

const AEROMESH_SERVICE = '4a6f2c9e-1b3d-4f7a-8e2b-5c9d1f4a3b6e';
const SOS_CHAR         = '4a6f2c9e-0001-4f7a-8e2b-5c9d1f4a3b6e';
const ACK_CHAR         = '4a6f2c9e-0002-4f7a-8e2b-5c9d1f4a3b6e';

// Stale peer threshold: 30 seconds in milliseconds (Requirement 3.3)
const PEER_STALE_MS = 30_000;

// GATT connection timeout: 5 seconds (Requirement 3.7)
const GATT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Singleton BleManager instance
// ---------------------------------------------------------------------------

export const bleManager = new BleManager();

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Whether a scan is currently active. */
let _scanning = false;

// ---------------------------------------------------------------------------
// startScanning
// ---------------------------------------------------------------------------

/**
 * Starts BLE scanning filtered to the AeroMesh service UUID.
 *
 * On each device discovery:
 *  1. Upserts the peer into the `peers` table (Requirement 3.2)
 *  2. Prunes stale peers older than 30 s (Requirement 3.3)
 *  3. Attempts GATT connect + SOS_CHAR read (Requirement 3.6)
 *
 * If Bluetooth is not PoweredOn, logs a warning and returns without throwing
 * (Requirement 3.4). A state-change listener auto-restarts scanning when
 * Bluetooth transitions to PoweredOn (Requirement 3.5).
 */
export async function startScanning(): Promise<void> {
  // Register state-change listener for auto-restart (Requirement 3.5)
  bleManager.onStateChange((state) => {
    if (state === State.PoweredOn && !_scanning) {
      console.log('[BLE] Bluetooth powered on — restarting scan');
      startScanning().catch((err) =>
        console.warn('[BLE] Auto-restart scan failed:', err)
      );
    }
  }, true /* emitCurrentState */);

  // Check current Bluetooth state (Requirement 3.4)
  const currentState = await bleManager.state();
  if (currentState !== State.PoweredOn) {
    console.warn(
      `[BLE] startScanning: Bluetooth not powered on (state=${currentState}). Scan deferred.`
    );
    return;
  }

  if (_scanning) {
    console.log('[BLE] Already scanning — skipping duplicate startScanning call');
    return;
  }

  _scanning = true;
  console.log('[BLE] Starting scan for AEROMESH_SERVICE:', AEROMESH_SERVICE);

  bleManager.startDeviceScan(
    [AEROMESH_SERVICE],
    { allowDuplicates: true },
    (error, device) => {
      if (error) {
        console.warn('[BLE] Scan error:', error.message);
        _scanning = false;
        return;
      }
      if (!device) return;

      // Handle discovered device asynchronously; do not block the scan callback
      handleDiscoveredDevice(device).catch((err) =>
        console.warn('[BLE] handleDiscoveredDevice error:', err)
      );
    }
  );
}

// ---------------------------------------------------------------------------
// stopScanning
// ---------------------------------------------------------------------------

/**
 * Stops the active BLE scan.
 */
export function stopScanning(): void {
  if (_scanning) {
    bleManager.stopDeviceScan();
    _scanning = false;
    console.log('[BLE] Scan stopped');
  }
}

// ---------------------------------------------------------------------------
// handleDiscoveredDevice (internal)
// ---------------------------------------------------------------------------

/**
 * Called for each discovered BLE device.
 *  1. Upserts peer row (Requirement 3.2)
 *  2. Prunes stale peers (Requirement 3.3)
 *  3. Attempts GATT connect + SOS read (Requirement 3.6)
 */
async function handleDiscoveredDevice(device: Device): Promise<void> {
  const now = Date.now();
  const db = getDB();

  // 1. Upsert peer — update rssi and lastSeen on conflict (Requirement 3.2)
  await db
    .insert(peers)
    .values({
      id:       device.id,
      rssi:     device.rssi ?? null,
      lastSeen: now,
    })
    .onConflictDoUpdate({
      target: peers.id,
      set: {
        rssi:     device.rssi ?? null,
        lastSeen: now,
      },
    });

  // 2. Prune stale peers once per discovery cycle (Requirement 3.3)
  const staleThreshold = now - PEER_STALE_MS;
  await db.delete(peers).where(lt(peers.lastSeen, staleThreshold));

  // 3. Attempt GATT connect + SOS read (Requirement 3.6)
  await connectAndSync(device);
}

// ---------------------------------------------------------------------------
// connectAndSync
// ---------------------------------------------------------------------------

/**
 * GATT-connects to a peer device, reads the SOS_CHAR characteristic,
 * validates the payload (≥ 18 bytes), decodes it, and passes it to
 * onReceiveSOS. All GATT errors are caught silently (log + continue).
 *
 * Uses a 5-second timeout via Promise.race (Requirement 3.7).
 */
export async function connectAndSync(device: Device): Promise<void> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`GATT timeout after ${GATT_TIMEOUT_MS}ms for device ${device.id}`)),
      GATT_TIMEOUT_MS
    )
  );

  try {
    const connectedDevice = await Promise.race([
      device.connect(),
      timeoutPromise,
    ]);

    // Discover services and characteristics
    const discoveredDevice = await Promise.race([
      connectedDevice.discoverAllServicesAndCharacteristics(),
      timeoutPromise,
    ]);

    // Read SOS_CHAR
    const characteristic = await Promise.race([
      discoveredDevice.readCharacteristicForService(AEROMESH_SERVICE, SOS_CHAR),
      timeoutPromise,
    ]);

    // Disconnect after read (best-effort, ignore errors)
    discoveredDevice.cancelConnection().catch(() => {});

    if (!characteristic.value) {
      console.warn('[BLE] SOS_CHAR returned null value for device:', device.id);
      return;
    }

    // Decode base64 → Buffer
    const rawBuffer = Buffer.from(characteristic.value, 'base64');

    // Validate payload length ≥ 18 bytes (Requirement 4.10)
    if (rawBuffer.length < 18) {
      console.warn(
        `[BLE] Discarding short payload from ${device.id}: ${rawBuffer.length} bytes (expected ≥ 18)`
      );
      return;
    }

    // Decode MeshPayload
    let payload: MeshPayload;
    try {
      payload = decode(rawBuffer);
    } catch (decodeErr) {
      console.warn('[BLE] Failed to decode MeshPayload from', device.id, ':', decodeErr);
      return;
    }

    // Pass to relay handler
    await onReceiveSOS(payload, device.id);
  } catch (err) {
    // Catch all GATT errors silently — log and continue (Requirement 14.4)
    console.warn('[BLE] connectAndSync error for device', device.id, ':', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// onReceiveSOS
// ---------------------------------------------------------------------------

/**
 * Processes a received MeshPayload from a peer device.
 *
 * Flow (Requirements 4.1–4.7):
 *  1. Check MMKV seen_msg_ids for dedup → return if already seen
 *  2. Check TTL ≤ 0 → return without storing or relaying
 *  3. Persist msgId to MMKV BEFORE DB insert (Requirement 4.3, 4.6)
 *  4. Insert relay row with origin='RELAY', ttl-1, onConflictDoNothing
 *  5. Send ACK to originating peer (Requirement 4.4)
 *  6. Rebroadcast if TTL > 1 (Requirement 4.5)
 */
export async function onReceiveSOS(
  payload: MeshPayload,
  fromDeviceId: string
): Promise<void> {
  // 1. Deduplication check (Requirement 4.1)
  const seenIds = getSeenMsgIds();
  if (seenIds.includes(payload.msgId)) {
    console.log('[BLE] Duplicate msgId, discarding:', payload.msgId);
    return;
  }

  // 2. TTL guard (Requirement 4.2)
  if (payload.ttl <= 0) {
    console.log('[BLE] TTL expired, discarding:', payload.msgId);
    return;
  }

  // 3. Persist msgId to MMKV BEFORE DB insert (Requirements 4.3, 4.6)
  addSeenMsgId(payload.msgId);

  console.log(
    `[BLE] Relaying SOS msgId=${payload.msgId} TTL=${payload.ttl} from=${fromDeviceId}`
  );

  const db = getDB();

  // 4. Insert relay row with origin='RELAY', ttl-1, onConflictDoNothing (Requirement 4.3)
  await db
    .insert(sosQueue)
    .values({
      msgId:   payload.msgId,
      type:    payload.type,
      origin:  'RELAY',
      lat:     payload.lat,
      lng:     payload.lng,
      ts:      payload.ts,
      ttl:     payload.ttl - 1,
    })
    .onConflictDoNothing();

  // 5. Send ACK to originating peer (Requirement 4.4)
  await sendAck(fromDeviceId, payload.msgId);

  // 6. Rebroadcast if TTL > 1 (Requirement 4.5)
  if (payload.ttl > 1) {
    console.log(`[BLE] Rebroadcasting msgId=${payload.msgId} with TTL=${payload.ttl - 1}`);
    // Rebroadcast is handled by the advertising layer (bleAdvertiser.ts, Task 11).
    // Here we trigger it by calling the broadcast function if available.
    // This is a best-effort call — if the advertiser is not yet initialized, it is a no-op.
    try {
      // Dynamic import to avoid circular dependency with bleAdvertiser
      const { broadcastPendingSOS } = await import('./bleAdvertiser');
      await broadcastPendingSOS();
    } catch {
      // bleAdvertiser not yet implemented or unavailable — log and continue
      console.log('[BLE] Rebroadcast skipped: bleAdvertiser not available');
    }
  }
}

// ---------------------------------------------------------------------------
// sendAck
// ---------------------------------------------------------------------------

/**
 * Connects to a peer and writes the msgId bytes to ACK_CHAR.
 * On success, updates the sos_queue row with ackFrom and ackTs.
 * All connection errors are caught silently (Requirement 14.4).
 *
 * @param deviceId - BLE device ID of the peer to ACK
 * @param msgId    - 8-char hex message ID to acknowledge
 */
export async function sendAck(deviceId: string, msgId: string): Promise<void> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`ACK GATT timeout after ${GATT_TIMEOUT_MS}ms for device ${deviceId}`)),
      GATT_TIMEOUT_MS
    )
  );

  try {
    const connectedDevice = await Promise.race([
      bleManager.connectToDevice(deviceId),
      timeoutPromise,
    ]);

    const discoveredDevice = await Promise.race([
      connectedDevice.discoverAllServicesAndCharacteristics(),
      timeoutPromise,
    ]);

    // Encode msgId as bytes (UTF-8 → base64 for BLE write)
    const msgIdBytes = Buffer.from(msgId, 'utf8');
    const msgIdBase64 = msgIdBytes.toString('base64');

    await Promise.race([
      discoveredDevice.writeCharacteristicWithResponseForService(
        AEROMESH_SERVICE,
        ACK_CHAR,
        msgIdBase64
      ),
      timeoutPromise,
    ]);

    // Disconnect after write (best-effort)
    discoveredDevice.cancelConnection().catch(() => {});

    // Update sos_queue row with ackFrom and ackTs (Requirement 4.8)
    const db = getDB();
    await db
      .update(sosQueue)
      .set({
        ackFrom: deviceId,
        ackTs:   Date.now(),
      })
      .where(eq(sosQueue.msgId, msgId));

    console.log(`[BLE] ACK sent for msgId=${msgId} to device=${deviceId}`);
  } catch (err) {
    // Catch all connection errors silently (Requirement 14.4)
    console.warn('[BLE] sendAck error for device', deviceId, ':', (err as Error).message);
  }
}
