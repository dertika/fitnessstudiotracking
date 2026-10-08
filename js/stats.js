// Statistik-Berechnungen. Reine Funktionen ohne DOM, damit sie sich leicht testen lassen.
// Datumswerte sind 'YYYY-MM-DD'-Strings in lokaler Zeit.

const DAY = 86400000;

// ---- Kennzahlen pro Satz / Training ----

// Geschätztes 1-Wiederholungs-Maximum nach Epley.
export function e1rm(set) {
  const w = set.weight ?? 0;
  const r = set.reps ?? 0;
  if (!w || !r) return 0;
  return r === 1 ? w : w * (1 + r / 30);
}

export const sessionMaxWeight = (s) => Math.max(0, ...s.sets.map((x) => x.weight ?? 0));
export const sessionVolume = (s) => s.sets.reduce((sum, x) => sum + (x.reps ?? 0) * (x.weight ?? 0), 0);
export const sessionBestE1rm = (s) => Math.max(0, ...s.sets.map(e1rm));

// ---- Datum ----

export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Montag der Woche (lokal, 00:00).
export function weekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// ISO-Wochenschlüssel, z. B. '2026-W41'.
export function weekKey(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Donnerstag dieser Woche
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

// ---- Gesamtübersicht ----

// Volumen und Anzahl Trainings pro Tag.
export function dailyStats(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const e = map.get(s.date) || { volume: 0, sessions: 0 };
    e.volume += sessionVolume(s);
    e.sessions += 1;
    map.set(s.date, e);
  }
  return map;
}

// Die letzten `weeks` Wochen (älteste zuerst), inkl. der laufenden.
export function weeklyStats(sessions, weeks = 12, today = new Date()) {
  const current = weekStart(today);
  const list = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(current, -7 * i);
    list.push({ key: weekKey(start), start, days: new Set(), volume: 0, sets: 0 });
  }
  const byKey = new Map(list.map((w) => [w.key, w]));
  for (const s of sessions) {
    const w = byKey.get(weekKey(parseDate(s.date)));
    if (!w) continue;
    w.days.add(s.date);
    w.volume += sessionVolume(s);
    w.sets += s.sets.length;
  }
  return list.map((w) => ({ ...w, days: w.days.size }));
}

// Aufeinanderfolgende Wochen mit mindestens einem Training.
// Die laufende Woche zählt mit, bricht die Serie aber nicht ab, solange darin noch nicht trainiert wurde.
export function weekStreak(sessions, today = new Date()) {
  const weeks = new Set(sessions.map((s) => weekKey(parseDate(s.date))));
  let cursor = weekStart(today);
  if (!weeks.has(weekKey(cursor))) cursor = addDays(cursor, -7);
  let streak = 0;
  while (weeks.has(weekKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -7);
  }
  return streak;
}

export function overview(sessions, today = new Date()) {
  const monthPrefix = toIso(today).slice(0, 7);
  const days = new Set(sessions.map((s) => s.date));
  const daysThisMonth = [...days].filter((d) => d.startsWith(monthPrefix)).length;
  const last8 = weeklyStats(sessions, 8, today);
  const thisWeek = last8[last8.length - 1];
  // Durchschnitt nur über abgeschlossene Wochen (ohne die laufende).
  const done = last8.slice(0, -1);
  const avgDays = done.reduce((s, w) => s + w.days, 0) / done.length;
  return {
    daysThisMonth,
    avgDaysPerWeek: avgDays,
    streak: weekStreak(sessions, today),
    volumeThisWeek: thisWeek.volume,
    totalDays: days.size,
  };
}

// ---- Pro Gerät ----

// Rekorde eines Geräts. `sessions` in beliebiger Reihenfolge.
export function machineRecords(sessions) {
  const rec = { heaviest: null, bestE1rm: null, volume: null, mostReps: null };
  for (const s of sessions) {
    for (const set of s.sets) {
      if ((set.weight ?? 0) > 0 && (!rec.heaviest || set.weight > rec.heaviest.value || (set.weight === rec.heaviest.value && (set.reps ?? 0) > rec.heaviest.reps))) {
        rec.heaviest = { value: set.weight, reps: set.reps ?? 0, date: s.date };
      }
      const e = e1rm(set);
      if (e > 0 && (!rec.bestE1rm || e > rec.bestE1rm.value)) rec.bestE1rm = { value: e, date: s.date };
      if ((set.reps ?? 0) > 0 && (!rec.mostReps || set.reps > rec.mostReps.value)) {
        rec.mostReps = { value: set.reps, weight: set.weight ?? 0, date: s.date };
      }
    }
    const v = sessionVolume(s);
    if (v > 0 && (!rec.volume || v > rec.volume.value)) rec.volume = { value: v, date: s.date };
  }
  return rec;
}

// 1RM-Veränderung in Prozent: seit dem ersten Training und gegenüber dem letzten Training vor >= 4 Wochen.
export function progress(sessions) {
  const sorted = sessions.filter((s) => sessionBestE1rm(s) > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return { sinceStart: null, last4Weeks: null };
  const last = sorted[sorted.length - 1];
  const now = sessionBestE1rm(last);
  const pct = (from) => ((now - from) / from) * 100;
  const cutoff = toIso(addDays(parseDate(last.date), -28));
  const before = sorted.filter((s) => s.date <= cutoff).pop();
  return {
    sinceStart: pct(sessionBestE1rm(sorted[0])),
    last4Weeks: before ? pct(sessionBestE1rm(before)) : null,
  };
}

// Welche Rekorde bricht `session` gegenüber `previous`? Ohne Vorgeschichte gibt es keine Rekorde.
export function newRecords(session, previous) {
  const prev = previous.filter((s) => s.id !== session.id && s.sets.length);
  if (!prev.length) return [];
  const old = machineRecords(prev);
  const cur = machineRecords([session]);
  const out = [];
  if (cur.heaviest && old.heaviest && cur.heaviest.value > old.heaviest.value) out.push({ type: 'heaviest', value: cur.heaviest.value });
  if (cur.bestE1rm && old.bestE1rm && cur.bestE1rm.value > old.bestE1rm.value + 0.01) out.push({ type: 'e1rm', value: cur.bestE1rm.value });
  if (cur.volume && old.volume && cur.volume.value > old.volume.value) out.push({ type: 'volume', value: cur.volume.value });
  return out;
}
