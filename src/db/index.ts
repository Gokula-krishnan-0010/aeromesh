// src/db/index.ts
// SQLite database initialization for AeroMesh
// Uses raw SQL CREATE TABLE IF NOT EXISTS for reliability with expo-sqlite
// Requirements: 11.1, 11.2, 11.3, 11.7, 11.8

import * as SQLite from 'expo-sqlite'
import { drizzle } from 'drizzle-orm/expo-sqlite'
import * as schema from './schema'

// Singleton database connection
let _db: ReturnType<typeof drizzle> | null = null

/**
 * Initialize the SQLite database, creating all tables and indexes if they
 * don't already exist. Safe to call multiple times (idempotent).
 *
 * Returns the Drizzle ORM database instance for use throughout the app.
 */
export async function initDB(): Promise<ReturnType<typeof drizzle>> {
  if (_db) {
    return _db
  }

  const sqlite = await SQLite.openDatabaseAsync('aeromesh.db')

  // Create tables and indexes using raw SQL for maximum compatibility
  // with expo-sqlite's WAL mode and background task contexts.
  await sqlite.execAsync(`
    PRAGMA journal_mode = WAL;

    -- Model 1: pressure_readings
    -- Stores rolling 3-hour window of barometric sensor data
    CREATE TABLE IF NOT EXISTS pressure_readings (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      pressure REAL    NOT NULL,
      lat      REAL    NOT NULL,
      lng      REAL    NOT NULL,
      altitude REAL,
      ts       INTEGER NOT NULL
    );

    -- Index for efficient range queries by timestamp (Requirement 11.7)
    CREATE INDEX IF NOT EXISTS idx_pressure_ts ON pressure_readings(ts);

    -- Model 2: sos_queue (extended schema with origin and ACK fields)
    -- Stores all SOS events pending BLE relay or SMS upload
    CREATE TABLE IF NOT EXISTS sos_queue (
      msg_id   TEXT    PRIMARY KEY,
      type     TEXT    NOT NULL,
      origin   TEXT    NOT NULL DEFAULT 'SELF',
      lat      REAL    NOT NULL,
      lng      REAL    NOT NULL,
      pressure REAL,
      ts       INTEGER NOT NULL,
      ttl      INTEGER DEFAULT 6,
      uploaded INTEGER DEFAULT 0,
      ack_from TEXT,
      ack_ts   INTEGER
    );

    -- Index for efficient gateway queries (Requirement 11.8)
    CREATE INDEX IF NOT EXISTS idx_sos_uploaded ON sos_queue(uploaded);

    -- Model 3: peers
    -- Tracks currently visible BLE mesh peers
    CREATE TABLE IF NOT EXISTS peers (
      id        TEXT    PRIMARY KEY,
      rssi      INTEGER,
      last_seen INTEGER NOT NULL,
      has_sos   INTEGER DEFAULT 0,
      lat       REAL,
      lng       REAL
    );
  `)

  _db = drizzle(sqlite, { schema })
  return _db
}

/**
 * Returns the current Drizzle ORM database instance.
 * Throws if initDB() has not been called yet.
 */
export function getDB(): ReturnType<typeof drizzle> {
  if (!_db) {
    throw new Error('Database not initialized. Call initDB() first.')
  }
  return _db
}
