'use strict'

const db = require('../database/db')

// Table is created in db.js schema setup

async function getPatient(phone) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM patients WHERE phone = ?', [phone], (err, row) => {
      resolve(row || null)
    })
  })
}

async function upsertPatient(data) {
  return new Promise((resolve) => {
    db.run(`
      INSERT INTO patients (phone, name, last_service, last_doctor, last_date, visit_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(phone) DO UPDATE SET
        name         = EXCLUDED.name,
        last_service = EXCLUDED.last_service,
        last_doctor  = EXCLUDED.last_doctor,
        last_date    = EXCLUDED.last_date,
        visit_count  = patients.visit_count + 1,
        updated_at   = CURRENT_TIMESTAMP
    `, [data.phone, data.name, data.service, data.doctor_name || null, data.date],
    function(err) {
      if (err) console.error('[Patients] Upsert error:', err.message)
      resolve(!err)
    })
  })
}

function buildWelcomeBack(patient) {
  if (!patient) return null

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