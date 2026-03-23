'use strict'

const db = require('../database/db')

async function addToWaitlist(data) {
  return new Promise((resolve) => {
    db.run(
      'INSERT INTO waitlist (name, phone, email, date, doctor_id, doctor_name, service, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [data.name, data.phone, data.email||'', data.date, data.doctor_id||null, data.doctor_name||null, data.service||'Checkup', data.notes||''],
      function(err) { resolve(err ? null : this.lastID) }
    )
  })
}

async function getWaitlistForDate(date, doctorId) {
  return new Promise((resolve) => {
    const sql    = doctorId ? 'SELECT * FROM waitlist WHERE date = ? AND (doctor_id = ? OR doctor_id IS NULL) AND notified = 0 ORDER BY created_at' : 'SELECT * FROM waitlist WHERE date = ? AND notified = 0 ORDER BY created_at'
    const params = doctorId ? [date, doctorId] : [date]
    db.all(sql, params, (err, rows) => resolve(rows || []))
  })
}

async function markWaitlistNotified(id) {
  return new Promise((resolve) => { db.run('UPDATE waitlist SET notified = 1 WHERE id = ?', [id], () => resolve()) })
}

async function getAllWaitlist() {
  return new Promise((resolve) => { db.all('SELECT * FROM waitlist ORDER BY date, created_at', [], (err, rows) => resolve(rows || [])) })
}

async function removeFromWaitlist(id) {
  return new Promise((resolve) => { db.run('DELETE FROM waitlist WHERE id = ?', [id], function(err) { resolve(!err && this.changes > 0) }) })
}

async function notifyWaitlistOnCancel(date, time, doctorId) {
  const waiters = await getWaitlistForDate(date, doctorId)
  if (!waiters.length) return
  const first = waiters[0]
  await markWaitlistNotified(first.id)
  console.log(`[Waitlist] Slot opened on ${date} at ${time} — notifying ${first.name} (${first.phone})`)
  return first
}

module.exports = { addToWaitlist, getWaitlistForDate, markWaitlistNotified, getAllWaitlist, removeFromWaitlist, notifyWaitlistOnCancel }
