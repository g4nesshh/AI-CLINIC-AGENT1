/**
 * Run this script once from your project folder:
 *   node fix_server.js
 * 
 * It will patch your server.js to fix:
 * 1. Booking confirm bug ("No appointment found" after skip)
 * 2. Add missing admin routes for doctors, holidays, waitlist, services
 */

const fs = require('fs')
const path = require('path')

const serverPath = path.join(__dirname, 'server.js')
let code = fs.readFileSync(serverPath, 'utf8')

let changes = 0

// ── FIX 1: Booking confirm bug ──────────────────────────────
// Force intent back to "book" before showing confirmation summary
// This prevents the confirm step from treating "skip" as cancel

const oldConfirm1 = `    // All fields ready — show confirmation
    state.step = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── MID-FLOW`
const newConfirm1 = `    // All fields ready — force intent to book and show confirmation
    state.intent = "book"
    state.step   = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── MID-FLOW`

if (code.includes(oldConfirm1)) {
  code = code.replace(oldConfirm1, newConfirm1)
  console.log('✅ Fix 1a applied: book flow confirm guard')
  changes++
}

const oldConfirm2 = `    state.step = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── SLOTS QUERY`
const newConfirm2 = `    state.intent = "book"
    state.step   = "confirming"
    return res.json({ reply: buildSummary(state) })
  }

  // ── SLOTS QUERY`

if (code.includes(oldConfirm2)) {
  code = code.replace(oldConfirm2, newConfirm2)
  console.log('✅ Fix 1b applied: mid-flow confirm guard')
  changes++
}

// ── FIX 2: Add missing admin routes ────────────────────────
// Add doctors, holidays, waitlist, services routes before app.listen

const adminRoutes = `
/* ── GET all doctors ── */
app.get("/doctors", (req, res) => {
  db.all("SELECT * FROM doctors ORDER BY name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(rows || [])
  })
})

/* ── ADD a doctor ── */
app.post("/doctors", (req, res) => {
  const { name, specialization, available_days } = req.body
  if (!name) return res.status(400).json({ error: "name required" })
  db.run(
    "INSERT INTO doctors (name, specialization, available_days) VALUES (?, ?, ?)",
    [name, specialization || 'General', available_days || 'Mon,Tue,Wed,Thu,Fri,Sat'],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, id: this.lastID })
    }
  )
})

/* ── UPDATE a doctor ── */
app.put("/doctors/:id", (req, res) => {
  const { name, specialization, available_days, active } = req.body
  db.run(
    "UPDATE doctors SET name=?, specialization=?, available_days=?, active=? WHERE id=?",
    [name, specialization, available_days, active ?? 1, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true })
    }
  )
})

/* ── DELETE a doctor ── */
app.delete("/doctors/:id", (req, res) => {
  db.run("UPDATE doctors SET active=0 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

/* ── GET all holidays ── */
app.get("/holidays", (req, res) => {
  db.all("SELECT * FROM holidays ORDER BY date", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(rows || [])
  })
})

/* ── ADD a holiday ── */
app.post("/holidays", (req, res) => {
  const { date, reason } = req.body
  if (!date) return res.status(400).json({ error: "date required" })
  db.run(
    "INSERT OR REPLACE INTO holidays (date, reason) VALUES (?, ?)",
    [date, reason || 'Clinic Holiday'],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, id: this.lastID })
    }
  )
})

/* ── DELETE a holiday ── */
app.delete("/holidays/:id", (req, res) => {
  db.run("DELETE FROM holidays WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

/* ── GET all services ── */
app.get("/services", (req, res) => {
  db.all("SELECT * FROM services WHERE active=1 ORDER BY name", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(rows || [])
  })
})

/* ── ADD a service ── */
app.post("/services", (req, res) => {
  const { name, duration_minutes } = req.body
  if (!name) return res.status(400).json({ error: "name required" })
  db.run(
    "INSERT OR REPLACE INTO services (name, duration_minutes) VALUES (?, ?)",
    [name, duration_minutes || 30],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true, id: this.lastID })
    }
  )
})

/* ── UPDATE a service ── */
app.put("/services/:id", (req, res) => {
  const { name, duration_minutes, active } = req.body
  db.run(
    "UPDATE services SET name=?, duration_minutes=?, active=? WHERE id=?",
    [name, duration_minutes || 30, active ?? 1, req.params.id],
    function(err) {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json({ success: true })
    }
  )
})

/* ── DELETE a service ── */
app.delete("/services/:id", (req, res) => {
  db.run("UPDATE services SET active=0 WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

/* ── GET waitlist ── */
app.get("/waitlist", (req, res) => {
  db.all("SELECT * FROM waitlist ORDER BY date, created_at", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json(rows || [])
  })
})

/* ── DELETE from waitlist ── */
app.delete("/waitlist/:id", (req, res) => {
  db.run("DELETE FROM waitlist WHERE id=?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: "DB error" })
    res.json({ success: true })
  })
})

/* ── GET today's appointments ── */
app.get("/appointments/today", (req, res) => {
  const today = new Date().toISOString().split('T')[0]
  db.all(
    "SELECT * FROM appointments WHERE date=? ORDER BY time",
    [today],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" })
      res.json(rows || [])
    }
  )
})

/* ── Quick config setter ── */
app.post("/set-sms-key", (req, res) => {
  const { key, enabled } = req.body
  db.run(
    "UPDATE clinic_config SET sms_api_key=?, otp_enabled=? WHERE id=1",
    [key || '', enabled !== undefined ? enabled : 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ success: true })
    }
  )
})

/* ── Debug config ── */
app.get("/debug-config", (req, res) => {
  db.get("SELECT * FROM clinic_config WHERE id=1", [], (err, row) => {
    if (!row) return res.json({})
    res.json({
      otp_enabled: row.otp_enabled,
      sms_api_key: row.sms_api_key ? row.sms_api_key.slice(0,15)+'...' : 'NOT SET',
      clinic_name: row.clinic_name
    })
  })
})

`

// Insert admin routes before app.listen
if (!code.includes('app.get("/doctors"')) {
  code = code.replace(
    `app.listen(3000`,
    adminRoutes + `app.listen(3000`
  )
  console.log('✅ Fix 2 applied: admin routes for doctors/holidays/waitlist/services added')
  changes++
} else {
  console.log('ℹ️  Admin routes already exist — skipped')
}

if (changes > 0) {
  // Backup original
  fs.writeFileSync(serverPath + '.backup', fs.readFileSync(serverPath))
  fs.writeFileSync(serverPath, code)
  console.log('\n✅ server.js patched successfully!')
  console.log('   Original saved as server.js.backup')
  console.log('\n   Restart server: node server.js')
} else {
  console.log('\n⚠️  No changes made — patterns not found')
  console.log('   Your server.js may already be patched or have different formatting')
}
