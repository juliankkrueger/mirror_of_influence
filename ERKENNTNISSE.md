# Erkenntnisse & Projektwissen — Mirror of Influence

## Deployment

### Railway
- **Live URL:** https://mirror-of-influence-production.up.railway.app
- **Custom Domain:** https://mof.blueprint-summit.de
- **GitHub Repo:** https://github.com/juliankkrueger/mirror_of_influence
- **Plan:** Railway Pro ($20/Monat, inkl. $20 Credits)
- Railway deployt automatisch bei jedem `git push` auf `main`

### Railway Custom Domain Setup (All-Inkl DNS)
- CNAME: `mof` → `z3f5u6gz.up.railway.app`
- TXT: `_railway-verify.mof` → `railway-verify=e54620b0f6b7beeee001c7171c029715cee2259e645a01b1b57dcf4e5651e499`
- **Wichtig:** Das "Custom port" Feld in Railway muss `8080` sein (nicht leer lassen, nicht `4` oder andere Werte)
- All-Inkl zeigt Warnung beim Anlegen einer Subdomain die vorher vom Wildcard-Record bedient wurde — das ist normal und harmlos

### Puppeteer auf Railway
- Railway installiert Chromium-Dependencies automatisch via apt (kein nixpacks.toml nötig)
- `nixpacks.toml` mit NixOS-Pfaden (`/run/current-system/sw/bin/chromium`) funktioniert NICHT auf Railway (Debian-Umgebung)
- `server.js` nutzt `process.env.PORT || 3001` — Railway setzt PORT automatisch auf 8080
- Build dauert ~10 Minuten wegen Chromium-Download

### Lokales Testen
```
cd "/Users/julian/Claude Coding/Blueprint Summit Mirror"
node server.js
```
→ http://localhost:3001 · Passwort: `blueprint2026`

---

## Fragestruktur (aktuell, nach Update März 2026)

### Pro Kategorie (4 Bewertungsfragen + 1 Freitext):
1. **Bedarf** (1–5) — kategoriespezifisch
2. **Eignung des Mentors** (1–5) — kategoriespezifisch
3. **Aktuelle Wirkung** (1–5) — kategoriespezifisch (NEU, vorher nur 3 Fragen)
4. **Vergleich mit idealem Vorbild** (1–5) — kategoriespezifisch
5. **Reflexion** (Freitext, optional) — kategoriespezifisch

### 7 Kategorien:
1. Selbstführung
2. Fachliche Autorität
3. Auftreten & Wirkung
4. Soziale Kompetenz
5. Gesundheit & Energie
6. Leadership & Verantwortung
7. Finanzielle Kompetenz

### 2 Globale Abschlussfragen (Freitext):
1. In welchem dieser Bereiche hat dieser Mentor aktuell den geringsten Einfluss auf dich?
2. In welchem Bereich hätte dieser Mentor aus deiner Sicht das größte Potenzial, seinen Einfluss zu verbessern?

### Antwort-Struktur (JS):
```json
{
  "categories": [
    {
      "bedarf": 4,
      "eignung": 3,
      "aktuelleWirkung": 2,
      "vergleich": 3,
      "reflexion": "..."
    }
  ],
  "global": {
    "spiegel": "...",
    "potenzial": "..."
  }
}
```

---

## Railway vs. Vercel (Entscheidung)
- **Railway** ist die richtige Wahl für dieses Projekt: dauerhaft laufender Server, WebSockets (Socket.io), Puppeteer
- **Vercel** wäre falsch: Serverless/Frontend-fokussiert, Socket.io funktioniert dort nicht
- Railway Pro ermöglicht mehrere Projekte parallel im gleichen Workspace

---

## Git / GitHub
- gh CLI liegt unter: `/Users/julian/Downloads/gh_2.88.0_macOS_amd64/bin/gh`
- `.gitignore` schließt aus: `.env`, `node_modules/`, `.DS_Store`
- `.env` enthält `APP_PASSWORD=blueprint2026` — nie committen

---

## Bekannte Stolperfallen
- `nixpacks.toml` mit NixOS-Pfaden bricht Puppeteer auf Railway → nicht verwenden
- Railway "Custom port" Feld: immer `8080` eintragen, nie `4` oder leer lassen
- DNS-Propagation dauert bis zu 1h nach CNAME-Änderung
- All-Inkl Wildcard-Warnung bei neuen Subdomains ist harmlos
- Disconnect/Reconnect der Source Repo in Railway triggert neuen Deploy (verliert Zeit)
- Build dauert ~10 Min bei erstem Deploy (Chromium), danach gecacht
