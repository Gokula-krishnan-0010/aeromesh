/**
 * MeshPayload encoder/decoder — 18-byte binary BLE packet.
 *
 * Binary layout (Model 4 from design doc):
 *   bytes  0–3:  msgId as UInt32BE (8-char hex string parsed as 32-bit integer)
 *   byte   4:    type  (0 = AUTO, 1 = MANUAL)
 *   bytes  5–8:  lat   as FloatBE (32-bit IEEE 754)
 *   bytes  9–12: lng   as FloatBE (32-bit IEEE 754)
 *   bytes 13–16: ts    as UInt32BE (Unix seconds — NOT milliseconds)
 *   byte  17:    ttl   (0–255)
 *
 * Total: 4 + 1 + 4 + 4 + 4 + 1 = 18 bytes
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9
 */

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MeshPayload {
  /** 8-character lowercase hex string (e.g. "a1b2c3d4"). */
  msgId: string;
  /** SOS trigger source. */
  type: 'AUTO' | 'MANUAL';
  /** Latitude in decimal degrees [-90, 90]. */
  lat: number;
  /** Longitude in decimal degrees [-180, 180]. */
  lng: number;
  /** Unix timestamp in **milliseconds**. */
  ts: number;
  /** Time-to-live hop counter [0, 255]. */
  ttl: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAYLOAD_SIZE = 18;

const TYPE_AUTO   = 0;
const TYPE_MANUAL = 1;

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * Encodes a MeshPayload into an 18-byte Buffer for BLE transmission.
 *
 * Preconditions (caller's responsibility):
 *   - payload.msgId is an 8-character lowercase hex string
 *   - payload.lat ∈ [-90, 90]
 *   - payload.lng ∈ [-180, 180]
 *   - payload.ttl ∈ [0, 255]
 *   - payload.ts is a positive Unix millisecond timestamp
 *
 * Postconditions:
 *   - Returns a Buffer of exactly 18 bytes
 *   - ts precision is reduced to seconds (milliseconds truncated)
 *   - lat/lng precision is reduced to float32 (~1.7 m at equator)
 */
export function encode(payload: MeshPayload): Buffer {
  const buf = Buffer.alloc(PAYLOAD_SIZE);

  // bytes 0–3: msgId as UInt32BE
  const msgIdInt = parseInt(payload.msgId, 16);
  buf.writeUInt32BE(msgIdInt, 0);

  // byte 4: type (0=AUTO, 1=MANUAL)
  buf.writeUInt8(payload.type === 'AUTO' ? TYPE_AUTO : TYPE_MANUAL, 4);

  // bytes 5–8: lat as FloatBE
  buf.writeFloatBE(payload.lat, 5);

  // bytes 9–12: lng as FloatBE
  buf.writeFloatBE(payload.lng, 9);

  // bytes 13–16: ts as UInt32BE (Unix seconds, not ms)
  buf.writeUInt32BE(Math.floor(payload.ts / 1000), 13);

  // byte 17: ttl
  buf.writeUInt8(payload.ttl, 17);

  return buf;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Decodes an 18-byte Buffer into a MeshPayload.
 *
 * Preconditions:
 *   - buf.length >= 18
 *   - buf was produced by encode() or is a valid AeroMesh BLE packet
 *
 * Postconditions:
 *   - Returns a MeshPayload with all six fields populated
 *   - msgId is zero-padded to 8 hexadecimal characters
 *   - ts is in milliseconds (stored seconds × 1000)
 *
 * @throws {RangeError} if buf.length < 18
 * @throws {RangeError} if the type byte is neither 0 nor 1
 */
export function decode(buf: Buffer): MeshPayload {
  if (buf.length < PAYLOAD_SIZE) {
    throw new RangeError(
      `MeshPayload buffer too short: expected at least ${PAYLOAD_SIZE} bytes, got ${buf.length}`
    );
  }

  // bytes 0–3: msgId
  const msgIdInt = buf.readUInt32BE(0);
  const msgId = msgIdInt.toString(16).padStart(8, '0');

  // byte 4: type
  const typeByte = buf.readUInt8(4);
  if (typeByte !== TYPE_AUTO && typeByte !== TYPE_MANUAL) {
    throw new RangeError(
      `Invalid MeshPayload type byte: expected 0 (AUTO) or 1 (MANUAL), got ${typeByte}`
    );
  }
  const type: 'AUTO' | 'MANUAL' = typeByte === TYPE_AUTO ? 'AUTO' : 'MANUAL';

  // bytes 5–8: lat
  const lat = buf.readFloatBE(5);

  // bytes 9–12: lng
  const lng = buf.readFloatBE(9);

  // bytes 13–16: ts (seconds → milliseconds)
  const tsSec = buf.readUInt32BE(13);
  const ts = tsSec * 1000;

  // byte 17: ttl
  const ttl = buf.readUInt8(17);

  return { msgId, type, lat, lng, ts, ttl };
}
