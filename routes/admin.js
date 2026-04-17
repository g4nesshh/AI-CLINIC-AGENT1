'use strict'

const express = require('express')
const router  = express.Router()
const db      = require('../database/db')

const { rateLimit }                          = require('../utils/helpers')
const { getAllWaitlist, removeFromWaitlist }  = require('../services/waitlist')
const { getAllServices }                      = require('../services/booking')
const { getAllHolidays, addHoliday, deleteHoliday } = require('../services/slots')
const { getAnalyticsSummary, getTopServices, getDropOffPoints } = require('../utils/analytics')

/* ================================================
   EMAIL — Resend API
   Sign up free at resend.com → get API key
   Add to Render env vars: RESEND_API_KEY=re_xxxxx
   Free tier: 3000 emails/month, 100/day
================================================ */

async function getClinicConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not set. Add it in Render → Environment Variables.' }
  }
  if (!to || !to.includes('@')) {
    return { ok: false, error: 'Invalid recipient email address.' }
  }

  const config = await getClinicConfig()
  const fromName = config.clinic_name || 'ClinicAI'

  // Resend requires a verified domain for custom from address.
  // Use onboarding@resend.dev for testing, or your verified domain.
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    `${fromName} <${fromEmail}>`,
        to:      [to],
        subject,
        html
      })
    })

    const data = await res.json()

    if (!res.ok) {
      console.error('[Email] ❌ Resend error:', data)
      return { ok: false, error: data.message || 'Resend API error' }
    }

    console.log('[Email] ✅ Sent to', to, '| ID:', data.id)
    return { ok: true, id: data.id }

  } catch(err) {
    console.error('[Email] ❌ Network error:', err.message)
    return { ok: false, error: 'Network error: ' + err.message }
  }
}

/* ── Test email endpoint ── */
router.post('/test-email', async (req, res) => {
  const { to } = req.body
  if (!to) return res.status(400).json({ error: 'Recipient email required' })

  const config = await getClinicConfig()
  const result = await sendEmail({
    to,
    subject: `✅ Test email from ${config.clinic_name || 'ClinicAI'}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;padding:32px;background:#f8fafc;border-radius:12px">
        <h2 style="color:#0ea5e9;margin-bottom:8px">✅ Email is working!</h2>
        <p style="color:#475569;margin-bottom:16px">This is a test from your <strong>${config.clinic_name || 'ClinicAI'}</strong> admin panel.</p>
        <p style="color:#64748b;font-size:14px">Resend is configured correctly. Appointment reminders will now be sent automatically.</p>
      </div>`
  })

  if (result.ok) res.json({ success: true, message: 'Email sent! Check your inbox.' })
  else res.status(500).json({ error: result.error })
})

/* ── Email status check ── */
router.get('/email-status', async (req, res) => {
  const hasKey = !!process.env.RESEND_API_KEY
  res.json({
    configured:  hasKey,
    provider:    'Resend',
    from_email:  process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
    hint:        !hasKey ? 'Add RESEND_API_KEY to Render Environment Variables' : null
  })
})

/* ================================================
   CLINIC CONFIG
================================================ */

router.get('/clinic-config', (req, res) => {
  db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(row || {})
  })
})

router.put('/clinic-config', (req, res) => {
  const {
    clinic_name, clinic_tagline, clinic_type, clinic_icon,
    clinic_phone, clinic_address, clinic_website, whatsapp, google_maps,
    open_hour, close_hour, slot_duration, open_days, max_per_day,
    clinic_email, smtp_host, smtp_port, smtp_user, smtp_pass,
    deposit_enabled, deposit_amount
  } = req.body

  // Add deposit columns if missing
  const addCols = [
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS deposit_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS deposit_amount  INTEGER DEFAULT 0`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_tagline  TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_type     TEXT DEFAULT 'general'`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_icon     TEXT DEFAULT '🏥'`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_phone    TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_address  TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_website  TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS whatsapp        TEXT DEFAULT ''`,
    `ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS google_maps     TEXT DEFAULT ''`
  ]

  Promise.all(addCols.map(sql => new Promise(r => db.run(sql, r)))).then(() => {
    db.run(`
      UPDATE clinic_config SET
        clinic_name     = ?,
        clinic_tagline  = ?,
        clinic_type     = ?,
        clinic_icon     = ?,
        clinic_phone    = ?,
        clinic_address  = ?,
        clinic_website  = ?,
        whatsapp        = ?,
        google_maps     = ?,
        open_hour       = ?,
        close_hour      = ?,
        slot_duration   = ?,
        open_days       = ?,
        max_per_day     = ?,
        clinic_email    = ?,
        smtp_host       = ?,
        smtp_port       = ?,
        smtp_user       = ?,
        smtp_pass       = ?,
        deposit_enabled = ?,
        deposit_amount  = ?
      WHERE id = 1
    `, [
      clinic_name     || 'My Clinic',
      clinic_tagline  || '',
      clinic_type     || 'general',
      clinic_icon     || '🏥',
      clinic_phone    || '',
      clinic_address  || '',
      clinic_website  || '',
      whatsapp        || '',
      google_maps     || '',
      open_hour       || 10,
      close_hour      || 17,
      slot_duration   || 30,
      open_days       || 'Mon,Tue,Wed,Thu,Fri,Sat',
      max_per_day     || 20,
      clinic_email    || '',
      smtp_host       || 'smtp.gmail.com',
      smtp_port       || 587,
      smtp_user       || '',
      smtp_pass       || '',
      deposit_enabled || 0,
      deposit_amount  || 0
    ], function(err) {
      if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
      res.json({ success: true })
    })
  })
})

/* ================================================
   APPOINTMENTS
================================================ */

router.get('/appointments/today', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  const today = new Date().toISOString().split('T')[0]
  db.all(`
    SELECT a.*, d.name as doctor_name_live, d.specialization
    FROM appointments a
    LEFT JOIN doctors d ON a.doctor_id = d.id
    WHERE a.date = ? ORDER BY a.time
  `, [today], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.get('/appointments', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  db.all(`
    SELECT a.*, d.name as doctor_name_live, d.specialization
    FROM appointments a
    LEFT JOIN doctors d ON a.doctor_id = d.id
    ORDER BY a.date DESC, a.time
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.delete('/appointments/:id', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  db.run('DELETE FROM appointments WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    if (this.changes === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ success: true })
  })
})

/* ── No-show tracking ── */
router.patch('/appointments/:id/attendance', (req, res) => {
  const { attended } = req.body
  if (![1, 2].includes(attended)) return res.status(400).json({ error: 'attended must be 1 (attended) or 2 (no-show)' })

  // Add attended column if it doesn't exist
  db.run(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS attended INTEGER DEFAULT 0`, () => {
    db.run('UPDATE appointments SET attended = ? WHERE id = ?', [attended, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
      if (this.changes === 0) return res.status(404).json({ error: 'Appointment not found' })
      res.json({ success: true })
    })
  })
})

/* ── No-show stats ── */
router.get('/appointments/noshows', (req, res) => {
  db.all(`
    SELECT phone, name, COUNT(*) as noshow_count,
           MAX(date) as last_noshow
    FROM appointments
    WHERE attended = 2
    GROUP BY phone, name
    ORDER BY noshow_count DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.get('/appointments/noshows', (req, res) => {
  db.all(`
    SELECT phone, name, COUNT(*) as noshow_count,
           MAX(date) as last_noshow
    FROM appointments
    WHERE attended = 2
    GROUP BY phone, name
    ORDER BY noshow_count DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

/* ── Save prescription/notes for appointment ── */
router.patch('/appointments/:id/notes', (req, res) => {
  const { notes, prescription, follow_up_date } = req.body

  // Add columns if they don't exist
  const addCols = [
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS prescription TEXT DEFAULT ''`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_date TEXT DEFAULT ''`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS prescription_sent INTEGER DEFAULT 0`
  ]

  Promise.all(addCols.map(sql => new Promise(r => db.run(sql, r)))).then(() => {
    db.run(`
      UPDATE appointments SET
        notes             = ?,
        prescription      = ?,
        follow_up_date    = ?
      WHERE id = ?
    `, [notes || '', prescription || '', follow_up_date || '', req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
      if (this.changes === 0) return res.status(404).json({ error: 'Appointment not found' })
      res.json({ success: true })
    })
  })
})

/* ── Generate + email prescription PDF ── */
router.post('/appointments/:id/send-prescription', async (req, res) => {
  const id = req.params.id

  // Get appointment
  const appt = await new Promise((resolve) => {
    db.get('SELECT * FROM appointments WHERE id = ?', [id], (err, row) => resolve(row || null))
  })

  if (!appt) return res.status(404).json({ error: 'Appointment not found' })
  if (!appt.email) return res.status(400).json({ error: 'Patient has no email address on file' })

  const config    = await getClinicConfig()
  const clinicName = config.clinic_name || 'ClinicAI Clinic'

  // Format date nicely
  const apptDate = new Date(appt.date + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  // Build prescription HTML (renders as PDF-like email)
  const prescriptionHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:0;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">

      <!-- HEADER -->
      <div style="background:linear-gradient(135deg,#0ea5e9,#0284c7);padding:28px 32px;color:white">
        <div style="font-size:22px;font-weight:700;margin-bottom:4px">${clinicName}</div>
        <div style="font-size:13px;opacity:.85">Patient Prescription &amp; Visit Summary</div>
      </div>

      <!-- PATIENT INFO -->
      <div style="padding:24px 32px;border-bottom:1px solid #e2e8f0">
        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Patient Details</div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:6px 0;color:#64748b;width:140px;font-size:13px">Patient Name</td>
            <td style="padding:6px 0;font-weight:600;font-size:14px">${appt.name}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Phone</td>
            <td style="padding:6px 0;font-size:13px">${appt.phone}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Visit Date</td>
            <td style="padding:6px 0;font-size:13px">${apptDate}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Time</td>
            <td style="padding:6px 0;font-size:13px">${appt.time}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Service</td>
            <td style="padding:6px 0;font-size:13px">${appt.service}</td>
          </tr>
          ${appt.doctor_name ? `<tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Doctor</td>
            <td style="padding:6px 0;font-size:13px">${appt.doctor_name}</td>
          </tr>` : ''}
          <tr>
            <td style="padding:6px 0;color:#64748b;font-size:13px">Ref #</td>
            <td style="padding:6px 0;font-size:13px;color:#94a3b8">${appt.id}</td>
          </tr>
        </table>
      </div>

      ${appt.notes ? `
      <!-- DIAGNOSIS / NOTES -->
      <div style="padding:24px 32px;border-bottom:1px solid #e2e8f0">
        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Doctor's Notes</div>
        <div style="font-size:14px;color:#1e293b;line-height:1.7;white-space:pre-wrap">${appt.notes}</div>
      </div>` : ''}

      ${appt.prescription ? `
      <!-- PRESCRIPTION -->
      <div style="padding:24px 32px;border-bottom:1px solid #e2e8f0;background:#f8fafc">
        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Prescription</div>
        <div style="font-size:14px;color:#1e293b;line-height:1.8;white-space:pre-wrap;font-family:'Courier New',monospace">${appt.prescription}</div>
      </div>` : ''}

      ${appt.follow_up_date ? `
      <!-- FOLLOW UP -->
      <div style="padding:20px 32px;border-bottom:1px solid #e2e8f0;background:#eff6ff">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:22px">📅</div>
          <div>
            <div style="font-size:12px;color:#3b82f6;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Follow-up Appointment</div>
            <div style="font-size:15px;font-weight:600;color:#1e293b;margin-top:2px">${appt.follow_up_date}</div>
          </div>
        </div>
      </div>` : ''}

      <!-- FOOTER -->
      <div style="padding:20px 32px;text-align:center;background:#f8fafc">
        <div style="font-size:12px;color:#94a3b8;line-height:1.6">
          This is an official document from ${clinicName}.<br>
          Please keep it for your records. For queries, contact the clinic directly.
        </div>
      </div>

    </div>`

  const result = await sendEmail({
    to:      appt.email,
    subject: `Your prescription from ${clinicName} — ${appt.date}`,
    html:    prescriptionHtml
  })

  if (!result.ok) return res.status(500).json({ error: result.error })

  // Mark as sent
  db.run('UPDATE appointments SET prescription_sent = 1 WHERE id = ?', [id])

  res.json({ success: true, message: 'Prescription emailed to ' + appt.email })
})

/* ── Weekly report email ── */
router.post('/send-weekly-report', async (req, res) => {
  const { to } = req.body
  if (!to) return res.status(400).json({ error: 'Recipient email required' })

  const config = await getClinicConfig()
  const today  = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - today.getDay() + 1)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const fmt    = d => d.toISOString().split('T')[0]
  const weekStart = fmt(monday)
  const weekEnd   = fmt(sunday)

  // Gather stats
  const stats = await new Promise((resolve) => {
    db.all(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN attended = 1 THEN 1 ELSE 0 END) as attended,
        SUM(CASE WHEN attended = 2 THEN 1 ELSE 0 END) as noshows,
        SUM(CASE WHEN is_urgent = 1 THEN 1 ELSE 0 END) as urgent
      FROM appointments
      WHERE date >= ? AND date <= ?
    `, [weekStart, weekEnd], (err, rows) => resolve(rows?.[0] || {}))
  })

  const topService = await new Promise((resolve) => {
    db.get(`
      SELECT service, COUNT(*) as count
      FROM appointments
      WHERE date >= ? AND date <= ?
      GROUP BY service ORDER BY count DESC LIMIT 1
    `, [weekStart, weekEnd], (err, row) => resolve(row))
  })

  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  const busiest   = await new Promise((resolve) => {
    db.get(`
      SELECT date, COUNT(*) as count
      FROM appointments
      WHERE date >= ? AND date <= ?
      GROUP BY date ORDER BY count DESC LIMIT 1
    `, [weekStart, weekEnd], (err, row) => resolve(row))
  })

  const result = await sendEmail({
    to,
    subject: `📊 Weekly Report — ${config.clinic_name || 'ClinicAI'} (${weekStart} to ${weekEnd})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px">
        <h2 style="color:#0ea5e9;margin-bottom:4px">Weekly Report</h2>
        <p style="color:#64748b;margin-bottom:24px">${weekStart} to ${weekEnd} — ${config.clinic_name || 'ClinicAI'}</p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr style="background:#f0f9ff">
            <td style="padding:14px;border-radius:8px;text-align:center">
              <div style="font-size:32px;font-weight:700;color:#0ea5e9">${stats.total || 0}</div>
              <div style="font-size:12px;color:#64748b;margin-top:4px">Total Appointments</div>
            </td>
            <td style="padding:14px;border-radius:8px;text-align:center">
              <div style="font-size:32px;font-weight:700;color:#10b981">${stats.attended || 0}</div>
              <div style="font-size:12px;color:#64748b;margin-top:4px">Attended</div>
            </td>
            <td style="padding:14px;border-radius:8px;text-align:center">
              <div style="font-size:32px;font-weight:700;color:#ef4444">${stats.noshows || 0}</div>
              <div style="font-size:12px;color:#64748b;margin-top:4px">No-shows</div>
            </td>
            <td style="padding:14px;border-radius:8px;text-align:center">
              <div style="font-size:32px;font-weight:700;color:#f59e0b">${stats.urgent || 0}</div>
              <div style="font-size:12px;color:#64748b;margin-top:4px">Urgent</div>
            </td>
          </tr>
        </table>

        ${topService ? `<p style="color:#475569;margin-bottom:8px">🏆 <strong>Top service this week:</strong> ${topService.service} (${topService.count} bookings)</p>` : ''}
        ${busiest    ? `<p style="color:#475569;margin-bottom:24px">📅 <strong>Busiest day:</strong> ${busiest.date} (${busiest.count} appointments)</p>` : ''}
        ${(!topService && !busiest) ? '<p style="color:#64748b">No appointments this week.</p>' : ''}

        <div style="background:#f8fafc;border-radius:10px;padding:16px;margin-top:16px">
          <p style="font-size:12px;color:#94a3b8;margin:0">Generated by ClinicAI • <a href="${process.env.CLINIC_URL || '#'}" style="color:#0ea5e9">View Admin Panel</a></p>
        </div>
      </div>`
  })

  if (result.ok) res.json({ success: true, message: 'Weekly report sent!' })
  else res.status(500).json({ error: result.error })
})

/* ================================================
   DOCTORS — full CRUD with hard delete
================================================ */

router.get('/doctors', (req, res) => {
  // Return ALL doctors including inactive for admin view
  db.all('SELECT * FROM doctors ORDER BY active DESC, name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.post('/doctors', (req, res) => {
  const { name, specialization, available_days } = req.body
  if (!name) return res.status(400).json({ error: 'Doctor name is required' })
  if (!specialization) return res.status(400).json({ error: 'Specialization is required' })

  const days = available_days || 'Mon,Tue,Wed,Thu,Fri,Sat'

  db.runReturning(
    'INSERT INTO doctors (name, specialization, available_days, active) VALUES (?, ?, ?, 1)',
    [name.trim(), specialization.trim(), days],
    function(err) {
      if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
      res.json({ success: true, id: this.lastID })
    }
  )
})

router.put('/doctors/:id', (req, res) => {
  const { name, specialization, available_days, active } = req.body
  if (!name) return res.status(400).json({ error: 'Doctor name is required' })

  db.run(`
    UPDATE doctors SET
      name           = ?,
      specialization = ?,
      available_days = ?,
      active         = ?
    WHERE id = ?
  `, [
    name.trim(),
    specialization || 'General Dentist',
    available_days || 'Mon,Tue,Wed,Thu,Fri,Sat',
    active !== undefined ? (active ? 1 : 0) : 1,
    req.params.id
  ], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    if (this.changes === 0) return res.status(404).json({ error: 'Doctor not found' })
    res.json({ success: true })
  })
})

// Hard delete — permanently removes doctor
router.delete('/doctors/:id', (req, res) => {
  db.run('DELETE FROM doctors WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    if (this.changes === 0) return res.status(404).json({ error: 'Doctor not found' })
    res.json({ success: true })
  })
})

// Toggle active/inactive without deleting
router.patch('/doctors/:id/toggle', (req, res) => {
  db.run('UPDATE doctors SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?',
    [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json({ success: true })
  })
})

/* ================================================
   SERVICES — full CRUD with hard delete
================================================ */

router.get('/services', (req, res) => {
  db.all('SELECT * FROM services ORDER BY active DESC, name', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.post('/services', (req, res) => {
  const { name, duration_minutes } = req.body
  if (!name) return res.status(400).json({ error: 'Service name is required' })

  db.runReturning(
    'INSERT INTO services (name, duration_minutes, active) VALUES (?, ?, 1)',
    [name.trim(), parseInt(duration_minutes) || 30],
    function(err) {
      if (err) {
        // Handle duplicate name
        if (err.message && err.message.includes('unique')) {
          return res.status(409).json({ error: 'A service with this name already exists' })
        }
        return res.status(500).json({ error: 'DB error: ' + err.message })
      }
      res.json({ success: true, id: this.lastID })
    }
  )
})

router.put('/services/:id', (req, res) => {
  const { name, duration_minutes, active } = req.body
  if (!name) return res.status(400).json({ error: 'Service name is required' })

  db.run(`
    UPDATE services SET
      name             = ?,
      duration_minutes = ?,
      active           = ?
    WHERE id = ?
  `, [
    name.trim(),
    parseInt(duration_minutes) || 30,
    active !== undefined ? (active ? 1 : 0) : 1,
    req.params.id
  ], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    if (this.changes === 0) return res.status(404).json({ error: 'Service not found' })
    res.json({ success: true })
  })
})

// Hard delete service
router.delete('/services/:id', (req, res) => {
  db.run('DELETE FROM services WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    if (this.changes === 0) return res.status(404).json({ error: 'Service not found' })
    res.json({ success: true })
  })
})

/* ================================================
   HOLIDAYS — full CRUD
================================================ */

router.get('/holidays', async (req, res) => {
  try { res.json(await getAllHolidays()) }
  catch(e) { res.status(500).json({ error: 'DB error: ' + e.message }) }
})

router.post('/holidays', async (req, res) => {
  const { date, reason } = req.body
  if (!date) return res.status(400).json({ error: 'Date is required' })
  const id = await addHoliday(date, reason || 'Clinic Holiday')
  if (id) res.json({ success: true, id })
  else res.status(500).json({ error: 'Could not add holiday — date may already exist' })
})

router.delete('/holidays/:id', async (req, res) => {
  const ok = await deleteHoliday(req.params.id)
  if (ok) res.json({ success: true })
  else res.status(404).json({ error: 'Holiday not found' })
})

/* ================================================
   WAITLIST
================================================ */

router.get('/waitlist', async (req, res) => {
  try { res.json(await getAllWaitlist()) }
  catch(e) { res.status(500).json({ error: 'DB error: ' + e.message }) }
})

router.delete('/waitlist/:id', async (req, res) => {
  const ok = await removeFromWaitlist(req.params.id)
  if (ok) res.json({ success: true })
  else res.status(404).json({ error: 'Not found' })
})

/* ================================================
   ANALYTICS
================================================ */

router.get('/analytics', async (req, res) => {
  try {
    const [summary, topServices, dropOffs] = await Promise.all([
      getAnalyticsSummary(),
      getTopServices(),
      getDropOffPoints()
    ])
    res.json({ summary, topServices, dropOffs })
  } catch(e) {
    res.status(500).json({ error: 'DB error: ' + e.message })
  }
})

/* ================================================
   AUDIT LOG
   Tracks every admin action permanently
================================================ */

// Create audit_log table on startup
db.run(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id         SERIAL PRIMARY KEY,
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  TEXT,
    details    TEXT,
    username   TEXT DEFAULT 'admin',
    ip         TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => { if (err) console.error('[Audit] Table error:', err.message) })

function auditLog(req, action, entity, entityId, details) {
  const username = req.admin?.username || 'unknown'
  const ip       = req.ip || 'unknown'
  const meta     = details ? JSON.stringify(details) : null
  db.run(
    'INSERT INTO audit_log (action, entity, entity_id, details, username, ip) VALUES (?, ?, ?, ?, ?, ?)',
    [action, entity, String(entityId || ''), meta, username, ip],
    (err) => { if (err) console.error('[Audit] Log error:', err.message) }
  )
}

router.get('/audit-log', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  db.all(`
    SELECT * FROM audit_log
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `, [limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json(rows || [])
  })
})

router.delete('/audit-log', (req, res) => {
  // Only clear logs older than 90 days
  db.run(`DELETE FROM audit_log WHERE created_at < CURRENT_DATE - INTERVAL '90 days'`,
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ success: true, deleted: this.changes })
    })
})

module.exports = { router, auditLog }
