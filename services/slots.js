'use strict'

const db = require('../database/db')

/* ================================================
   CLINIC CONFIG
================================================ */

async function getClinicConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => {
      if (err || !row) resolve({ open_hour:10, close_hour:17, slot_duration:30, clinic_name:'ClinicAI Dental', open_days:'Mon,Tue,Wed,Thu,Fri,Sat' })
      else resolve(row)
    })
  })
}

/* ================================================
   SLOT GENERATION
================================================ */

function generateSlots(open_hour, close_hour, slot_duration) {
  const slots = []
  let current = open_hour * 60
  const end   = close_hour * 60
  while (current < end) {
    slots.push(Math.floor(current/60).toString().padStart(2,'0') + ':' + (current%60).toString().padStart(2,'0'))
    current += slot_duration
  }
  return slots
}

function slotsNeeded(durationMinutes, slotDuration) {
  return Math.ceil(durationMinutes / slotDuration)
}

/* ================================================
   HOLIDAYS
================================================ */

async function getHoliday(dateStr) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM holidays WHERE date = ?', [dateStr], (err, row) => resolve(row || null))
  })
}

async function getAllHolidays() {
  return new Promise((resolve) => {
    db.all('SELECT * FROM holidays ORDER BY date', [], (err, rows) => resolve(rows || []))
  })
}

async function addHoliday(date, reason) {
  return new Promise((resolve) => {
    db.run('INSERT OR REPLACE INTO holidays (date, reason) VALUES (?, ?)', [date, reason], function(err) { resolve(err ? null : this.lastID) })
  })
}

async function deleteHoliday(id) {
  return new Promise((resolve) => {
    db.run('DELETE FROM holidays WHERE id = ?', [id], function(err) { resolve(!err && this.changes > 0) })
  })
}

/* ================================================
   CLINIC OPEN CHECK
================================================ */

async function isClinicOpen(dateStr) {
  const config   = await getClinicConfig()
  const openDays = (config.open_days || 'Mon,Tue,Wed,Thu,Fri,Sat').split(',').map(d => d.trim().toLowerCase())
  const dayNames = ['sun','mon','tue','wed','thu','fri','sat']
  const d        = new Date(dateStr + 'T00:00:00')
  const dayName  = dayNames[d.getDay()]
  if (!openDays.includes(dayName)) return { open: false, reason: 'weekly_closed' }
  const holiday = await getHoliday(dateStr)
  if (holiday) return { open: false, reason: 'holiday', name: holiday.reason }
  return { open: true, reason: null }
}

/* ================================================
   AVAILABLE SLOTS
================================================ */

async function getAvailableSlots(date, serviceDuration) {
  const config    = await getClinicConfig()
  const allSlots  = generateSlots(config.open_hour, config.close_hour, config.slot_duration)
  const slotDur   = config.slot_duration || 30
  const needSlots = slotsNeeded(serviceDuration || slotDur, slotDur)

  return new Promise((resolve, reject) => {
    db.all('SELECT time, COALESCE(service_duration, ?) as dur FROM appointments WHERE date=?', [slotDur, date], (err, rows) => {
      if (err) return reject(err)
      const blocked = new Set()
      rows.forEach(row => {
        const startIdx = allSlots.indexOf(row.time)
        if (startIdx === -1) return
        for (let i = 0; i < slotsNeeded(row.dur, slotDur); i++) { if (allSlots[startIdx+i]) blocked.add(allSlots[startIdx+i]) }
      })
      resolve(allSlots.filter((slot, idx) => {
        if (blocked.has(slot)) return false
        for (let i = 1; i < needSlots; i++) { const n = allSlots[idx+i]; if (!n || blocked.has(n)) return false }
        return true
      }))
    })
  })
}

function formatSlots(slots) {
  if (slots.length === 0) return 'No slots available on this date.'
  return 'Available time slots: ' + slots.join(', ')
}

/* ================================================
   DAILY CAP
================================================ */

async function isDailyCapReached(date, doctorId) {
  const config    = await getClinicConfig()
  const maxPerDay = config.max_per_day || 20
  return new Promise((resolve) => {
    const sql    = doctorId && doctorId !== 0 ? 'SELECT COUNT(*) as count FROM appointments WHERE date = ? AND doctor_id = ?' : 'SELECT COUNT(*) as count FROM appointments WHERE date = ?'
    const params = doctorId && doctorId !== 0 ? [date, doctorId] : [date]
    db.get(sql, params, (err, row) => { if (err) return resolve(false); resolve((row.count||0) >= maxPerDay) })
  })
}

module.exports = {
  getClinicConfig, generateSlots, slotsNeeded,
  getHoliday, getAllHolidays, addHoliday, deleteHoliday,
  isClinicOpen, getAvailableSlots, formatSlots, isDailyCapReached
}
