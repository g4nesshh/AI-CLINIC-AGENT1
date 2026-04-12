'use strict'

/* ================================================
   GROQ AI CALL
================================================ */

async function callAI(model, prompt) {
  try {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 30000)

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages:   [{ role: 'user', content: prompt }],
        max_tokens: 500
      })
    })

    clearTimeout(timeout)
    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || ''

  } catch (err) {
    if (err.name === 'AbortError') { console.error('[AI] Request timed out'); return '' }
    console.error('[AI] Call failed:', err.message)
    return ''
  }
}

/* ================================================
   STRUCTURED EXTRACTION
   Uses llama-3.3-70b to extract booking fields
================================================ */

async function extractDetails(message) {
  const today = new Date().toISOString().split('T')[0]

  const prompt = `You are a strict data extraction engine for a medical clinic booking system.
Today's date is ${today}.

Extract ONLY these fields from the user message below.

RULES:
- intent  : one of ["book","cancel","reschedule","query","reset","confirm","deny"] or ""
- name    : person's full name only. Max 3 words. NO digits. NO dates. NO service names.
- phone   : exactly 10 consecutive digits only. No spaces, no dashes.
- date    : convert any date expression to YYYY-MM-DD using today=${today}.
- time    : convert to HH:MM 24-hour format. "10am"=10:00, "2pm"=14:00
- service : the medical service requested. Short phrase only.
- notes   : any symptom or reason for visit. Only if explicitly mentioned.

If a field is not present or unclear, return exactly "".
Never guess. Never combine two fields into one.

Return ONLY this exact JSON (no markdown, no explanation):
{"intent":"","name":"","phone":"","date":"","time":"","service":"","notes":""}

User message: "${message}"`

  const raw   = await callAI('llama-3.3-70b-versatile', prompt)
  const match = raw.match(/\{[\s\S]*?\}/)
  if (!match) return {}

  let parsed = {}
  try { parsed = JSON.parse(match[0]) } catch (e) { return {} }

  // Clean name
  if (parsed.name) {
    parsed.name = parsed.name
      .replace(/\d+/g, '')
      .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/gi, '')
      .replace(/[^a-zA-Z\s]/g, '').replace(/\s{2,}/g, ' ').trim()
    const words = parsed.name.split(/\s+/).filter(Boolean)
    if (words.length === 0 || words.length > 4 || parsed.name.length < 2) parsed.name = ''
  }

  // Clean phone
  if (parsed.phone) {
    parsed.phone = parsed.phone.replace(/\D/g, '')
    if (parsed.phone.length !== 10) parsed.phone = ''
  }

  // Clean date
  if (parsed.date) {
    const td = new Date().toISOString().split('T')[0]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date) || parsed.date < td) parsed.date = ''
  }

  // Clean time
  if (parsed.time && !/^\d{2}:\d{2}$/.test(parsed.time)) parsed.time = ''

  // Clean service
  if (parsed.service) {
    parsed.service = parsed.service.replace(/[^a-zA-Z\s]/g, '').trim().toLowerCase()
    if (parsed.service.length < 2) parsed.service = ''
  }

  return parsed
}

/* ================================================
   GENERAL CHAT
================================================ */

async function chatReply(message, history, lang) {
  const { getLanguageInstruction } = require('./language')
  const langInstruction = getLanguageInstruction(lang || 'en')

  const systemPrompt =
    langInstruction +
    `You are a smart, friendly receptionist at a clinic.\n` +
    `Answer patient questions clearly and helpfully. Keep replies short and warm.\n\n` +
    `RULES:\n` +
    `- To book say "book appointment"\n` +
    `- To check booking say "check my appointment" with phone number\n` +
    `- To cancel or reschedule say those exact words\n` +
    `- Never make up appointment details, prices, or doctor names\n\n` +
    `Conversation so far:\n` +
    history.slice(-6).map(h => `${h.role==='user'?'Patient':'Receptionist'}: ${h.content}`).join('\n') +
    `\nPatient: ${message}\nReceptionist:`

  return await callAI('llama-3.3-70b-versatile', systemPrompt)
}

module.exports = { callAI, extractDetails, chatReply }
