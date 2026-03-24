
'use strict'

const express = require('express')
const path    = require('path')
const db      = require('./database/db')

const app = express()

/* ── Middleware ── */
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

/* ── Routes ── */
app.use('/chat', require('./routes/chat'))
app.use('/api',  require('./routes/admin'))

/* ── Legacy admin routes (keeps admin.html working) ── */
const admin = require('./routes/admin')
app.use(admin)

/* ── Start ── */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ClinicAI running on port ${PORT}`)
})
