'use strict'

const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production'

/* ================================================
   GENERATE TOKEN
   Call this on successful login
================================================ */

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' })
}

/* ================================================
   VERIFY MIDDLEWARE
   Protects routes — returns 401 if no valid token
================================================ */

function verifyToken(req, res, next) {
  const auth = req.headers['authorization']

  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Please log in.' })
  }

  const token = auth.slice(7)

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.admin     = decoded
    next()
  } catch(err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }
    return res.status(401).json({ error: 'Invalid token. Please log in.' })
  }
}

module.exports = { generateToken, verifyToken, JWT_SECRET }