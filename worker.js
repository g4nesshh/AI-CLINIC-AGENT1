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

setTimeout(runReminderJob,  8000)
setTimeout(runCleanupJob,   15000)
setInterval(runReminderJob,  15 * 60 * 1000)
setInterval(runCleanupJob,   24 * 60 * 60 * 1000)
setInterval(runWeeklyReport, 60 * 60 * 1000)   // check every hour

console.log('[Worker] Ready — reminders every 15 min, weekly report Mondays 8am')