'use strict'

const express = require('express')
const path    = require('path')

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

/* ── Static files (public/) ── */
app.use(express.static(path.join(__dirname, 'public')))

/* ── HTML pages ── */
const page = (f) => (req, res) =>
  res.sendFile(path.join(__dirname, 'public', f))

app.get('/',           page('clinic.html'))
app.get('/chat',       page('chat.html'))
app.get('/chat-ui',    page('chat.html'))
app.get('/admin',      page('admin.html'))
app.get('/login',      page('login.html'))
app.get('/portal',     page('portal.html'))
app.get('/onboarding', page('onboarding.html'))

/* ── Public API (no auth) ── */
app.use('/auth',    require('./routes/auth'))
app.use('/chat',    require('./routes/chat'))
app.use('/public',  require('./routes/public'))
app.use('/patient', require('./routes/patient'))
app.use('/payment', require('./routes/payment'))

/* ── Protected Admin API (JWT required) ──
   Mounted on specific paths so it NEVER intercepts
   HTML page requests like GET /admin or GET /login
── */
const { verifyToken } = require('./middleware/auth')
const { router: adminRouter } = require('./routes/admin')

const ADMIN_API_PATHS = [
  '/appointments',
  '/doctors',
  '/services',
  '/holidays',
  '/waitlist',
  '/analytics',
  '/clinic-config',
  '/email-status',
  '/test-email',
  '/send-weekly-report',
  '/audit-log',
]

ADMIN_API_PATHS.forEach(p => {
  app.use(p, verifyToken, adminRouter)
})

/* ── 404 ── */
app.use((req, res) => {
  if (req.accepts('html'))
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'))
  res.status(404).json({ error: 'Not found' })
})

/* ── Start ── */
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`ClinicAI running on port ${PORT}`)
  if (!process.env.JWT_SECRET)   console.warn('⚠️  JWT_SECRET not set')
  if (!process.env.DATABASE_URL) console.warn('⚠️  DATABASE_URL not set')
})
