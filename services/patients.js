'use strict'

const db = require('../database/db')

/* ================================================
   PATIENTS TABLE
   Created automatically if it doesn't exist.
   Tracks returning patients by phone number.
================================================ */

db.run(`
  CREATE TABLE IF NOT EXISTS patients (
    phone         TEXT PRIMARY KEY,
    name          TEXT,
    last_service  TEXT,
    last_doctor   TEXT,
    last_date     TEXT,
    visit_count   INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) console.error('[Patients] Table error:', err.message)
  else console.log('[Patients] Table ready ✅')
})

/* ================================================
   GET PATIENT
   Returns patient record or null
================================================ */

async function getPatient(phone) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM patients WHERE phone = ?', [phone], (err, row) => {
      resolve(row || null)
    })
  })
}

/* ================================================
   UPSERT PATIENT
   Called after every successful booking.
   Updates visit count and last service info.
================================================ */

async function upsertPatient(data) {
  return new Promise((resolve) => {
    db.run(`
      INSERT INTO patients (phone, name, last_service, last_doctor, last_date, visit_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(phone) DO UPDATE SET
        name         = excluded.name,
        last_service = excluded.last_service,
        last_doctor  = excluded.last_doctor,
        last_date    = excluded.last_date,
        visit_count  = patients.visit_count + 1,
        updated_at   = CURRENT_TIMESTAMP
    `, [data.phone, data.name, data.service, data.doctor_name || null, data.date],
    function(err) {
      if (err) console.error('[Patients] Upsert error:', err.message)
      resolve(!err)
    })
  })
}

/* ================================================
   BUILD WELCOME BACK MESSAGE
   Returns a personalised greeting string,
   or null if this is a new patient.
================================================ */

function buildWelcomeBack(patient) {
  if (!patient) return null

  const visitWord = patient.visit_count === 1 ? 'first' :
    patient.visit_count === 2 ? 'second' :
    patient.visit_count === 3 ? 'third' :
    `${patient.visit_count}th`

  let msg = `👋 Welcome back, ${patient.name}! Great to hear from you again.`

  if (patient.last_service && patient.last_date) {
    msg += `\n\nYour last visit was a **${patient.last_service}**`
    if (patient.last_doctor) msg += ` with ${patient.last_doctor}`
    msg += ` on ${patient.last_date}.`
  }

  msg += `\n\nWould you like to book the same service again, or something different?`

  return msg
}

module.exports = { getPatient, upsertPatient, buildWelcomeBack }