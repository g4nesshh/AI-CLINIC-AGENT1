'use strict'

const db = require('../database/db')
const { upsertPatient } = require('./patients')

async function bookAppointment(data) {
  return new Promise((resolve) => {
    db.run(
      'INSERT INTO appointments (name,phone,date,time,service,service_duration,doctor_id,doctor_name,notes,email,is_urgent) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [data.name, data.phone, data.date, data.time, data.service, data.service_duration||30, data.doctor_id||null, data.doctor_name||null, data.notes||'', data.email||'', data.is_urgent?1:0],
      function(err) {
        if (err) return resolve(null)
        const id = this.lastID
        // Update patient memory after successful booking
        upsertPatient(data).catch(() => {})
        resolve(id)
      }
    )
  })
}

async function checkDuplicateBooking(phone, date, doctorId) {
  return new Promise((resolve, reject) => {
    const sql    = doctorId && doctorId !== 0 ? 'SELECT id, time, service, doctor_name FROM appointments WHERE phone = ? AND date = ? AND doctor_id = ?' : 'SELECT id, time, service, doctor_name FROM appointments WHERE phone = ? AND date = ?'
    const params = doctorId && doctorId !== 0 ? [phone, date, doctorId] : [phone, date]
    db.all(sql, params, (err, rows) => { if (err) return reject(err); resolve(rows) })
  })
}

async function cancelAppointment(data) {
  return new Promise((resolve) => {
    db.run('DELETE FROM appointments WHERE phone=? AND date=? AND time=?', [data.phone, data.date, data.time], function(err) {
      if (err) return resolve('error')
      if (this.changes > 0) resolve('cancelled')
      else resolve('not_found')
    })
  })
}

async function findAppointmentsByPhone(phone) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM appointments WHERE phone = ? ORDER BY date, time', [phone], (err, rows) => { if (err) return reject(err); resolve(rows) })
  })
}

async function rescheduleAppointment(oldId, oldData, newDate, newTime) {
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION')
      db.run('DELETE FROM appointments WHERE id = ?', [oldId], function(err) {
        if (err) { db.run('ROLLBACK'); return resolve('error') }
      })
      db.run(
        'INSERT INTO appointments (name, phone, date, time, service) VALUES (?, ?, ?, ?, ?)',
        [oldData.name, oldData.phone, newDate, newTime, oldData.service],
        function(err) {
          if (err) { db.run('ROLLBACK'); return resolve('slot_taken') }
          db.run('COMMIT'); resolve(this.lastID)
        }
      )
    })
  })
}

async function getAllServices() {
  return new Promise((resolve) => { db.all('SELECT * FROM services WHERE active = 1 ORDER BY name', [], (err, rows) => resolve(rows || [])) })
}

async function getServiceByName(name) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM services WHERE LOWER(name) = LOWER(?) AND active = 1', [name], (err, row) => {
      if (row) return resolve(row)
      db.all('SELECT * FROM services WHERE active = 1', [], (err2, rows) => {
        if (!rows) return resolve(null)
        const lower = name.toLowerCase()
        resolve(rows.find(s => lower.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(lower)) || null)
      })
    })
  })
}

module.exports = { bookAppointment, checkDuplicateBooking, cancelAppointment, findAppointmentsByPhone, rescheduleAppointment, getAllServices, getServiceByName }