// Austausch mit den Apple-Watch-Kurzbefehlen. Reine Funktionen ohne DOM.
//
// Der Watch-Kurzbefehl speichert pro Training eine Erinnerung in der Liste „Gym Log“:
//   GT1;<Geräte-ID>;<JJJJ-MM-TT>;12x40/10x42,5/8x45
// Sätze werden mit „/“ getrennt, damit Dezimalkommas (42,5) eindeutig bleiben.

const fmt = (n) => String(n).replace('.', ',');

// Geräteliste für den Watch-Kurzbefehl: { "<Name>": { id, info } }.
// Doppelte Namen bekommen eine Nummer, weil die Namen in der Watch-Auswahl eindeutig sein müssen.
export function buildWatchConfig(machines, lastSessionByMachine = {}) {
  const out = {};
  for (const m of machines) {
    let name = m.name.trim() || 'Gerät';
    for (let i = 2; out[name]; i++) name = `${m.name.trim()} (${i})`;
    const lines = [];
    if (m.settings.length) lines.push(m.settings.map((s) => `${s.label}: ${s.value}`).join('\n'));
    const last = lastSessionByMachine[m.id];
    if (last) lines.push(`Zuletzt: ${last.sets.map((s) => `${fmt(s.reps ?? 0)}×${fmt(s.weight ?? 0)}`).join(' / ')} kg`);
    out[name] = { id: m.id, info: lines.join('\n\n') || 'Keine Einstellungen' };
  }
  return out;
}

const num = (v) => {
  const n = parseFloat(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Liest die eingefügten Erinnerungen. Ergebnis: { entries: [{ machineId, date, sets }], errors: [{ line, reason }] }
export function parseWatchLog(text) {
  const entries = [];
  const errors = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(';').map((p) => p.trim());
    if (parts[0] !== 'GT1') {
      errors.push({ line, reason: 'Kein Gym-Tracker-Eintrag' });
      continue;
    }
    const [, machineId, date, setsText] = parts;
    if (!machineId) {
      errors.push({ line, reason: 'Gerät fehlt' });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      errors.push({ line, reason: 'Datum ungültig' });
      continue;
    }
    const sets = [];
    let bad = false;
    for (const chunk of (setsText || '').split(/[/|]/)) {
      if (!chunk.trim()) continue;
      const m = chunk.match(/^\s*([\d.,]+)\s*[x×*]\s*([\d.,]+)\s*(?:kg)?\s*$/i);
      const reps = m && num(m[1]);
      const weight = m && num(m[2]);
      if (reps === null || weight === null || !m) {
        bad = true;
        break;
      }
      sets.push({ reps, weight });
    }
    if (bad || !sets.length) {
      errors.push({ line, reason: 'Sätze nicht lesbar' });
      continue;
    }
    entries.push({ machineId, date, sets });
  }
  return { entries, errors };
}

// Schlüssel zum Erkennen doppelter Importe.
export const sessionKey = (s) => `${s.machineId}|${s.date}|${s.sets.map((x) => `${x.reps}x${x.weight}`).join('/')}`;
