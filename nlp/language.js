'use strict'

/* ================================================
   LANGUAGE DETECTION
   Detects Hindi, Marathi, Gujarati from message.
   Falls back to English if unsure.
================================================ */

const HINDI_PATTERNS = [
  /[\u0900-\u097F]/,           // Devanagari script (Hindi + Marathi)
  /\b(mujhe|meri|mera|mere|hai|hain|kya|kab|kaise|aur|nahi|haan|theek|doctor|appointment|bimari|dard|takleef|please|bolo)\b/i,
  /\b(mein|ko|se|ka|ki|ke|par|pe|yahan|wahan|abhi|kal|aaj)\b/i
]

const GUJARATI_PATTERNS = [
  /[\u0A80-\u0AFF]/,           // Gujarati script
  /\b(mane|tamne|chhe|nathi|haa|na|kem|kyare|kya|doctor|dukhaavo|taklif)\b/i
]

const MARATHI_PATTERNS = [
  /\b(mala|tumhi|aahe|naahi|hoy|nay|kasa|kadhi|ithe|tithe|aaj|udya|doctor|dukhaane)\b/i
]

const HINGLISH_PATTERNS = [
  /\b(mujhe|meri|appointment|chahiye|karna|hai|doctor|pain|dard|aaj|kal|bhaiya|bhai|didi|please|help)\b/i
]

function detectLanguage(text) {
  if (!text) return 'en'
  const t = text.toLowerCase()

  // Script-based detection (most reliable)
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gu'
  if (/[\u0900-\u097F]/.test(text)) {
    // Devanagari used for both Hindi and Marathi
    // Marathi-specific words
    if (MARATHI_PATTERNS[0].test(t)) return 'mr'
    return 'hi'
  }

  // Romanized detection
  if (GUJARATI_PATTERNS[1].test(t)) return 'gu'
  if (MARATHI_PATTERNS[0].test(t)) return 'mr'
  if (HINDI_PATTERNS[1].test(t) || HINDI_PATTERNS[2].test(t)) return 'hi'
  if (HINGLISH_PATTERNS[0].test(t)) return 'hi' // treat Hinglish as Hindi

  return 'en'
}

/* ================================================
   LANGUAGE NAMES (for prompts)
================================================ */

const LANGUAGE_NAMES = {
  en: 'English',
  hi: 'Hindi',
  mr: 'Marathi',
  gu: 'Gujarati'
}

/* ================================================
   SYSTEM PROMPTS PER LANGUAGE
================================================ */

function getLanguageInstruction(lang) {
  if (lang === 'en') return ''

  const name = LANGUAGE_NAMES[lang] || 'English'

  return `IMPORTANT: The patient is writing in ${name}. 
You MUST reply in ${name}. 
If they mix ${name} and English (code-switching), reply in the same mix.
Keep medical terms like "appointment", "checkup", "doctor" in English as patients understand these.
Be warm and respectful — use appropriate honorifics for the culture.\n\n`
}

/* ================================================
   QUICK REPLIES IN LANGUAGE
   Translated versions of common bot prompts
================================================ */

const TRANSLATED_PROMPTS = {
  hi: {
    ask_name:    'आपका पूरा नाम बताएं?',
    ask_phone:   'अपना 10 अंकों का फोन नंबर दें।',
    ask_date:    'कौन सी तारीख को appointment चाहिए? (जैसे: आज, कल, अगले सोमवार)',
    ask_service: 'कौन सी service चाहिए? (जैसे: checkup, cleaning, consultation)',
    confirmed:   '✅ Appointment confirm हो गई!',
    cancelled:   '✅ आपकी appointment cancel हो गई।',
    hours:       'हम सोमवार से शनिवार, सुबह 10 बजे से शाम 5 बजे तक खुले हैं।',
    welcome:     'नमस्ते! 👋 हमारे clinic में आपका स्वागत है। मैं आपकी appointment book करने में मदद कर सकता हूं।'
  },
  mr: {
    ask_name:    'आपले पूर्ण नाव सांगा?',
    ask_phone:   'आपला 10 अंकी फोन नंबर द्या।',
    ask_date:    'कोणत्या तारखेला appointment हवी? (उदा: आज, उद्या, पुढील सोमवार)',
    ask_service: 'कोणती service हवी? (उदा: checkup, cleaning, consultation)',
    confirmed:   '✅ Appointment confirm झाली!',
    cancelled:   '✅ आपली appointment cancel झाली.',
    hours:       'आम्ही सोमवार ते शनिवार, सकाळी 10 ते संध्याकाळी 5 वाजेपर्यंत उघडे आहोत.',
    welcome:     'नमस्कार! 👋 आमच्या clinic मध्ये आपले स्वागत आहे। मी आपली appointment book करण्यात मदत करतो.'
  },
  gu: {
    ask_name:    'તમારું પૂરું નામ જણાવો?',
    ask_phone:   'તમારો 10 આંકડાનો ફોન નંબર આપો.',
    ask_date:    'ક્યારે appointment જોઈએ? (જેવા: આજ, કાલ, આવતા સોમવારે)',
    ask_service: 'કઈ service જોઈએ? (જેવા: checkup, cleaning, consultation)',
    confirmed:   '✅ Appointment confirm થઈ ગઈ!',
    cancelled:   '✅ તમારી appointment cancel થઈ ગઈ.',
    hours:       'અમે સોમવારથી શનિવાર, સવારે 10 થી સાંજે 5 વાગ્યા સુધી ખુલ્લા છીએ.',
    welcome:     'નમસ્તે! 👋 અમારા clinic માં આપનું સ્વાગત છે। હું appointment book કરવામાં મદદ કરી શકું.'
  }
}

function getTranslatedPrompt(lang, key, fallback) {
  if (lang === 'en' || !TRANSLATED_PROMPTS[lang]) return fallback
  return TRANSLATED_PROMPTS[lang][key] || fallback
}

module.exports = { detectLanguage, getLanguageInstruction, getTranslatedPrompt, LANGUAGE_NAMES }