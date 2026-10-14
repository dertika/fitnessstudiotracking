// Automatische Sicherung in ein privates GitHub-Repo.
// Prinzip: Die Daten auf dem Gerät sind maßgeblich. Nach Änderungen wird die komplette Sicherung
// (db.exportAll) als JSON-Datei hochgeladen; jede Sicherung ist ein Commit (= Versionshistorie).
// Wiederherstellen ersetzt die lokalen Daten nur auf ausdrücklichen Wunsch.
import * as db from './db.js';

const KEY = 'gt-sync';
const STATE_KEY = 'gt-sync-state';
const DEBOUNCE_MS = 5000;
const API = 'https://api.github.com';

// ---- Speicher (localStorage kann fehlen, z. B. im privaten Modus) ----

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const getConfig = () => read(KEY);
export const getState = () => read(STATE_KEY) || {};
const setState = (patch) => {
  const s = { ...getState(), ...patch };
  write(STATE_KEY, s);
  listeners.forEach((cb) => cb(s));
  return s;
};

const listeners = new Set();
export function onStatus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- Base64 mit UTF-8 (btoa/atob können nur Latin-1) ----

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Einfacher Hash, um unveränderte Daten nicht erneut hochzuladen.
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// ---- GitHub-API ----

class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gh(cfg, path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new SyncError('Keine Verbindung zu GitHub (offline?)', 0);
  }
  if (res.status === 404 && options.allow404) return null;
  if (!res.ok) {
    const msg =
      res.status === 401
        ? 'Token ungültig oder abgelaufen'
        : res.status === 403
          ? 'Kein Zugriff – Token-Berechtigung „Contents: Read and write“ prüfen'
          : res.status === 404
            ? 'Repo nicht gefunden – Besitzer/Name und Token-Zugriff prüfen'
            : `GitHub-Fehler ${res.status}`;
    throw new SyncError(msg, res.status);
  }
  return res.status === 204 ? null : res.json();
}

const contentPath = (cfg) =>
  `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;

// Prüft Zugriff. Öffentliche Repos werden abgelehnt, damit Trainingsdaten nicht öffentlich landen.
export async function test(cfg) {
  const repo = await gh(cfg, `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
  if (!repo.private) throw new SyncError('Das Repo ist öffentlich. Bitte ein privates Repo verwenden.', 'public');
  const file = await gh(cfg, contentPath(cfg), { allow404: true });
  return { fullName: repo.full_name, hasBackup: !!file };
}

export async function connect(cfg) {
  const clean = { owner: cfg.owner.trim(), repo: cfg.repo.trim(), path: (cfg.path || 'gym-tracker.json').trim(), token: cfg.token.trim() };
  const info = await test(clean);
  write(KEY, clean);
  setState({ error: null, lastHash: null });
  return info;
}

export function disconnect() {
  write(KEY, null);
  write(STATE_KEY, null);
  listeners.forEach((cb) => cb({}));
}

// Lädt die aktuelle Sicherung hoch, falls sich etwas geändert hat. Gibt true zurück, wenn hochgeladen wurde.
export async function backup({ force = false } = {}) {
  const cfg = getConfig();
  if (!cfg) return false;
  const data = await db.exportAll();
  // Nie einen leeren Stand über eine vorhandene Sicherung schreiben (z. B. neues Gerät, gelöschte Daten).
  if (!force && !data.machines.length && !data.sessions.length) {
    setState({ pending: false });
    return false;
  }
  const payload = JSON.stringify({ machines: data.machines, sessions: data.sessions });
  const h = hash(payload);
  if (!force && getState().lastHash === h) {
    setState({ pending: false });
    return false;
  }
  setState({ pending: true, busy: true });
  try {
    const existing = await gh(cfg, contentPath(cfg), { allow404: true });
    const now = new Date();
    const when = now.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    await gh(cfg, contentPath(cfg), {
      method: 'PUT',
      body: JSON.stringify({
        message: `Sicherung ${when} (${data.machines.length} Geräte, ${data.sessions.length} Trainings)`,
        content: toBase64(JSON.stringify(data, null, 2)),
        ...(existing?.sha ? { sha: existing.sha } : {}),
      }),
    });
    setState({ pending: false, busy: false, error: null, lastHash: h, lastBackup: now.toISOString() });
    return true;
  } catch (e) {
    setState({ pending: true, busy: false, error: e.message });
    throw e;
  }
}

// Holt die Sicherung aus GitHub (ohne sie anzuwenden).
export async function fetchBackup() {
  const cfg = getConfig();
  if (!cfg) throw new SyncError('Sicherung nicht eingerichtet');
  const file = await gh(cfg, contentPath(cfg), { allow404: true });
  if (!file) return null;
  // Große Dateien (> 1 MB) liefert die Contents-API ohne Inhalt; dann über download_url laden.
  const text = file.content ? fromBase64(file.content) : await (await fetch(file.download_url)).text();
  return JSON.parse(text);
}

export async function restore(data) {
  await db.importAll(data);
  const payload = JSON.stringify({ machines: data.machines, sessions: data.sessions });
  setState({ pending: false, error: null, lastHash: hash(payload) });
}

// ---- Automatik ----

let timer = null;
let errorHandler = null;
let reportedError = false;

function schedule(delay = DEBOUNCE_MS) {
  if (!getConfig()) return;
  setState({ pending: true });
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  clearTimeout(timer);
  timer = null;
  try {
    await backup();
  } catch (e) {
    if (!reportedError && errorHandler) errorHandler(e);
    reportedError = true;
  }
}

// Startet die automatische Sicherung. `onError` wird höchstens einmal pro Sitzung aufgerufen.
export function start(onError) {
  errorHandler = onError;
  db.onChange(() => schedule());
  const flush = () => {
    if (getConfig() && (timer || getState().pending)) run();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('online', flush);
  // Ausstehende Sicherung vom letzten Mal nachholen.
  if (getConfig() && getState().pending) setTimeout(run, 1500);
}
