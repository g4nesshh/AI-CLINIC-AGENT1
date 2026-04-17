'use strict'

/**
 * worker.js — Background job runner
 * Sends appointment reminder emails via Resend API.
 * Requires env var: RESEND_API_KEY=re_xxxxx
 */

const db = require('./database/db')

console.log('[Worker] Starting ✅')

async function getConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) { console.log('[Worker] RESEND_API_KEY not set — skipping'); return false }

  const config    = await getConfig()
  const fromName  = config.clinic_name || 'ClinicAI'
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [to], subject, html })
    })
    const data = await res.json()
    if (!res.ok) { console.error('[Worker] Resend error:', data.message); return false }
    console.log('[Worker] ✅ Email sent to', to)
    return true
  } catch(err) {
    console.error('[Worker] ❌ Error:', err.message)
    return false
  }
}

async function sendReminderEmail({ to, patientName, clinicName, date, time, service, doctorName, type }) {
  const timeLabel = type === '24h' ? 'tomorrow' : 'in 1 hour'
  return sendEmail({
    to,
    subject: `Reminder: Your appointment at ${clinicName} is ${timeLabel}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;padding:28px;background:#f8fafc;border-radius:12px">
        <h2 style="color:#0ea5e9">Appointment Reminder</h2>
        <p>Hello <strong>${patientName}</strong>, your appointment is <strong>${timeLabel}</strong>.</p>
        <table style="width:100%;margin:16px 0;border-collapse:collapse">
          <tr><td style="padding:8px;color:#64748b">Clinic</td><td style="padding:8px;font-weight:600">${clinicName}</td></tr>
          <tr style="background:#fff"><td style="padding:8px;color:#64748b">Doctor</td><td style="padding:8px">${doctorName || 'Any available'}</td></tr>
          <tr><td style="padding:8px;color:#64748b">Date</td><td style="padding:8px">${date}</td></tr>
          <tr style="background:#fff"><td style="padding:8px;color:#64748b">Time</td><td style="padding:8px">${time}</td></tr>
          <tr><td style="padding:8px;color:#64748b">Service</td><td style="padding:8px">${service}</td></tr>
        </table>
        <p style="color:#64748b;font-size:13px">Please arrive 10 minutes early. See you!</p>
      </div>`
  })
}

async function runReminderJob() {
  if (!process.env.RESEND_API_KEY) return

  const config = await getConfig()
  const nowMs  = Date.now()

  db.all(`
    SELECT * FROM appointments
    WHERE email != '' AND email IS NOT NULL
    AND date >= CURRENT_DATE
    AND (reminder_24h = 0 OR reminder_1h = 0)
    ORDER BY date, time
  `, [], async (err, rows) => {
    if (err || !rows || !rows.length) return
    console.log(`[Worker] Checking ${rows.length} appointment(s)`)

    for (const appt of rows) {
      const diffHrs = (new Date(`${appt.date}T${appt.time}:00`).getTime() - nowMs) / 3600000

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

async function runCleanupJob() {
  db.run(`DELETE FROM analytics WHERE created_at < CURRENT_DATE - INTERVAL '90 days'`, () => {
    console.log('[Worker] Analytics cleanup done')
  })
}

/* ── Weekly report — every Monday 8am ── */
async function runWeeklyReport() {
  const now = new Date()
  if (now.getDay() !== 1) return          // only on Monday
  if (now.getHours() !== 8) return        // only at 8am

  const reportEmail = process.env.WEEKLY_REPORT_EMAIL
  if (!reportEmail) return

  console.log('[Worker] Sending weekly report to', reportEmail)

  try {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/send-weekly-report`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ to: reportEmail })
    })
    if (res.ok) console.log('[Worker] ✅ Weekly report sent')
    else        console.error('[Worker] Weekly report failed')
  } catch(e) {
    console.error('[Worker] Weekly report error:', e.message)
  }
}

/* ================================================
   AI FOLLOW-UP JOB
   3 days after appointment → email patient asking
   how they feel + any concerns.
   Requires: RESEND_API_KEY, GROQ_API_KEY, CLINIC_URL
================================================ */

async function generateFollowUpMessage(patientName, service, clinicName) {
  if (!process.env.GROQ_API_KEY) return null

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role:    'user',
          content: `Write a warm, short follow-up message from ${clinicName} to patient ${patientName} who had a ${service} 3 days ago.

Rules:
- 2-3 sentences only
- Ask how they are feeling
- Mention they can contact us if they have concerns
- Warm and caring tone
- Do NOT use generic phrases like "hope this message finds you well"
- End with the clinic name
- No subject line, just the message body`
        }],
        max_tokens: 150
      })
    })
    const data = await res.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch(e) {
    console.error('[FollowUp] AI error:', e.message)
    return null
  }
}

async function runFollowUpJob() {
  if (!process.env.RESEND_API_KEY) return

  const config   = await getConfig()
  const apiKey   = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
  const clinicName = config.clinic_name || 'ClinicAI'
  const bookingUrl = process.env.CLINIC_URL || '#'

  // Find appointments from exactly 3 days ago with email, not yet followed up
  const threeDaysAgo = new Date()
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
  const targetDate = threeDaysAgo.toISOString().split('T')[0]

  db.all(`
    SELECT * FROM appointments
    WHERE date = ?
    AND email != '' AND email IS NOT NULL
    AND (follow_up_sent IS NULL OR follow_up_sent = 0)
    AND attended != 2
  `, [targetDate], async (err, rows) => {
    if (err || !rows || !rows.length) return
    console.log(`[FollowUp] Found ${rows.length} patient(s) to follow up with`)

    // Add column if not exists
    db.run(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_sent INTEGER DEFAULT 0`, () => {})

    for (const appt of rows) {
      const message = await generateFollowUpMessage(appt.name, appt.service, clinicName)

      const body = message || `Hi ${appt.name}, we hope your ${appt.service} went well! How are you feeling? Please don't hesitate to reach out if you have any questions or concerns. — ${clinicName}`

      try {
        const res = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    `${clinicName} <${fromEmail}>`,
            to:      [appt.email],
            subject: `Following up on your visit — ${clinicName}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px">
                <div style="font-size:28px;margin-bottom:16px">👋</div>
                <h2 style="color:#0ea5e9;margin-bottom:16px">How are you feeling?</h2>
                <p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:20px">${body.replace(/\n/g, '<br>')}</p>
                <div style="background:#f0f9ff;border-radius:10px;padding:16px;margin-bottom:20px">
                  <div style="font-size:12px;color:#64748b;margin-bottom:8px">Your visit details</div>
                  <div style="font-size:13px;color:#1e293b">
                    <strong>Date:</strong> ${appt.date}<br>
                    <strong>Service:</strong> ${appt.service}<br>
                    ${appt.doctor_name ? `<strong>Doctor:</strong> ${appt.doctor_name}<br>` : ''}
                  </div>
                </div>
                <a href="${bookingUrl}" style="display:inline-block;background:#0ea5e9;color:white;text-decoration:none;padding:11px 24px;border-radius:9px;font-weight:600;font-size:14px">📅 Book Next Visit</a>
                <p style="color:#94a3b8;font-size:12px;margin-top:24px">This is an automated follow-up from ${clinicName}.</p>
              </div>`
          })
        })

        if (res.ok) {
          console.log(`[FollowUp] ✅ Sent to ${appt.email}`)
          db.run('UPDATE appointments SET follow_up_sent = 1 WHERE id = ?', [appt.id])
        }
      } catch(e) {
        console.error(`[FollowUp] ❌ Failed for ${appt.email}:`, e.message)
      }
    }
  })
}

setTimeout(runReminderJob,  8000)
setTimeout(runCleanupJob,   15000)
setTimeout(runFollowUpJob,  20000)
setInterval(runReminderJob,  15 * 60 * 1000)
setInterval(runCleanupJob,   24 * 60 * 60 * 1000)
setInterval(runWeeklyReport, 60 * 60 * 1000)
setInterval(runFollowUpJob,  6 * 60 * 60 * 1000)  // check every 6 hours

console.log('[Worker] Ready — reminders 15min, follow-ups every 6hrs, weekly report Mondays 8am')