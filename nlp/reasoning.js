'use strict'

const { callAI } = require('./extract')

/* ================================================
   AI REASONING LAYER
   Called when the bot is unsure what to do next.
   Replaces complex if/else chains with AI judgement.

   Returns:
   {
     action:        "ask_missing" | "show_slots" | "confirm" | "book" | "chat" | "skip"
     missing_field: "name" | "phone" | "date" | "service" | "time" | null
     response:      string (what to say to user) or null
     confidence:    "high" | "low"
   }
================================================ */

async function decideNextStep(state, message) {
  const today = new Date().toISOString().split('T')[0]

  const stateStr = JSON.stringify({
    step:        state.step,
    intent:      state.intent,
    has_name:    !!state.name,
    has_phone:   !!state.phone,
    has_date:    !!state.date,
    has_service: !!state.service,
    has_time:    !!state.time,
    has_doctor:  !!state.doctor_id,
    notes_asked: state.notes !== null,
    email_asked: state.email !== null
  })

  const prompt = `You are the decision engine for a dental clinic booking assistant.
Today is ${today}.

Current booking state:
${stateStr}

User just said: "${message}"

Decide what the assistant should do next.

RULES:
- If booking is in progress and a field is missing, action = "ask_missing" with the missing_field
- If all fields collected (name, phone, date, service, time), action = "confirm"
- If user asked about slots/availability, action = "show_slots"
- If user intent is unclear or general question, action = "chat"
- If state is idle and no booking intent, action = "chat"

Missing field priority order: name → phone → date → service → time

Return ONLY this exact JSON (no markdown):
{"action":"","missing_field":"","response":"","confidence":""}

action must be one of: ask_missing, show_slots, confirm, book, chat
missing_field: the next field to collect, or ""
response: a short friendly message to say, or "" to use default
confidence: "high" if obvious, "low" if uncertain`

  try {
    const raw   = await callAI('llama-3.3-70b-versatile', prompt)
    const match = raw.match(/\{[\s\S]*?\}/)
    if (!match) return null

    const parsed = JSON.parse(match[0])
    if (!parsed.action) return null

    return parsed

  } catch(e) {
    console.error('[Reasoning] Failed:', e.message)
    return null
  }
}

/* ================================================
   APPLY REASONING DECISION
   Takes the AI decision and maps it to a response.
   Only called when normal flow doesn't match.
================================================ */

function applyDecision(decision, state, slots) {
  if (!decision) return null

  // Low confidence — don't override, let normal flow handle it
  if (decision.confidence === 'low') return null

  switch (decision.action) {

    case 'ask_missing': {
      const prompts = {
        name:    "May I have your full name?",
        phone:   `Thanks ${state.name||''}! Please share your 10-digit phone number.`,
        date:    "Which date would you prefer? (e.g. tomorrow, next Monday, 25th March)",
        service: "What service do you need? (e.g. checkup, cleaning, consultation, x-ray)",
        time:    "Here are the available time slots — please select one:"
      }
      const field = decision.missing_field
      if (!field || state[field]) return null  // already have it

      const reply = decision.response || prompts[field] || `Please provide your ${field}.`

      if (field === 'time' && slots && slots.length > 0) {
        return { reply, slots }
      }
      return { reply }
    }

    case 'show_slots':
      if (slots && slots.length > 0) {
        return { reply: decision.response || "Here are the available slots:", slots }
      }
      return null

    case 'confirm':
      return null  // let normal confirm flow handle this

    case 'chat':
      if (decision.response) return { reply: decision.response }
      return null

    default:
      return null
  }
}

module.exports = { decideNextStep, applyDecision }