# CLAUDE.md — Mentor Influence Mirror

## Projekt-Überblick
Anonymes Echtzeit-Feedback-Tool für Mentoren im Blueprint Summit Stil.
Mentees bewerten ihren Mentor anonym über 7 Kategorien (je 3 Bewertungsfragen + 1 Reflexion)
plus 3 globale Abschlussfragen. Mentor erhält PDF-Auswertung am Ende.

## Technischer Stack
- Frontend: Single HTML file (`public/index.html`)
- Backend: Node.js + Express + **Socket.io** (Echtzeit)
- PDF Export: Puppeteer (server-seitig, auto-download)
- Kein Claude API / KI — Fragen sind fix hardcoded
- UI: 100% Deutsch

## Lokales Testen
```
cd "/Users/julian/Claude Coding/Blueprint Summit Mirror"
node server.js
```
→ http://localhost:3001 · Passwort: `blueprint2026`

## Deployment (noch ausstehend)
- Noch kein GitHub Repo / Railway Deployment eingerichtet
- Soll komplett getrennt vom Blueprint Survey Architect laufen
- gh CLI verfügbar: `/Users/julian/Downloads/gh_2.88.0_macOS_amd64/bin/gh`

## Passwort & Sicherheit
- APP_PASSWORD=blueprint2026 (in .env, nie hardcoden)
- .env ist in .gitignore
- Kein ANTHROPIC_API_KEY nötig (kein KI-Einsatz)

## Session-Ablauf (Kahoot/Discord-Stil)
1. Alle (Mentor + Mentees) loggen sich mit Passwort ein
2. **Lobby** zeigt 5 feste Räume (frei / aktiv / abgeschlossen)
3. **Mentor** klickt freien Raum → gibt Name + erwartete Mentee-Anzahl ein → Session startet
4. Mentor-Screen: "Bitte verlasse den Raum" + Live-Counter (X/Y abgegeben) + Progress-Bar
5. **Mentees** klicken aktiven Raum → sehen Intro-Text → füllen Survey aus → "Feedback abgeben"
6. Wenn alle eingereicht ODER Mentor drückt "Sitzung beenden" → Mentor-Screen zeigt PDF-Download
7. Nach Download: "Neue Session starten" → Raum wird zurückgesetzt

## Fragen-Struktur (hardcoded in index.html)
7 Kategorien × 4 Fragen:
- Bedarf (1–5 Buttons)
- Mentor Influence (1–5 Buttons)
- Vergleich mit Idealperson (1–5 Buttons)
- Reflexion (Freitext, optional)

Kategorien:
1. Selbstführung
2. Fachliche Autorität
3. Auftreten & Wirkung
4. Soziale Kompetenz
5. Gesundheit & Energie
6. Leadership & Verantwortung
7. Finanzielle Kompetenz

3 globale Abschlussfragen (Freitext):
- Wichtigste Spiegel-Frage (geringster Einfluss)
- Brutalste Abschlussfrage (freiwillige Orientierung)
- Blinde Flecken (Entwicklungsbedarf)

Bewertungsskala: 1 = überhaupt nicht · 5 = absolut

## Server-Architektur (server.js)

### Room State (In-Memory)
```js
rooms[1..5] = {
  id, status,           // 'free' | 'active' | 'complete'
  mentorName, date,
  expectedMentees,
  submissions: [],      // Array von Mentee-Antworten
  mentorSocketId
}
```

### REST Routes
- `GET /`             → index.html
- `POST /api/login`   → Passwort-Check gegen process.env.APP_PASSWORD
- `POST /api/pdf`     → Puppeteer PDF-Generierung, gibt PDF zurück

### Socket.io Events (Client → Server)
| Event | Payload | Beschreibung |
|---|---|---|
| `create-session` | `{roomId, mentorName, expectedMentees}` | Mentor erstellt Session |
| `join-session` | `{roomId}` | Mentee tritt bei |
| `submit-feedback` | `{roomId, answers}` | Mentee reicht ein |
| `end-session` | `{roomId}` | Mentor beendet manuell |
| `reset-room` | `{roomId}` | Raum zurücksetzen nach PDF |

### Socket.io Events (Server → Client)
| Event | Beschreibung |
|---|---|
| `rooms-state` | Alle 5 Räume (bei connect + nach jeder Änderung) |
| `session-created` | Mentor: Session erfolgreich erstellt |
| `session-joined` | Mentee: Raum beigetreten |
| `submission-update` | Live-Counter update `{submitted, expected}` |
| `session-complete` | Session abgeschlossen → PDF-Ansicht |
| `feedback-accepted` | Mentee: Danke-Screen |
| `error-msg` | Fehler als Toast |

### Answers-Struktur (Mentee-Submission)
```json
{
  "categories": [
    { "bedarf": 4, "influence": 3, "vergleich": 2, "reflexion": "..." }
  ],
  "global": {
    "spiegel": "...",
    "abschluss": "...",
    "blindeFlecken": "..."
  }
}
```

## PDF-Inhalt (generatePDFHtml)
- Title-Block: Mentor-Name, Datum, Anzahl Rückmeldungen
- Blueprint Summit Logo (Base64 eingebettet)
- Radar-Chart (Chart.js CDN) — Mentor Influence Ø pro Kategorie
- Pro Kategorie: Bedarf / Influence / Vergleich je mit Ø-Wert + Verteilungsbalken (1–5)
- Pro Kategorie: alle anonymen Reflexions-Textantworten
- Abschnitt "Offene Abschlussfragen": alle 3 Fragen mit allen Antworten

## Design System (Blueprint Summit)
- Background: `#072330` (Deep Navy) + SVG Topo-Overlay
- Teal: `#00E9B9` (primäre Akzentfarbe)
- Cyan: `#5CE1E6` (sekundäre Akzentfarbe)
- Cards: Glassmorphism — `rgba(255,255,255,0.05)` + `backdrop-filter: blur(12px)`
- Buttons: Gradient Teal→Cyan, `border-radius: 999px`, Text `#072330`
- Fonts: Unbounded (Headings) + Noto Sans Display (Body)
- Logo: `/branding_assets/brand_guide/Logos/blueprint_summit_logo_weiss.png`

## Views (index.html)
| View-ID | Wer | Beschreibung |
|---|---|---|
| `view-login` | Alle | Passwort-Eingabe |
| `view-lobby` | Alle | 5 Räume Übersicht |
| `view-mentor-waiting` | Mentor | Warten + Live-Counter |
| `view-mentor-complete` | Mentor | PDF-Download |
| `view-mentee-intro` | Mentee | "Mirror of Influence" Intro-Text |
| `view-mentee-survey` | Mentee | Fragebogen (7 Kategorien + 3 Abschlussfragen) |
| `view-mentee-thankyou` | Mentee | Danke-Screen nach Einreichung |
| Modal: `mentor-setup-modal` | Mentor | Name + Anzahl eingeben |

## Technische Besonderheiten
- Puppeteer: dynamic `import()` (NICHT require) wegen Node v25 ESM
- Socket.io: Räume als `room-${roomId}` Channels — io.to(...).emit() für gezielte Nachrichten
- PDF Chart.js: `window.chartRendered = true` nach 2s → Puppeteer wartet darauf
- Validation: Alle 3 numerischen Fragen pro Kategorie müssen ausgefüllt sein (JS-seitig)

## Dateistruktur
```
Blueprint Summit Mirror/
├── server.js           ✅
├── public/index.html   ✅
├── branding_assets/    ✅ (kopiert vom Blueprint Summit Projekt)
├── .env                ✅ (APP_PASSWORD=blueprint2026)
├── .gitignore          ✅
├── package.json        ✅
├── node_modules/       ✅
└── CLAUDE.md           ✅ (diese Datei)
```

## Nächste Schritte (offen)
- [ ] GitHub Repo erstellen (public, Name: z.B. `blueprint_summit_mirror`)
- [ ] Railway Deployment einrichten
- [ ] Custom Domain (z.B. mirror.blueprint-summit.de)
- [ ] APP_PASSWORD in Railway Variables setzen
