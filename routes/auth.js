'use strict'

const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const db       = require('../database/db')
const { generateToken, verifyToken } = require('../middleware/auth')

/* ================================================
   SETUP — add admin_users table
   Called once on server start
================================================ */

async function setupAdminTable() {
  return new Promise((resolve) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id         SERIAL PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, async (err) => {
      if (err) { console.error('[Auth] Table error:', err.message); return resolve() }

      // Create default admin if none exists
      db.get('SELECT COUNT(*) as count FROM admin_users', [], async (err2, row) => {
        if (err2 || (row && parseInt(row.count) > 0)) return resolve()

        // Default password: admin123 — user MUST change this
        const defaultPass = process.env.ADMIN_DEFAULT_PASSWORD || 'admin123'
        const hashed      = await bcrypt.hash(defaultPass, 10)

        db.run(
          'INSERT INTO admin_users (username, password) VALUES (?, ?)',
          ['admin', hashed],
          (err3) => {
            if (!err3) {
              console.log('[Auth] ✅ Default admin created')
              console.log('[Auth] ⚠️  Username: admin | Password: ' + defaultPass)
              console.log('[Auth] ⚠️  CHANGE THIS PASSWORD immediately from admin panel!')
            }
            resolve()
          }
        )
      })
    })
  })
}

setupAdminTable()

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