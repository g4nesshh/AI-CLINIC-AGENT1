'use strict'

const express = require('express')
const router  = express.Router()
const db      = require('../database/db')
const crypto  = require('crypto')

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET

/* ================================================
   CREATE PAYMENT ORDER
   Called when patient confirms booking details.
   Creates a Razorpay order for the deposit amount.
================================================ */

router.post('/create-order', async (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(503).json({
      error: 'Razorpay not configured',
      hint:  'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to Render environment variables'
    })
  }

  const { amount, booking_ref, patient_name, service } = req.body

  if (!amount || amount < 1) {
    return res.status(400).json({ error: 'Invalid amount' })
  }

  const amountPaise = Math.round(amount * 100) // Razorpay uses paise

  try {
    const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')

    const res2 = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `booking_${booking_ref || Date.now()}`,
        notes: {
          patient_name: patient_name || '',
          service:      service      || '',
          booking_ref:  String(booking_ref || '')
        }
      })
    })

    const order = await res2.json()

    if (!res2.ok) {
      console.error('[Payment] Razorpay order failed:', order)
      return res.status(500).json({ error: order.error?.description || 'Could not create payment order' })
    }

    console.log('[Payment] Order created:', order.id)
    res.json({
      order_id:  order.id,
      amount:    order.amount,
      currency:  order.currency,
      key_id:    RAZORPAY_KEY_ID
    })

  } catch(e) {
    console.error('[Payment] Error:', e.message)
    res.status(500).json({ error: 'Payment service error: ' + e.message })
  }
})

/* ================================================
   VERIFY PAYMENT
   Called after patient completes payment.
   Verifies signature and marks appointment as paid.
================================================ */

router.post('/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, appointment_id } = req.body

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details' })
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex')

  if (expectedSignature !== razorpay_signature) {
    console.error('[Payment] ❌ Signature mismatch')
    return res.status(400).json({ error: 'Payment verification failed — invalid signature' })
  }

  // Mark appointment as paid
  if (appointment_id) {
    db.run(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_id TEXT DEFAULT ''
    `, () => {
      db.run(`
        ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid'
      `, () => {
        db.run(
          `UPDATE appointments SET payment_id = ?, payment_status = 'paid' WHERE id = ?`,
          [razorpay_payment_id, appointment_id],
          (err) => { if (err) console.error('[Payment] DB update error:', err.message) }
        )
      })
    })
  }

  console.log('[Payment] ✅ Payment verified:', razorpay_payment_id)
  res.json({ success: true, payment_id: razorpay_payment_id })
})

/* ================================================
   GET DEPOSIT AMOUNT
   Returns the configured deposit amount for booking.
   Admin can set this in clinic config.
================================================ */

router.get('/deposit-amount', async (req, res) => {
  const config = await new Promise(resolve => {
    db.get('SELECT * FROM clinic_config WHERE id = 1', [], (err, row) => resolve(row || {}))
  })

  const depositAmount = config.deposit_amount || 0
  const depositEnabled = config.deposit_enabled || 0

  res.json({
    enabled: depositEnabled === 1,
    amount:  depositAmount,
    key_id:  RAZORPAY_KEY_ID || null,
    configured: !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  })
})

module.exports = router