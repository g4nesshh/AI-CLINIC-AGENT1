'use strict'

const express = require('express')
const path    = require('path')
const db      = require('./database/db')

const app = express()

app.use(express.json())
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// Clinic landing page (QR code points here)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'clinic.html'))
})

// Chat page
app.get('/chat-ui', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'))
})

app.use(express.static(path.join(__dirname, 'public')))
app.use('/chat',   require('./routes/chat'))
app.use('/public', require('./routes/public'))
app.use(require('./routes/admin'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('ClinicAI running on port ' + PORT))
