'use strict'

const express = require('express')
const router  = express.Router()
const db      = require('../database/db')

const { rateLimit }       = require('../utils/helpers')
const { getAllWaitlist, removeFromWaitlist } = require('../services/waitlist')
const { getAllServices }   = require('../services/booking')
const { getAllHolidays, addHoliday, deleteHoliday } = require('../services/slots')

// Note: Email reminders are handled by worker.js (run separately)

async function getSmtpConfig() {
  return new Promise((resolve) => { db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {})) })
}

/* ── Clinic Config ── */
router.get('/clinic-config', (req, res) => {
  db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' })
    res.json(row)
  })
})

router.put('/clinic-config', (req, res) => {
  const { clinic_name, open_hour, close_hour, slot_duration, open_days, clinic_email, smtp_host, smtp_port, smtp_user, smtp_pass } = req.body
  db.run(
    `UPDATE clinic_config SET clinic_name=?, open_hour=?, close_hour=?, slot_duration=?, open_days=?, clinic_email=?, smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=? WHERE id=1`,
    [clinic_name, open_hour, close_hour, slot_duration, open_days, clinic_email||'', smtp_host||'smtp.gmail.com', smtp_port||587, smtp_user||'', smtp_pass||''],
    function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }) }
  )
})

router.post('/test-email', async (req, res) => {
  const { to } = req.body
  if (!to) return res.status(400).json({ error: 'email required' })
  const config = await getSmtpConfig()
  const sent = await sendReminderEmail({ to, patientName: 'Admin', clinicName: config.clinic_name||'ClinicAI', doctorName: 'Dr. Test', date: new Date().toISOString().split('T')[0], time: '10:00', service: 'Test', type: '24h' })
  if (sent) res.json({ success: true }); else res.status(500).json({ error: 'Failed — check SMTP settings' })
})

/* ── Appointments ── */
router.get('/appointments/today', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  const today = new Date().toISOString().split('T')[0]
  db.all(`SELECT a.*, d.name as doctor_name_live, d.specialization FROM appointments a LEFT JOIN doctors d ON a.doctor_id = d.id WHERE a.date = ? ORDER BY a.time`, [today], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows) })
})

router.get('/appointments', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  db.all(`SELECT a.*, d.name as doctor_name_live, d.specialization FROM appointments a LEFT JOIN doctors d ON a.doctor_id = d.id ORDER BY a.date, a.time`, [], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows) })
})

router.delete('/appointments/:id', (req, res) => {
  if (rateLimit(`admin:${req.ip}`, 60, 60000)) return res.status(429).json({ error: 'Too many requests.' })
  db.run('DELETE FROM appointments WHERE id=?', [req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); if (this.changes === 0) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }) })
})

/* ── Doctors ── */
router.get('/doctors', (req, res) => {
  db.all('SELECT * FROM doctors ORDER BY name', [], (err, rows) => { if (err) return res.status(500).json({ error: 'DB error' }); res.json(rows) })
})

router.post('/doctors', (req, res) => {
  const { name, specialization, available_days } = req.body
  if (!name || !specialization) return res.status(400).json({ error: 'name and specialization required' })
  db.run('INSERT INTO doctors (name, specialization, available_days) VALUES (?, ?, ?)', [name, specialization, available_days||'Mon,Tue,Wed,Thu,Fri,Sat'], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true, id: this.lastID }) })
})

router.put('/doctors/:id', (req, res) => {
  const { name, specialization, available_days, active } = req.body
  db.run('UPDATE doctors SET name=?, specialization=?, available_days=?, active=? WHERE id=?', [name, specialization, available_days, active??1, req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }) })
})

router.delete('/doctors/:id', (req, res) => {
  db.run('UPDATE doctors SET active=0 WHERE id=?', [req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }) })
})

/* ── Waitlist ── */
router.get('/waitlist',        async (req, res) => { try { res.json(await getAllWaitlist()) } catch { res.status(500).json({ error: 'DB error' }) } })
router.delete('/waitlist/:id', async (req, res) => { const ok = await removeFromWaitlist(req.params.id); if (ok) res.json({ success: true }); else res.status(404).json({ error: 'Not found' }) })

/* ── Services ── */
router.get('/services', async (req, res) => { try { res.json(await getAllServices()) } catch { res.status(500).json({ error: 'DB error' }) } })

router.post('/services', (req, res) => {
  const { name, duration_minutes } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  db.run('INSERT OR REPLACE INTO services (name, duration_minutes) VALUES (?, ?)', [name, duration_minutes||30], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true, id: this.lastID }) })
})

router.put('/services/:id', (req, res) => {
  const { name, duration_minutes, active } = req.body
  db.run('UPDATE services SET name=?, duration_minutes=?, active=? WHERE id=?', [name, duration_minutes||30, active??1, req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }) })
})

router.delete('/services/:id', (req, res) => {
  db.run('UPDATE services SET active=0 WHERE id=?', [req.params.id], function(err) { if (err) return res.status(500).json({ error: 'DB error' }); res.json({ success: true }) })
})

/* ── Holidays ── */
router.get('/holidays',        async (req, res) => { try { res.json(await getAllHolidays()) } catch { res.status(500).json({ error: 'DB error' }) } })
router.post('/holidays',       async (req, res) => { const { date, reason } = req.body; if (!date) return res.status(400).json({ error: 'date required' }); const id = await addHoliday(date, reason||'Clinic Holiday'); if (id) res.json({ success: true, id }); else res.status(500).json({ error: 'DB error' }) })
router.delete('/holidays/:id', async (req, res) => { const ok = await deleteHoliday(req.params.id); if (ok) res.json({ success: true }); else res.status(404).json({ error: 'Not found' }) })

/* ── Analytics ── */
const { getAnalyticsSummary, getTopServices, getDropOffPoints } = require('../utils/analytics')

router.get('/analytics', async (req, res) => {
  try {
    const [summary, topServices, dropOffs] = await Promise.all([
      getAnalyticsSummary(),
      getTopServices(),
      getDropOffPoints()
    ])
    res.json({ summary, topServices, dropOffs })
  } catch(e) { res.status(500).json({ error: 'DB error' }) }
})

module.exports = router
