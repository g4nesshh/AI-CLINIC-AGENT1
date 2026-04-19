'use strict'

const express = require('express')
const router  = express.Router()
const db      = require('../database/db')
const jwt     = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret'

/* ── OTP store (in-memory, expires in 10 min) ── */
const otpStore = {}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function cleanOTPs() {
  const now = Date.now()
  for (const key of Object.keys(otpStore)) {
    if (otpStore[key].expires < now) delete otpStore[key]
  }
}
setInterval(cleanOTPs, 5 * 60 * 1000)

/* ── Patient JWT ── */
function generatePatientToken(phone, name) {
  return jwt.sign({ phone, name, role: 'patient' }, JWT_SECRET, { expiresIn: '7d' })
}

function verifyPatientToken(req, res, next) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please log in to continue' })
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET)
    if (decoded.role !== 'patient') return res.status(401).json({ error: 'Invalid token' })
    req.patient = decoded
    next()
  } catch(e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' })
  }
}

/* ================================================
   POST /patient/send-otp
   Body: { phone }
   Sends a 6-digit OTP via Resend email or SMS
   (Uses email if patient has one, otherwise shows
   OTP in response for testing — swap for real SMS)
================================================ */

router.post('/send-otp', async (req, res) => {
  const { phone } = req.body
  if (!phone || phone.replace(/\D/g,'').length !== 10) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit phone number' })
  }

  const cleaned = phone.replace(/\D/g,'')
  const otp     = generateOTP()
  const expires = Date.now() + 10 * 60 * 1000 // 10 minutes

  otpStore[cleaned] = { otp, expires, attempts: 0 }

  // Get patient's email from last appointment
  const appt = await new Promise(resolve => {
    db.get(
      `SELECT email, name FROM appointments WHERE phone = ? AND email != '' ORDER BY date DESC LIMIT 1`,
      [cleaned], (err, row) => resolve(row || null)
    )
  })

  const config = await new Promise(resolve => {
    db.get('SELECT clinic_name FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })

  // Try to send OTP via email if available
  if (appt?.email && process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    `${config.clinic_name || 'ClinicAI'} <${process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'}>`,
          to:      [appt.email],
          subject: `Your login OTP — ${config.clinic_name || 'ClinicAI'}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:32px;text-align:center">
              <div style="font-size:48px;margin-bottom:16px">🔐</div>
              <h2 style="color:#0ea5e9;margin-bottom:8px">Your login code</h2>
              <p style="color:#64748b;margin-bottom:24px">Enter this code to access your appointments</p>
              <div style="background:#f0f9ff;border:2px solid #0ea5e9;border-radius:12px;padding:20px;margin-bottom:20px">
                <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:monospace">${otp}</div>
              </div>
              <p style="color:#94a3b8;font-size:12px">Valid for 10 minutes. Do not share this code.</p>
            </div>`
        })
      })
      console.log(`[Patient] OTP sent to email ${appt.email} for phone ${cleaned}`)
      return res.json({ success: true, method: 'email', hint: `OTP sent to ${appt.email.replace(/(.{2}).*(@.*)/, '$1***$2')}` })
    } catch(e) {
      console.error('[Patient] OTP email failed:', e.message)
    }
  }

  // Fallback: return OTP in response (for development / when no email)
  // In production: integrate Twilio/MSG91 for SMS here
  console.log(`[Patient] OTP for ${cleaned}: ${otp}`)
  res.json({
    success: true,
    method:  'console',
    // Only show OTP in dev — remove this in production when SMS is set up
    otp:     process.env.NODE_ENV !== 'production' ? otp : undefined,
    hint:    appt?.email
      ? `OTP sent to your email`
      : `OTP: check Render logs (add SMS provider for production)`
  })
})

/* ================================================
   POST /patient/verify-otp
   Body: { phone, otp }
   Returns: { token, name, appointmentCount }
================================================ */

router.post('/verify-otp', async (req, res) => {
  const { phone, otp } = req.body
  const cleaned = (phone || '').replace(/\D/g,'')

  if (!cleaned || !otp) {
    return res.status(400).json({ error: 'Phone and OTP required' })
  }

  const record = otpStore[cleaned]

  if (!record) {
    return res.status(400).json({ error: 'No OTP found. Please request a new one.' })
  }
  if (Date.now() > record.expires) {
    delete otpStore[cleaned]
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' })
  }

  record.attempts = (record.attempts || 0) + 1
  if (record.attempts > 5) {
    delete otpStore[cleaned]
    return res.status(429).json({ error: 'Too many attempts. Please request a new OTP.' })
  }
  if (record.otp !== otp.trim()) {
    return res.status(400).json({ error: `Incorrect OTP. ${5 - record.attempts} attempts remaining.` })
  }

  // OTP valid — clean up and issue token
  delete otpStore[cleaned]

  // Get patient name from appointments
  const appt = await new Promise(resolve => {
    db.get(`SELECT name FROM appointments WHERE phone = ? ORDER BY date DESC LIMIT 1`,
      [cleaned], (err, row) => resolve(row || null))
  })

  const name  = appt?.name || 'Patient'
  const token = generatePatientToken(cleaned, name)

  // Count upcoming appointments
  const today = new Date().toISOString().split('T')[0]
  const count = await new Promise(resolve => {
    db.get(`SELECT COUNT(*) as c FROM appointments WHERE phone = ? AND date >= ?`,
      [cleaned, today], (err, row) => resolve(row?.c || 0))
  })

  res.json({ success: true, token, name, appointmentCount: count })
})

/* ================================================
   GET /patient/appointments
   Returns patient's appointments (upcoming + past)
================================================ */

router.get('/appointments', verifyPatientToken, (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  db.all(`
    SELECT a.*, d.name as doctor_name_live, d.specialization
    FROM appointments a
    LEFT JOIN doctors d ON a.doctor_id = d.id
    WHERE a.phone = ?
    ORDER BY a.date DESC, a.time DESC
  `, [req.patient.phone], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' })
    const appts  = rows || []
    const upcoming = appts.filter(a => a.date >= today)
    const past     = appts.filter(a => a.date <  today)
    res.json({ upcoming, past, total: appts.length })
  })
})

/* ================================================
   DELETE /patient/appointments/:id
   Patient cancels their own appointment
================================================ */

router.delete('/appointments/:id', verifyPatientToken, (req, res) => {
  // Verify this appointment belongs to this patient
  db.get('SELECT * FROM appointments WHERE id = ? AND phone = ?',
    [req.params.id, req.patient.phone], (err, appt) => {
      if (err || !appt) return res.status(404).json({ error: 'Appointment not found' })

      const today = new Date().toISOString().split('T')[0]
      if (appt.date < today) return res.status(400).json({ error: 'Cannot cancel a past appointment' })

      db.run('DELETE FROM appointments WHERE id = ?', [appt.id], function(err2) {
        if (err2) return res.status(500).json({ error: 'Could not cancel' })

        // Notify waitlist
        const { notifyWaitlistOnCancel } = require('../services/waitlist')
        notifyWaitlistOnCancel(appt.date, appt.time, appt.doctor_id).catch(() => {})

        res.json({ success: true })
      })
    }
  )
})

/* ================================================
   GET /patient/profile
   Returns patient name + basic info
================================================ */

router.get('/profile', verifyPatientToken, async (req, res) => {
  const patient = await new Promise(resolve => {
    db.get('SELECT * FROM patients WHERE phone = ?', [req.patient.phone], (err, row) => resolve(row || null))
  })
  res.json({
    phone:        req.patient.phone,
    name:         req.patient.name,
    last_service: patient?.last_service,
    last_date:    patient?.last_date,
    visit_count:  patient?.visit_count || 0
  })
})

module.exports = router