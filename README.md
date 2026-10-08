# Gym Tracker

PWA zum Tracken des Trainings im Fitnessstudio:

- **QR-Code am Gerät scannen** → das Gerät wird erkannt und die hinterlegten, festen Einstellungen (Sitzhöhe, Rückenlehne, …) werden groß angezeigt.
- **Unbekannter Code** → Gerät einmalig anlegen (Name + beliebige Einstellungen).
- **Training erfassen** als Sätze × Wiederholungen × Gewicht, vorausgefüllt mit dem letzten Training.
- **Verlauf** pro Gerät mit Diagramm (Höchstgewicht, geschätztes 1RM oder Volumen), Rekorden und Fortschritt in %.
- **Statistik** (📊): Trainingstage diesen Monat, Ø pro Woche, Wochen-Serie, Trainingskalender (Heatmap), Trainingstage und Volumen pro Woche, Fortschritt pro Gerät.
- **Rekord-Hinweis** beim Speichern, wenn ein Training einen persönlichen Rekord bricht.
- **Offline-fähig**, alle Daten nur lokal auf dem Gerät (IndexedDB).
- **Sicherung** als JSON exportieren/importieren (Einstellungen ⚙︎).

## Veröffentlichen (GitHub Pages)

1. Repo → **Settings → Pages → Build and deployment → Source: „GitHub Actions“**.
2. Jeder Push auf `main` deployt automatisch (`.github/workflows/pages.yml`).
3. URL: `https://dertika.github.io/fitnessstudiotracking/`

## Auf dem iPhone installieren

1. URL in **Safari** öffnen.
2. Teilen-Symbol → **„Zum Home-Bildschirm“**.
3. App vom Home-Bildschirm starten und beim ersten Scan den Kamerazugriff erlauben.

> Tipp: Regelmäßig unter ⚙︎ eine Sicherung exportieren (z. B. in iCloud Drive). Wenn Safari-Websitedaten gelöscht werden, sind die Daten sonst weg.

## Technik

Statisches HTML/CSS/JS ohne Build-Schritt. QR-Erkennung mit [jsQR](https://github.com/cozmo/jsQR) (`vendor/`, Apache-2.0). Bei Änderungen an App-Dateien die `CACHE`-Version in `sw.js` erhöhen.
