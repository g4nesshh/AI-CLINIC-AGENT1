const express = require("express")
const fs = require("fs")

const app = express()
app.use(express.json())
app.use(express.static("public"))

let bookingState = {}

/* =========================
   CLINIC CONFIG
========================= */

const CLINIC_OPEN = 10
const CLINIC_CLOSE = 16
const SLOT_DURATION = 30

/* =========================
   SLOT GENERATION
========================= */

function generateSlots(){

let slots=[]
let start=CLINIC_OPEN*60
let end=CLINIC_CLOSE*60

for(let t=start;t<end;t+=SLOT_DURATION){

let h=Math.floor(t/60)
let m=t%60

slots.push(`${h.toString().padStart(2,"0")}:${m.toString().padStart(2,"0")}`)
}

return slots
}

const TIME_SLOTS = generateSlots()

/* =========================
   DATE NORMALIZATION
========================= */

function normalizeDate(text){

const months={
january:"01",february:"02",march:"03",april:"04",
may:"05",june:"06",july:"07",august:"08",
september:"09",october:"10",november:"11",december:"12"
}

const match=text.toLowerCase().match(
/(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)/
)

if(match){

let day=match[1].padStart(2,"0")
let month=months[match[3]]

return `2026-${month}-${day}`
}

return ""
}

/* =========================
   PHONE EXTRACTION
========================= */

function extractPhone(text){

const match=text.match(/\b\d{10}\b/)
if(match) return match[0]

return ""
}

/* =========================
   TIME EXTRACTION
========================= */

function extractTime(text){

const full=text.match(/\b([0-9]{1,2}:[0-9]{2})\b/)
if(full) return full[1]

const hour=text.match(/\b([0-9]{1,2})\b/)
if(hour){
return hour[1].padStart(2,"0")+":00"
}

return ""
}

/* =========================
   SERVICE CLEANING
========================= */

function cleanService(text){

return text
.replace(/\d{1,2}(st|nd|rd|th)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)/i,"")
.replace(/\d{4}-\d{2}-\d{2}/,"")
.trim()

}

/* =========================
   AVAILABLE SLOTS
========================= */

function getAvailableSlots(date){

let appointments=[]

if(fs.existsSync("appointments.json")){
appointments=JSON.parse(fs.readFileSync("appointments.json"))
}

const booked=appointments
.filter(a=>a.date===date)
.map(a=>a.time)

return TIME_SLOTS.filter(s=>!booked.includes(s))
}

/* =========================
   AI EXTRACTION
========================= */

async function aiExtract(text){

try{

const response=await fetch("http://127.0.0.1:11434/api/generate",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
model:"qwen2.5:7b",
prompt:`Extract name and service.

Return JSON:

{
"name":"",
"service":""
}

Message:
${text}`,
stream:false
})
})

const data=await response.json()

let output=data.response||""
const match=output.match(/\{[\s\S]*\}/)

if(match) return JSON.parse(match[0])

return {name:"",service:""}

}catch{
return {name:"",service:""}
}

}

/* =========================
   CHAT ENDPOINT
========================= */

app.post("/chat", async (req,res)=>{

const userMessage=req.body.message
const userId=req.body.userId||"default"
const lower=userMessage.toLowerCase()

if(lower.includes("appointment")||lower.includes("book")){

bookingState[userId]={name:"",phone:"",date:"",time:"",service:""}

return res.json({
reply:"Provide name, phone, date and service."
})
}

if(bookingState[userId]){

const ai=await aiExtract(userMessage)

if(ai.name) bookingState[userId].name=ai.name
if(ai.service) bookingState[userId].service=cleanService(ai.service)

const phone=extractPhone(userMessage)
if(phone) bookingState[userId].phone=phone

const date=normalizeDate(userMessage)
if(date) bookingState[userId].date=date

const time=extractTime(userMessage)
if(time) bookingState[userId].time=time

const booking=bookingState[userId]

if(!booking.name) return res.json({reply:"Provide name"})
if(!booking.phone) return res.json({reply:"Provide 10 digit phone"})
if(!booking.date) return res.json({reply:"Provide date (20th March)"})

if(!booking.time){

const slots=getAvailableSlots(booking.date)

if(slots.length===0){
bookingState[userId].date=""
return res.json({reply:`No slots on ${booking.date}. Choose another date.`})
}

return res.json({reply:`Available times: ${slots.join(", ")}`})
}

if(!booking.service) return res.json({reply:"What service?"})

const slots=getAvailableSlots(booking.date)

if(!slots.includes(booking.time)){
return res.json({reply:`${booking.time} unavailable. Available: ${slots.join(", ")}`})
}

/* SAVE BOOKING */

let appointments=[]

if(fs.existsSync("appointments.json")){
appointments=JSON.parse(fs.readFileSync("appointments.json"))
}

appointments.push(booking)

fs.writeFileSync("appointments.json",JSON.stringify(appointments,null,2))

delete bookingState[userId]

return res.json({reply:"✅ Appointment booked"})
}

res.json({reply:"How can I assist you?"})

})

/* =========================
   ADMIN
========================= */

app.get("/appointments",(req,res)=>{

let data=[]

if(fs.existsSync("appointments.json")){
data=JSON.parse(fs.readFileSync("appointments.json"))
}

res.json(data)

})

app.listen(3000,()=>console.log("Server running on port 3000"))