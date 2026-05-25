/**
 * Tests for MeshPayload encoder/decoder (src/lib/payload.ts)
 *
 * Covers Requirements 7.1 – 7.9:
 *   7.1  encode() produces exactly 18 bytes
 *   7.2  decode() populates all six fields
 *   7.3  decode() throws RangeError when buf.length < 18
 *   7.4  round-trip: msgId, type, ttl are identical
 *   7.5  round-trip: lat/lng within float32 precision (~0.00002°)
 *   7.6  round-trip: ts within 1000 ms (second-level truncation)
 *   7.7  decode() zero-pads msgId to 8 hex chars
 *   7.8  decode() converts ts from seconds back to milliseconds
 *   7.9  decode() throws RangeError when type byte is not 0 or 1
 */

import { encode, decode, MeshPayload } from './payload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum absolute error introduced by float32 encoding (~1.7 m at equator). */
const FLOAT32_PRECISION = 0.00002;

/** A representative valid payload used across multiple tests. */
const SAMPLE: MeshPayload = {
  msgId: 'a1b2c3d4',
  type: 'AUTO',
  lat: 12.34567,
  lng: 77.12345,
  ts: 1_700_000_000_000, // 2023-11-14 in ms
  ttl: 6,
};

// ---------------------------------------------------------------------------
// Requirement 7.1 — encode() produces exactly 18 bytes
// ---------------------------------------------------------------------------

describe('encode()', () => {
  test('Req 7.1 — produces exactly 18 bytes for AUTO payload', () => {
    expect(encode(SAMPLE).length).toBe(18);
  });

  test('Req 7.1 — produces exactly 18 bytes for MANUAL payload', () => {
    const p: MeshPayload = { ...SAMPLE, type: 'MANUAL' };
    expect(encode(p).length).toBe(18);
  });

  test('Req 7.1 — produces exactly 18 bytes for edge-case coordinates', () => {
    const p: MeshPayload = { ...SAMPLE, lat: -90, lng: -180 };
    expect(encode(p).length).toBe(18);
  });

  test('Req 7.1 — produces exactly 18 bytes for zero-value msgId', () => {
    const p: MeshPayload = { ...SAMPLE, msgId: '00000000' };
    expect(encode(p).length).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.2 — decode() populates all six fields
// ---------------------------------------------------------------------------

describe('decode()', () => {
  test('Req 7.2 — returns an object with all six fields populated', () => {
    const result = decode(encode(SAMPLE));
    expect(result).toHaveProperty('msgId');
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('lat');
    expect(result).toHaveProperty('lng');
    expect(result).toHaveProperty('ts');
    expect(result).toHaveProperty('ttl');
  });

  test('Req 7.2 — type field is "AUTO" or "MANUAL" (not a raw number)', () => {
    const auto   = decode(encode({ ...SAMPLE, type: 'AUTO' }));
    const manual = decode(encode({ ...SAMPLE, type: 'MANUAL' }));
    expect(auto.type).toBe('AUTO');
    expect(manual.type).toBe('MANUAL');
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.3 — decode() throws RangeError when buf.length < 18
// ---------------------------------------------------------------------------

describe('decode() — buffer length validation (Req 7.3)', () => {
  test('throws RangeError for empty buffer', () => {
    expect(() => decode(Buffer.alloc(0))).toThrow(RangeError);
  });

  test('throws RangeError for 17-byte buffer', () => {
    expect(() => decode(Buffer.alloc(17))).toThrow(RangeError);
  });

  test('throws RangeError for 1-byte buffer', () => {
    expect(() => decode(Buffer.alloc(1))).toThrow(RangeError);
  });

  test('does NOT throw for exactly 18-byte buffer', () => {
    expect(() => decode(Buffer.alloc(18))).not.toThrow();
  });

  test('does NOT throw for buffer longer than 18 bytes', () => {
    const buf = Buffer.alloc(32);
    expect(() => decode(buf)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.4 — round-trip: msgId, type, ttl are identical
// ---------------------------------------------------------------------------

describe('encode/decode round-trip — exact fields (Req 7.4)', () => {
  const cases: Array<Partial<MeshPayload>> = [
    { msgId: 'a1b2c3d4', type: 'AUTO',   ttl: 6  },
    { msgId: 'ffffffff', type: 'MANUAL',  ttl: 15 },
    { msgId: '00000001', type: 'AUTO',   ttl: 0  },
    { msgId: 'deadbeef', type: 'MANUAL',  ttl: 1  },
  ];

  test.each(cases)(
    'msgId=%s type=%s ttl=%s round-trips exactly',
    ({ msgId, type, ttl }) => {
      const p: MeshPayload = { ...SAMPLE, msgId: msgId!, type: type!, ttl: ttl! };
      const result = decode(encode(p));
      expect(result.msgId).toBe(p.msgId);
      expect(result.type).toBe(p.type);
      expect(result.ttl).toBe(p.ttl);
    }
  );
});

// ---------------------------------------------------------------------------
// Requirement 7.5 — round-trip: lat/lng within float32 precision
// ---------------------------------------------------------------------------

describe('encode/decode round-trip — lat/lng precision (Req 7.5)', () => {
  const coordCases: Array<{ lat: number; lng: number }> = [
    { lat:  12.34567,  lng:  77.12345  },
    { lat: -33.86785,  lng: 151.20732  }, // Sydney
    { lat:  51.50735,  lng:  -0.12776  }, // London
    { lat:  90,        lng:  180       }, // poles/antimeridian
    { lat: -90,        lng: -180       },
    { lat:   0,        lng:   0        }, // null island
  ];

  test.each(coordCases)(
    'lat=%f lng=%f within ±%f degrees',
    ({ lat, lng }) => {
      const p: MeshPayload = { ...SAMPLE, lat, lng };
      const result = decode(encode(p));
      expect(Math.abs(result.lat - lat)).toBeLessThanOrEqual(FLOAT32_PRECISION);
      expect(Math.abs(result.lng - lng)).toBeLessThanOrEqual(FLOAT32_PRECISION);
    }
  );
});

// ---------------------------------------------------------------------------
// Requirement 7.6 — round-trip: ts within 1000 ms
// ---------------------------------------------------------------------------

describe('encode/decode round-trip — ts precision (Req 7.6)', () => {
  test('ts is within 1000 ms of original (second truncation)', () => {
    const result = decode(encode(SAMPLE));
    expect(Math.abs(result.ts - SAMPLE.ts)).toBeLessThan(1000);
  });

  test('ts with exact second boundary round-trips to identical value', () => {
    const p: MeshPayload = { ...SAMPLE, ts: 1_700_000_000_000 }; // exact second
    const result = decode(encode(p));
    expect(result.ts).toBe(p.ts);
  });

  test('ts with sub-second component is truncated (not rounded)', () => {
    const p: MeshPayload = { ...SAMPLE, ts: 1_700_000_000_999 }; // 999 ms sub-second
    const result = decode(encode(p));
    // Should truncate to 1_700_000_000_000, not round up to 1_700_000_001_000
    expect(result.ts).toBe(1_700_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.7 — decode() zero-pads msgId to 8 hex chars
// ---------------------------------------------------------------------------

describe('decode() — msgId zero-padding (Req 7.7)', () => {
  test('msgId with leading zeros is zero-padded to 8 chars', () => {
    // msgId "00000001" → integer 1 → decoded back to "00000001"
    const p: MeshPayload = { ...SAMPLE, msgId: '00000001' };
    const result = decode(encode(p));
    expect(result.msgId).toBe('00000001');
    expect(result.msgId.length).toBe(8);
  });

  test('msgId "00000000" round-trips to "00000000"', () => {
    const p: MeshPayload = { ...SAMPLE, msgId: '00000000' };
    const result = decode(encode(p));
    expect(result.msgId).toBe('00000000');
  });

  test('decoded msgId is always exactly 8 characters', () => {
    const ids = ['00000001', '0000ffff', 'a1b2c3d4', 'ffffffff'];
    for (const msgId of ids) {
      const result = decode(encode({ ...SAMPLE, msgId }));
      expect(result.msgId.length).toBe(8);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.8 — decode() converts ts from seconds to milliseconds
// ---------------------------------------------------------------------------

describe('decode() — ts unit conversion (Req 7.8)', () => {
  test('decoded ts is in milliseconds (divisible by 1000)', () => {
    const result = decode(encode(SAMPLE));
    expect(result.ts % 1000).toBe(0);
  });

  test('decoded ts equals stored seconds × 1000', () => {
    const tsSec = 1_700_000_000;
    const p: MeshPayload = { ...SAMPLE, ts: tsSec * 1000 };
    const result = decode(encode(p));
    expect(result.ts).toBe(tsSec * 1000);
  });
});

// ---------------------------------------------------------------------------
// Requirement 7.9 — decode() throws RangeError for invalid type byte
// ---------------------------------------------------------------------------

describe('decode() — invalid type byte (Req 7.9)', () => {
  function bufWithTypeByte(typeByte: number): Buffer {
    const buf = encode(SAMPLE);
    buf.writeUInt8(typeByte, 4);
    return buf;
  }

  test('throws RangeError for type byte = 2', () => {
    expect(() => decode(bufWithTypeByte(2))).toThrow(RangeError);
  });

  test('throws RangeError for type byte = 255', () => {
    expect(() => decode(bufWithTypeByte(255))).toThrow(RangeError);
  });

  test('throws RangeError for type byte = 128', () => {
    expect(() => decode(bufWithTypeByte(128))).toThrow(RangeError);
  });

  test('does NOT throw for type byte = 0 (AUTO)', () => {
    expect(() => decode(bufWithTypeByte(0))).not.toThrow();
  });

  test('does NOT throw for type byte = 1 (MANUAL)', () => {
    expect(() => decode(bufWithTypeByte(1))).not.toThrow();
  });
});
