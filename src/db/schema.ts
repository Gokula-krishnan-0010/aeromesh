// src/db/schema.ts
// Drizzle ORM schema definitions for AeroMesh SQLite database
// Requirements: 11.1, 11.2, 11.3

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Model 1: pressureReadings
// Stores rolling 3-hour window of barometric sensor data
// Index: idx_pressure_ts on ts column (Requirement 11.7)
export const pressureReadings = sqliteTable('pressure_readings', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  pressure: real('pressure').notNull(),   // hPa, range [800, 1100]
  lat:      real('lat').notNull(),        // [-90, 90]
  lng:      real('lng').notNull(),        // [-180, 180]
  altitude: real('altitude'),             // meters, nullable
  ts:       integer('ts').notNull(),      // Unix milliseconds
})

// Model 2: sosQueue (extended schema)
// Stores all SOS events pending BLE relay or SMS upload
// Index: idx_sos_uploaded on uploaded column (Requirement 11.8)
export const sosQueue = sqliteTable('sos_queue', {
  msgId:    text('msg_id').primaryKey(),                        // 8-char hex, globally unique
  type:     text('type').notNull(),                             // 'AUTO' | 'MANUAL'
  origin:   text('origin').notNull().default('SELF'),           // 'SELF' | 'RELAY'
  lat:      real('lat').notNull(),
  lng:      real('lng').notNull(),
  pressure: real('pressure'),                                   // nullable for relayed messages
  ts:       integer('ts').notNull(),                            // Unix ms (originator's timestamp)
  ttl:      integer('ttl').default(6),                          // decremented on each relay hop
  uploaded: integer('uploaded').default(0),                     // 0=pending, 1=sent via SMS
  ackFrom:  text('ack_from'),                                   // BLE device ID that sent ACK
  ackTs:    integer('ack_ts'),                                  // Unix ms when ACK received
})

// Model 3: peers
// Tracks currently visible BLE mesh peers
// Rows with lastSeen older than 30 seconds are pruned by pruneStakePeers()
export const peers = sqliteTable('peers', {
  id:       text('id').primaryKey(),          // BLE device ID (MAC or UUID)
  rssi:     integer('rssi'),                  // dBm, typically [-100, 0]
  lastSeen: integer('last_seen').notNull(),   // Unix ms
  hasSOS:   integer('has_sos').default(0),    // 1 if peer has unrelayed SOS
  lat:      real('lat'),                      // peer's last known location (from HB_CHAR)
  lng:      real('lng'),
})
