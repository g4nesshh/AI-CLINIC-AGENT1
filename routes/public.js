'use strict'

const express = require('express')
const router  = express.Router()
const db      = require('../database/db')
const { getClinicConfig, isClinicOpen, getAvailableSlots } = require('../services/slots')

// Public clinic info — no auth needed
router.get('/clinic-info', async (req, res) => {
  try {
    const [config, doctors, services] = await Promise.all([
      getClinicConfig(),
      new Promise((resolve) => db.all('SELECT id,name,specialization,available_days FROM doctors WHERE active=1 ORDER BY name', [], (e,r) => resolve(r||[]))),
      new Promise((resolve) => db.all('SELECT id,name,duration_minutes FROM services WHERE active=1 ORDER BY name', [], (e,r) => resolve(r||[])))
    ])
    res.json({ config, doctors, services })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Public slots for a given date
router.get('/public-slots', async (req, res) => {
  const { date } = req.query
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' })
  }
  try {
    const openCheck = await isClinicOpen(date)
    if (!openCheck.open) {
      return res.json({ open: false, reason: openCheck.reason, slots: [] })
    }
    const slots = await getAvailableSlots(date)
    res.json({ open: true, slots })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router