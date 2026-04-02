'use strict'

/**
 * worker.js — Background job runner
 * Run separately from server.js:
 *   node worker.js
 *
 * Handles:
 *   - Email reminders (24h + 1h before appointment)
 *   - Waitlist notifications
 *   - Session cleanup logs
 *
 * On Render: add a second service pointing to this file
 * Locally: run in a separate terminal
 */

const db = require('./database/db')

/* ── nodemailer ── */
let nodemailer = null
try {
  nodemailer = require('nodemailer')
  console.log('[Worker] nodemailer loaded ✅')
} catch(e) {
  console.log('[Worker] nodemailer not installed — reminders disabled')
  console.log('[Worker] Run: npm install nodemailer')
}

/* ================================================
   SMTP CONFIG
================================================ */

async function getSmtpConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

/* ================================================
   SEND REMINDER EMAIL
================================================ */

async function sendReminderEmail({ to, patientName, clinicName, doctorName, date, time, service, type }) {
  if (!nodemailer || !to || !to.includes('@')) return false

  const config = await getSmtpConfig()
  if (!config.smtp_user || !config.smtp_pass) {
    console.log('[Worker] SMTP not configured — skipping reminder to', to)
    return false
  }

  try {
    const transporter = nodemailer.createTransport({
      host:   config.smtp_host || 'smtp.gmail.com',
      port:   config.smtp_port || 587,
      secure: false,
      auth:   { user: config.smtp_user, pass: config.smtp_pass }
    })

    const timeLabel = type === '24h' ? 'tomorrow' : type === 'waitlist' ? 'as a slot just opened' : 'in 1 hour'

    await transporter.sendMail({
      from:    `"${clinicName}" <${config.smtp_user}>`,
      to,
      subject: `Reminder: Your appointment at ${clinicName} is ${timeLabel}`,
      html: `
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
          <p style="color:#666">Please arrive 10 minutes early.</p>
          <p style="color:#999;font-size:12px">Automated reminder from ${clinicName}.</p>
        </div>
      `
    })

    console.log(`[Worker] ${type} reminder sent to ${to} for ${date} ${time}`)
    return true

  } catch(err) {
    console.error('[Worker] Email failed:', err.message)
    return false
  }
}

/* ================================================
   REMINDER JOB
   Runs every 15 minutes.
   Checks for upcoming appointments needing reminders.
================================================ */

async function runReminderJob() {
  if (!nodemailer) return

  const config = await getSmtpConfig()
  if (!config.smtp_user) return

  const nowMs = Date.now()

  db.all(`
    SELECT * FROM appointments
    WHERE email != '' AND email IS NOT NULL
    AND date >= date('now')
    AND (reminder_24h = 0 OR reminder_1h = 0)
    ORDER BY date, time
  `, [], async (err, rows) => {
    if (err || !rows || !rows.length) return

    console.log(`[Worker] Checking ${rows.length} appointment(s) for reminders...`)

    for (const appt of rows) {
      const apptMs  = new Date(`${appt.date}T${appt.time}:00`).getTime()
      const diffHrs = (apptMs - nowMs) / 3600000

      // 24-hour reminder: send between 23h and 25h before
      if (!appt.reminder_24h && diffHrs >= 23 && diffHrs <= 25) {
        const sent = await sendReminderEmail({
          to: appt.email, patientName: appt.name,
          clinicName: config.clinic_name || 'ClinicAI',
          doctorName: appt.doctor_name,
          date: appt.date, time: appt.time, service: appt.service, type: '24h'
        })
        if (sent) db.run('UPDATE appointments SET reminder_24h = 1 WHERE id = ?', [appt.id])
      }

      // 1-hour reminder: send between 55min and 65min before
      if (!appt.reminder_1h && diffHrs >= 0.916 && diffHrs <= 1.083) {
        const sent = await sendReminderEmail({
          to: appt.email, patientName: appt.name,
          clinicName: config.clinic_name || 'ClinicAI',
          doctorName: appt.doctor_name,
          date: appt.date, time: appt.time, service: appt.service, type: '1h'
        })
        if (sent) db.run('UPDATE appointments SET reminder_1h = 1 WHERE id = ?', [appt.id])
      }
    }
  })
}

/* ================================================
   ANALYTICS CLEANUP JOB
   Runs daily — removes analytics older than 90 days
================================================ */

async function runCleanupJob() {
  db.run(`DELETE FROM analytics WHERE created_at < DATE('now', '-90 days')`, (err) => {
    if (!err) console.log('[Worker] Old analytics cleaned up')
  })
}

/* ================================================
   START JOBS
================================================ */

console.log('[Worker] Starting background jobs...')

// Run immediately on startup
setTimeout(runReminderJob, 5000)
setTimeout(runCleanupJob,  10000)

// Then on schedule
setInterval(runReminderJob, 15 * 60 * 1000)  // every 15 min
setInterval(runCleanupJob,  24 * 60 * 60 * 1000)  // every 24 hours

console.log('[Worker] Reminder job: every 15 minutes')
console.log('[Worker] Cleanup job: every 24 hours')
console.log('[Worker] Ready ✅')