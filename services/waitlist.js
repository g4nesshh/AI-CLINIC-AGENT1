'use strict'

const db = require('../database/db')

async function addToWaitlist(data) {
  return new Promise((resolve) => {
    db.run(
      'INSERT INTO waitlist (name, phone, email, date, doctor_id, doctor_name, service, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [data.name, data.phone, data.email||'', data.date, data.doctor_id||null, data.doctor_name||null, data.service||'Checkup', data.notes||''],
      function(err) { resolve(err ? null : this.lastID) }
    )
  })
}

async function getWaitlistForDate(date, doctorId) {
  return new Promise((resolve) => {
    const sql    = doctorId
      ? 'SELECT * FROM waitlist WHERE date = ? AND (doctor_id = ? OR doctor_id IS NULL) AND notified = 0 ORDER BY created_at'
      : 'SELECT * FROM waitlist WHERE date = ? AND notified = 0 ORDER BY created_at'
    const params = doctorId ? [date, doctorId] : [date]
    db.all(sql, params, (err, rows) => resolve(rows || []))
  })
}

async function markWaitlistNotified(id) {
  return new Promise((resolve) => {
    db.run('UPDATE waitlist SET notified = 1 WHERE id = ?', [id], () => resolve())
  })
}

async function getAllWaitlist() {
  return new Promise((resolve) => {
    db.all('SELECT * FROM waitlist ORDER BY date, created_at', [], (err, rows) => resolve(rows || []))
  })
}

async function removeFromWaitlist(id) {
  return new Promise((resolve) => {
    db.run('DELETE FROM waitlist WHERE id = ?', [id], function(err) {
      resolve(!err && this.changes > 0)
    })
  })
}

async function sendWaitlistEmail(waiter, date, time, clinicName, fromEmail, bookingUrl) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !waiter.email || !waiter.email.includes('@')) return

  const [h, m] = time.split(':').map(Number)
  const time12  = `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${clinicName} <${fromEmail || 'onboarding@resend.dev'}>`,
        to:      [waiter.email],
        subject: `🎉 A slot just opened for you at ${clinicName}!`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px">
            <h2 style="color:#0ea5e9;margin-bottom:4px">Good news, ${waiter.name}!</h2>
            <p style="color:#64748b;margin-bottom:20px">A slot you were waiting for just opened up.</p>
            <div style="background:#f0f9ff;border-radius:12px;padding:20px;margin-bottom:20px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:6px 0;color:#64748b;width:100px">Date</td><td style="padding:6px 0;font-weight:600">${date}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b">Time</td><td style="padding:6px 0;font-weight:600">${time12}</td></tr>
                <tr><td style="padding:6px 0;color:#64748b">Service</td><td style="padding:6px 0;font-weight:600">${waiter.service}</td></tr>
                ${waiter.doctor_name?`<tr><td style="padding:6px 0;color:#64748b">Doctor</td><td style="padding:6px 0;font-weight:600">${waiter.doctor_name}</td></tr>`:''}
              </table>
            </div>
            <p style="color:#475569;margin-bottom:20px">Book quickly before someone else takes it!</p>
            <a href="${bookingUrl||'#'}" style="display:inline-block;background:#0ea5e9;color:white;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px">📅 Book This Slot Now</a>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">You were on the waitlist at ${clinicName}. Ignore this if no longer needed.</p>
          </div>`
      })
    })
    const data = await res.json()
    if (res.ok) console.log('[Waitlist] ✅ Email sent to', waiter.email)
    else        console.error('[Waitlist] ❌ Email failed:', data.message)
  } catch(e) {
    console.error('[Waitlist] ❌ Error:', e.message)
  }
}

async function notifyWaitlistOnCancel(date, time, doctorId) {
  const waiters = await getWaitlistForDate(date, doctorId)
  if (!waiters.length) return null

  const first = waiters[0]
  await markWaitlistNotified(first.id)
  console.log(`[Waitlist] Slot opened ${date} ${time} — notifying ${first.name}`)

  if (first.email && first.email.includes('@')) {
    const config = await new Promise((resolve) => {
      db.get('SELECT clinic_name FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
    })
    await sendWaitlistEmail(
      first, date, time,
      config.clinic_name || 'Our Clinic',
      process.env.RESEND_FROM_EMAIL,
      process.env.CLINIC_URL
    )
  }

  return first
}

module.exports = {
  addToWaitlist, getWaitlistForDate, markWaitlistNotified,
  getAllWaitlist, removeFromWaitlist, notifyWaitlistOnCancel
}

