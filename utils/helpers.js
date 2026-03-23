'use strict'

/* ================================================
   RATE LIMITER
================================================ */

const rateLimits = {}

function rateLimit(key, maxRequests, windowMs) {
  const now  = Date.now()
  const data = rateLimits[key]
  if (!data || (now - data.windowStart) > windowMs) {
    rateLimits[key] = { count: 1, windowStart: now }
    return false
  }
  data.count++
  return data.count > maxRequests
}

setInterval(() => {
  const now = Date.now()
  for (const key of Object.keys(rateLimits)) {
    if ((now - rateLimits[key].windowStart) > 120000) delete rateLimits[key]
  }
}, 120000)

/* ================================================
   SESSION STORE
================================================ */

const conversations   = {}
const bookingState    = {}
const rescheduleState = {}
const checkState      = {}

const SESSION_TTL    = 30 * 60 * 1000
const SWEEP_INTERVAL =  5 * 60 * 1000

function getHistory(userId) {
  if (!conversations[userId]) conversations[userId] = []
  return conversations[userId]
}

function getState(userId) {
  if (!bookingState[userId]) {
    bookingState[userId] = {
      step: 'idle', intent: null, name: null, phone: null,
      date: null, time: null, service: null, service_duration: null,
      is_urgent: false, wants_waitlist: false,
      doctor_id: null, doctor_name: null, notes: null, email: null,
      lastActivity: Date.now()
    }
  }
  return bookingState[userId]
}

function getCheckState(userId) {
  if (!checkState[userId]) checkState[userId] = { phone: null, lastActivity: Date.now() }
  return checkState[userId]
}

function getRescheduleState(userId) {
  if (!rescheduleState[userId]) {
    rescheduleState[userId] = {
      step: 'idle', phone: null, oldAppt: null,
      newDate: null, newTime: null, lastActivity: Date.now()
    }
  }
  return rescheduleState[userId]
}

function resetCheck(userId)      { delete checkState[userId] }
function resetReschedule(userId) { resetCheck(userId); delete rescheduleState[userId] }

function resetState(userId) {
  delete bookingState[userId]
  delete conversations[userId]
  resetReschedule(userId)
  resetCheck(userId)
}

function touchSession(userId) {
  const now = Date.now()
  if (bookingState[userId])    bookingState[userId].lastActivity    = now
  if (rescheduleState[userId]) rescheduleState[userId].lastActivity = now
  if (checkState[userId])      checkState[userId].lastActivity      = now
}

function isExpired(userId) {
  const state = bookingState[userId] || rescheduleState[userId] || checkState[userId]
  if (!state || !state.lastActivity) return false
  return (Date.now() - state.lastActivity) > SESSION_TTL
}

function sweepExpiredSessions() {
  const now = Date.now()
  let cleared = 0
  for (const id of Object.keys(bookingState)) {
    if ((now - (bookingState[id].lastActivity || 0)) > SESSION_TTL) { resetState(id); cleared++ }
  }
  for (const id of Object.keys(rescheduleState)) {
    if ((now - (rescheduleState[id].lastActivity || 0)) > SESSION_TTL) { resetReschedule(id); cleared++ }
  }
  for (const id of Object.keys(checkState)) {
    if ((now - (checkState[id].lastActivity || 0)) > SESSION_TTL) { resetCheck(id); cleared++ }
  }
  if (cleared > 0) console.log(`[Session] Cleared ${cleared} expired session(s)`)
}

setInterval(sweepExpiredSessions, SWEEP_INTERVAL)
console.log(`[Session] TTL=${SESSION_TTL/60000}min, sweep every ${SWEEP_INTERVAL/60000}min`)

/* ================================================
   MISC
================================================ */

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim())
}

function buildSummary(state) {
  return (
    `📋 Booking Summary\n\n` +
    `  Name    : ${state.name}\n` +
    `  Phone   : ${state.phone}\n` +
    `  Doctor  : ${state.doctor_name || 'Any available'}\n` +
    `  Date    : ${state.date}\n` +
    `  Time    : ${state.time}\n` +
    `  Service : ${state.service}\n` +
    `  Notes   : ${state.notes && state.notes !== '__asking__' ? state.notes : 'None'}\n` +
    (state.email ? `  Email   : ${state.email}\n` : '') +
    `\nIs everything correct? Reply yes to confirm or no to change something.`
  )
}

module.exports = {
  rateLimit,
  getHistory, getState, getCheckState, getRescheduleState,
  resetState, resetCheck, resetReschedule,
  touchSession, isExpired,
  isValidEmail, buildSummary
}
