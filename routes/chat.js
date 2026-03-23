'use strict'

const express = require('express')
const router  = express.Router()

const { extractDetails, chatReply }           = require('../nlp/extract')
const { detectIntent, detectCorrection }       = require('../nlp/intent')
const { parseDate, parseTime, parsePhone, isSimpleMessage } = require('../nlp/parser')
const { getAvailableSlots, formatSlots, isClinicOpen, isDailyCapReached } = require('../services/slots')
const { getAllDoctors, getDoctorById, isDoctorAvailableOnDate, formatDoctorList, findEarliestSlot } = require('../services/doctors')
const { bookAppointment, checkDuplicateBooking, cancelAppointment, findAppointmentsByPhone, rescheduleAppointment, getServiceByName } = require('../services/booking')
const { addToWaitlist, getAllWaitlist, removeFromWaitlist, notifyWaitlistOnCancel, getWaitlistForDate } = require('../services/waitlist')
const { rateLimit, getHistory, getState, getCheckState, getRescheduleState, resetState, resetCheck, resetReschedule, touchSession, isExpired, isValidEmail, buildSummary } = require('../utils/helpers')

/* ================================================
   FIELD FALLBACKS
   Apply these after AI extraction to catch
   cases where Groq misses simple inputs
================================================ */

function applyFallbacks(message, state, merged) {

  // Name fallback — plain text that looks like a name
  if (!state.name && (state.step === 'collecting' || state.intent === 'book')) {
    const t = message.trim()
    const isName = /^[a-zA-Z\s]{2,30}$/.test(t) &&
      t.split(' ').length <= 3 &&
      !detectIntent(t) &&
      !/\b(book|appointment|cancel|clinic|hours|service|slot|time|available|what|how|when|where|help|doctor|check|reschedule)\b/i.test(t)
    if (isName) {
      state.name = t.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    }
  }

  // Service fallback
  if (!state.service && state.step === 'collecting') {
    const t = message.trim().toLowerCase()
    const services = ['checkup','cleaning','tooth cleaning','consultation','x-ray','xray','x ray','root canal','braces','whitening','extraction','filling','crown','implant']
    const matched  = services.find(s => t.includes(s))
    if (matched) state.service = (matched === 'x ray' || matched === 'xray') ? 'x-ray' : matched
  }

  // Date fallback — plain day names
  if (!state.date && state.step === 'collecting') {
    const t = message.trim().toLowerCase()
    const dayMap = {
      'monday':1,'tuesday':2,'wednesday':3,'thursday':4,'friday':5,'saturday':6,'sunday':0,
      'mon':1,'tue':2,'wed':3,'thu':4,'fri':5,'sat':6,'sun':0,'thurs':4,'tues':2,'weds':3
    }
    const found = Object.keys(dayMap).find(d => t === d || t === 'next '+d || t === 'this '+d)
    if (found) {
      const targetDay = dayMap[found.replace('next ','').replace('this ','')]
      const today = new Date(); today.setHours(0,0,0,0)
      let diff = targetDay - today.getDay(); if (diff <= 0) diff += 7
      today.setDate(today.getDate() + diff)
      state.date = today.toISOString().split('T')[0]
    }
  }
}

/* ================================================
   CHAT ROUTE
================================================ */

router.post('/', async (req, res) => {
  const raw     = (req.body.message || '').trim()
  const message = raw.slice(0, 500)
  const userId  = req.body.userId || req.ip

  if (!message) return res.json({ reply: 'Please type a message.' })
  if (raw.length > 500) return res.json({ reply: '⚠️ Message too long. Please keep it under 500 characters.' })

  if (rateLimit(`chat:${userId}`, 30, 60000)) {
    return res.status(429).json({ reply: '⚠️ Too many messages. Please wait a moment.' })
  }

  const history = getHistory(userId)
  const state   = getState(userId)

  history.push({ role: 'user', content: message })

  if (isExpired(userId)) {
    resetState(userId)
    return res.json({ reply: "Your session expired. How can I help you today?" })
  }

  touchSession(userId)

  // ── NLP: run AI extraction + local parsers in parallel ──
  const simple = isSimpleMessage(message)
  const [aiDetails, localPhone, localDate, localTime, localIntent] = await Promise.all([
    simple ? Promise.resolve({}) : extractDetails(message),
    Promise.resolve(parsePhone(message)),
    Promise.resolve(parseDate(message)),
    Promise.resolve(parseTime(message)),
    Promise.resolve(detectIntent(message))
  ])

  const merged = {
    intent:  aiDetails.intent  || localIntent  || null,
    name:    aiDetails.name    || null,
    phone:   aiDetails.phone   || localPhone   || null,
    date:    aiDetails.date    || localDate    || null,
    time:    aiDetails.time    || localTime    || null,
    service: aiDetails.service || null
  }

  for (const key of ['intent','name','phone','date','time','service','notes']) {
    if (merged[key]) state[key] = merged[key]
  }

  // Apply fallbacks for common extraction misses
  applyFallbacks(message, state, merged)

  // ── Mid-flow field correction ──
  if (state.step === 'collecting' || state.step === 'confirming') {
    const correction = detectCorrection(message, aiDetails)
    if (correction && correction.field) {
      state[correction.field] = correction.value
      if (correction.field === 'date') state.time = null
      const labels = { name:'name', phone:'phone number', date:'date', time:'time', service:'service' }
      return res.json({ reply: `Got it! Updated your ${labels[correction.field]} to "${correction.value}". ${state.step === 'confirming' ? 'Here is the updated summary:' : "Let's continue."}` })
    }
  }

  // ── RESET ──
  if (state.intent === 'reset') {
    resetState(userId)
    return res.json({ reply: "Conversation cleared! How can I help you today?" })
  }

  // ── CONFIRMING ──
  if (state.step === 'confirming') {
    if (state.intent === 'confirm') {
      let existing
      try { existing = await checkDuplicateBooking(state.phone, state.date, state.doctor_id) } catch(e) { existing = [] }

      if (existing.length > 0) {
        const list = existing.map(a => `${a.time} — ${a.service} (Ref #${a.id})`).join(', ')
        const badDate = state.date
        state.step = 'collecting'; state.date = null; state.time = null
        return res.json({ reply: `⚠️ You already have an appointment on ${badDate}:\n  ${list}\n\nWould you like to pick a different date?` })
      }

      const id = await bookAppointment(state)
      if (id) {
        const msg = `✅ Appointment confirmed!\n\n  Ref #   : ${id}\n  Name    : ${state.name}\n  Doctor  : ${state.doctor_name||'Any available'}\n  Date    : ${state.date}\n  Time    : ${state.time}\n  Service : ${state.service}\n  Notes   : ${state.notes && state.notes !== '__asking__' ? state.notes : 'None'}\n\nPlease arrive 10 minutes early. See you! 😊`
        resetState(userId)
        return res.json({ reply: msg })
      } else {
        state.step = 'collecting'; state.time = null
        const slots = await getAvailableSlots(state.date)
        return res.json({ reply: 'Sorry, that slot was just taken! Please pick another:', slots })
      }
    }

    if (state.intent === 'deny') {
      state.step = 'collecting'
      return res.json({ reply: "No problem! What would you like to change — name, phone, date, time, or service?" })
    }

    return res.json({ reply: buildSummary(state) + '\n\n(Reply yes to confirm or no to change something)' })
  }

  // ── WAITLIST ──
  if (state.intent === 'waitlist' || state.wants_waitlist) {
    state.wants_waitlist = true; state.step = 'collecting'
    if (!state.name)    return res.json({ reply: "I'll add you to the waitlist! What is your full name?" })
    if (!state.phone)   return res.json({ reply: `Thanks ${state.name}! Please share your 10-digit phone number.` })
    if (!state.date)    return res.json({ reply: "Which date would you like to be waitlisted for?" })
    if (!state.service) return res.json({ reply: "What service do you need?" })
    if (state.email === null) { state.email = '__asking__'; return res.json({ reply: "Share your email to get notified when a slot opens, or say skip." }) }
    if (state.email === '__asking__') {
      const t = message.trim()
      state.email = /^(skip|none|no|nope|na)$/i.test(t) ? '' : isValidEmail(t) ? t.toLowerCase() : ''
    }
    const wlId = await addToWaitlist(state)
    if (wlId) {
      resetState(userId)
      return res.json({ reply: `✅ Added to waitlist!\n\n  Name    : ${state.name}\n  Date    : ${state.date}\n  Service : ${state.service}\n\nWe'll contact you when a slot opens. 😊` })
    }
    return res.json({ reply: "Sorry, couldn't add you to the waitlist. Please try again." })
  }

  // ── URGENT ──
  if (state.intent === 'urgent') {
    state.is_urgent = true; state.intent = 'book'
    let earliest = null
    try { earliest = await findEarliestSlot(state.doctor_id||null) } catch(e) { earliest = null }
    if (!earliest) return res.json({ reply: '🚨 No slots available today or tomorrow. Please call the clinic directly for emergency assistance.' })
    state.date = earliest.date; state.time = earliest.time; state.notes = `URGENT: ${message.trim()}`
    if (earliest.doctor) { state.doctor_id = earliest.doctor.id; state.doctor_name = earliest.doctor.name }
    const isToday = earliest.date === new Date().toISOString().split('T')[0]
    return res.json({ reply: `🚨 Emergency booking!\n\nEarliest slot: ${earliest.date} (${isToday?'today':'tomorrow'}) at ${earliest.time}${earliest.doctor ? ' with '+earliest.doctor.name : ''}\n\nWhat is your full name?` })
  }

  // ── CHECK ──
  if (state.intent === 'check') {
    const cs = getCheckState(userId)
    if (!cs.phone) cs.phone = state.phone || localPhone || null
    if (!cs.phone) return res.json({ reply: "Please share your 10-digit phone number and I'll look up your appointments." })
    let appts
    try { appts = await findAppointmentsByPhone(cs.phone) } catch(e) { return res.json({ reply: "Sorry, couldn't fetch appointments. Please try again." }) }
    resetCheck(userId); state.intent = null
    if (appts.length === 0) return res.json({ reply: `No appointments found for ${cs.phone}. Would you like to book one?` })
    const todayStr = new Date().toISOString().split('T')[0]
    const upcoming = appts.filter(a => a.date >= todayStr)
    const past     = appts.filter(a => a.date <  todayStr)
    let reply = `Found ${appts.length} appointment(s) for ${cs.phone}:\n`
    if (upcoming.length > 0) { reply += `\n📅 Upcoming:\n`; upcoming.forEach((a,i) => { reply += `  ${i+1}. ${a.date} at ${a.time} — ${a.service} (Ref #${a.id})\n` }) }
    if (past.length > 0)     { reply += `\n🕐 Past:\n`;     past.forEach((a,i) => { reply += `  ${i+1}. ${a.date} at ${a.time} — ${a.service} (Ref #${a.id})\n` }) }
    reply += upcoming.length > 0 ? '\nWould you like to reschedule or cancel any of these?' : '\nNo upcoming appointments. Would you like to book a new one?'
    return res.json({ reply })
  }

  // ── CANCEL ──
  if (state.intent === 'cancel') {
    if (!state.phone) return res.json({ reply: "Please share your 10-digit phone number to cancel." })
    if (!state.date)  return res.json({ reply: "Which date is the appointment you want to cancel?" })
    if (!state.time)  return res.json({ reply: "What time is the appointment?" })
    const result = await cancelAppointment(state)
    resetState(userId)
    if (result === 'cancelled') return res.json({ reply: "✅ Your appointment has been successfully cancelled." })
    if (result === 'not_found') return res.json({ reply: "❌ No appointment found with those details. Please check the date and time." })
    return res.json({ reply: "Something went wrong. Please try again." })
  }

  // ── RESCHEDULE ──
  if (state.intent === 'reschedule') {
    const rs = getRescheduleState(userId)
    if (!rs.phone) rs.phone = state.phone || null
    if (!rs.phone) return res.json({ reply: "Please share your 10-digit phone number so I can find your appointment." })

    if (!rs.oldAppt) {
      let appts
      try { appts = await findAppointmentsByPhone(rs.phone) } catch(e) { return res.json({ reply: "Sorry, could not look up appointments." }) }
      if (appts.length === 0) { resetReschedule(userId); state.intent = null; return res.json({ reply: `No appointments found for ${rs.phone}.` }) }
      if (appts.length === 1) { rs.oldAppt = appts[0]; rs.step = 'picked'; return res.json({ reply: `Found:\n  Date: ${rs.oldAppt.date}\n  Time: ${rs.oldAppt.time}\n  Service: ${rs.oldAppt.service}\n\nWhat new date would you like?` }) }
      rs.step = 'finding'; rs.allAppts = appts
      return res.json({ reply: `Found ${appts.length} appointments:\n${appts.map((a,i)=>`  ${i+1}. ${a.date} at ${a.time} — ${a.service}`).join('\n')}\n\nWhich one to reschedule? (Reply with number)` })
    }

    if (rs.step === 'finding' && rs.allAppts) {
      const numMatch = message.match(/\b([1-9])\b/)
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1
        if (idx >= 0 && idx < rs.allAppts.length) { rs.oldAppt = rs.allAppts[idx]; rs.step = 'picked'; return res.json({ reply: `Rescheduling: ${rs.oldAppt.date} at ${rs.oldAppt.time}\n\nWhat new date?` }) }
      }
      return res.json({ reply: "Please reply with the number (e.g. 1, 2, 3)." })
    }

    if (!rs.newDate) rs.newDate = state.date || localDate || null
    if (!rs.newDate) return res.json({ reply: "What new date? (e.g. tomorrow, 25th March, next Monday)" })

    if (!rs.newTime) rs.newTime = state.time || localTime || null
    if (!rs.newTime) {
      let slots; try { slots = await getAvailableSlots(rs.newDate) } catch(e) { return res.json({ reply: "Could not fetch slots." }) }
      if (slots.length === 0) { const bad = rs.newDate; rs.newDate = null; return res.json({ reply: `No slots on ${bad}. Please choose another date.` }) }
      return res.json({ reply: `${formatSlots(slots)}\n\nWhich time works for you?` })
    }

    let slots; try { slots = await getAvailableSlots(rs.newDate) } catch(e) { return res.json({ reply: "Could not verify slot." }) }
    if (!slots.includes(rs.newTime)) { const bad = rs.newTime; rs.newTime = null; return res.json({ reply: `Sorry, ${bad} is not available.\n\n${formatSlots(slots)}` }) }

    if (rs.step !== 'confirming') { rs.step = 'confirming'; return res.json({ reply: `📋 Reschedule Summary\n\n  From : ${rs.oldAppt.date} at ${rs.oldAppt.time}\n  To   : ${rs.newDate} at ${rs.newTime}\n\nConfirm? Reply yes or no.` }) }

    const rsYes = /\b(yes|confirm|correct|go ahead|sure|ok|yep|yeah)\b/i.test(message)
    const rsNo  = /\b(no|nope|wrong|change|different|cancel)\b/i.test(message)

    if (rsYes) {
      const newId = await rescheduleAppointment(rs.oldAppt.id, rs.oldAppt, rs.newDate, rs.newTime)
      resetReschedule(userId); state.intent = null
      if (newId === 'slot_taken') return res.json({ reply: "Sorry, that slot was just taken! Please pick another time." })
      if (newId === 'error')      return res.json({ reply: "Something went wrong. Please try again." })
      return res.json({ reply: `✅ Rescheduled!\n\n  Ref # : ${newId}\n  New Date: ${rs.newDate}\n  New Time: ${rs.newTime}\n\nSee you! 😊` })
    }
    if (rsNo) { rs.step = 'picked'; rs.newDate = null; rs.newTime = null; return res.json({ reply: "No problem! What new date and time would you like?" }) }
    return res.json({ reply: `📋 Reschedule Summary\n\n  From : ${rs.oldAppt.date} at ${rs.oldAppt.time}\n  To   : ${rs.newDate} at ${rs.newTime}\n\nReply yes or no.` })
  }

  // ── BOOK ──
  if (state.intent === 'book') {
    state.step = 'collecting'
    if (!state.name)  return res.json({ reply: "I'd be happy to book an appointment! May I have your full name?" })
    if (!state.phone) return res.json({ reply: `Thanks ${state.name}! Please share your 10-digit phone number.` })

    if (!state.doctor_id) {
      let doctors; try { doctors = await getAllDoctors() } catch(e) { doctors = [] }
      if (doctors.length === 0) { state.doctor_id = 0; state.doctor_name = 'Any available doctor' }
      else if (doctors.length === 1) { state.doctor_id = doctors[0].id; state.doctor_name = doctors[0].name }
      else {
        const msgLower = message.toLowerCase()
        const matched  = doctors.find(d => msgLower.includes(d.name.toLowerCase().split(' ').pop()))
        if (matched) { state.doctor_id = matched.id; state.doctor_name = matched.name }
        else {
          const numMatch = message.match(/^\s*([1-9])\s*$/)
          if (numMatch) {
            const idx = parseInt(numMatch[1]) - 1
            if (idx >= 0 && idx < doctors.length) { state.doctor_id = doctors[idx].id; state.doctor_name = doctors[idx].name }
          }
          if (!state.doctor_id) return res.json({ reply: `Which doctor would you like to see?\n\n${formatDoctorList(doctors)}\n\nReply with the number or doctor's name.` })
        }
      }
    }

    if (!state.date) return res.json({ reply: `Great! Which date would you prefer? (e.g. tomorrow, 25th March, next Monday)` })

    const openCheck = await isClinicOpen(state.date)
    if (!openCheck.open) {
      const badDate = state.date; state.date = null
      return res.json({ reply: `Sorry, the clinic is closed on ${badDate}${openCheck.reason === 'holiday' ? ' for '+openCheck.name : ' (not a working day)'}. Please choose another date.` })
    }

    if (state.doctor_id && state.doctor_id !== 0) {
      const doc = await getDoctorById(state.doctor_id)
      if (doc && !isDoctorAvailableOnDate(doc, state.date)) {
        const badDate = state.date; state.date = null
        return res.json({ reply: `Sorry, ${state.doctor_name} is not available on ${badDate}. Please choose another date.` })
      }
    }

    if (!state.service) return res.json({ reply: `What service do you need? (e.g. checkup, tooth cleaning, consultation, x-ray)` })

    if (state.service && !state.service_duration) {
      const svc = await getServiceByName(state.service)
      state.service_duration = svc ? svc.duration_minutes : 30
    }

    const capReached = await isDailyCapReached(state.date, state.doctor_id)
    if (capReached) {
      const capDate = state.date; state.date = null; state.time = null
      return res.json({ reply: `Sorry, fully booked on ${capDate}. Say "waitlist" to join the waitlist, or choose another date.` })
    }

    if (!state.time) {
      let slots; try { slots = await getAvailableSlots(state.date) } catch(e) { return res.json({ reply: "Sorry, couldn't fetch slots. Please try again." }) }
      if (slots.length === 0) return res.json({ reply: `No slots on ${state.date}. Say "waitlist" to join the waitlist, or choose another date.` })
      return res.json({ reply: "Here are the available time slots. Please select one:", slots })
    }

    let slots; try { slots = await getAvailableSlots(state.date) } catch(e) { return res.json({ reply: "Couldn't verify slot." }) }
    if (!slots.includes(state.time)) {
      const badTime = state.time; state.time = null
      return res.json({ reply: `Sorry, ${badTime} is not available. Please pick from:`, slots })
    }

    if (state.notes === null) { state.notes = '__asking__'; return res.json({ reply: `Any symptoms or reason for visit?\n\nOr say skip.` }) }
    if (state.notes === '__asking__') {
      const t = message.toLowerCase().trim()
      state.notes = /^(skip|none|no|nope|nothing|na|no thanks|dont know|alright)[.!]?$/.test(t) ? '' : message.trim()
    }

    if (state.email === null) { state.email = '__asking__'; return res.json({ reply: `Would you like a reminder email? Share your email or say skip.` }) }
    if (state.email === '__asking__') {
      const t = message.trim()
      if (/^(skip|none|no|nope|no thanks|na)$/i.test(t)) state.email = ''
      else if (isValidEmail(t)) state.email = t.toLowerCase()
      else return res.json({ reply: `That doesn't look like a valid email. Please share a valid email or say skip.` })
    }

    state.intent = 'book'; state.step = 'confirming'
    return res.json({ reply: buildSummary(state) })
  }

  // ── MID-FLOW ──
  if (state.step === 'collecting') {
    if (!state.name)    return res.json({ reply: "What's your full name?" })
    if (!state.phone)   return res.json({ reply: "Please share your 10-digit phone number." })
    if (!state.date)    return res.json({ reply: "Which date would you like?" })
    if (!state.service) return res.json({ reply: "What service do you need?" })
    if (!state.time) {
      let slots; try { slots = await getAvailableSlots(state.date) } catch(e) { return res.json({ reply: "Couldn't fetch slots." }) }
      if (slots.length === 0) return res.json({ reply: `No slots on ${state.date}. Try another date?` })
      return res.json({ reply: "Here are the available time slots. Please select one:", slots })
    }
    if (state.notes === null) { state.notes = '__asking__'; return res.json({ reply: `Any symptoms or reason for visit?\n\nOr say skip.` }) }
    if (state.notes === '__asking__') {
      const t = message.toLowerCase().trim()
      state.notes = /^(skip|none|no|nope|nothing|na|no thanks|dont know|alright)[.!]?$/.test(t) ? '' : message.trim()
    }
    if (state.email === null) { state.email = '__asking__'; return res.json({ reply: `Would you like a reminder email? Share your email or say skip.` }) }
    if (state.email === '__asking__') {
      const t = message.trim()
      if (/^(skip|none|no|nope|no thanks|na)$/i.test(t)) state.email = ''
      else if (isValidEmail(t)) state.email = t.toLowerCase()
      else return res.json({ reply: `That doesn't look like a valid email. Please share a valid email or say skip.` })
    }
    state.intent = 'book'; state.step = 'confirming'
    return res.json({ reply: buildSummary(state) })
  }

  // ── SLOTS QUERY ──
  if (state.intent === 'slots' && state.step === 'idle') {
    const todayStr  = new Date().toISOString().split('T')[0]
    const queryDate = localDate || todayStr
    const dayNames  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
    const d         = new Date(queryDate + 'T00:00:00')
    const isToday    = queryDate === todayStr
    const isTomorrow = queryDate === (() => { const t = new Date(); t.setDate(t.getDate()+1); return t.toISOString().split('T')[0] })()
    const label      = isToday ? 'today' : isTomorrow ? 'tomorrow' : `${dayNames[d.getDay()]} ${queryDate}`

    const openThatDay = await isClinicOpen(queryDate)
    if (!openThatDay.open) return res.json({ reply: `Sorry, the clinic is closed on ${label}${openThatDay.reason==='holiday'?' for '+openThatDay.name:''}. Would you like to check another date?` })

    let slots; try { slots = await getAvailableSlots(queryDate) } catch(e) { return res.json({ reply: "Sorry, couldn't fetch slots." }) }

    if (localTime) {
      const isAvail = slots.includes(localTime)
      if (isAvail) return res.json({ reply: `Yes! ${localTime} is available ${label}. Tap to book:`, slots: [localTime], slotDate: queryDate })
      if (slots.length === 0) return res.json({ reply: `No slots ${label}. Would you like to check another date?` })
      return res.json({ reply: `Sorry, ${localTime} is taken ${label}. Available slots:`, slots, slotDate: queryDate })
    }

    const t = message.toLowerCase()
    let filtered = slots, filterLabel = ''
    if (/\bmorning\b/.test(t))                  { filtered = slots.filter(s => parseInt(s) < 12);  filterLabel = ' (morning)' }
    else if (/\b(afternoon|evening)\b/.test(t)) { filtered = slots.filter(s => parseInt(s) >= 12); filterLabel = ' (afternoon/evening)' }

    if (filtered.length === 0 && filterLabel) return res.json({ reply: `No ${filterLabel.trim()} slots ${label}. All available:`, slots, slotDate: queryDate })
    if (/\b(earliest|first|soonest)\b/.test(t) && filtered.length > 0) return res.json({ reply: `Earliest slot ${label}: ${filtered[0]}. Tap to book:`, slots: [filtered[0]], slotDate: queryDate })
    if (slots.length === 0) return res.json({ reply: `No slots ${label}. 😔 Would you like to check another date?` })

    return res.json({ reply: `Available slots${filterLabel} for ${label} — tap one to book:`, slots: filtered.length > 0 ? filtered : slots, slotDate: queryDate })
  }

  // ── QUICK ANSWERS ──
  const tLow = message.toLowerCase()
  if (/hour|time|open|close|timing/i.test(tLow))     return res.json({ reply: "We are open Monday to Saturday, 10:00 AM to 5:00 PM. Closed on Sundays and public holidays. 🕐" })
  if (/service|offer|treatment|provide/i.test(tLow)) return res.json({ reply: "We offer: Checkup, Tooth Cleaning, Root Canal, Consultation, X-Ray, Braces, Whitening, and more! Say 'book appointment' to get started. 😊" })
  if (/price|cost|fee|charge|how much/i.test(tLow))  return res.json({ reply: "For pricing, please visit the clinic or call us directly. 😊" })
  if (/location|address|where/i.test(tLow))          return res.json({ reply: "Please contact the clinic directly for our address. 📍" })

  // ── GENERAL CHAT ──
  const aiReply    = await chatReply(message, history)
  const finalReply = aiReply || "I'm here to help! Say 'book appointment' to get started or ask me anything about the clinic. 😊"

  history.push({ role: 'assistant', content: finalReply })
  if (history.length > 20) { const h = getHistory(userId); h.splice(0, h.length - 20) }

  return res.json({ reply: finalReply })
})

module.exports = router
