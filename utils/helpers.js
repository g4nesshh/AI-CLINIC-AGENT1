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

/* ================================================
   STRUCTURED RESPONSE BUILDER
   Adds action tags to every response so the
   frontend can render the right UI element.
================================================ */

function respond(res, payload) {
  if (!payload.action) {
    if (payload.slots && payload.slots.length > 0)                                     payload.action = 'show_slots'
    else if (payload.reply && payload.reply.includes('📋 Booking Summary'))            payload.action = 'show_summary'
    else if (payload.reply && payload.reply.startsWith('✅ Appointment confirmed'))    payload.action = 'confirmed'
    else if (payload.reply && payload.reply.includes('successfully cancelled'))         payload.action = 'cancelled'
    else if (payload.reply && payload.reply.includes('May I have your full name'))      payload.action = 'ask_name'
    else if (payload.reply && payload.reply.includes('10-digit phone'))                payload.action = 'ask_phone'
    else if (payload.reply && payload.reply.includes('Which date'))                    payload.action = 'ask_date'
    else if (payload.reply && payload.reply.includes('What service'))                  payload.action = 'ask_service'
    else if (payload.options)                                                           payload.action = 'show_options'
    else                                                                                payload.action = 'chat'
  }
  return res.json(payload)
}

// Re-export everything including respond
const originalExports = module.exports
module.exports = { ...originalExports, respond }
