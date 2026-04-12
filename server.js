'use strict'

const express = require('express')
const path    = require('path')
const db      = require('./database/db')

const app = express()

/* ── Middleware ── */
app.use(express.json())
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

/* ── Public pages ── */
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'clinic.html')))
app.get('/chat-ui',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')))
app.get('/onboarding', (req, res) => res.sendFile(path.join(__dirname, 'public', 'onboarding.html')))

/* ── Static files ── */
app.use(express.static(path.join(__dirname, 'public')))

/* ── Public API routes (no auth) ── */
app.use('/auth',   require('./routes/auth'))
app.use('/chat',   require('./routes/chat'))
app.use('/public', require('./routes/public'))

/* ── Protected admin routes (JWT required) ── */
const { verifyToken } = require('./middleware/auth')
const { router: adminRouter } = require('./routes/admin')
app.use(verifyToken, adminRouter)

/* ── 404 handler ── */
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/chat') || req.path.startsWith('/public')) {
    return res.status(404).json({ error: 'Not found' })
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'))
})

/* ── Start ── */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('ClinicAI running on port ' + PORT)
  if (!process.env.JWT_SECRET) console.warn('[Auth] ⚠️  JWT_SECRET not set!')
  if (!process.env.RESEND_API_KEY) console.warn('[Email] ⚠️  RESEND_API_KEY not set!')
})
