'use strict'

const db = require('../database/db')

async function getAllDoctors() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM doctors WHERE active = 1 ORDER BY name', [], (err, rows) => { if (err) reject(err); else resolve(rows || []) })
  })
}

async function getDoctorById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM doctors WHERE id = ? AND active = 1', [id], (err, row) => { if (err) reject(err); else resolve(row || null) })
  })
}

function isDoctorAvailableOnDate(doctor, dateStr) {
  const dayNames  = ['sun','mon','tue','wed','thu','fri','sat']
  const d         = new Date(dateStr + 'T00:00:00')
  const dayName   = dayNames[d.getDay()]
  const availDays = (doctor.available_days || 'Mon,Tue,Wed,Thu,Fri,Sat').split(',').map(x => x.trim().toLowerCase())
  return availDays.includes(dayName)
}

function formatDoctorList(doctors) {
  return doctors.map((d, i) => `  ${i+1}. ${d.name} — ${d.specialization}`).join('\n')
}

async function getAvailableSlotsForDoctor(doctorId, date, serviceDuration) {
  const { getClinicConfig, generateSlots, slotsNeeded } = require('./slots')
  const config    = await getClinicConfig()
  const allSlots  = generateSlots(config.open_hour, config.close_hour, config.slot_duration)
  const slotDur   = config.slot_duration || 30
  const needSlots = slotsNeeded(serviceDuration || slotDur, slotDur)

  return new Promise((resolve, reject) => {
    db.all('SELECT time, COALESCE(service_duration, ?) as dur FROM appointments WHERE doctor_id = ? AND date = ?', [slotDur, doctorId, date], (err, rows) => {
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

async function findEarliestSlot(preferDoctorId) {
  const { isClinicOpen } = require('./slots')
  const today    = new Date().toISOString().split('T')[0]
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0] })()
  const now      = new Date()
  const nowTime  = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0')
  const doctors  = await getAllDoctors()

  for (const date of [today, tomorrow]) {
    const openCheck = await isClinicOpen(date)
    if (!openCheck.open) continue

    const doctorsToCheck = preferDoctorId
      ? [doctors.find(d => d.id === preferDoctorId), ...doctors.filter(d => d.id !== preferDoctorId)].filter(Boolean)
      : doctors

    for (const doctor of doctorsToCheck) {
      if (!isDoctorAvailableOnDate(doctor, date)) continue
      const available = await getAvailableSlotsForDoctor(doctor.id, date, 30)
      const future    = date === today ? available.filter(s => s > nowTime) : available
      if (future.length > 0) return { date, time: future[0], doctor }
    }

    if (doctors.length === 0) {
      const { getAvailableSlots } = require('./slots')
      const available = await getAvailableSlots(date, 30)
      const future    = date === today ? available.filter(s => s > nowTime) : available
      if (future.length > 0) return { date, time: future[0], doctor: null }
    }
  }
  return null
}

module.exports = { getAllDoctors, getDoctorById, isDoctorAvailableOnDate, formatDoctorList, getAvailableSlotsForDoctor, findEarliestSlot }
