'use strict'

const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const db       = require('../database/db')
const { generateToken, verifyToken } = require('../middleware/auth')

// admin_users table is created by database/db.js setupSchema()
// Default admin user (username: admin) is also seeded there

/* ================================================
   POST /auth/login
   Body: { username, password }
   Returns: { token, expiresIn }
================================================ */

router.post('/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM admin_users WHERE username = ?',
      [username.toLowerCase().trim()],
      async (err, user) => {
        if (err || !user) {
          return resolve(res.status(401).json({ error: 'Invalid username or password' }))
        }

        const match = await bcrypt.compare(password, user.password)
        if (!match) {
          return resolve(res.status(401).json({ error: 'Invalid username or password' }))
        }

        const token = generateToken({ id: user.id, username: user.username })
        console.log('[Auth] ✅ Login:', user.username)

        resolve(res.json({
          success:   true,
          token,
          expiresIn: '24h',
          username:  user.username
        }))
      }
    )
  })
})

/* ================================================
   POST /auth/change-password
   Protected — requires valid token
   Body: { currentPassword, newPassword }
================================================ */

router.post('/change-password', verifyToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' })
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }

  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM admin_users WHERE id = ?',
      [req.admin.id],
      async (err, user) => {
        if (err || !user) {
          return resolve(res.status(404).json({ error: 'User not found' }))
        }

        const match = await bcrypt.compare(currentPassword, user.password)
        if (!match) {
          return resolve(res.status(401).json({ error: 'Current password is incorrect' }))
        }

        const hashed = await bcrypt.hash(newPassword, 10)
        db.run(
          'UPDATE admin_users SET password = ? WHERE id = ?',
          [hashed, user.id],
          (err2) => {
            if (err2) return resolve(res.status(500).json({ error: 'Could not update password' }))
            console.log('[Auth] Password changed for:', user.username)
            resolve(res.json({ success: true, message: 'Password updated successfully' }))
          }
        )
      }
    )
  })
})

/* ================================================
   GET /auth/verify
   Quick check — is the token still valid?
================================================ */

router.get('/verify', verifyToken, (req, res) => {
  res.json({ valid: true, username: req.admin.username })
})

module.exports = router