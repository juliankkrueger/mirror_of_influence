import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'
import dotenv from 'dotenv'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer)

// ─── Shared Puppeteer Browser Pool ───────────────────────────────────────────
// Ein Browser bleibt geöffnet, Pages werden geöffnet/geschlossen.
// Verhindert crash bei gleichzeitigen PDF-Anfragen von 40+ Nutzern.
let _browser = null
let _pdfQueue = 0
const PDF_CONCURRENCY = 3

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    const { default: puppeteer } = await import('puppeteer')
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    console.log('Puppeteer Browser gestartet ✓')
    _browser.on('disconnected', () => { _browser = null })
  }
  return _browser
}

app.use(express.json({ limit: '10mb' }))
app.use(express.static(join(__dirname, 'public')))
app.use('/branding_assets', express.static(join(__dirname, 'branding_assets')))

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Limits für Event-Betrieb mit shared IP (Corporate WLAN / alle hinter einem Router)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte kurz warten.' }
})

const pdfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele PDF-Anfragen. Bitte kurz warten.' }
})

// ─── Session State ────────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generateCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
}

const sessions = {} // keyed by session code
const activeSessions = new Set()

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token']
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Nicht authentifiziert' })
  }
  next()
}

const getSessionsPublic = () =>
  Object.values(sessions).map(s => ({
    code: s.code,
    status: s.status,
    mentorName: s.mentorName,
    date: s.date,
    submittedCount: s.submissions.length,
    expectedMentees: s.expectedMentees
  }))

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body
  if (password === process.env.APP_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex')
    activeSessions.add(token)
    res.json({ success: true, token })
  } else {
    res.status(401).json({ error: 'Falsches Passwort' })
  }
})

app.post('/api/pdf', requireAuth, pdfLimiter, async (req, res) => {
  const { sessionCode } = req.body
  const session = sessions[sessionCode]
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' })

  // Concurrency-Schutz: max. 3 PDFs gleichzeitig
  if (_pdfQueue >= PDF_CONCURRENCY) {
    return res.status(503).json({ error: 'PDF-Erstellung kurz ausgelastet — bitte 10 Sekunden warten und erneut versuchen.' })
  }
  _pdfQueue++

  let logoBase64 = ''
  try {
    const logoPath = join(__dirname, 'branding_assets/brand_guide/Logos/blueprint_summit_logo_weiss.png')
    logoBase64 = 'data:image/png;base64,' + readFileSync(logoPath).toString('base64')
  } catch (e) { /* logo optional */ }

  let page
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(generatePDFHtml(session, logoBase64), { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.chartRendered === true, { timeout: 10000 }).catch(() => {})

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
    })
    await page.close()

    const safeDate = session.date ? session.date.replace(/\./g, '-') : 'Datum'
    const safeName = (session.mentorName || 'Mentor').replace(/[^a-zA-Z0-9äöüÄÖÜß_\- ]/g, '')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Mirror_${safeName}_${safeDate}.pdf"`)
    res.send(pdf)
  } catch (err) {
    if (page) await page.close().catch(() => {})
    console.error('PDF error:', err)
    res.status(500).json({ error: 'PDF-Generierung fehlgeschlagen' })
  } finally {
    _pdfQueue--
  }
})

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.emit('sessions-state', getSessionsPublic())

  socket.on('create-session', ({ mentorName, expectedMentees, token }) => {
    if (!token || !activeSessions.has(token)) {
      socket.emit('error-msg', 'Nicht authentifiziert.')
      return
    }
    let code
    do { code = generateCode() } while (sessions[code])

    sessions[code] = {
      code,
      status: 'active',
      mentorName: mentorName.trim(),
      date: new Date().toLocaleDateString('de-DE'),
      expectedMentees: parseInt(expectedMentees),
      submissions: [],
      mentorSocketId: socket.id
    }

    socket.join(`session-${code}`)
    socket.data.sessionCode = code
    socket.data.role = 'mentor'
    socket.emit('session-created', {
      session: getSessionsPublic().find(s => s.code === code),
      code
    })
    io.emit('sessions-state', getSessionsPublic())
  })

  socket.on('join-session', ({ sessionCode }) => {
    const session = sessions[sessionCode]
    if (!session || session.status !== 'active') {
      socket.emit('error-msg', 'Diese Session ist nicht aktiv oder existiert nicht.')
      return
    }
    socket.join(`session-${sessionCode}`)
    socket.data.sessionCode = sessionCode
    socket.data.role = 'mentee'
    socket.emit('session-joined', {
      session: getSessionsPublic().find(s => s.code === sessionCode)
    })
  })

  socket.on('submit-feedback', ({ sessionCode, answers }) => {
    const session = sessions[sessionCode]
    if (!session || session.status !== 'active') return
    session.submissions.push(answers)
    const submitted = session.submissions.length
    const expected = session.expectedMentees
    socket.emit('feedback-accepted')
    io.to(`session-${sessionCode}`).emit('submission-update', { submitted, expected })
    if (submitted >= expected) {
      session.status = 'complete'
      io.to(`session-${sessionCode}`).emit('session-complete', { submitted, expected })
      io.emit('sessions-state', getSessionsPublic())
    }
  })

  socket.on('end-session', ({ sessionCode, token }) => {
    if (!token || !activeSessions.has(token)) return
    const session = sessions[sessionCode]
    if (!session) return
    session.status = 'complete'
    io.to(`session-${sessionCode}`).emit('session-complete', {
      submitted: session.submissions.length,
      expected: session.expectedMentees
    })
    io.emit('sessions-state', getSessionsPublic())
  })

  socket.on('reset-session', ({ sessionCode, token }) => {
    if (!token || !activeSessions.has(token)) return
    delete sessions[sessionCode]
    io.emit('sessions-state', getSessionsPublic())
  })
})

// ─── PDF HTML Generator ───────────────────────────────────────────────────────

const CATEGORY_NAMES = [
  'Selbstführung', 'Fachliche Autorität', 'Auftreten & Wirkung',
  'Soziale Kompetenz', 'Gesundheit & Energie', 'Leadership & Verantwortung',
  'Finanzielle Kompetenz'
]

const CATEGORY_REFLEXION_QUESTIONS = [
  'In welchen Situationen wirkt diese Person für dich selbst unstrukturiert oder überfordert?',
  'In welchen fachlichen Bereichen würdest du diese Person nicht um Rat fragen?',
  'In welchen Situationen verliert diese Person aus deiner Sicht an Wirkung oder Präsenz?',
  'In welchen Situationen wirkt diese Person für dich sozial unsicher oder wenig empathisch?',
  'In welchen Bereichen wirkt der Lebensstil dieser Person für dich nicht überzeugend?',
  'In welchen Situationen wirkt diese Person für dich nicht wie eine echte Führungspersönlichkeit?',
  'In welchen finanziellen Themen würdest du dieser Person keinen Rat zutrauen?'
]

function generatePDFHtml(session, logoBase64) {
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '–'
  const dist = arr => {
    const d = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    arr.forEach(v => { if (d[v] !== undefined) d[v]++ })
    return d
  }

  const catStats = CATEGORY_NAMES.map((name, idx) => {
    const bedarfVals = session.submissions.map(s => s.categories?.[idx]?.bedarf).filter(Number.isFinite)
    const eignungVals = session.submissions.map(s => s.categories?.[idx]?.eignung).filter(Number.isFinite)
    const aktuelleWirkungVals = session.submissions.map(s => s.categories?.[idx]?.aktuelleWirkung).filter(Number.isFinite)
    const vergleichVals = session.submissions.map(s => s.categories?.[idx]?.vergleich).filter(Number.isFinite)
    const reflexionen = session.submissions.map(s => s.categories?.[idx]?.reflexion).filter(t => t?.trim())
    const eignungAvgNum = parseFloat(avg(eignungVals)) || 0
    const aktuelleWirkungAvgNum = parseFloat(avg(aktuelleWirkungVals)) || 0
    const vergleichAvgNum = parseFloat(avg(vergleichVals)) || 0
    const mentorInfluenceAvg = (eignungVals.length || aktuelleWirkungVals.length || vergleichVals.length)
      ? parseFloat(((eignungAvgNum + aktuelleWirkungAvgNum + vergleichAvgNum) / 3).toFixed(1))
      : 0
    return {
      name,
      bedarf: { avg: avg(bedarfVals), dist: dist(bedarfVals) },
      eignung: { avg: avg(eignungVals), dist: dist(eignungVals) },
      aktuelleWirkung: { avg: avg(aktuelleWirkungVals), dist: dist(aktuelleWirkungVals) },
      vergleich: { avg: avg(vergleichVals), dist: dist(vergleichVals) },
      reflexionen,
      aktuelleWirkungAvgNum,
      mentorInfluenceAvg
    }
  })

  const globalAnswers = {
    spiegel: session.submissions.map(s => s.global?.spiegel).filter(t => t?.trim()),
    potenzial: session.submissions.map(s => s.global?.potenzial).filter(t => t?.trim()),
    wunsch: session.submissions.map(s => s.global?.wunsch).filter(t => t?.trim())
  }

  const distBar = (d, total) => [1, 2, 3, 4, 5].map(v => {
    const count = d[v] || 0
    const pct = total > 0 ? Math.round(count / total * 100) : 0
    return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
      <span style="width:10px;color:rgba(255,255,255,0.7);font-size:10px;text-align:right">${v}</span>
      <div style="flex:1;background:rgba(255,255,255,0.08);border-radius:3px;height:12px">
        <div style="width:${pct}%;background:linear-gradient(90deg,#00E9B9,#5CE1E6);height:100%;border-radius:3px"></div>
      </div>
      <span style="color:rgba(255,255,255,0.5);font-size:10px;width:24px">${count}×</span>
    </div>`
  }).join('')

  const answerBlock = (answers) => answers.length > 0
    ? answers.map(a => `<p style="color:#e0e0e0;font-size:11px;padding:6px 10px;background:rgba(0,0,0,0.3);border-left:2px solid #5CE1E6;border-radius:3px;margin:4px 0;line-height:1.5">"${a}"</p>`).join('')
    : '<p style="color:rgba(255,255,255,0.3);font-size:11px;font-style:italic">Keine Antworten.</p>'

  const catSections = catStats.map((cat, idx) => `
    <div style="margin-bottom:24px;background:rgba(255,255,255,0.04);border:1px solid rgba(0,233,185,0.25);border-radius:10px;padding:18px;page-break-inside:avoid">
      <h3 style="color:#00E9B9;font-family:Unbounded,sans-serif;font-size:12px;letter-spacing:1px;margin:0 0 14px 0;text-transform:uppercase">${cat.name}</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:14px">
        <div>
          <p style="color:rgba(255,255,255,0.5);font-size:10px;letter-spacing:1px;margin:0 0 6px 0">BEDARF · Ø ${cat.bedarf.avg}</p>
          ${distBar(cat.bedarf.dist, session.submissions.length)}
        </div>
        <div>
          <p style="color:rgba(255,255,255,0.5);font-size:10px;letter-spacing:1px;margin:0 0 6px 0">EIGNUNG · Ø ${cat.eignung.avg}</p>
          ${distBar(cat.eignung.dist, session.submissions.length)}
        </div>
        <div>
          <p style="color:rgba(255,255,255,0.5);font-size:10px;letter-spacing:1px;margin:0 0 6px 0">AKTUELLE WIRKUNG · Ø ${cat.aktuelleWirkung.avg}</p>
          ${distBar(cat.aktuelleWirkung.dist, session.submissions.length)}
        </div>
        <div>
          <p style="color:rgba(255,255,255,0.5);font-size:10px;letter-spacing:1px;margin:0 0 6px 0">VERGLEICH IDEAL · Ø ${cat.vergleich.avg}</p>
          ${distBar(cat.vergleich.dist, session.submissions.length)}
        </div>
      </div>
      ${cat.reflexionen.length > 0 ? `
      <div>
        <p style="color:rgba(255,255,255,0.5);font-size:10px;letter-spacing:1px;margin:0 0 6px 0">REFLEXION — ANONYME ANTWORTEN</p>
        <p style="color:rgba(255,255,255,0.45);font-size:10px;font-style:italic;margin:0 0 8px 0">${CATEGORY_REFLEXION_QUESTIONS[idx]}</p>
        ${answerBlock(cat.reflexionen)}
      </div>` : ''}
    </div>`).join('')

  const globalSection = (label, questionText, answers) => `
    <div style="margin-bottom:18px">
      <p style="color:#5CE1E6;font-size:10px;letter-spacing:1px;margin:0 0 4px 0;text-transform:uppercase">${label}</p>
      <p style="color:rgba(255,255,255,0.45);font-size:10px;font-style:italic;margin:0 0 8px 0">${questionText}</p>
      ${answerBlock(answers)}
    </div>`

  const radarData = JSON.stringify({
    labels: CATEGORY_NAMES.map(n => n.length > 14 ? n.substring(0, 12) + '…' : n),
    datasets: [{
      label: 'Mentor-Einfluss (Ø)',
      data: catStats.map(c => c.mentorInfluenceAvg),
      backgroundColor: 'rgba(0,233,185,0.15)',
      borderColor: '#00E9B9',
      borderWidth: 2,
      pointBackgroundColor: '#00E9B9',
      pointRadius: 4
    }]
  })

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700&family=Noto+Sans+Display:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
* { margin:0;padding:0;box-sizing:border-box }
body { background:#072330;color:#fff;font-family:'Noto Sans Display',sans-serif;padding:24px;font-size:13px }
</style>
</head><body>

<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid rgba(0,233,185,0.3)">
  <div>
    ${logoBase64 ? `<img src="${logoBase64}" style="height:32px;margin-bottom:12px;display:block">` : ''}
    <h1 style="font-family:Unbounded,sans-serif;font-size:20px;color:#fff;margin-bottom:4px">Mentor Influence Mirror</h1>
    <p style="color:rgba(255,255,255,0.6);font-size:12px">Feedback-Auswertung für <strong style="color:#00E9B9">${session.mentorName}</strong> · ${session.date}</p>
  </div>
  <div style="text-align:right">
    <p style="font-family:Unbounded,sans-serif;font-size:28px;color:#00E9B9">${session.submissions.length}</p>
    <p style="color:rgba(255,255,255,0.5);font-size:11px">Rückmeldungen</p>
  </div>
</div>

<div style="display:flex;justify-content:center;margin-bottom:36px">
  <div style="width:380px;height:380px"><canvas id="radarChart"></canvas></div>
</div>

<h2 style="font-family:Unbounded,sans-serif;font-size:13px;color:#fff;letter-spacing:2px;text-transform:uppercase;margin-bottom:20px">Detailauswertung</h2>
${catSections}

<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(92,225,230,0.3);border-radius:10px;padding:20px;margin-top:8px;page-break-inside:avoid">
  <h2 style="font-family:Unbounded,sans-serif;font-size:12px;color:#5CE1E6;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px">Offene Abschlussfragen</h2>
  ${globalSection('Geringster Einfluss', 'In welchem dieser Bereiche hat dieser Mentor aktuell den geringsten Einfluss auf dich?', globalAnswers.spiegel)}
  ${globalSection('Größtes Potenzial', 'In welchem Bereich hätte dieser Mentor aus deiner Sicht das größte Potenzial, seinen Einfluss zu verbessern?', globalAnswers.potenzial)}
  ${globalSection('Dein persönlicher Wunsch', 'In welchem Bereich würdest du dir für ihn persönlich die größte Weiterentwicklung wünschen?', globalAnswers.wunsch)}
</div>

<script>
const ctx = document.getElementById('radarChart').getContext('2d')
new Chart(ctx, {
  type: 'radar',
  data: ${radarData},
  options: {
    responsive: true,
    scales: {
      r: {
        min: 0, max: 5, ticks: { stepSize: 1, color: 'rgba(255,255,255,0.5)', backdropColor: 'transparent', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.1)' },
        pointLabels: { color: '#fff', font: { size: 10 } },
        angleLines: { color: 'rgba(255,255,255,0.1)' }
      }
    },
    plugins: { legend: { labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } } } }
  }
})
setTimeout(() => { window.chartRendered = true }, 2000)
</script>
</body></html>`
}

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => console.log(`Mirror läuft auf Port ${PORT}`))
