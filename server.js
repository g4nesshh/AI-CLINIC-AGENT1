const express = require("express")
const db      = require("./database/db")

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.sendStatus(200)
  next()
})
app.use(express.static("public"))

/* ================================================
   RATE LIMITER — no external package needed
   Chat:  max 30 messages per minute per user
   Admin: max 60 requests per minute per IP
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

  if (data.count > maxRequests) return true
  return false
}

setInterval(() => {
  const now = Date.now()
  for (const key of Object.keys(rateLimits)) {
    if ((now - rateLimits[key].windowStart) > 120000) {
      delete rateLimits[key]
    }
  }
}, 120000)




/* ================================================
   IN-MEMORY STORE
================================================ */

const conversations   = {}
const bookingState    = {}
const rescheduleState = {}
const checkState      = {}

function getCheckState(userId) {
  if (!checkState[userId]) checkState[userId] = { phone: null, lastActivity: Date.now() }
  return checkState[userId]
}

function resetCheck(userId) { delete checkState[userId] }

function getRescheduleState(userId) {
  if (!rescheduleState[userId]) {
    rescheduleState[userId] = {
      step:         "idle",
      phone:        null,
      oldAppt:      null,
      newDate:      null,
      newTime:      null,
      lastActivity: Date.now()
    }
  }
  return rescheduleState[userId]
}

function resetReschedule(userId) {
  resetCheck(userId)
  delete rescheduleState[userId]
}

function getHistory(userId) {
  if (!conversations[userId]) conversations[userId] = []
  return conversations[userId]
}

function getState(userId) {
  if (!bookingState[userId]) {
    bookingState[userId] = {
      step:             "idle",
      intent:           null,
      name:             null,
      phone:            null,
      date:             null,
      time:             null,
      service:          null,
      service_duration: null,
      is_urgent:        false,
      wants_waitlist:   false,
      doctor_id:        null,
      doctor_name:      null,
      notes:            null,
      email:            null,
      lastActivity:     Date.now()
    }
  }
  return bookingState[userId]
}

function resetState(userId) {
  delete bookingState[userId]
  delete conversations[userId]
  resetReschedule(userId)
  resetCheck(userId)
}

/* ================================================
   SESSION EXPIRY
================================================ */

const SESSION_TTL    = 30 * 60 * 1000
const SWEEP_INTERVAL =  5 * 60 * 1000

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

  for (const userId of Object.keys(bookingState)) {
    if ((now - (bookingState[userId].lastActivity || 0)) > SESSION_TTL) {
      resetState(userId)
      cleared++
    }
  }

  for (const userId of Object.keys(rescheduleState)) {
    if ((now - (rescheduleState[userId].lastActivity || 0)) > SESSION_TTL) {
      resetReschedule(userId)
      cleared++
    }
  }

  for (const userId of Object.keys(checkState)) {
    if ((now - (checkState[userId].lastActivity || 0)) > SESSION_TTL) {
      resetCheck(userId)
      cleared++
    }
  }

  if (cleared > 0) console.log(`[Session Sweep] Cleared ${cleared} expired session(s)`)
}

setInterval(sweepExpiredSessions, SWEEP_INTERVAL)
console.log(`[Session] Expiry set to ${SESSION_TTL/60000} min, sweep every ${SWEEP_INTERVAL/60000} min`)


async function callAI(model, prompt) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500
      })
    })
    
    const MODELS = {
  conversation: "llama3-8b-8192",
  extraction:   "llama3-8b-8192"
}

    clearTimeout(timeout)
    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || ""

  } catch (err) {
    if (err.name === "AbortError") { console.error("AI timed out"); return "" }
    console.error("AI failed:", err.message)
    return ""
  }
}

/* ── Email validator ── */
function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim())
}

function isSimpleMessage(text) {
  const t = text.trim()
  if (/^\d{10}$/.test(t.replace(/[\s\-().]/g,''))) return true
  if (/^(yes|no|yeah|nope|yep|nah|ok|sure|correct|wrong|confirm|deny|cancel that)$/i.test(t)) return true
  if (/^\d{1,2}(:\d{2})?(\s*(am|pm))?$/i.test(t)) return true
  if (/^(today|tomorrow|day after tomorrow)$/i.test(t)) return true
  if (/^\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true
  if (t.length < 4) return true
  return false
}

async function extractDetails(message) {
  const today = new Date().toISOString().split("T")[0]

  const prompt = `You are a strict data extraction engine for a medical clinic booking system.
Today's date is ${today}.

Extract ONLY these fields from the user message below.
Apply each rule exactly:

RULES:
- intent  : one of ["book","cancel","reschedule","query","reset","confirm","deny"] or ""
- name    : person's full name only. Max 3 words. NO digits. NO dates. NO service names.
            Examples of valid names: "Ganesh", "Priya Mehta", "Raj Kumar Singh"
            Examples of INVALID names: "ganesh 9876543210", "march 20 checkup"
- phone   : exactly 10 consecutive digits only. No spaces, no dashes.
- date    : convert any date expression to YYYY-MM-DD using today=${today}.
            "tomorrow"=next day, "day after tomorrow"=+2 days,
            "next monday"=coming monday, "20th march"=current year march 20
- time    : convert to HH:MM 24-hour format.
            "10am"=10:00, "2pm"=14:00, "morning"=10:00, "afternoon"=14:00, "evening"=16:00
- service : the medical service requested. Short phrase only. e.g. "checkup","tooth cleaning","consultation"
- notes   : any symptom, complaint, or reason for visit mentioned. Only if explicitly mentioned.

If a field is not present or unclear, return exactly "".
Never guess. Never combine two fields into one.

Return ONLY this exact JSON (no markdown, no explanation):
{"intent":"","name":"","phone":"","date":"","time":"","service":"","notes":""}

User message: "${message}"`

  const raw = await callAI("llama3-8b-8192", prompt)

  const match = raw.match(/\{[\s\S]*?\}/)
  if (!match) return {}

  let parsed = {}
  try { parsed = JSON.parse(match[0]) } catch (e) { return {} }

  if (parsed.name) {
    parsed.name = parsed.name
      .replace(/\d+/g, "")
      .replace(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi, "")
      .replace(/\b(st|nd|rd|th)\b/gi, "")
      .replace(/[^a-zA-Z\s]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
    const words = parsed.name.split(/\s+/).filter(Boolean)
    if (words.length === 0 || words.length > 4 || parsed.name.length < 2) parsed.name = ""
  }

  if (parsed.phone) {
    parsed.phone = parsed.phone.replace(/\D/g, "")
    if (parsed.phone.length !== 10) parsed.phone = ""
  }

  if (parsed.date) {
    const td = new Date().toISOString().split("T")[0]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date) || parsed.date < td) parsed.date = ""
  }

  if (parsed.time) {
    if (!/^\d{2}:\d{2}$/.test(parsed.time)) parsed.time = ""
  }

  if (parsed.service) {
    parsed.service = parsed.service.replace(/[^a-zA-Z\s]/g, "").trim().toLowerCase()
    if (parsed.service.length < 2) parsed.service = ""
  }

  return parsed
}

/* ================================================
   NLP HELPERS — local fast parsers (fallback)
================================================ */

function fmt(d) { return d.toISOString().split("T")[0] }

/* ── Levenshtein + Fuzzy NLP ── */
function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m+1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[m][n]
}

const VOCAB = {
  slots:    ['available','availability','slot','slots','time','times','timing','timings','appointment','appointments','booking','bookings','free','open','empty','vacancy','vacancies','opening','openings','schedule'],
  temporal: ['today','tomorrow','yesterday','morning','afternoon','evening','night','monday','tuesday','wednesday','thursday','friday','saturday','sunday','week','month','january','february','march','april','may','june','july','august','september','october','november','december','next','this','last','earliest','soonest','first'],
  intent:   ['book','cancel','reschedule','check','confirm','yes','no','reset','show','find','view','change','update','correct'],
  clinic:   ['clinic','doctor','dentist','receptionist','service','checkup','cleaning','consultation','xray','braces','whitening','canal']
}
const ALL_VOCAB = Object.values(VOCAB).flat()

function fixWord(word) {
  if (word.length <= 2) return word
  if (/\d/.test(word)) return word
  if (ALL_VOCAB.includes(word)) return word

  let best = word, bestDist = Infinity

  for (const correct of ALL_VOCAB) {
    if (Math.abs(correct.length - word.length) > Math.max(3, word.length * 0.4)) continue
    const dist = levenshtein(word, correct)
    const threshold = word.length <= 5 ? 1 : word.length <= 8 ? 2 : 3
    if (dist < bestDist && dist <= threshold) { bestDist = dist; best = correct }
  }
  return best
}

const TYPO_MAP = {
  'slto':'slot','sltos':'slots','solt':'slot','solts':'slots','slt':'slot',
  'tiem':'time','tmie':'time','tiems':'times','timr':'time','tme':'time',
  'avilable':'available','avialable':'available','availble':'available',
  'availabel':'available','avalable':'available','avaliable':'available',
  'tomoro':'tomorrow','tomorow':'tomorrow','tomarrow':'tomorrow','tommorow':'tomorrow',
  'tomorro':'tomorrow','tomrrow':'tomorrow',
  'toady':'today','todya':'today','tdoay':'today',
  'monay':'monday','tuesay':'tuesday','wenesday':'wednesday',
  'thirsday':'thursday','fridy':'friday','saterday':'saturday',
  'boo':'book','bok':'book','boook':'book',
  'cancle':'cancel','cancell':'cancel','canel':'cancel',
  'appointmnt':'appointment','appoinment':'appointment','apointment':'appointment',
  'chekup':'checkup','reschedual':'reschedule','rescheudle':'reschedule',
  'morming':'morning','afernoon':'afternoon','evning':'evening',
  '10am':'10am','11am':'11am','12pm':'12pm','1pm':'1pm','2pm':'2pm',
  '3pm':'3pm','4pm':'4pm','5pm':'5pm','6pm':'6pm','7am':'7am','8am':'8am','9am':'9am',
  'ealiest':'earliest',
}

function normalizeMessage(text) {
  const words = text.toLowerCase().trim().split(/\s+/)
  const fixed = words.map(word => {
    if (/\d/.test(word)) return word
    const clean  = word.replace(/[^a-z]/g, '')
    const suffix = word.slice(clean.length)
    if (!clean) return word
    if (TYPO_MAP[clean]) return TYPO_MAP[clean] + suffix
    return fixWord(clean) + suffix
  })
  return fixed.join(' ')
}

function parseDate(text) {
  const t     = normalizeMessage(text).toLowerCase().trim()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const clone = d => new Date(d)

  if (t.includes("day after tomorrow")) { const d = clone(today); d.setDate(d.getDate()+2); return fmt(d) }
  if (t.includes("tomorrow"))           { const d = clone(today); d.setDate(d.getDate()+1); return fmt(d) }
  if (t.includes("today"))              return fmt(today)

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]
  for (let i = 0; i < weekdays.length; i++) {
    if (t.includes("next "+weekdays[i]) || t.includes("coming "+weekdays[i])) {
      const d = clone(today); let diff = i - d.getDay(); if (diff<=0) diff+=7; d.setDate(d.getDate()+diff); return fmt(d)
    }
    if (t.includes("this "+weekdays[i])) {
      const d = clone(today); let diff = i - d.getDay(); if (diff<0) diff+=7; d.setDate(d.getDate()+diff); return fmt(d)
    }
  }

  const months = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}

  const dmyMatch = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)(?:\s+(\d{4}))?/)
  if (dmyMatch) {
    const day=parseInt(dmyMatch[1]), month=months[dmyMatch[2]], year=dmyMatch[3]?parseInt(dmyMatch[3]):today.getFullYear()
    const d = new Date(year, month-1, day); if (d>=today) return fmt(d)
  }

  const mdyMatch = t.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/)
  if (mdyMatch) {
    const month=months[mdyMatch[1]], day=parseInt(mdyMatch[2]), year=mdyMatch[3]?parseInt(mdyMatch[3]):today.getFullYear()
    const d = new Date(year, month-1, day); if (d>=today) return fmt(d)
  }

  const isoMatch = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (isoMatch) return isoMatch[1]

  return null
}

function parseTime(text) {
  const t = normalizeMessage(text).toLowerCase().trim()

  if (t.includes("morning"))   return "10:00"
  if (t.includes("afternoon")) return "14:00"
  if (t.includes("evening"))   return "16:00"
  if (t.includes("night"))     return "18:00"

  const halfPast = t.match(/half\s+past\s+(\d{1,2})/)
  if (halfPast) { let h=parseInt(halfPast[1]); if(h<8)h+=12; return `${h.toString().padStart(2,"0")}:30` }

  const quarterPast = t.match(/quarter\s+past\s+(\d{1,2})/)
  if (quarterPast) { let h=parseInt(quarterPast[1]); if(h<8)h+=12; return `${h.toString().padStart(2,"0")}:15` }

  const quarterTo = t.match(/quarter\s+to\s+(\d{1,2})/)
  if (quarterTo) { let h=parseInt(quarterTo[1])-1; if(h<8)h+=12; return `${h.toString().padStart(2,"0")}:45` }

  const withColon = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/)
  if (withColon) {
    let h=parseInt(withColon[1]); const m=withColon[2], p=withColon[3]
    if(p==="pm"&&h<12)h+=12; if(p==="am"&&h===12)h=0
    return `${h.toString().padStart(2,"0")}:${m}`
  }

  const ampm = t.match(/\b(\d{1,2})\s*(am|pm)\b/)
  if (ampm) {
    let h=parseInt(ampm[1]); const p=ampm[2]
    if(p==="pm"&&h<12)h+=12; if(p==="am"&&h===12)h=0
    return `${h.toString().padStart(2,"0")}:00`
  }

  return null
}

function parsePhone(text) {
  const match = text.replace(/[\s\-().]/g,"").match(/\d{10}/)
  return match ? match[0] : null
}

/* ================================================
   CORRECTION DETECTOR
================================================ */

function detectCorrection(text, aiDetails) {
  const t = text.toLowerCase()
  if (/\b(actually|change|update|correct|fix|wrong)\b/.test(t)) {
    if (/\b(name)\b/.test(t)              && aiDetails && aiDetails.name)    return { field: "name",    value: aiDetails.name }
    if (/\b(phone|number)\b/.test(t)      && aiDetails && aiDetails.phone)   return { field: "phone",   value: aiDetails.phone }
    if (/\b(date|day)\b/.test(t)          && aiDetails && aiDetails.date)    return { field: "date",    value: aiDetails.date }
    if (/\b(time|slot)\b/.test(t)         && aiDetails && aiDetails.time)    return { field: "time",    value: aiDetails.time }
    if (/\b(service|treatment)\b/.test(t) && aiDetails && aiDetails.service) return { field: "service", value: aiDetails.service }
  }
  if (/\bmy name is\b/i.test(t))   return { field: "name",  value: null }
  if (/\bmy number is\b/i.test(t)) return { field: "phone", value: null }
  return null
}

/* ================================================
   INTENT DETECTION
================================================ */

function detectIntent(text) {
  const normalized = normalizeMessage(text)
  const t = normalized.trim().toLowerCase()

  if (/\b(cancel|delete|remove)\b/.test(t) && /\b(appointment|booking|my|appt|apnt)\b/.test(t)) return "cancel"
  if (/\b(reset|start over|restart|clear|begin again)\b/.test(t))    return "reset"
  if (/\b(reschedule|change my appointment|move my appointment)\b/.test(t)) return "reschedule"

  if (/\b(waitlist|wait list|wait.?list|add me to|put me on|join the|waiting list|on the list)\b/.test(t)) return "waitlist"

  if (/\b(emergency|urgent|severe|unbearable|excruciating|critical|accident|bleeding|swollen|broken tooth|knocked out|abscess|cannot eat|can't eat|cant eat|extreme pain)\b/.test(t)) return "urgent"
  if (/\b(very bad|bad pain|lot of pain|lots of pain|so much pain|too much pain|terrible pain|worst pain)\b/.test(t)) return "urgent"
  if (/\b(need to see|need a doctor|need dentist).{0,10}(now|today|asap|immediately|right now|urgent)\b/.test(t)) return "urgent"
  if (/\b(help|please help).{0,20}(pain|tooth|mouth|jaw|bleeding)\b/.test(t)) return "urgent"

  if (/^(yes|yeah|yep|yup|y|confirm|confirmed|book it|go ahead|proceed|that'?s right|sounds good|perfect|done|correct)\s*[.!]?$/i.test(t)) return "confirm"
  if (/^(no|nope|nah|n|wrong|incorrect|not right|cancel that|change it|go back)\s*[.!]?$/i.test(t)) return "deny"

  if (/\b(my appointment|my booking|check my|view my|show my|find my|look up my|when is my|what is my)\b/.test(t)) return "check"
  if (/\bcheck\b.{0,10}\b(my|the)\b.{0,20}\b(appointment|booking)\b/.test(t)) return "check"

  if (/\b(available|free|open|empty).{0,20}(slot|time|appointment|timing|booking)\b/.test(t)) return "slots"
  if (/\b(slot|time|timing|appointment).{0,20}(available|free|open|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(t)) return "slots"
  if (/\b(slots?|times?|timings?|availability).{0,10}(on|for|this|next|today|tomorrow)\b/.test(t)) return "slots"
  if (/\b(what|show|any|check).{0,15}(slot|time|timing|available|free|open).{0,15}(on|for|date|day|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(t)) return "slots"
  if (/\b(when can (i|we)|when (are|is) (you|the clinic)|when.{0,10}(come|visit|come in|drop by))\b/.test(t)) return "slots"
  if (/\b(do you have|have you got|is there|are there).{0,20}(anything|any slot|any time|any timing|any appointment|free|available)\b/.test(t)) return "slots"
  if (/\bis\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s+(available|free|open|taken|booked|free|there)\b/.test(t)) return "slots"
  if (/\b\d{1,2}\s*(am|pm)\s+(available|free|open|avalible|avalable)\b/.test(t)) return "slots"
  if (/\bwhat (times?|slots?|timings?|appointments?) (do you have|are (available|free|open)|have you got)\b/.test(t)) return "slots"
  if (/\b(earliest|next|first|soonest|nearest).{0,15}(available|free|open|slot|time|timing|appointment)\b/.test(t)) return "slots"
  if (/\b(morning|afternoon|evening|night).{0,10}(slot|time|timing|appointment|available|free)\b/.test(t)) return "slots"
  if (/\b(slot|time|timing|appointment).{0,10}(morning|afternoon|evening)\b/.test(t)) return "slots"
  if (/\bhow many.{0,20}(slot|time|timing|appointment)\b/.test(t)) return "slots"
  if (/\bcan (i|we|u) (come|visit|drop by|get an appointment|get in|come in).{0,30}(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|this week|next week)?\b/.test(t)) return "slots"
  if (/\b(any|have).{0,10}(opening|vacancy|vacancies|gap|space)\b/.test(t)) return "slots"
  if (/\bis there.{0,20}(slot|time|timing|appointment|available|free|opening)\b/.test(t)) return "slots"
  if (/\b(do you have|have you got).{0,20}(evening|morning|afternoon|night|slot|time|timing)\b/.test(t)) return "slots"
  if (/^(any\s+)?(slot|slots|time|times|timing|timings|availability)\s*(pls|please|today|tomorrow|tmrw|tmr)?$/i.test(t)) return "slots"
  if (/^(free|available|open)\s+(tmrw|tmr|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)$/i.test(t)) return "slots"
  if (/^(tomorrow|today|tmrw|tmr|monday|tuesday|wednesday|thursday|friday|saturday)\s+(slot|slots|time|times|free|available|open)$/i.test(t)) return "slots"
  if (/^(slot|slots|time|times)\s+(tmrw|tmr|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|morning|afternoon|evening)$/i.test(t)) return "slots"
  if (/^(morning|afternoon|evening)\s+(slot|slots|time|times|available|free)?$/i.test(t)) return "slots"
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tmrw)\b.{0,15}\b(free|available|open|slot|slots|time|times)\b/.test(t)) return "slots"
  if (/\b(cancl|cncl|canc|canel)\b.{0,10}\b(appt|apnt|apptmnt|apointmnt)\b/.test(t)) return "cancel"
  if (/^(cancl|cncl|canc)\s+(appt|appoint|appointmnt)$/i.test(t)) return "cancel"

  if (/\b(book|schedule|reserve|i want an appointment|make an appointment)\b/.test(t)) return "book"

  return null
}

/* ================================================
   SLOTS
================================================ */

async function getClinicConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => {
      if (err || !row) {
        resolve({ open_hour: 10, close_hour: 17, slot_duration: 30, clinic_name: 'ClinicAI Dental', open_days: 'Mon,Tue,Wed,Thu,Fri,Sat' })
      } else {
        resolve(row)
      }
    })
  })
}

function generateSlots(open_hour, close_hour, slot_duration) {
  const slots = []
  let current = open_hour * 60
  const end   = close_hour * 60
  while (current < end) {
    const h = Math.floor(current / 60).toString().padStart(2, '0')
    const m = (current % 60).toString().padStart(2, '0')
    slots.push(h + ':' + m)
    current += slot_duration
  }
  return slots
}

/* ── Holiday DB functions ── */

async function getHoliday(dateStr) {
  return new Promise((resolve) => {
    db.get("SELECT * FROM holidays WHERE date = ?", [dateStr], (err, row) => resolve(row || null))
  })
}

async function getAllHolidays() {
  return new Promise((resolve) => {
    db.all("SELECT * FROM holidays ORDER BY date", [], (err, rows) => resolve(rows || []))
  })
}

async function addHoliday(date, reason) {
  return new Promise((resolve) => {
    db.run("INSERT OR REPLACE INTO holidays (date, reason) VALUES (?, ?)", [date, reason],
      function(err) { resolve(err ? null : this.lastID) })
  })
}

async function deleteHoliday(id) {
  return new Promise((resolve) => {
    db.run("DELETE FROM holidays WHERE id = ?", [id], function(err) { resolve(!err && this.changes > 0) })
  })
}

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

function slotsNeeded(durationMinutes, slotDuration) {
  return Math.ceil(durationMinutes / slotDuration)
}

async function getAvailableSlots(date, serviceDuration) {
  const config    = await getClinicConfig()
  const allSlots  = generateSlots(config.open_hour, config.close_hour, config.slot_duration)
  const slotDur   = config.slot_duration || 30
  const needSlots = slotsNeeded(serviceDuration || slotDur, slotDur)

  return new Promise((resolve, reject) => {
    db.all("SELECT time, COALESCE(service_duration, ?) as dur FROM appointments WHERE date=?",
      [slotDur, date],
      (err, rows) => {
        if (err) return reject(err)
        const blocked = new Set()
        rows.forEach(row => {
          const startIdx = allSlots.indexOf(row.time)
          if (startIdx === -1) return
          const occupies = slotsNeeded(row.dur, slotDur)
          for (let i = 0; i < occupies; i++) {
            if (allSlots[startIdx + i]) blocked.add(allSlots[startIdx + i])
          }
        })
        const free = allSlots.filter((slot, idx) => {
          if (blocked.has(slot)) return false
          for (let i = 1; i < needSlots; i++) {
            const nextSlot = allSlots[idx + i]
            if (!nextSlot || blocked.has(nextSlot)) return false
          }
          return true
        })
        resolve(free)
      }
    )
  })
}

function formatSlots(slots) {
  if (slots.length === 0) return "No slots available on this date."
  return "Available time slots: " + slots.join(", ")
}

/* ── Daily cap check ── */
async function isDailyCapReached(date, doctorId) {
  const config    = await getClinicConfig()
  const maxPerDay = config.max_per_day || 20
  return new Promise((resolve) => {
    const sql    = doctorId && doctorId !== 0 ? "SELECT COUNT(*) as count FROM appointments WHERE date = ? AND doctor_id = ?" : "SELECT COUNT(*) as count FROM appointments WHERE date = ?"
    const params = doctorId && doctorId !== 0 ? [date, doctorId] : [date]
    db.get(sql, params, (err, row) => {
      if (err) return resolve(false)
      resolve((row.count || 0) >= maxPerDay)
    })
  })
}

/* ================================================
   WAITLIST DB FUNCTIONS
================================================ */

async function addToWaitlist(data) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO waitlist (name, phone, email, date, doctor_id, doctor_name, service, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.phone, data.email || '', data.date, data.doctor_id || null, data.doctor_name || null, data.service || 'Checkup', data.notes || ''],
      function(err) { resolve(err ? null : this.lastID) }
    )
  })
}

async function getWaitlistForDate(date, doctorId) {
  return new Promise((resolve) => {
    const sql    = doctorId ? "SELECT * FROM waitlist WHERE date = ? AND (doctor_id = ? OR doctor_id IS NULL) AND notified = 0 ORDER BY created_at" : "SELECT * FROM waitlist WHERE date = ? AND notified = 0 ORDER BY created_at"
    const params = doctorId ? [date, doctorId] : [date]
    db.all(sql, params, (err, rows) => resolve(rows || []))
  })
}

async function markWaitlistNotified(id) {
  return new Promise((resolve) => {
    db.run("UPDATE waitlist SET notified = 1 WHERE id = ?", [id], () => resolve())
  })
}

async function getAllWaitlist() {
  return new Promise((resolve) => {
    db.all("SELECT * FROM waitlist ORDER BY date, created_at", [], (err, rows) => resolve(rows || []))
  })
}

async function removeFromWaitlist(id) {
  return new Promise((resolve) => {
    db.run("DELETE FROM waitlist WHERE id = ?", [id], function(err) { resolve(!err && this.changes > 0) })
  })
}

async function notifyWaitlistOnCancel(date, time, doctorId) {
  const waiters = await getWaitlistForDate(date, doctorId)
  if (!waiters.length) return
  const first = waiters[0]
  await markWaitlistNotified(first.id)
  console.log(`[Waitlist] Slot opened on ${date} at ${time} — notifying ${first.name} (${first.phone})`)
  return first
}

/* ================================================
   URGENT BOOKING HELPERS
================================================ */

async function findEarliestSlot(preferDoctorId) {
  const config   = await getClinicConfig()
  const slotDur  = config.slot_duration || 30
  const today    = new Date().toISOString().split('T')[0]
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0] })()
  const now      = new Date()
  const nowTime  = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0')
  const dates    = [today, tomorrow]
  const doctors  = await getAllDoctors()

  for (const date of dates) {
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
      const available = await getAvailableSlots(date, 30)
      const future    = date === today ? available.filter(s => s > nowTime) : available
      if (future.length > 0) return { date, time: future[0], doctor: null }
    }
  }
  return null
}

/* ================================================
   DOCTOR DB FUNCTIONS
================================================ */

async function getAllDoctors() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM doctors WHERE active = 1 ORDER BY name", [], (err, rows) => {
      if (err) reject(err); else resolve(rows || [])
    })
  })
}

async function getDoctorById(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM doctors WHERE id = ? AND active = 1", [id], (err, row) => {
      if (err) reject(err); else resolve(row || null)
    })
  })
}

async function getAvailableSlotsForDoctor(doctorId, date, serviceDuration) {
  const config    = await getClinicConfig()
  const allSlots  = generateSlots(config.open_hour, config.close_hour, config.slot_duration)
  const slotDur   = config.slot_duration || 30
  const needSlots = slotsNeeded(serviceDuration || slotDur, slotDur)

  return new Promise((resolve, reject) => {
    db.all("SELECT time, COALESCE(service_duration, ?) as dur FROM appointments WHERE doctor_id = ? AND date = ?",
      [slotDur, doctorId, date],
      (err, rows) => {
        if (err) return reject(err)
        const blocked = new Set()
        rows.forEach(row => {
          const startIdx = allSlots.indexOf(row.time)
          if (startIdx === -1) return
          const occupies = slotsNeeded(row.dur, slotDur)
          for (let i = 0; i < occupies; i++) {
            if (allSlots[startIdx + i]) blocked.add(allSlots[startIdx + i])
          }
        })
        const free = allSlots.filter((slot, idx) => {
          if (blocked.has(slot)) return false
          for (let i = 1; i < needSlots; i++) {
            const nextSlot = allSlots[idx + i]
            if (!nextSlot || blocked.has(nextSlot)) return false
          }
          return true
        })
        resolve(free)
      }
    )
  })
}

function isDoctorAvailableOnDate(doctor, dateStr) {
  const dayNames  = ['sun','mon','tue','wed','thu','fri','sat']
  const d         = new Date(dateStr + 'T00:00:00')
  const dayName   = dayNames[d.getDay()]
  const availDays = (doctor.available_days || 'Mon,Tue,Wed,Thu,Fri,Sat').split(',').map(x => x.trim().toLowerCase())
  return availDays.includes(dayName)
}

/* ================================================
   SERVICE DB FUNCTIONS
================================================ */

async function getAllServices() {
  return new Promise((resolve) => {
    db.all("SELECT * FROM services WHERE active = 1 ORDER BY name", [], (err, rows) => resolve(rows || []))
  })
}

async function getServiceByName(name) {
  return new Promise((resolve) => {
    db.get("SELECT * FROM services WHERE LOWER(name) = LOWER(?) AND active = 1", [name], (err, row) => {
      if (row) return resolve(row)
      db.all("SELECT * FROM services WHERE active = 1", [], (err2, rows) => {
        if (!rows) return resolve(null)
        const lower = name.toLowerCase()
        const match = rows.find(s => lower.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(lower))
        resolve(match || null)
      })
    })
  })
}

function formatDoctorList(doctors) {
  return doctors.map((d, i) => `  ${i+1}. ${d.name} — ${d.specialization}`).join('\n')
}

/* ================================================
   DB OPERATIONS
================================================ */

async function bookAppointment(data) {
  return new Promise((resolve) => {
    db.run(
      "INSERT INTO appointments (name,phone,date,time,service,service_duration,doctor_id,doctor_name,notes,email,is_urgent) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [data.name, data.phone, data.date, data.time, data.service, data.service_duration || 30, data.doctor_id || null, data.doctor_name || null, data.notes || '', data.email || '', data.is_urgent ? 1 : 0],
      function(err) { resolve(err ? null : this.lastID) }
    )
  })
}

async function checkDuplicateBooking(phone, date, doctorId) {
  return new Promise((resolve, reject) => {
    const sql    = doctorId && doctorId !== 0 ? "SELECT id, time, service, doctor_name FROM appointments WHERE phone = ? AND date = ? AND doctor_id = ?" : "SELECT id, time, service, doctor_name FROM appointments WHERE phone = ? AND date = ?"
    const params = doctorId && doctorId !== 0 ? [phone, date, doctorId] : [phone, date]
    db.all(sql, params, (err, rows) => { if (err) return reject(err); resolve(rows) })
  })
}

async function cancelAppointment(data) {
  return new Promise((resolve) => {
    db.run("DELETE FROM appointments WHERE phone=? AND date=? AND time=?",
      [data.phone, data.date, data.time],
      function(err) {
        if (err) return resolve("error")
        if (this.changes > 0) {
          notifyWaitlistOnCancel(data.date, data.time, data.doctor_id).catch(() => {})
          resolve("cancelled")
        } else {
          resolve("not_found")
        }
      }
    )
  })
}

async function findAppointmentsByPhone(phone) {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM appointments WHERE phone = ? ORDER BY date, time", [phone],
      (err, rows) => { if (err) return reject(err); resolve(rows) })
  })
}

async function rescheduleAppointment(oldId, oldData, newDate, newTime) {
  return new Promise((resolve) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION")
      db.run("DELETE FROM appointments WHERE id = ?", [oldId], function(err) {
        if (err) { db.run("ROLLBACK"); return resolve("error") }
      })
      db.run(
        "INSERT INTO appointments (name, phone, date, time, service) VALUES (?, ?, ?, ?, ?)",
        [oldData.name, oldData.phone, newDate, newTime, oldData.service],
        function(err) {
          if (err) { db.run("ROLLBACK"); return resolve("slot_taken") }
          db.run("COMMIT")
          resolve(this.lastID)
        }
      )
    })
  })
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

/* ================================================
   EMAIL REMINDER SCHEDULER
================================================ */

let nodemailer = null
try {
  nodemailer = require('nodemailer')
  console.log('[Reminders] nodemailer loaded ✅')
} catch(e) {
  console.log('[Reminders] nodemailer not installed. Run: npm install nodemailer')
  console.log('[Reminders] Reminders disabled until nodemailer is installed.')
}

async function getSmtpConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

async function sendReminderEmail({ to, patientName, clinicName, doctorName, date, time, service, type }) {
  if (!nodemailer) return false
  if (!to || !to.includes('@')) return false

  const config = await getSmtpConfig()
  if (!config.smtp_user || !config.smtp_pass) {
    console.log('[Reminders] SMTP not configured — skipping email to', to)
    return false
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp_host || 'smtp.gmail.com',
      port: config.smtp_port || 587,
      secure: false,
      auth: { user: config.smtp_user, pass: config.smtp_pass }
    })

    const timeLabel = type === '24h' ? 'tomorrow' : type === 'waitlist' ? 'as a slot just opened' : 'in 1 hour'
    const subject   = `Reminder: Your appointment at ${clinicName || 'the clinic'} is ${timeLabel}`

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#0ea5e9">Appointment Reminder</h2>
        <p>Hello <strong>${patientName}</strong>,</p>
        <p>This is a reminder that you have an appointment <strong>${timeLabel}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0">
          <tr><td style="padding:8px;color:#666;width:120px">Clinic</td><td style="padding:8px;font-weight:bold">${clinicName}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#666">Doctor</td><td style="padding:8px">${doctorName || 'Any available'}</td></tr>
          <tr><td style="padding:8px;color:#666">Date</td><td style="padding:8px">${date}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px;color:#666">Time</td><td style="padding:8px">${time}</td></tr>
          <tr><td style="padding:8px;color:#666">Service</td><td style="padding:8px">${service}</td></tr>
        </table>
        <p style="color:#666">Please arrive 10 minutes early. If you need to cancel or reschedule, contact us as soon as possible.</p>
        <p style="color:#999;font-size:12px">This is an automated reminder from ${clinicName}.</p>
      </div>
    `

    await transporter.sendMail({ from: `"${clinicName}" <${config.smtp_user}>`, to, subject, html })
    console.log(`[Reminders] ${type} reminder sent to ${to} for ${date} ${time}`)
    return true

  } catch(err) {
    console.error('[Reminders] Failed to send email to', to, '—', err.message)
    return false
  }
}

async function runReminderJob() {
  if (!nodemailer) return
  const config = await getSmtpConfig()
  if (!config.smtp_user) return

  const now   = new Date()
  const nowMs = now.getTime()

  db.all(`
    SELECT * FROM appointments
    WHERE email != '' AND email IS NOT NULL
    AND date >= date('now')
    AND (reminder_24h = 0 OR reminder_1h = 0)
    ORDER BY date, time
  `, [], async (err, rows) => {
    if (err || !rows.length) return
    for (const appt of rows) {
      const apptDate = new Date(`${appt.date}T${appt.time}:00`)
      const diffMs   = apptDate.getTime() - nowMs
      const diffHrs  = diffMs / (1000 * 60 * 60)

      if (!appt.reminder_24h && diffHrs >= 23 && diffHrs <= 25) {
        const sent = await sendReminderEmail({ to: appt.email, patientName: appt.name, clinicName: config.clinic_name || 'ClinicAI', doctorName: appt.doctor_name, date: appt.date, time: appt.time, service: appt.service, type: '24h' })
        if (sent) db.run('UPDATE appointments SET reminder_24h = 1 WHERE id = ?', [appt.id])
      }

      if (!appt.reminder_1h && diffHrs >= 0.916 && diffHrs <= 1.083) {
        const sent = await sendReminderEmail({ to: appt.email, patientName: appt.name, clinicName: config.clinic_name || 'ClinicAI', doctorName: appt.doctor_name, date: appt.date, time: appt.time, service: appt.service, type: '1h' })
        if (sent) db.run('UPDATE appointments SET reminder_1h = 1 WHERE id = ?', [appt.id])
      }
    }
  })
}

setInterval(runReminderJob, 15 * 60 * 1000)
setTimeout(runReminderJob, 10000)
console.log('[Reminders] Scheduler started — checks every 15 minutes')

/* ================================================
   CHAT ENDPOINT
================================================ */

app.post("/chat", async (req, res) => {

  const raw     = (req.body.message || "").trim()
  const message = raw.slice(0, 500)
  const userId  = req.body.userId || req.ip

  if (!message) return res.json({ reply: "Please type a message." })
  if (raw.length > 500) return res.json({ reply: "⚠️ Your message is too long. Please keep it under 500 characters." })

  if (rateLimit(`chat:${userId}`, 30, 60000)) {
    return res.status(429).json({ reply: "⚠️ You're sending messages too fast. Please wait a moment and try again." })
  }

  const history = getHistory(userId)
  const state   = getState(userId)

  history.push({ role: "user", content: message })

  if (isExpired(userId)) {
    resetState(userId)
    return res.json({ reply: "Your session expired after 30 minutes of inactivity. No worries — how can I help you today?" })
  }

  touchSession(userId)

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
// Apply to state — never overwrite already set fields with null
  for (const key of ["intent","name","phone","date","time","service","notes"]) {
    if (merged[key]) state[key] = merged[key]
  }

  // ── Name fallback: if collecting and message looks like a plain name ──
 // ── Name fallback: if collecting and message looks like a plain name ──
  if (!state.name && (state.step === "collecting" || state.intent === "book")) {
    const t = message.trim()
    const isName = /^[a-zA-Z\s]{2,30}$/.test(t) &&
      t.split(' ').length <= 3 &&
      !detectIntent(t) &&
      !/\b(book|appointment|cancel|clinic|hours|service|slot|time|available|what|how|when|where|help)\b/i.test(t)
    if (isName) {
      state.name = t.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    }
  }

  // ── Mid-flow field correction
  if (state.step === "collecting" || state.step === "confirming") {
    const corrField = detectCorrection(message, null)
    if (corrField && typeof corrField === 'string') {
      state[corrField] = null
      state.step       = "collecting"
      const fieldLabels = { name:"name", phone:"phone number", date:"date", time:"time", service:"service" }
      if (corrField === "name"    && merged.name)    state.name    = merged.name
      if (corrField === "phone"   && merged.phone)   state.phone   = merged.phone
      if (corrField === "date"    && merged.date)     state.date    = merged.date
      if (corrField === "time"    && merged.time)     state.time    = merged.time
      if (corrField === "service" && merged.service)  state.service = merged.service
      if (!state[corrField]) {
        return res.json({ reply: `Sure! What is the correct ${fieldLabels[corrField]}?` })
      }
    }

    const correction = detectCorrection(message, aiDetails)
    if (correction && correction.field) {
      state[correction.field] = correction.value
      if (correction.field === "date") state.time = null
      const friendly = { name:"name", phone:"phone number", date:"date", time:"time", service:"service" }
      return res.json({ reply: `Got it! Updated your ${friendly[correction.field]} to "${correction.value}". ${state.step === "confirming" ? "Here is the updated summary:" : "Let's continue."}` })
    }
  }

  // ── RESET ─────────────────────────────────────────────
  if (state.intent === "reset") {
    resetState(userId)
    return res.json({ reply: "Conversation cleared! How can I help you today?" })
  }

  // ── CONFIRMING STEP ───────────────────────────────────
  if (state.step === "confirming") {

    if (state.intent === "confirm") {
      let existing
      try { existing = await checkDuplicateBooking(state.phone, state.date, state.doctor_id) }
      catch (e) { existing = [] }

      if (existing.length > 0) {
        const list    = existing.map(a => `${a.time} — ${a.service} (Ref #${a.id})`).join(", ")
        const badDate = state.date
        state.step = "collecting"; state.date = null; state.time = null
        return res.json({
          reply: `⚠️ You already have an appointment on ${badDate}:\n  ${list}\n\nWould you like to pick a different date, or cancel the existing one first?`
        })
      }

      const id = await bookAppointment(state)
      if (id) {
        const msg =
          `✅ Appointment confirmed!\n\n` +
          `  Ref #   : ${id}\n` +
          `  Name    : ${state.name}\n` +
          `  Doctor  : ${state.doctor_name || 'Any available'}\n` +
          `  Date    : ${state.date}\n` +
          `  Time    : ${state.time}\n` +
          `  Service : ${state.service}\n` +
          `  Notes   : ${state.notes && state.notes !== '__asking__' ? state.notes : 'None'}\n` +
          `\nPlease arrive 10 minutes early. ${state.email ? 'A confirmation email will be sent to ' + state.email + '.' : ''} See you! 😊`
        resetState(userId)
        return res.json({ reply: msg })
      } else {
        state.step = "collecting"; state.time = null
        const slots = await getAvailableSlots(state.date)
        return res.json({ reply: "Sorry, that slot was just taken! Please pick another:", slots })
      }
    }

    if (state.intent === "deny") {
      state.step = "collecting"
      return res.json({ reply: "No problem! What would you like to change — name, phone, date, time, or service?" })
    }

    return res.json({ reply: buildSummary(state) + "\n\n(Reply yes to confirm or no to change something)" })
  }

  // ── WAITLIST FLOW ─────────────────────────────────────
  if (state.intent === "waitlist" || state.wants_waitlist) {
    state.wants_waitlist = true
    state.step = "collecting"

    if (!state.name) return res.json({ reply: "I'll add you to the waitlist! What is your full name?" })
    if (!state.phone) return res.json({ reply: `Thanks ${state.name}! Please share your 10-digit phone number.` })
    if (!state.date) return res.json({ reply: "Which date would you like to be waitlisted for?" })
    if (!state.service) return res.json({ reply: "What service do you need? (e.g. checkup, cleaning, consultation)" })

    if (state.email === null) {
      state.email = "__asking__"
      return res.json({ reply: "Share your email to get notified when a slot opens up, or say skip." })
    }

    if (state.email === "__asking__") {
      const t = message.trim()
      const skip = /^(skip|none|no|nope|no thanks|na)$/i.test(t)
      state.email = skip ? "" : isValidEmail(t) ? t.toLowerCase() : ""
    }

    const wlId = await addToWaitlist(state)
    if (wlId) {
      const emailLine = state.email ? `\n\nWe'll email you at ${state.email} when a slot opens.` : `\n\nShare your email next time to get notified automatically.`
      resetState(userId)
      return res.json({
        reply:
          `✅ You've been added to the waitlist!\n\n` +
          `  Name    : ${state.name || 'You'}\n` +
          `  Date    : ${state.date}\n` +
          `  Service : ${state.service}\n` +
          `\nWe'll contact you as soon as a slot opens up on that date.${emailLine}`
      })
    } else {
      return res.json({ reply: "Sorry, couldn't add you to the waitlist. Please try again." })
    }
  }

  // ── URGENT / EMERGENCY FLOW ───────────────────────────
  if (state.intent === "urgent") {
    state.is_urgent = true
    state.intent    = "book"

    const symptomsNote = message.trim()
    let earliest = null
    try { earliest = await findEarliestSlot(state.doctor_id || null) }
    catch(e) { earliest = null }

    if (!earliest) {
      return res.json({ reply: `🚨 I'm sorry to hear you're in pain. Unfortunately we have no available slots today or tomorrow.\n\nPlease call the clinic directly for emergency assistance.` })
    }

    state.date  = earliest.date
    state.time  = earliest.time
    state.notes = `URGENT: ${symptomsNote}`
    if (earliest.doctor) { state.doctor_id = earliest.doctor.id; state.doctor_name = earliest.doctor.name }

    const isToday = earliest.date === new Date().toISOString().split('T')[0]
    const label   = isToday ? 'today' : 'tomorrow'
    const docLine = earliest.doctor ? `\n  Doctor  : ${earliest.doctor.name}` : ''

    return res.json({
      reply:
        `🚨 Emergency booking — I'll get you seen as soon as possible!\n\n` +
        `Earliest slot available:\n` +
        `  Date    : ${earliest.date} (${label})\n` +
        `  Time    : ${earliest.time}${docLine}\n\n` +
        `To confirm this urgent appointment, I just need a few details.\n` +
        `What is your full name?`
    })
  }

  // ── CHECK APPOINTMENT FLOW ────────────────────────────
  if (state.intent === "check") {
    const cs = getCheckState(userId)
    if (!cs.phone) cs.phone = state.phone || localPhone || null
    if (!cs.phone) return res.json({ reply: "Sure! Please share your 10-digit phone number and I'll look up your appointments." })

    let appts
    try { appts = await findAppointmentsByPhone(cs.phone) }
    catch (e) { return res.json({ reply: "Sorry, couldn't fetch appointments right now. Please try again." }) }

    resetCheck(userId)
    state.intent = null

    if (appts.length === 0) return res.json({ reply: `No appointments found for number ${cs.phone}. Would you like to book one?` })

    const today    = new Date().toISOString().split("T")[0]
    const upcoming = appts.filter(a => a.date >= today)
    const past     = appts.filter(a => a.date <  today)

    let reply = `Found ${appts.length} appointment(s) for ${cs.phone}:\n`
    if (upcoming.length > 0) { reply += `\n📅 Upcoming:\n`; upcoming.forEach((a, i) => { reply += `  ${i+1}. ${a.date} at ${a.time} — ${a.service} (Ref #${a.id})\n` }) }
    if (past.length > 0)     { reply += `\n🕐 Past:\n`;     past.forEach((a, i) => { reply += `  ${i+1}. ${a.date} at ${a.time} — ${a.service} (Ref #${a.id})\n` }) }
    if (upcoming.length > 0) reply += `\nWould you like to reschedule or cancel any of these?`
    else reply += `\nNo upcoming appointments. Would you like to book a new one?`
    return res.json({ reply })
  }

  // ── CANCEL FLOW ───────────────────────────────────────
  if (state.intent === "cancel") {
    if (!state.phone) return res.json({ reply: "To cancel an appointment, please share your 10-digit phone number." })
    if (!state.date)  return res.json({ reply: "Which date is the appointment you want to cancel?" })
    if (!state.time)  return res.json({ reply: "What time is the appointment?" })

    const result = await cancelAppointment(state)
    resetState(userId)
    if (result === "cancelled") return res.json({ reply: "✅ Your appointment has been successfully cancelled." })
    if (result === "not_found") return res.json({ reply: "❌ No appointment found with those details. Please check the date and time." })
    return res.json({ reply: "Something went wrong. Please try again." })
  }

  // ── RESCHEDULE FLOW ───────────────────────────────────
  if (state.intent === "reschedule") {
    const rs = getRescheduleState(userId)

    if (!rs.phone) rs.phone = state.phone || null
    if (!rs.phone) return res.json({ reply: "Sure, I can reschedule! Please share your 10-digit phone number so I can find your appointment." })

    if (!rs.oldAppt) {
      let appts
      try { appts = await findAppointmentsByPhone(rs.phone) }
      catch (e) { return res.json({ reply: "Sorry, could not look up appointments. Please try again." }) }

      if (appts.length === 0) {
        resetReschedule(userId); state.intent = null
        return res.json({ reply: `No appointments found for phone number ${rs.phone}. Please check the number and try again.` })
      }

      if (appts.length === 1) {
        rs.oldAppt = appts[0]; rs.step = "picked"
        return res.json({ reply: `Found your appointment:\n\n  Date    : ${rs.oldAppt.date}\n  Time    : ${rs.oldAppt.time}\n  Service : ${rs.oldAppt.service}\n\nWhat new date would you like?` })
      }

      const list = appts.map((a, i) => `  ${i+1}. ${a.date} at ${a.time} — ${a.service}`).join('\n')
      rs.step = "finding"; rs.allAppts = appts
      return res.json({ reply: `Found ${appts.length} appointments:\n${list}\n\nWhich one would you like to reschedule? (Reply with the number)` })
    }

    if (rs.step === "finding" && rs.allAppts) {
      const numMatch = message.match(/\b([1-9])\b/)
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1
        if (idx >= 0 && idx < rs.allAppts.length) {
          rs.oldAppt = rs.allAppts[idx]; rs.step = "picked"
          return res.json({ reply: `Got it! Rescheduling:\n  ${rs.oldAppt.date} at ${rs.oldAppt.time} — ${rs.oldAppt.service}\n\nWhat new date would you prefer?` })
        }
      }
      return res.json({ reply: "Please reply with the number of the appointment you want to reschedule (e.g. 1, 2, 3)." })
    }

    if (!rs.newDate) rs.newDate = state.date || localDate || null
    if (!rs.newDate) return res.json({ reply: "What new date would you like? (e.g. tomorrow, 25th March, next Monday)" })

    if (!rs.newTime) rs.newTime = state.time || localTime || null
    if (!rs.newTime) {
      let slots
      try { slots = await getAvailableSlots(rs.newDate) }
      catch (e) { return res.json({ reply: "Could not fetch slots. Please try again." }) }
      if (slots.length === 0) { const bad = rs.newDate; rs.newDate = null; return res.json({ reply: `No slots available on ${bad}. Please choose another date.` }) }
      return res.json({ reply: `${formatSlots(slots)}\n\nWhich time works for you?` })
    }

    let slots
    try { slots = await getAvailableSlots(rs.newDate) }
    catch (e) { return res.json({ reply: "Could not verify slot. Please try again." }) }

    if (!slots.includes(rs.newTime)) {
      const bad = rs.newTime; rs.newTime = null
      return res.json({ reply: `Sorry, ${bad} is not available on ${rs.newDate}.\n\n${formatSlots(slots)}\n\nPlease pick another time.` })
    }

    if (rs.step !== "confirming") {
      rs.step = "confirming"
      return res.json({ reply: `📋 Reschedule Summary\n\n  From : ${rs.oldAppt.date} at ${rs.oldAppt.time}\n  To   : ${rs.newDate} at ${rs.newTime}\n  Name : ${rs.oldAppt.name}\n  Service: ${rs.oldAppt.service}\n\nConfirm? Reply yes or no.` })
    }

    const rsYes = /\b(yes|confirm|correct|go ahead|proceed|sure|ok|yep|yeah)\b/i.test(message)
    const rsNo  = /\b(no|nope|wrong|change|different|cancel)\b/i.test(message)

    if (rs.step === "confirming" && rsYes) {
      const newId = await rescheduleAppointment(rs.oldAppt.id, rs.oldAppt, rs.newDate, rs.newTime)
      resetReschedule(userId); state.intent = null
      if (newId === "slot_taken") return res.json({ reply: "Sorry, that slot was just taken by someone else! Please pick another time." })
      if (newId === "error")      return res.json({ reply: "Something went wrong. Please try again." })
      return res.json({ reply: `✅ Appointment rescheduled!\n\n  Ref #   : ${newId}\n  Name    : ${rs.oldAppt.name}\n  New Date: ${rs.newDate}\n  New Time: ${rs.newTime}\n  Service : ${rs.oldAppt.service}\n\nPlease arrive 10 minutes early. See you! 😊` })
    }

    if (rs.step === "confirming" && rsNo) {
      rs.step = "picked"; rs.newDate = null; rs.newTime = null
      return res.json({ reply: "No problem! What new date and time would you like instead?" })
    }

    return res.json({ reply: `📋 Reschedule Summary\n\n  From : ${rs.oldAppt.date} at ${rs.oldAppt.time}\n  To   : ${rs.newDate} at ${rs.newTime}\n\nReply yes to confirm or no to change.` })
  }

  // ── BOOK FLOW ─────────────────────────────────────────
  if (state.intent === "book") {
    state.step = "collecting"

    if (!state.name) return res.json({ reply: "I'd be happy to book an appointment! May I have your full name?" })
    if (!state.phone) return res.json({ reply: `Thanks ${state.name}! Please share your 10-digit phone number.` })

    // ── Doctor selection ──────────────────────────────
    if (!state.doctor_id) {
      let doctors
      try { doctors = await getAllDoctors() } catch(e) { doctors = [] }

      if (doctors.length === 0) {
        state.doctor_id = 0; state.doctor_name = "Any available doctor"
      } else if (doctors.length === 1) {
        state.doctor_id = doctors[0].id; state.doctor_name = doctors[0].name
      } else {
        const msgLower = message.toLowerCase()
        const matched  = doctors.find(d => msgLower.includes(d.name.toLowerCase().split(' ').pop()))
        if (matched) {
          state.doctor_id = matched.id; state.doctor_name = matched.name
        } else {
          const numMatch = message.match(/^\s*([1-9])\s*$/)
          if (numMatch) {
            const idx = parseInt(numMatch[1]) - 1
            if (idx >= 0 && idx < doctors.length) { state.doctor_id = doctors[idx].id; state.doctor_name = doctors[idx].name }
          }
          if (!state.doctor_id) {
            return res.json({ reply: `Which doctor would you like to see?\n\n${formatDoctorList(doctors)}\n\nReply with the number or the doctor's name.` })
          }
        }
      }
    }

    if (!state.date) return res.json({ reply: `Great! Which date would you prefer? (e.g. tomorrow, 20th March, next Monday)` })

    const openCheck = await isClinicOpen(state.date)
    if (!openCheck.open) {
      const badDate = state.date; state.date = null
      const reason  = openCheck.reason === 'holiday' ? `the clinic is closed on ${badDate} for ${openCheck.name}` : `the clinic is closed on ${badDate} (not a working day)`
      return res.json({ reply: `Sorry, ${reason}. Please choose another date.` })
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
      return res.json({ reply: `Sorry, ${state.doctor_name || 'the clinic'} is fully booked on ${capDate}.\n\nSay "waitlist" to join the waitlist for that date, or choose a different date.` })
    }

    if (!state.time) {
      let slots
      try { slots = await getAvailableSlots(state.date) }
      catch (e) { return res.json({ reply: "Sorry, couldn't fetch slots. Please try again." }) }

      if (slots.length === 0) {
        return res.json({
          reply:
            `No slots available for ${state.doctor_name || 'any doctor'} on ${state.date}.\n\n` +
            `You can:\n  1. Choose a different date\n  2. Join the waitlist for ${state.date} — we'll notify you if a slot opens\n\n` +
            `Say "waitlist" to join, or share another date.`
        })
      }

      return res.json({ reply: "Here are the available time slots. Please select one:", slots })
    }

    let slots
    try { slots = await getAvailableSlots(state.date) }
    catch (e) { return res.json({ reply: "Couldn't verify slot availability. Please try again." }) }

    if (!slots.includes(state.time)) {
      const badTime = state.time; state.time = null
      return res.json({ reply: `Sorry, ${badTime} is not available. Please pick from the options below:`, slots })
    }

    // ── Ask for notes (optional) ──────────────────────
    if (state.notes === null) {
      state.notes = "__asking__"
      return res.json({ reply: `Almost done! Any symptoms or reason for visit the doctor should know?\n\n(e.g. tooth pain for 3 days, bleeding gums, sensitivity to cold)\n\nOr say skip to proceed.` })
    }

    if (state.notes === "__asking__") {
      const t    = message.toLowerCase().trim()
      const skip = /^(skip|none|no|nope|nothing|na|no thanks|dont know|alright)[.!]?$/.test(t)
      state.notes = skip ? "" : message.trim()
    }

    // ── Ask for email (optional) ──────────────────────
    if (state.email === null) {
      state.email = "__asking__"
      return res.json({ reply: `Would you like to receive a reminder email before your appointment?\n\nIf yes, please share your email address. Or say skip.` })
    }

    if (state.email === "__asking__") {
      const t    = message.trim()
      const skip = /^(skip|none|no|nope|no thanks|na)$/i.test(t)
      if (skip) {
        state.email = ""
      } else if (isValidEmail(t)) {
        state.email = t.toLowerCase()
      } else {
        return res.json({ reply: `That doesn't look like a valid email address. Please share a valid email or say skip.` })
      }
    }

    // All fields ready — show confirmation
    state.intent = "book"
    state.step   = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── MID-FLOW: collecting but no clear intent ──────────
  if (state.step === "collecting") {
    if (!state.name)    return res.json({ reply: "What's your full name?" })
    if (!state.phone)   return res.json({ reply: "Please share your 10-digit phone number." })
    if (!state.date)    return res.json({ reply: "Which date would you like?" })
    if (!state.service) return res.json({ reply: "What service do you need?" })

    if (!state.time) {
      let slots
      try { slots = await getAvailableSlots(state.date) }
      catch (e) { return res.json({ reply: "Couldn't fetch slots. Please try again." }) }
      if (slots.length === 0) return res.json({ reply: `No slots on ${state.date}. Try another date?` })
      return res.json({ reply: "Here are the available time slots. Please select one:", slots })
    }

    if (state.notes === null) {
      state.notes = "__asking__"
      return res.json({ reply: `One last thing — any symptoms or reason for visit the doctor should know?\n\nOr say skip to proceed.` })
    }

    if (state.notes === "__asking__") {
      const t    = message.toLowerCase().trim()
      const skip = /^(skip|none|no|nope|nothing|na|no thanks|dont know|alright)[.!]?$/.test(t)
      state.notes = skip ? "" : message.trim()
    }

    if (state.email === null) {
      state.email = "__asking__"
      return res.json({ reply: `Would you like a reminder email? Share your email address or say skip.` })
    }

    if (state.email === "__asking__") {
      const t    = message.trim()
      const skip = /^(skip|none|no|nope|no thanks|na)$/i.test(t)
      if (skip) {
        state.email = ""
      } else if (isValidEmail(t)) {
        state.email = t.toLowerCase()
      } else {
        return res.json({ reply: `That doesn't look like a valid email. Please share a valid email or say skip.` })
      }
    }

    state.intent = "book"
    state.step   = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── SLOTS QUERY — only when NOT mid-booking ───────────
  if (state.intent === "slots" && state.step === "idle" && !rescheduleState[userId]) {
    const todayStr = new Date().toISOString().split("T")[0]
    const queryDate = localDate || todayStr

    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
    const d         = new Date(queryDate + "T00:00:00")
    const isToday    = queryDate === todayStr
    const isTomorrow = queryDate === (() => { const t = new Date(); t.setDate(t.getDate()+1); return t.toISOString().split("T")[0] })()
    const label      = isToday ? "today" : isTomorrow ? "tomorrow" : `${dayNames[d.getDay()]} ${queryDate}`

    const openThatDay = await isClinicOpen(queryDate)
    if (!openThatDay.open) {
      const closeReason = openThatDay.reason === 'holiday'
        ? `the clinic is closed on ${label} for ${openThatDay.name}`
        : `the clinic is closed on ${dayNames[d.getDay()]}s (not a working day)`
      return res.json({ reply: `Sorry, ${closeReason}. Would you like to check another date?` })
    }

    let slots
    try { slots = await getAvailableSlots(queryDate) }
    catch (e) { return res.json({ reply: "Sorry, couldn't fetch slots right now. Please try again." }) }

    if (localTime) {
      const isAvailable = slots.includes(localTime)
      if (isAvailable) return res.json({ reply: `Yes! ${localTime} is available ${label}. Tap to book it:`, slots: [localTime], slotDate: queryDate })
      if (slots.length === 0) return res.json({ reply: `Sorry, ${localTime} is not available and there are no other slots ${label}. Would you like to check another date?` })
      return res.json({ reply: `Sorry, ${localTime} is already taken ${label}. Here are the available slots — tap one to book:`, slots, slotDate: queryDate })
    }

    const t = message.toLowerCase()
    let filtered = slots, filterLabel = ""
    if (/\bmorning\b/.test(t))          { filtered = slots.filter(s => parseInt(s) < 12);  filterLabel = " (morning)" }
    else if (/\b(afternoon|evening)\b/.test(t)) { filtered = slots.filter(s => parseInt(s) >= 12); filterLabel = " (afternoon/evening)" }

    if (filtered.length === 0 && filterLabel) {
      return res.json({ reply: `No ${filterLabel.trim()} slots available ${label}. Here are all available slots:`, slots, slotDate: queryDate })
    }

    if (/\b(earliest|first|soonest|next)\b/.test(t) && filtered.length > 0) {
      return res.json({ reply: `The earliest available slot ${label} is ${filtered[0]}. Tap to book:`, slots: [filtered[0]], slotDate: queryDate })
    }

    if (slots.length === 0) return res.json({ reply: `No slots available ${label}. 😔 Would you like to check another date?` })

    return res.json({ reply: `Available slots${filterLabel} for ${label} — tap one to book:`, slots: filtered.length > 0 ? filtered : slots, slotDate: queryDate })
  }

  // ── GENERAL CHAT ──────────────────────────────────────
  const systemPrompt =
    `You are a smart, friendly receptionist at ClinicAI dental clinic.\n` +
    `Answer patient questions clearly and helpfully. Keep replies short and warm.\n\n` +
    `CLINIC INFO:\n` +
    `- Services: checkup, tooth cleaning, root canal, consultation, x-ray, braces, whitening\n` +
    `- Hours: Monday to Saturday, 10am to 5pm (closed Sundays)\n` +
    `- Slots: every 30 minutes from 10:00 to 16:30\n` +
    `- To book: patient needs to share their name, phone, date, service, and preferred time\n\n` +
    `RULES:\n` +
    `- If asked about available slots/times, tell them to say "available slots for [date]"\n` +
    `- If asked to book, guide them: "Just say 'book appointment' to get started!"\n` +
    `- If asked to check their booking, say: "Say 'check my appointment' with your phone number"\n` +
    `- If asked to cancel or reschedule, guide them to say those exact words\n` +
    `- Never make up appointment details, prices, or doctor names\n` +
    `- If unsure, say "I'm not sure about that, but I can help you book or check appointments!"\n\n` +
    `Conversation so far:\n` +
    history.slice(-6).map(h => `${h.role==="user"?"Patient":"Receptionist"}: ${h.content}`).join("\n") +
    `\nPatient: ${message}\nReceptionist:`

  const aiReply    = await callAI("llama3-8b-8192", systemPrompt)
  const finalReply = aiReply || "I'm here to help! You can ask about our services or say 'book appointment' to schedule a visit."

  history.push({ role: "assistant", content: finalReply })
  if (history.length > 20) conversations[userId] = history.slice(-20)

  return res.json({ reply: finalReply })
})

/* ================================================
   ADMIN ROUTES
================================================ */

app.get("/clinic-config", (req, res) => {
  db.get("SELECT * FROM clinic_config WHERE id = 1", [], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(row)
  })
})

app.put("/clinic-config", (req, res) => {
  const { clinic_name, open_hour, close_hour, slot_duration, open_days, clinic_email, smtp_host, smtp_port, smtp_user, smtp_pass } = req.body
  db.run(
    `UPDATE clinic_config SET clinic_name=?, open_hour=?, close_hour=?, slot_duration=?, open_days=?, clinic_email=?, smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=? WHERE id=1`,
    [clinic_name, open_hour, close_hour, slot_duration, open_days, clinic_email||'', smtp_host||'smtp.gmail.com', smtp_port||587, smtp_user||'', smtp_pass||''],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, message: "Config updated" })
    }
  )
})

app.post("/test-email", async (req, res) => {
  const { to } = req.body
  if (!to) return res.status(400).json({ error: "email required" })
  const config = await getSmtpConfig()
  const sent = await sendReminderEmail({ to, patientName: "Admin", clinicName: config.clinic_name || 'ClinicAI', doctorName: "Dr. Test", date: new Date().toISOString().split('T')[0], time: "10:00", service: "Test Appointment", type: "24h" })
  if (sent) res.json({ success: true })
  else res.status(500).json({ error: "Failed to send — check SMTP settings" })
})

app.get("/waitlist", async (req, res) => {
  try { res.json(await getAllWaitlist()) }
  catch { res.status(500).json({ error: "DB error" }) }
})

app.delete("/waitlist/:id", async (req, res) => {
  const ok = await removeFromWaitlist(req.params.id)
  if (ok) res.json({ success: true })
  else res.status(404).json({ error: "Not found" })
})

app.get("/services", async (req, res) => {
  try { res.json(await getAllServices()) }
  catch { res.status(500).json({ error: "DB error" }) }
})

app.post("/services", (req, res) => {
  const { name, duration_minutes } = req.body
  if (!name) return res.status(400).json({ error: "name required" })
  db.run("INSERT OR REPLACE INTO services (name, duration_minutes) VALUES (?, ?)", [name, duration_minutes || 30],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, id: this.lastID })
    })
})

app.put("/services/:id", (req, res) => {
  const { name, duration_minutes, active } = req.body
  db.run("UPDATE services SET name=?, duration_minutes=?, active=? WHERE id=?", [name, duration_minutes || 30, active ?? 1, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true })
    })
})

app.delete("/services/:id", (req, res) => {
  db.run("UPDATE services SET active=0 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

app.get("/doctors", (req, res) => {
  db.all("SELECT * FROM doctors ORDER BY name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(rows)
  })
})

app.post("/doctors", (req, res) => {
  const { name, specialization, available_days } = req.body
  if (!name || !specialization) return res.status(400).json({ error: "name and specialization required" })
  db.run("INSERT INTO doctors (name, specialization, available_days) VALUES (?, ?, ?)", [name, specialization, available_days || 'Mon,Tue,Wed,Thu,Fri,Sat'],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, id: this.lastID })
    })
})

app.put("/doctors/:id", (req, res) => {
  const { name, specialization, available_days, active } = req.body
  db.run("UPDATE doctors SET name=?, specialization=?, available_days=?, active=? WHERE id=?", [name, specialization, available_days, active ?? 1, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true })
    })
})

app.delete("/doctors/:id", (req, res) => {
  db.run("UPDATE doctors SET active=0 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

app.get("/holidays", async (req, res) => {
  try { res.json(await getAllHolidays()) }
  catch { res.status(500).json({ error: "DB error" }) }
})

app.post("/holidays", async (req, res) => {
  const { date, reason } = req.body
  if (!date) return res.status(400).json({ error: "date required" })
  const id = await addHoliday(date, reason || 'Clinic Holiday')
  if (id) res.json({ success: true, id })
  else res.status(500).json({ error: "DB error" })
})

app.delete("/holidays/:id", async (req, res) => {
  const ok = await deleteHoliday(req.params.id)
  if (ok) res.json({ success: true })
  else res.status(404).json({ error: "Not found" })
})

app.get("/appointments/today", (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: "Too many requests." })
  const today = new Date().toISOString().split('T')[0]
  db.all(`SELECT a.*, d.name as doctor_name_live, d.specialization FROM appointments a LEFT JOIN doctors d ON a.doctor_id = d.id WHERE a.date = ? ORDER BY a.time`, [today],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json(rows)
    })
})

app.get("/appointments", (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: "Too many requests. Slow down." })
  db.all(`SELECT a.*, d.name as doctor_name_live, d.specialization FROM appointments a LEFT JOIN doctors d ON a.doctor_id = d.id ORDER BY a.date, a.time`, [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json(rows)
    })
})

app.delete("/appointments/:id", (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: "Too many requests. Slow down." })
  db.run("DELETE FROM appointments WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    if (this.changes === 0) return res.status(404).json({ error: "Not found" })
    res.json({ success: true })
  })
})

/* ================================================
   START
================================================ */

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ClinicAI running on port ${PORT}`)
})