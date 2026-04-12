'use strict'

const { callAI } = require('./extract')

/* ================================================
   AI TRIAGE
   Patient describes symptoms → AI suggests:
   - Which service they need
   - Urgency level
   - Short explanation
   - Whether to fast-track to urgent booking
================================================ */

async function triageSymptoms(message, availableServices) {
  const serviceList = availableServices.length
    ? availableServices.map(s => s.name).join(', ')
    : 'Checkup, Consultation, X-Ray, Cleaning, Root Canal, Extraction'

  const prompt = `You are a medical receptionist AI for a clinic.
A patient has described their symptoms or concern. Suggest the most appropriate service.

Available services at this clinic: ${serviceList}

Patient message: "${message}"

Analyze and return ONLY this JSON (no markdown, no explanation):
{
  "is_medical": true or false,
  "urgency": "emergency" | "urgent" | "normal" | "routine",
  "suggested_service": "exact service name from the list above, or empty string",
  "reason": "1 sentence explaining why this service",
  "response": "warm, friendly 2-sentence response to the patient acknowledging their concern and suggesting the service"
}

RULES:
- is_medical: true only if they mentioned a symptom, pain, or health concern
- urgency emergency: severe pain, bleeding, broken tooth, can't breathe, chest pain
- urgency urgent: moderate pain, swelling, infection signs — needs same/next day
- urgency normal: visible issue but manageable — within a few days
- urgency routine: checkup, cleaning, cosmetic — any time
- suggested_service: must exactly match one of the available services
- response: never say "I" — speak as the clinic. Keep it under 40 words.`

  try {
    const raw   = await callAI('llama-3.3-70b-versatile', prompt)
    const match = raw.match(/\{[\s\S]*?\}/)
    if (!match) return null

    const parsed = JSON.parse(match[0])

    // Validate
    if (typeof parsed.is_medical !== 'boolean') return null
    if (!['emergency', 'urgent', 'normal', 'routine'].includes(parsed.urgency)) return null

    return parsed

  } catch(e) {
    console.error('[Triage] Failed:', e.message)
    return null
  }
}

/* ================================================
   BUILD TRIAGE RESPONSE
   Converts triage result into a chat reply
================================================ */

function buildTriageReply(triage, state) {
  if (!triage || !triage.is_medical) return null

  const urgencyEmoji = {
    emergency: '🚨',
    urgent:    '⚠️',
    normal:    '📋',
    routine:   '😊'
  }

  const emoji = urgencyEmoji[triage.urgency] || '📋'

  let reply = `${emoji} ${triage.response}`

  if (triage.urgency === 'emergency') {
    reply += `\n\n🚨 This sounds like an emergency. I'll prioritize finding you the earliest possible slot right now.`
  } else if (triage.urgency === 'urgent') {
    reply += `\n\nI'll help you book this as soon as possible.`
  }

  // Pre-fill service if suggested
  if (triage.suggested_service) {
    state.service   = triage.suggested_service
    state.is_urgent = triage.urgency === 'emergency'
  }

  return reply
}

/* ================================================
   SHOULD TRIAGE?
   Only trigger triage on symptom-like messages
   before booking has started
================================================ */

const SYMPTOM_KEYWORDS = [
  'pain', 'hurt', 'ache', 'aching', 'sore', 'swollen', 'swelling',
  'bleed', 'bleeding', 'broken', 'crack', 'cracked', 'chip', 'chipped',
  'sensitive', 'sensitivity', 'throb', 'throbbing', 'abscess',
  'infection', 'infected', 'decay', 'cavity', 'loose', 'fell out',
  'knocked', 'problem', 'issue', 'trouble', 'difficulty',
  'cannot eat', 'can\'t eat', 'can\'t sleep', 'jaw', 'gum', 'gums',
  'tooth', 'teeth', 'mouth', 'check', 'checkup', 'cleaning', 'scale',
  'whitening', 'braces', 'crown', 'implant', 'root canal', 'extraction',
  'remove', 'replace', 'fill', 'filling', 'xray', 'x-ray', 'consult'
]

function shouldTriage(message, state) {
  // Only triage at start of conversation
  if (state.step !== 'idle' || state.intent === 'book') return false

  const t = message.toLowerCase()

  // Skip if clearly not medical
  if (/^(hi|hello|hey|good|thanks|ok|yes|no)\s*[.!]?$/.test(t.trim())) return false

  // Trigger if any symptom keyword found
  return SYMPTOM_KEYWORDS.some(kw => t.includes(kw))
}

module.exports = { triageSymptoms, buildTriageReply, shouldTriage }