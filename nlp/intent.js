'use strict'

/* ================================================
   TYPO MAP + FUZZY NLP
================================================ */

const VOCAB = {
  slots:    ['available','availability','slot','slots','time','times','timing','timings','appointment','appointments','booking','bookings','free','open','empty','vacancy','vacancies','opening','openings','schedule'],
  temporal: ['today','tomorrow','yesterday','morning','afternoon','evening','night','monday','tuesday','wednesday','thursday','friday','saturday','sunday','week','month','january','february','march','april','may','june','july','august','september','october','november','december','next','this','last','earliest','soonest','first'],
  intent:   ['book','cancel','reschedule','check','confirm','yes','no','reset','show','find','view','change','update','correct'],
  clinic:   ['clinic','doctor','dentist','receptionist','service','checkup','cleaning','consultation','xray','braces','whitening','canal']
}
const ALL_VOCAB = Object.values(VOCAB).flat()

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m+1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[m][n]
}

function fixWord(word) {
  if (word.length <= 2 || /\d/.test(word) || ALL_VOCAB.includes(word)) return word
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
  'slto':'slot','sltos':'slots','solt':'slot','tiem':'time','tmie':'time',
  'avilable':'available','avialable':'available','availble':'available',
  'tomoro':'tomorrow','tomorow':'tomorrow','tomarrow':'tomorrow','tommorow':'tomorrow',
  'toady':'today','todya':'today','monay':'monday','tuesay':'tuesday',
  'wenesday':'wednesday','thirsday':'thursday','fridy':'friday','saterday':'saturday',
  'boo':'book','bok':'book','cancle':'cancel','cancell':'cancel',
  'appointmnt':'appointment','appoinment':'appointment','apointment':'appointment',
  'chekup':'checkup','reschedual':'reschedule','morming':'morning',
  'afernoon':'afternoon','evning':'evening',
}

function normalizeMessage(text) {
  return text.toLowerCase().trim().split(/\s+/).map(word => {
    if (/\d/.test(word)) return word
    const clean  = word.replace(/[^a-z]/g, '')
    const suffix = word.slice(clean.length)
    if (!clean) return word
    if (TYPO_MAP[clean]) return TYPO_MAP[clean] + suffix
    return fixWord(clean) + suffix
  }).join(' ')
}

/* ================================================
   INTENT DETECTION
================================================ */

function detectIntent(text) {
  const t = normalizeMessage(text).trim().toLowerCase()

  if (/\b(cancel|delete|remove)\b/.test(t) && /\b(appointment|booking|my|appt)\b/.test(t)) return 'cancel'
  if (/\b(reset|start over|restart|clear|begin again)\b/.test(t))    return 'reset'
  if (/\b(reschedule|change my appointment|move my appointment)\b/.test(t)) return 'reschedule'
  if (/\b(waitlist|wait list|add me to|put me on|join the|waiting list)\b/.test(t)) return 'waitlist'

  if (/\b(emergency|urgent|severe|unbearable|excruciating|bleeding|swollen|broken tooth|abscess|cannot eat|extreme pain)\b/.test(t)) return 'urgent'
  if (/\b(very bad|bad pain|lot of pain|too much pain|terrible pain|worst pain)\b/.test(t)) return 'urgent'
  if (/\b(need to see|need a doctor).{0,10}(now|today|asap|immediately|urgent)\b/.test(t)) return 'urgent'
  if (/\b(help|please help).{0,20}(pain|tooth|mouth|jaw|bleeding)\b/.test(t)) return 'urgent'

  if (/^(yes|yeah|yep|yup|y|confirm|confirmed|book it|go ahead|proceed|that'?s right|sounds good|perfect|done|correct)\s*[.!]?$/i.test(t)) return 'confirm'
  if (/^(no|nope|nah|n|wrong|incorrect|not right|cancel that|change it|go back)\s*[.!]?$/i.test(t)) return 'deny'

  if (/\b(my appointment|my booking|check my|view my|show my|find my|look up my|when is my)\b/.test(t)) return 'check'

  if (/\b(available|free|open|empty).{0,20}(slot|time|appointment|timing)\b/.test(t)) return 'slots'
  if (/\b(slot|time|timing|appointment).{0,20}(available|free|open|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(t)) return 'slots'
  if (/\b(slots?|times?|timings?|availability).{0,10}(on|for|this|next|today|tomorrow)\b/.test(t)) return 'slots'
  if (/\b(when can (i|we)|when (are|is) (you|the clinic))\b/.test(t)) return 'slots'
  if (/\b(do you have|is there|are there).{0,20}(any slot|any time|free|available)\b/.test(t)) return 'slots'
  if (/\b(earliest|next|first|soonest).{0,15}(available|free|slot|time|appointment)\b/.test(t)) return 'slots'
  if (/\b(morning|afternoon|evening).{0,10}(slot|time|available|free)\b/.test(t)) return 'slots'
  if (/^(any\s+)?(slot|slots|time|times|availability)\s*(today|tomorrow|pls|please)?$/i.test(t)) return 'slots'

  if (/\b(book|schedule|reserve|i want an appointment|make an appointment)\b/.test(t)) return 'book'

  return null
}

/* ================================================
   CORRECTION DETECTOR
================================================ */

function detectCorrection(text, aiDetails) {
  const t = text.toLowerCase()
  if (/\b(actually|change|update|correct|fix|wrong)\b/.test(t)) {
    if (/\b(name)\b/.test(t)              && aiDetails?.name)    return { field: 'name',    value: aiDetails.name }
    if (/\b(phone|number)\b/.test(t)      && aiDetails?.phone)   return { field: 'phone',   value: aiDetails.phone }
    if (/\b(date|day)\b/.test(t)          && aiDetails?.date)    return { field: 'date',    value: aiDetails.date }
    if (/\b(time|slot)\b/.test(t)         && aiDetails?.time)    return { field: 'time',    value: aiDetails.time }
    if (/\b(service|treatment)\b/.test(t) && aiDetails?.service) return { field: 'service', value: aiDetails.service }
  }
  return null
}

module.exports = { normalizeMessage, detectIntent, detectCorrection }
