'use strict'

/**
 * Google Calendar Sync
 * 
 * Uses Google Calendar API via service account.
 * Setup:
 * 1. Go to console.cloud.google.com
 * 2. Create project → Enable Google Calendar API
 * 3. Create Service Account → Download JSON key
 * 4. Share your Google Calendar with the service account email
 * 5. Add env vars to Render:
 *    GOOGLE_CLIENT_EMAIL = service-account@project.iam.gserviceaccount.com
 *    GOOGLE_PRIVATE_KEY  = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
 *    GOOGLE_CALENDAR_ID  = your-calendar-id@group.calendar.google.com (or 'primary')
 */

const CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID || 'primary'
const CLIENT_EMAIL   = process.env.GOOGLE_CLIENT_EMAIL
const PRIVATE_KEY    = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')

/* ================================================
   JWT AUTH FOR GOOGLE API
   No extra packages — uses native crypto + fetch
================================================ */

async function getGoogleToken() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Google Calendar not configured. Set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY in Render.')
  }

  const now  = Math.floor(Date.now() / 1000)
  const claim = {
    iss:   CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  }

  // Build JWT
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url')
  const data    = `${header}.${payload}`

  // Sign with private key
  const crypto  = require('crypto')
  const sign    = crypto.createSign('RSA-SHA256')
  sign.update(data)
  const sig = sign.sign(PRIVATE_KEY, 'base64url')

  const jwt = `${data}.${sig}`

  // Exchange JWT for access token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  })

  const token = await res.json()
  if (!res.ok) throw new Error('Google auth failed: ' + (token.error_description || token.error))
  return token.access_token
}

/* ================================================
   ADD EVENT TO GOOGLE CALENDAR
   Called after every successful booking
================================================ */

async function addCalendarEvent(appointment) {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.log('[Calendar] Not configured — skipping')
    return null
  }

  try {
    const token = await getGoogleToken()

    const [h, m]   = appointment.time.split(':').map(Number)
    const duration = appointment.service_duration || 30

    const startDt  = new Date(`${appointment.date}T${appointment.time}:00`)
    const endDt    = new Date(startDt.getTime() + duration * 60000)

    const event = {
      summary:     `${appointment.service} — ${appointment.name}`,
      description: [
        `Patient: ${appointment.name}`,
        `Phone: ${appointment.phone}`,
        `Service: ${appointment.service}`,
        appointment.doctor_name ? `Doctor: ${appointment.doctor_name}` : '',
        appointment.notes       ? `Notes: ${appointment.notes}`        : '',
        appointment.is_urgent   ? '🚨 URGENT'                         : '',
        `\nRef #${appointment.id} — Booked via ClinicAI`
      ].filter(Boolean).join('\n'),
      start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endDt.toISOString(),   timeZone: 'Asia/Kolkata' },
      colorId: appointment.is_urgent ? '11' : '1',   // red for urgent, blue for normal
      reminders: {
        useDefault: false,
        overrides:  [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 10 }
        ]
      }
    }

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify(event)
      }
    )

    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message || 'Calendar API error')

    console.log('[Calendar] ✅ Event added:', data.id)
    return data.id

  } catch(err) {
    console.error('[Calendar] ❌ Failed:', err.message)
    return null
  }
}

/* ================================================
   DELETE EVENT FROM GOOGLE CALENDAR
   Called when appointment is cancelled
================================================ */

async function deleteCalendarEvent(calendarEventId) {
  if (!CLIENT_EMAIL || !PRIVATE_KEY || !calendarEventId) return

  try {
    const token = await getGoogleToken()

    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${calendarEventId}`,
      {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    )

    console.log('[Calendar] ✅ Event deleted:', calendarEventId)
  } catch(err) {
    console.error('[Calendar] ❌ Delete failed:', err.message)
  }
}

/* ================================================
   CHECK IF CONFIGURED
================================================ */

function isCalendarConfigured() {
  return !!(CLIENT_EMAIL && PRIVATE_KEY)
}

module.exports = { addCalendarEvent, deleteCalendarEvent, isCalendarConfigured }