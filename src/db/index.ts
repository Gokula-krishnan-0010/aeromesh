// src/db/index.ts
// SQLite database initialization for AeroMesh
// Uses expo-sqlite v16 openDatabaseSync (required by drizzle-orm/expo-sqlite adapter)
// Requirements: 11.1, 11.2, 11.3, 11.7, 11.8

import { openDatabaseSync } from 'expo-sqlite'
import { drizzle } from 'drizzle-orm/expo-sqlite'
import * as schema from './schema'

// Singleton database connection
let _db: ReturnType<typeof drizzle> | null = null

/**
 * Initialize the SQLite database, creating all tables and indexes if they
 * don't already exist. Safe to call multiple times (idempotent).
 *
 * Uses openDatabaseSync (required by drizzle-orm/expo-sqlite which operates
 * in sync mode). Schema setup runs via execSync before the drizzle instance
 * is created.
 *
 * Returns the Drizzle ORM database instance for use throughout the app.
 */
export function initDB(): ReturnType<typeof drizzle> {
  if (_db) {
    return _db
  }

  const sqlite = openDatabaseSync('aeromesh.db')

  // Create tables and indexes using raw SQL for maximum compatibility.
  // execSync runs each statement in the semicolon-separated string.
  sqlite.execSync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS pressure_readings (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      pressure REAL    NOT NULL,
      lat      REAL    NOT NULL,
      lng      REAL    NOT NULL,
      altitude REAL,
      ts       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pressure_ts ON pressure_readings(ts);

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

    CREATE INDEX IF NOT EXISTS idx_sos_uploaded ON sos_queue(uploaded);

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
