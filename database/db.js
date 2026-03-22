const sqlite3 = require('sqlite3').verbose()

const db = new sqlite3.Database('./database/appointments.db', (err) => {
  if (err) {
    console.error('DB connection failed:', err.message)
  } else {
    console.log('Connected to SQLite database')
  }
})

db.serialize(() => {

  /* ── CREATE ALL TABLES FIRST ── */

  db.run(`
    CREATE TABLE IF NOT EXISTS doctors (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      specialization TEXT NOT NULL DEFAULT 'General',
      available_days TEXT NOT NULL DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat',
      active         INTEGER NOT NULL DEFAULT 1
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      phone            TEXT NOT NULL,
      date             TEXT NOT NULL,
      time             TEXT NOT NULL,
      service          TEXT NOT NULL,
      service_duration INTEGER DEFAULT 30,
      doctor_id        INTEGER,
      doctor_name      TEXT,
      notes            TEXT DEFAULT '',
      email            TEXT DEFAULT '',
      is_urgent        INTEGER DEFAULT 0,
      reminder_24h     INTEGER DEFAULT 0,
      reminder_1h      INTEGER DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(doctor_id, date, time)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS clinic_config (
      id             INTEGER PRIMARY KEY,
      clinic_name    TEXT    DEFAULT 'ClinicAI Dental',
      open_hour      INTEGER DEFAULT 10,
      close_hour     INTEGER DEFAULT 17,
      slot_duration  INTEGER DEFAULT 30,
      open_days      TEXT    DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat',
      max_per_day    INTEGER DEFAULT 20,
      clinic_email   TEXT    DEFAULT '',
      smtp_host      TEXT    DEFAULT 'smtp.gmail.com',
      smtp_port      INTEGER DEFAULT 587,
      smtp_user      TEXT    DEFAULT '',
      smtp_pass      TEXT    DEFAULT '',
      sms_api_key    TEXT    DEFAULT '',
      otp_enabled    INTEGER DEFAULT 1
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      active           INTEGER NOT NULL DEFAULT 1
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS holidays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL UNIQUE,
      reason      TEXT NOT NULL DEFAULT 'Clinic Holiday',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL,
      email       TEXT DEFAULT '',
      date        TEXT NOT NULL,
      doctor_id   INTEGER,
      doctor_name TEXT,
      service     TEXT NOT NULL DEFAULT 'Checkup',
      notes       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now','localtime')),
      notified    INTEGER DEFAULT 0
    )
  `)

  /* ── MIGRATIONS — run AFTER CREATE TABLE so tables exist ──
     SQLite silently ignores ALTER TABLE errors via callback,
     so it's safe to run these every startup.               ── */
  const migrations = [
    /* appointments */
    `ALTER TABLE appointments ADD COLUMN service_duration INTEGER DEFAULT 30`,
    `ALTER TABLE appointments ADD COLUMN doctor_id INTEGER`,
    `ALTER TABLE appointments ADD COLUMN doctor_name TEXT`,
    `ALTER TABLE appointments ADD COLUMN notes TEXT DEFAULT ''`,
    `ALTER TABLE appointments ADD COLUMN email TEXT DEFAULT ''`,
    `ALTER TABLE appointments ADD COLUMN is_urgent INTEGER DEFAULT 0`,
    `ALTER TABLE appointments ADD COLUMN reminder_24h INTEGER DEFAULT 0`,
    `ALTER TABLE appointments ADD COLUMN reminder_1h  INTEGER DEFAULT 0`,
    `ALTER TABLE appointments ADD COLUMN created_at TEXT DEFAULT (datetime('now','localtime'))`,
    /* clinic_config — all new columns since initial release */
    `ALTER TABLE clinic_config ADD COLUMN clinic_name TEXT DEFAULT 'ClinicAI Dental'`,
    `ALTER TABLE clinic_config ADD COLUMN open_days TEXT DEFAULT 'Mon,Tue,Wed,Thu,Fri,Sat'`,
    `ALTER TABLE clinic_config ADD COLUMN max_per_day INTEGER DEFAULT 20`,
    `ALTER TABLE clinic_config ADD COLUMN clinic_email TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN smtp_host TEXT DEFAULT 'smtp.gmail.com'`,
    `ALTER TABLE clinic_config ADD COLUMN smtp_port INTEGER DEFAULT 587`,
    `ALTER TABLE clinic_config ADD COLUMN smtp_user TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN smtp_pass TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN sms_api_key TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN otp_enabled INTEGER DEFAULT 1`,
  ]
  migrations.forEach(sql => db.run(sql, () => {}))   // errors ignored — column already exists

  /* ── SEED clinic_config default row ── */
  db.run(`
    INSERT OR IGNORE INTO clinic_config
      (id, clinic_name, open_hour, close_hour, slot_duration, open_days,
       max_per_day, clinic_email, smtp_host, smtp_port, smtp_user, smtp_pass,
       sms_api_key, otp_enabled)
    VALUES
      (1, 'ClinicAI Dental', 10, 17, 30, 'Mon,Tue,Wed,Thu,Fri,Sat',
       20, '', 'smtp.gmail.com', 587, '', '', '', 1)
  `)

  /* ── Fill any NULLs in existing config row ── */
  db.run(`
    UPDATE clinic_config SET
      clinic_name  = COALESCE(clinic_name,  'ClinicAI Dental'),
      open_days    = COALESCE(open_days,    'Mon,Tue,Wed,Thu,Fri,Sat'),
      max_per_day  = COALESCE(max_per_day,  20),
      clinic_email = COALESCE(clinic_email, ''),
      smtp_host    = COALESCE(smtp_host,    'smtp.gmail.com'),
      smtp_port    = COALESCE(smtp_port,    587),
      smtp_user    = COALESCE(smtp_user,    ''),
      smtp_pass    = COALESCE(smtp_pass,    ''),
      sms_api_key  = COALESCE(sms_api_key,  ''),
      otp_enabled  = COALESCE(otp_enabled,  1)
    WHERE id = 1
  `)

  /* ── SEED sample doctors if empty ── */
  db.get('SELECT COUNT(*) as count FROM doctors', [], (err, row) => {
    if (!err && row && row.count === 0) {
      const ins = db.prepare(
        'INSERT INTO doctors (name, specialization, available_days) VALUES (?, ?, ?)'
      )
      ins.run('Dr. Sharma', 'General Dentist', 'Mon,Tue,Wed,Thu,Fri,Sat')
      ins.run('Dr. Patel',  'Orthodontist',    'Mon,Wed,Fri')
      ins.run('Dr. Mehta',  'Oral Surgeon',    'Tue,Thu,Sat')
      ins.finalize()
      console.log('Seeded 3 sample doctors')
    }
  })

  /* ── SEED sample services if empty ── */
  db.get('SELECT COUNT(*) as count FROM services', [], (err, row) => {
    if (!err && row && row.count === 0) {
      const ins = db.prepare(
        'INSERT INTO services (name, duration_minutes) VALUES (?, ?)'
      )
      ins.run('Checkup',          30)
      ins.run('Tooth Cleaning',   45)
      ins.run('Consultation',     30)
      ins.run('X-Ray',            20)
      ins.run('Tooth Extraction', 60)
      ins.run('Root Canal',       90)
      ins.run('Braces Fitting',   60)
      ins.run('Whitening',        60)
      ins.finalize()
      console.log('Seeded 8 sample services')
    }
  })

  /* ── SEED sample holidays if empty ── */
  db.get('SELECT COUNT(*) as count FROM holidays', [], (err, row) => {
    if (!err && row && row.count === 0) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO holidays (date, reason) VALUES (?, ?)'
      )
      ins.run('2026-10-20', 'Diwali')
      ins.run('2026-03-25', 'Holi')
      ins.run('2026-08-15', 'Independence Day')
      ins.finalize()
      console.log('Seeded sample holidays')
    }
  })

})

module.exports = db