'use strict'

const { normalizeMessage } = require('./intent')

function fmt(d) { return d.toISOString().split('T')[0] }

/* ================================================
   DATE PARSER
================================================ */

const MONTHS = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
}

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']

function parseDate(text) {
  const t     = normalizeMessage(text).toLowerCase().trim()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const clone = d => new Date(d)

  if (t.includes('day after tomorrow')) { const d = clone(today); d.setDate(d.getDate()+2); return fmt(d) }
  if (t.includes('tomorrow'))           { const d = clone(today); d.setDate(d.getDate()+1); return fmt(d) }
  if (t.includes('today'))              return fmt(today)

  // next/this/plain weekday
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const day = WEEKDAYS[i]
    if (t.includes('next '+day) || t.includes('coming '+day) || t === day) {
      const d = clone(today); let diff = i - d.getDay(); if (diff <= 0) diff += 7; d.setDate(d.getDate()+diff); return fmt(d)
    }
    if (t.includes('this '+day)) {
      const d = clone(today); let diff = i - d.getDay(); if (diff < 0) diff += 7; d.setDate(d.getDate()+diff); return fmt(d)
    }
  }

  // short day names: mon, tue, wed, thu, fri, sat, thurs, tues
  const shortDays = { mon:1, tue:2, wed:3, thu:4, thurs:4, fri:5, sat:6, sun:0, tues:2, weds:3 }
  const shortFound = Object.keys(shortDays).find(d => t === d || t === 'next '+d || t === 'this '+d)
  if (shortFound) {
    const targetDay = shortDays[shortFound.replace('next ','').replace('this ','')]
    const d = clone(today); let diff = targetDay - d.getDay(); if (diff <= 0) diff += 7; d.setDate(d.getDate()+diff); return fmt(d)
  }

  // "20th march" / "20 march"
  const dmyMatch = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)(?:\s+(\d{4}))?/)
  if (dmyMatch) {
    const day=parseInt(dmyMatch[1]), month=MONTHS[dmyMatch[2]], year=dmyMatch[3]?parseInt(dmyMatch[3]):today.getFullYear()
    const d = new Date(year, month-1, day); if (d >= today) return fmt(d)
  }

  // "march 20"
  const mdyMatch = t.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/)
  if (mdyMatch) {
    const month=MONTHS[mdyMatch[1]], day=parseInt(mdyMatch[2]), year=mdyMatch[3]?parseInt(mdyMatch[3]):today.getFullYear()
    const d = new Date(year, month-1, day); if (d >= today) return fmt(d)
  }

  // ISO format
  const isoMatch = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (isoMatch) return isoMatch[1]

  return null
}

/* ================================================
   TIME PARSER
================================================ */

function parseTime(text) {
  const t = normalizeMessage(text).toLowerCase().trim()

  if (t.includes('morning'))   return '10:00'
  if (t.includes('afternoon')) return '14:00'
  if (t.includes('evening'))   return '16:00'
  if (t.includes('night'))     return '18:00'

  const halfPast    = t.match(/half\s+past\s+(\d{1,2})/)
  if (halfPast)    { let h=parseInt(halfPast[1]); if(h<8)h+=12; return `${h.toString().padStart(2,'0')}:30` }
  const quarterPast = t.match(/quarter\s+past\s+(\d{1,2})/)
  if (quarterPast) { let h=parseInt(quarterPast[1]); if(h<8)h+=12; return `${h.toString().padStart(2,'0')}:15` }
  const quarterTo   = t.match(/quarter\s+to\s+(\d{1,2})/)
  if (quarterTo)   { let h=parseInt(quarterTo[1])-1; if(h<8)h+=12; return `${h.toString().padStart(2,'0')}:45` }

  const withColon = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/)
  if (withColon) {
    let h=parseInt(withColon[1]); const m=withColon[2], p=withColon[3]
    if(p==='pm'&&h<12)h+=12; if(p==='am'&&h===12)h=0
    return `${h.toString().padStart(2,'0')}:${m}`
  }

  const ampm = t.match(/\b(\d{1,2})\s*(am|pm)\b/)
  if (ampm) {
    let h=parseInt(ampm[1]); const p=ampm[2]
    if(p==='pm'&&h<12)h+=12; if(p==='am'&&h===12)h=0
    return `${h.toString().padStart(2,'0')}:00`
  }
  return null
}

/* ================================================
   PHONE PARSER
================================================ */

function parsePhone(text) {
  const match = text.replace(/[\s\-().]/g,'').match(/\d{10}/)
  return match ? match[0] : null
}

/* ================================================
   SIMPLE MESSAGE DETECTOR
   (skip AI extraction for trivial messages)
================================================ */

function isSimpleMessage(text) {
  const t = text.trim()
  if (/^\d{10}$/.test(t.replace(/[\s\-().]/g,''))) return true
  if (/^(yes|no|yeah|nope|yep|nah|ok|sure|correct|wrong|confirm|deny|cancel that)$/i.test(t)) return true
  if (/^\d{1,2}(:\d{2})?(\s*(am|pm))?$/i.test(t)) return true
  if (/^(today|tomorrow|day after tomorrow)$/i.test(t)) return true
  if (/^\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true
  if (t.length < 4) return true
  return false
}

module.exports = { parseDate, parseTime, parsePhone, isSimpleMessage }
