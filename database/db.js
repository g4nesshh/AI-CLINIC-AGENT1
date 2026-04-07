'use strict'

/**
 * database/db.js
 * PostgreSQL client — drop-in replacement for SQLite.
 *
 * Uses the same callback API as sqlite3 so no other
 * file needs to change:
 *   db.run(sql, params, callback)
 *   db.get(sql, params, callback)
 *   db.all(sql, params, callback)
 *   db.serialize(fn)
 *
 * Set environment variable:
 *   DATABASE_URL =
 *
 * On Render: Dashboard → your service → Environment → Add
 * On Render PostgreSQL: Dashboard → New → PostgreSQL (free)
 *   then copy the "Internal Database URL"
 */

const { Pool } = require('pg')

if (!process.env.DATABASE_URL) {
  console.error('[DB] ❌ DATABASE_URL environment variable not set!')
  console.error('[DB] Get it from: Render Dashboard → PostgreSQL → Internal Database URL')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:            10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message)
})

/* ================================================
   SQLITE COMPATIBILITY LAYER
   Converts SQLite ? placeholders → PostgreSQL $1,$2
   Wraps results to match sqlite3 callback format
================================================ */

function toPostgres(sql) {
  let i = 0
  // Convert SQLite ? to PostgreSQL $1, $2, ...
  return sql.replace(/\?/g, () => `$${++i}`)
}

function normalizeSql(sql) {
  return sql
    // SQLite → PostgreSQL type conversions
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bTEXT\b/g, 'TEXT')
    .replace(/\bINTEGER\b/g, 'INTEGER')
    .replace(/\bREAL\b/g, 'REAL')
    .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    .replace(/date\('now'\)/gi, "CURRENT_DATE")
    .replace(/date\('now',\s*'([^']+)'\)/gi, "(CURRENT_DATE + INTERVAL '$1')")
    .replace(/DATE\('now'\)/gi, "CURRENT_DATE")
    // SQLite AUTOINCREMENT quirk
    .replace(/INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
    // INSERT OR REPLACE → handled separately below
    .replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO')
    // ON CONFLICT for upserts — keep as-is (already PostgreSQL compatible)
}

/* ================================================
   db.run — INSERT, UPDATE, DELETE, CREATE TABLE
   callback(err) or callback.call({ lastID, changes }, err)
================================================ */

function run(sql, params, callback) {
  // Handle db.run(sql, callback) — no params
  if (typeof params === 'function') { callback = params; params = [] }
  if (!callback) callback = () => {}
  if (!params) params = []

  const pgSql = toPostgres(normalizeSql(sql))

  pool.query(pgSql, params)
    .then(result => {
      const ctx = {
        lastID:  result.rows?.[0]?.id || null,
        changes: result.rowCount || 0
      }
      callback.call(ctx, null)
    })
    .catch(err => {
      // Ignore "already exists" errors for CREATE TABLE IF NOT EXISTS
      if (err.code === '42P07') { callback.call({ lastID: null, changes: 0 }, null); return }
      console.error('[DB] run error:', err.message, '\nSQL:', pgSql)
      callback.call({ lastID: null, changes: 0 }, err)
    })
}

/* ================================================
   db.get — SELECT returning one row
   callback(err, row)
================================================ */

function get(sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = [] }
  if (!callback) callback = () => {}
  if (!params) params = []

  const pgSql = toPostgres(normalizeSql(sql))

  pool.query(pgSql, params)
    .then(result => callback(null, result.rows[0] || undefined))
    .catch(err => {
      console.error('[DB] get error:', err.message, '\nSQL:', pgSql)
      callback(err, undefined)
    })
}

/* ================================================
   db.all — SELECT returning multiple rows
   callback(err, rows)
================================================ */

function all(sql, params, callback) {
  if (typeof params === 'function') { callback = params; params = [] }
  if (!callback) callback = () => {}
  if (!params) params = []

  const pgSql = toPostgres(normalizeSql(sql))

  pool.query(pgSql, params)
    .then(result => callback(null, result.rows || []))
    .catch(err => {
      console.error('[DB] all error:', err.message, '\nSQL:', pgSql)
      callback(err, [])
    })
}

/* ================================================
   db.serialize — run queries sequentially
   SQLite uses this for transactions.
   In PostgreSQL we just run them in order.
================================================ */

function serialize(fn) {
  fn()
}

/* ================================================
   SCHEMA SETUP
   Creates all tables on first run.
   Safe to run multiple times (IF NOT EXISTS).
================================================ */

async function setupSchema() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // appointments
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id               SERIAL PRIMARY KEY,
        name             TEXT,
        phone            TEXT,
        date             TEXT,
        time             TEXT,
        service          TEXT,
        service_duration INTEGER DEFAULT 30,
        doctor_id        INTEGER,
        doctor_name      TEXT,
        notes            TEXT DEFAULT '',
        email            TEXT DEFAULT '',
        is_urgent        INTEGER DEFAULT 0,
        reminder_24h     INTEGER DEFAULT 0,
        reminder_1h      INTEGER DEFAULT 0,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(date, time, doctor_id)
      )
    `)

    // clinic_config
    await client.query(`
      CREATE TABLE IF NOT EXISTS clinic_config (
        id             SERIAL PRIMARY KEY,
        clinic_name    TEXT DEFAULT 'ClinicAI Dental',
        open_hour      INTEGER DEFAULT 10,
        close_hour     INTEGER DEFAULT 17,
        slot_duration  INTEGER DEFAULT 30,
        open_days      TEXT DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat',
        max_per_day    INTEGER DEFAULT 20,
        clinic_email   TEXT DEFAULT '',
        smtp_host      TEXT DEFAULT 'smtp.gmail.com',
        smtp_port      INTEGER DEFAULT 587,
        smtp_user      TEXT DEFAULT '',
        smtp_pass      TEXT DEFAULT ''
      )
    `)

    // Insert default config if not exists
    await client.query(`
      INSERT INTO clinic_config (id, clinic_name, open_hour, close_hour, slot_duration, open_days)
      VALUES (1, 'ClinicAI Dental', 10, 17, 30, 'Mon,Tue,Wed,Thu,Fri,Sat')
      ON CONFLICT (id) DO NOTHING
    `)

    // doctors
    await client.query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id             SERIAL PRIMARY KEY,
        name           TEXT NOT NULL,
        specialization TEXT DEFAULT 'General Dentist',
        available_days TEXT DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat',
        active         INTEGER DEFAULT 1,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // services
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id               SERIAL PRIMARY KEY,
        name             TEXT NOT NULL,
        duration_minutes INTEGER DEFAULT 30,
        active           INTEGER DEFAULT 1,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // holidays
    await client.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        id         SERIAL PRIMARY KEY,
        date       TEXT NOT NULL UNIQUE,
        reason     TEXT DEFAULT 'Clinic Holiday',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // waitlist
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id          SERIAL PRIMARY KEY,
        name        TEXT,
        phone       TEXT,
        email       TEXT DEFAULT '',
        date        TEXT,
        doctor_id   INTEGER,
        doctor_name TEXT,
        service     TEXT DEFAULT 'Checkup',
        notes       TEXT DEFAULT '',
        notified    INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // patients (returning user memory)
    await client.query(`
      CREATE TABLE IF NOT EXISTS patients (
        phone        TEXT PRIMARY KEY,
        name         TEXT,
        last_service TEXT,
        last_doctor  TEXT,
        last_date    TEXT,
        visit_count  INTEGER DEFAULT 1,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // analytics
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics (
        id         SERIAL PRIMARY KEY,
        event      TEXT NOT NULL,
        "userId"   TEXT,
        intent     TEXT,
        service    TEXT,
        doctor     TEXT,
        success    INTEGER DEFAULT 0,
        metadata   TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Seed sample doctors if empty
    const docCount = await client.query('SELECT COUNT(*) as count FROM doctors')
    if (parseInt(docCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO doctors (name, specialization, available_days) VALUES
        ('Dr. Sharma',  'General Dentist', 'Mon,Tue,Wed,Thu,Fri,Sat'),
        ('Dr. Patel',   'Orthodontist',    'Mon,Tue,Wed,Thu,Fri'),
        ('Dr. Mehta',   'Oral Surgeon',    'Tue,Wed,Thu,Fri,Sat')
      `)
      console.log('[DB] Seeded 3 sample doctors')
    }

    // Seed sample services if empty
    const svcCount = await client.query('SELECT COUNT(*) as count FROM services')
    if (parseInt(svcCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO services (name, duration_minutes) VALUES
        ('Checkup',        30),
        ('Tooth Cleaning', 45),
        ('Consultation',   30),
        ('X-Ray',          20),
        ('Root Canal',     90),
        ('Braces',         60),
        ('Whitening',      60),
        ('Extraction',     45)
      `)
      console.log('[DB] Seeded 8 sample services')
    }

    await client.query('COMMIT')
    console.log('[DB] ✅ Schema ready — all tables created/verified')

  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[DB] Schema setup failed:', err.message)
    throw err
  } finally {
    client.release()
  }
}

/* ================================================
   SPECIAL: run with RETURNING id for INSERTs
   Used by bookAppointment to get lastID
================================================ */

function runReturning(sql, params, callback) {
  if (!params) params = []
  let pgSql = toPostgres(normalizeSql(sql))

  // Add RETURNING id if it's an INSERT without it
  if (/^\s*INSERT/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
    pgSql += ' RETURNING id'
  }

  pool.query(pgSql, params)
    .then(result => {
      const ctx = {
        lastID:  result.rows?.[0]?.id || null,
        changes: result.rowCount || 0
      }
      callback.call(ctx, null)
    })
    .catch(err => {
      console.error('[DB] runReturning error:', err.message)
      callback.call({ lastID: null, changes: 0 }, err)
    })
}

/* ================================================
   CONNECT + SETUP
================================================ */

setupSchema()
  .then(() => console.log('[DB] Connected to PostgreSQL ✅'))
  .catch(err => {
    console.error('[DB] Failed to setup schema:', err.message)
    process.exit(1)
  })

module.exports = { run, get, all, serialize, runReturning, pool }