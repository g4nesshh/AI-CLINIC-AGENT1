'use strict'

/**
 * worker.js — Background job runner
 * Handles email reminders and cleanup.
 * On Render: runs as a separate background worker service.
 * Locally: node worker.js in a separate terminal.
 */

const db = require('./database/db')
const nodemailer = require('nodemailer')

console.log('[Worker] Starting ✅')

async function getConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

function buildTransporter(config) {
  return nodemailer.createTransport({
    host:   config.smtp_host || 'smtp.gmail.com',
    port:   parseInt(config.smtp_port) || 587,
    secure: parseInt(config.smtp_port) === 465,
    auth:   { user: config.smtp_user, pass: config.smtp_pass },
    tls:    { rejectUnauthorized: false }
  })
}

async function sendReminderEmail({ to, patientName, clinicName, doctorName, date, time, service, type }) {
  const config = await getConfig()
  if (!config.smtp_user || !config.smtp_pass) return false

  const timeLabel = type === '24h' ? 'tomorrow' : 'in 1 hour'

  try {
    const transporter = buildTransporter(config)
    await transporter.sendMail({
      from:    `"${clinicName}" <${config.smtp_user}>`,
      to,
      subject: `Reminder: Your appointment at ${clinicName} is ${timeLabel}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;padding:28px;background:#f8fafc;border-radius:12px">
          <h2 style="color:#0ea5e9">Appointment Reminder</h2>
          <p>Hello <strong>${patientName}</strong>,</p>
          <p>Your appointment is <strong>${timeLabel}</strong>.</p>
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
    console.log(`[Worker] ✅ ${type} reminder sent to ${to}`)
    return true
  } catch(err) {
    console.error('[Worker] ❌ Email failed:', err.message)
    return false
  }
}

async function runReminderJob() {
  const config = await getConfig()
  if (!config.smtp_user || !config.smtp_pass) return

  const nowMs = Date.now()

  db.all(`
    SELECT * FROM appointments
    WHERE email != '' AND email IS NOT NULL
    AND date >= CURRENT_DATE
    AND (reminder_24h = 0 OR reminder_1h = 0)
    ORDER BY date, time
  `, [], async (err, rows) => {
    if (err || !rows || !rows.length) return
    console.log(`[Worker] Checking ${rows.length} appointment(s) for reminders`)

    for (const appt of rows) {
      const apptMs  = new Date(`${appt.date}T${appt.time}:00`).getTime()
      const diffHrs = (apptMs - nowMs) / 3600000

      if (!appt.reminder_24h && diffHrs >= 23 && diffHrs <= 25) {
        const sent = await sendReminderEmail({
          to: appt.email, patientName: appt.name,
          clinicName: config.clinic_name || 'ClinicAI',
          doctorName: appt.doctor_name,
          date: appt.date, time: appt.time, service: appt.service, type: '24h'
        })
        if (sent) db.run('UPDATE appointments SET reminder_24h = 1 WHERE id = ?', [appt.id])
      }

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

async function runCleanupJob() {
  db.run(`DELETE FROM analytics WHERE created_at < CURRENT_DATE - INTERVAL '90 days'`, () => {
    console.log('[Worker] Analytics cleanup done')
  })
}

// Run on startup then on schedule
setTimeout(runReminderJob, 8000)
setTimeout(runCleanupJob,  15000)
setInterval(runReminderJob, 15 * 60 * 1000)
setInterval(runCleanupJob,  24 * 60 * 60 * 1000)

console.log('[Worker] Reminder job: every 15 min')
console.log('[Worker] Cleanup job: every 24 hours')