// Kleiner IndexedDB-Wrapper. Alle Daten bleiben lokal auf dem Gerät.
const DB_NAME = 'gym-tracker';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const machines = db.createObjectStore('machines', { keyPath: 'id' });
        machines.createIndex('qrCode', 'qrCode', { unique: false });
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('machineId', 'machineId', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---- Geräte ----

export async function getMachines() {
  const list = await promisify((await store('machines')).getAll());
  return list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getMachine(id) {
  return promisify((await store('machines')).get(id));
}

export async function findMachineByQr(code) {
  if (!code) return undefined;
  const list = await promisify((await store('machines')).index('qrCode').getAll(code));
  return list[0];
}

export async function saveMachine(machine) {
  await promisify((await store('machines', 'readwrite')).put(machine));
  return machine;
}

export async function deleteMachine(id) {
  const db = await open();
  const tx = db.transaction(['machines', 'sessions'], 'readwrite');
  tx.objectStore('machines').delete(id);
  const idx = tx.objectStore('sessions').index('machineId');
  const keys = await promisify(idx.getAllKeys(id));
  keys.forEach((k) => tx.objectStore('sessions').delete(k));
  return done(tx);
}

// ---- Trainings ----

export async function getSessions(machineId) {
  const list = await promisify((await store('sessions')).index('machineId').getAll(machineId));
  return list.sort((a, b) => b.date.localeCompare(a.date));
}

export async function getAllSessions() {
  return promisify((await store('sessions')).getAll());
}

export async function getSession(id) {
  return promisify((await store('sessions')).get(id));
}

export async function saveSession(session) {
  await promisify((await store('sessions', 'readwrite')).put(session));
  return session;
}

export async function deleteSession(id) {
  return promisify((await store('sessions', 'readwrite')).delete(id));
}

// ---- Backup ----

export async function exportAll() {
  return {
    app: 'gym-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    machines: await getMachines(),
    sessions: await getAllSessions(),
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'gym-tracker' || !Array.isArray(data.machines) || !Array.isArray(data.sessions)) {
    throw new Error('Keine gültige Gym-Tracker-Sicherung.');
  }
  const db = await open();
  const tx = db.transaction(['machines', 'sessions'], 'readwrite');
  tx.objectStore('machines').clear();
  tx.objectStore('sessions').clear();
  data.machines.forEach((m) => tx.objectStore('machines').put(m));
  data.sessions.forEach((s) => tx.objectStore('sessions').put(s));
  return done(tx);
}
