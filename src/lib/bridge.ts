/**
 * GatewayBridge — SMS upload loop for queued SOS events.
 *
 * Responsibilities:
 *  - Poll every 30 seconds via setInterval.
 *  - Check network connectivity with NetInfo; set MMKV `gateway_active` accordingly.
 *  - Query up to 15 pending SOS records (uploaded=0) from sos_queue.
 *  - Encode batch as compact MessagePack + base64.
 *  - Apply payload size guard: if base64 length > 459 chars, reduce batch by 1 and re-encode.
 *  - Send SMS via react-native-sms.
 *  - Mark records uploaded=1 only after confirmed send success.
 *  - On failure, retain records with uploaded=0 for next poll cycle.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12,
 *               10.4, 10.6, 10.7, 14.3
 */

import NetInfo from '@react-native-community/netinfo';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import SendSMS, { AndroidSuccessTypes } from 'react-native-sms';
import { eq, and, asc } from 'drizzle-orm';

import { storage, STORAGE_KEYS } from './storage';
import { getDB } from '../db/index';
import { sosQueue } from '../db/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of SOS records per SMS batch (Req 6.3, 6.10). */
const MAX_BATCH_SIZE = 15;

/**
 * Maximum base64-encoded payload length in characters.
 * Derived from multi-part SMS capacity (3 × 153 chars = 459 chars) (Req 6.10).
 */
const MAX_SMS_CHARS = 459;

/** Gateway poll interval in milliseconds (Req 6.8). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Rescuer phone number to send SMS to.
 * In production this should come from a configuration store or user settings.
 */
const RESCUER_NUMBER = process.env['RESCUER_NUMBER'] ?? '+10000000000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadResult {
  sent: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Rounds a number to the given number of decimal places.
 */
function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Converts a MessagePack-encoded Uint8Array to a base64 string.
 * Uses the built-in Buffer (available in React Native's Hermes/JSC runtime).
 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Compact record type (Req 6.9)
// ---------------------------------------------------------------------------

interface CompactRecord {
  i: string;       // msgId
  t: 0 | 1;        // type: 0=AUTO, 1=MANUAL
  la: number;      // lat rounded to 5dp
  ln: number;      // lng rounded to 5dp
  p: number | null; // pressure rounded to 1dp, or null
  ts: number;      // Unix seconds (integer)
}

/**
 * Converts a raw sos_queue row into the compact wire format (Req 6.9).
 */
function toCompact(row: {
  msgId: string;
  type: string;
  lat: number;
  lng: number;
  pressure: number | null;
  ts: number;
}): CompactRecord {
  return {
    i:  row.msgId,
    t:  row.type === 'AUTO' ? 0 : 1,
    la: round(row.lat, 5),
    ln: round(row.lng, 5),
    p:  row.pressure != null ? round(row.pressure, 1) : null,
    ts: Math.floor(row.ts / 1000),
  };
}

/**
 * Encodes a batch of compact records to base64 via MessagePack.
 * Returns the base64 string.
 */
function encodeBatch(records: CompactRecord[]): string {
  const packed = msgpackEncode(records);
  return toBase64(packed);
}

// ---------------------------------------------------------------------------
// SMS send helper
// ---------------------------------------------------------------------------

/**
 * Sends an SMS with the given body to the rescuer number.
 *
 * Returns a Promise that resolves to `true` on confirmed send success,
 * or `false` on failure or cancellation.
 *
 * Platform behaviour:
 *  - Android: sends silently using SEND_SMS permission; resolves true when
 *    `completed === true` in the callback (Req 6.11).
 *  - iOS: opens the native compose sheet; resolves true only after the user
 *    taps Send (`completed === true`) (Req 6.12).
 */
function sendSMSPayload(body: string): Promise<boolean> {
  return new Promise((resolve) => {
    SendSMS.send(
      {
        body,
        recipients: [RESCUER_NUMBER],
        successTypes: [AndroidSuccessTypes.sent],
      },
      (completed: boolean, _cancelled: boolean, _error: boolean) => {
        // Mark uploaded only when the send is confirmed (Req 6.11, 6.12).
        resolve(completed === true);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// checkAndUpload — main upload loop
// ---------------------------------------------------------------------------

/**
 * Checks connectivity and uploads all pending SOS records via SMS.
 *
 * Algorithm (Design Doc Algorithm 4):
 *  1. Fetch network state; set MMKV `gateway_active` accordingly (Req 6.1, 6.2, 6.3).
 *  2. If offline, return immediately without touching any records (Req 6.2).
 *  3. Query up to MAX_BATCH_SIZE pending records (Req 6.3).
 *  4. Build compact representation and encode (Req 6.4, 6.9).
 *  5. Apply size guard: reduce batch by 1 until base64 ≤ MAX_SMS_CHARS (Req 6.10).
 *  6. Send SMS (Req 6.5).
 *  7. On success: mark all records in batch as uploaded=1 (Req 6.6, 6.11, 6.12).
 *  8. On failure: leave records with uploaded=0; stop and let next poll retry (Req 6.7, 14.3).
 *
 * @returns UploadResult with counts of sent and failed records.
 */
export async function checkAndUpload(): Promise<UploadResult> {
  // -------------------------------------------------------------------------
  // Step 1: Check connectivity (Req 6.1)
  // -------------------------------------------------------------------------
  const netState = await NetInfo.fetch();

  if (!netState.isConnected) {
    // No connectivity — set gateway_active='0' and return (Req 6.2)
    storage.set(STORAGE_KEYS.GATEWAY_ACTIVE, '0');
    return { sent: 0, failed: 0 };
  }

  // Connected — set gateway_active='1' (Req 6.3)
  storage.set(STORAGE_KEYS.GATEWAY_ACTIVE, '1');

  const db = getDB();
  let totalSent = 0;
  let totalFailed = 0;

  // -------------------------------------------------------------------------
  // Step 2: Process pending records in batches (Req 6.3)
  // -------------------------------------------------------------------------
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Query up to MAX_BATCH_SIZE pending records ordered by ts ASC (oldest first)
    const pending = await db
      .select()
      .from(sosQueue)
      .where(and(eq(sosQueue.uploaded, 0)))
      .orderBy(asc(sosQueue.ts))
      .limit(MAX_BATCH_SIZE);

    if (pending.length === 0) {
      // No more pending records — done
      break;
    }

    // -----------------------------------------------------------------------
    // Step 3: Build compact records and apply size guard (Req 6.9, 6.10)
    // -----------------------------------------------------------------------
    let batchSize = pending.length;
    let b64: string;

    // Size guard loop: reduce batch until payload fits within MAX_SMS_CHARS
    while (true) {
      const slice = pending.slice(0, batchSize);
      const compact: CompactRecord[] = slice.map(toCompact);
      b64 = encodeBatch(compact);

      if (b64.length <= MAX_SMS_CHARS || batchSize <= 1) {
        // Fits within limit, or we're down to 1 record (can't reduce further)
        break;
      }

      batchSize -= 1;
    }

    const batch = pending.slice(0, batchSize);

    console.log(
      `[GATEWAY] Sending batch: ${batch.length} records, ${b64!.length} chars`
    );

    // -----------------------------------------------------------------------
    // Step 4: Send SMS (Req 6.5)
    // -----------------------------------------------------------------------
    let success: boolean;
    try {
      success = await sendSMSPayload(b64!);
    } catch (err) {
      console.warn('[GATEWAY] SMS send threw an error:', err);
      success = false;
    }

    if (success) {
      // -------------------------------------------------------------------
      // Step 5: Mark records as uploaded=1 (Req 6.6, 6.11, 6.12)
      // -------------------------------------------------------------------
      for (const record of batch) {
        await db
          .update(sosQueue)
          .set({ uploaded: 1 })
          .where(eq(sosQueue.msgId, record.msgId));
      }
      totalSent += batch.length;

      console.log(`[GATEWAY] Marked ${batch.length} records as uploaded.`);
    } else {
      // -------------------------------------------------------------------
      // Step 6: On failure, retain records and stop (Req 6.7, 14.3)
      // -------------------------------------------------------------------
      totalFailed += batch.length;
      console.warn(
        `[GATEWAY] SMS send failed. Retaining ${batch.length} records for next poll.`
      );
      break;
    }
  }

  return { sent: totalSent, failed: totalFailed };
}

// ---------------------------------------------------------------------------
// Poller — 30-second interval (Req 6.8)
// ---------------------------------------------------------------------------

let _pollerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the 30-second gateway poller.
 *
 * Idempotent: calling this when the poller is already running has no effect.
 * The poller calls `checkAndUpload()` immediately on start, then every 30 s.
 *
 * Requirements: 6.8, 10.6
 */
export function startGatewayPoller(): void {
  if (_pollerHandle !== null) {
    // Already running — no-op
    return;
  }

  // Run immediately on start, then on each interval tick
  void checkAndUpload();

  _pollerHandle = setInterval(() => {
    void checkAndUpload();
  }, POLL_INTERVAL_MS);

  console.log('[GATEWAY] Poller started (30s interval).');
}

/**
 * Stops the 30-second gateway poller.
 *
 * Safe to call even if the poller is not running.
 */
export function stopGatewayPoller(): void {
  if (_pollerHandle !== null) {
    clearInterval(_pollerHandle);
    _pollerHandle = null;
    console.log('[GATEWAY] Poller stopped.');
  }
}
