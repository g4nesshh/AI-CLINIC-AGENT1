'use strict'

const db = require('../database/db')

// Table created in db.js schema setup

function logEvent({ event, userId = null, intent = null, service = null, doctor = null, success = false, metadata = null }) {
  const meta = metadata ? JSON.stringify(metadata) : null
  db.run(
    'INSERT INTO analytics (event, "userId", intent, service, doctor, success, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [event, userId, intent, service, doctor, success ? 1 : 0, meta],
    (err) => { if (err) console.error('[Analytics] Log error:', err.message) }
  )
  console.log(`[Analytics] ${event}`, { userId: userId?.slice(0,8), intent, service, success })
}

async function getAnalyticsSummary() {
  return new Promise((resolve) => {
    db.all(`
      SELECT event, COUNT(*) as count, SUM(success) as successes, DATE(created_at) as date
      FROM analytics
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY event, DATE(created_at)
      ORDER BY date DESC, count DESC
    `, [], (err, rows) => resolve(rows || []))
  })
}

async function getTopServices() {
  return new Promise((resolve) => {
    db.all(`
      SELECT service, COUNT(*) as count
      FROM analytics
      WHERE event = 'booking_confirmed' AND service IS NOT NULL
      GROUP BY service ORDER BY count DESC LIMIT 5
    `, [], (err, rows) => resolve(rows || []))
  })
}

async function getDropOffPoints() {
  return new Promise((resolve) => {
    db.all(`
      SELECT intent, COUNT(*) as count, AVG(success) as success_rate
      FROM analytics
      WHERE intent IS NOT NULL
      GROUP BY intent ORDER BY count DESC
    `, [], (err, rows) => resolve(rows || []))
  })
}

module.exports = { logEvent, getAnalyticsSummary, getTopServices, getDropOffPoints }