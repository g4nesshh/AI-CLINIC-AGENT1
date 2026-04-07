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
   EMAIL — nodemailer
   Requires: npm install nodemailer
   For Gmail: use App Password, not your real password
   Google Account → Security → 2-Step → App Passwords
================================================ */

const nodemailer = require('nodemailer')
console.log('[Email] nodemailer loaded ✅')

async function getSmtpConfig() {
  return new Promise((resolve) => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })
}

function buildTransporter(config) {
  const host = config.smtp_host || 'smtp.gmail.com'
  const port = parseInt(config.smtp_port) || 587

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,   // true only for port 465
    auth: {
      user: config.smtp_user,
      pass: config.smtp_pass
    },
    tls: {
      rejectUnauthorized: false   // avoids cert errors on some hosts
    }
  })
}

async function sendEmail({ to, subject, html }) {
  const config = await getSmtpConfig()

  // Validation
  if (!config.smtp_user || !config.smtp_user.includes('@')) {
    return { ok: false, error: 'SMTP username not set. Go to Settings → Email and enter your Gmail address.' }
  }
  if (!config.smtp_pass || config.smtp_pass.length < 8) {
    return { ok: false, error: 'SMTP password not set. Go to Settings → Email and enter your App Password.' }
  }
  if (!to || !to.includes('@')) {
    return { ok: false, error: 'Invalid recipient email address.' }
  }

  try {
    const transporter = buildTransporter(config)
    const info = await transporter.sendMail({
      from:    `"${config.clinic_name || 'ClinicAI'}" <${config.smtp_user}>`,
      to,
      subject,
      html
    })
    console.log('[Email] ✅ Sent to', to, '| MessageId:', info.messageId)
    return { ok: true, messageId: info.messageId }

  } catch(err) {
    console.error('[Email] ❌ Failed:', err.message)

    // Friendly error messages
    let friendly = err.message
    if (err.message.includes('Invalid login') || err.message.includes('Username and Password')) {
      friendly = 'Gmail rejected the login. Make sure you are using an App Password (not your real Gmail password). Get one at: Google Account → Security → 2-Step Verification → App Passwords.'
    } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT')) {
      friendly = `Cannot connect to ${config.smtp_host || 'smtp.gmail.com'}:${config.smtp_port || 587}. Check your SMTP host and port settings.`
    } else if (err.message.includes('self signed') || err.message.includes('certificate')) {
      friendly = 'SSL certificate error. Try changing SMTP port to 587.'
    } else if (err.message.includes('getaddrinfo')) {
      friendly = `Cannot find SMTP host "${config.smtp_host}". Check your SMTP host setting.`
    }

    return { ok: false, error: friendly }
  }
}

/* ── Test email endpoint ── */
router.post('/test-email', async (req, res) => {
  const { to } = req.body
  if (!to) return res.status(400).json({ error: 'Recipient email required' })

  const config = await getSmtpConfig()
  const result = await sendEmail({
    to,
    subject: `✅ Test email from ${config.clinic_name || 'ClinicAI'}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;padding:32px;background:#f8fafc;border-radius:12px">
        <h2 style="color:#0ea5e9;margin-bottom:8px">✅ Email is working!</h2>
        <p style="color:#475569;margin-bottom:16px">This is a test from your <strong>${config.clinic_name || 'ClinicAI'}</strong> admin panel.</p>
        <p style="color:#64748b;font-size:14px">Your SMTP configuration is correct. Appointment reminders will be sent automatically.</p>
      </div>`
  })

  if (result.ok) {
    res.json({ success: true, message: 'Email sent successfully!' })
  } else {
    res.status(500).json({ error: result.error })
  }
})

/* ── Email status check ── */
router.get('/email-status', async (req, res) => {
  const config = await getSmtpConfig()
  res.json({
    configured: !!(config.smtp_user && config.smtp_pass),
    smtp_host:  config.smtp_host || 'smtp.gmail.com',
    smtp_port:  config.smtp_port || 587,
    smtp_user:  config.smtp_user ? config.smtp_user.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    hint: !config.smtp_user ? 'Go to Settings → Email to configure SMTP' : null
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
    clinic_email, smtp_host, smtp_port, smtp_user, smtp_pass
  } = req.body

  db.run(`
    UPDATE clinic_config SET
      clinic_name    = ?,
      clinic_tagline = ?,
      clinic_type    = ?,
      clinic_icon    = ?,
      clinic_phone   = ?,
      clinic_address = ?,
      clinic_website = ?,
      whatsapp       = ?,
      google_maps    = ?,
      open_hour      = ?,
      close_hour     = ?,
      slot_duration  = ?,
      open_days      = ?,
      max_per_day    = ?,
      clinic_email   = ?,
      smtp_host      = ?,
      smtp_port      = ?,
      smtp_user      = ?,
      smtp_pass      = ?
    WHERE id = 1
  `, [
    clinic_name    || 'My Clinic',
    clinic_tagline || 'Quality care, easy booking',
    clinic_type    || 'general',
    clinic_icon    || '🏥',
    clinic_phone   || '',
    clinic_address || '',
    clinic_website || '',
    whatsapp       || '',
    google_maps    || '',
    open_hour      || 10,
    close_hour     || 17,
    slot_duration  || 30,
    open_days      || 'Mon,Tue,Wed,Thu,Fri,Sat',
    max_per_day    || 20,
    clinic_email   || '',
    smtp_host      || 'smtp.gmail.com',
    smtp_port      || 587,
    smtp_user      || '',
    smtp_pass      || ''
  ], function(err) {
    if (err) return res.status(500).json({ error: 'DB error: ' + err.message })
    res.json({ success: true })
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

module.exports = router
