import * as db from './db.js';
import { Scanner, decodeImageFile } from './scanner.js';

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
let cleanup = null;

// ---------- Helfer ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '–');

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' });

const parseNum = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const todayIso = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function setHeader(title, back) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => (location.hash = back) : null;
}

const go = (hash) => (location.hash = hash);

function setsSummary(sets) {
  return sets.map((s) => `${fmtNum(s.reps)}×${fmtNum(s.weight)}`).join(' · ');
}

const maxWeight = (session) => Math.max(...session.sets.map((s) => s.weight ?? 0));
const volume = (session) => session.sets.reduce((sum, s) => sum + (s.reps ?? 0) * (s.weight ?? 0), 0);

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, home],
  [/^#\/scan$/, scan],
  [/^#\/new(?:\?qr=(.*))?$/, (qr) => editMachine(null, qr ? decodeURIComponent(qr) : '')],
  [/^#\/m\/([^/]+)$/, machineDetail],
  [/^#\/m\/([^/]+)\/edit$/, (id) => editMachine(id)],
  [/^#\/m\/([^/]+)\/log(?:\/([^/]+))?$/, logSession],
  [/^#\/settings$/, settings],
];

async function render() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  window.scrollTo(0, 0);
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (e) {
        console.error(e);
        view.innerHTML = `<p class="empty">Fehler: ${esc(e.message)}</p>`;
      }
      return;
    }
  }
  go('#/');
}

window.addEventListener('hashchange', render);

// ---------- Start ----------

async function home() {
  setHeader('Gym Tracker');
  const machines = await db.getMachines();
  const sessions = await db.getAllSessions();
  const last = {};
  sessions.forEach((s) => {
    if (!last[s.machineId] || s.date > last[s.machineId].date) last[s.machineId] = s;
  });

  view.innerHTML = `
    <a class="btn primary big" href="#/scan">
      <span class="btn-icon">⌗</span> Gerät scannen
    </a>
    ${machines.length > 3 ? `<input id="search" class="search" type="search" placeholder="Gerät suchen …" autocomplete="off">` : ''}
    <ul class="list" id="machine-list">
      ${machines
        .map(
          (m) => `
        <li data-name="${esc(m.name.toLowerCase())}">
          <a href="#/m/${m.id}">
            <div class="li-main">
              <strong>${esc(m.name)}</strong>
              <small>${m.settings.length ? esc(m.settings.map((s) => `${s.label}: ${s.value}`).join(' · ')) : 'Keine Einstellungen'}</small>
            </div>
            <div class="li-side">${last[m.id] ? `<small>${fmtDate(last[m.id].date)}</small><span>${fmtNum(maxWeight(last[m.id]))} kg</span>` : ''}</div>
          </a>
        </li>`
        )
        .join('')}
    </ul>
    ${machines.length ? '' : `<p class="empty">Noch keine Geräte. Scanne den QR-Code an einem Gerät, um es anzulegen.</p>`}
    <a class="btn ghost" href="#/new">+ Gerät ohne QR-Code anlegen</a>
  `;

  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      view.querySelectorAll('#machine-list li').forEach((li) => {
        li.hidden = q && !li.dataset.name.includes(q);
      });
    });
  }
}

// ---------- Scannen ----------

async function handleCode(code) {
  const machine = await db.findMachineByQr(code);
  if (machine) {
    if (navigator.vibrate) navigator.vibrate(50);
    go(`#/m/${machine.id}`);
  } else {
    go(`#/new?qr=${encodeURIComponent(code)}`);
  }
}

async function scan() {
  setHeader('Scannen', '#/');
  view.innerHTML = `
    <div class="scanner">
      <video id="video" playsinline muted></video>
      <div class="frame"></div>
      <canvas id="canvas" hidden></canvas>
    </div>
    <p class="hint" id="scan-hint">QR-Code des Geräts in den Rahmen halten.</p>
    <label class="btn ghost">
      Foto vom QR-Code wählen
      <input id="photo" type="file" accept="image/*" capture="environment" hidden>
    </label>
    <details class="manual">
      <summary>Gerät aus Liste wählen</summary>
      <ul class="list compact" id="pick"></ul>
    </details>
  `;

  const scanner = new Scanner(document.getElementById('video'), document.getElementById('canvas'));
  cleanup = () => scanner.stop();
  scanner.start(handleCode).catch((e) => {
    document.getElementById('scan-hint').textContent =
      e.name === 'NotAllowedError'
        ? 'Kamerazugriff verweigert. Bitte in den iOS-Einstellungen erlauben oder ein Foto wählen.'
        : `Kamera nicht verfügbar: ${e.message}`;
  });

  document.getElementById('photo').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const code = await decodeImageFile(file).catch(() => null);
    if (code) handleCode(code);
    else toast('Kein QR-Code im Foto gefunden.');
  });

  const machines = await db.getMachines();
  document.getElementById('pick').innerHTML =
    machines.map((m) => `<li><a href="#/m/${m.id}">${esc(m.name)}</a></li>`).join('') ||
    '<li class="empty">Noch keine Geräte.</li>';
}

// ---------- Gerätedetail ----------

function chart(sessions) {
  const pts = sessions
    .slice()
    .reverse()
    .map((s) => ({ date: s.date, w: maxWeight(s) }));
  if (pts.length < 2) return '';
  const W = 320, H = 140, P = 24;
  const ws = pts.map((p) => p.w);
  let min = Math.min(...ws), max = Math.max(...ws);
  if (min === max) { min -= 5; max += 5; }
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (w) => H - P - ((w - min) * (H - 2 * P)) / (max - min);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf Höchstgewicht">
      <text x="${P}" y="14" class="axis">${fmtNum(max)} kg</text>
      <text x="${P}" y="${H - 6}" class="axis">${fmtNum(min)} kg</text>
      <path d="${line}" class="line"/>
      ${pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="3.5" class="dot"><title>${fmtDate(p.date)}: ${fmtNum(p.w)} kg</title></circle>`).join('')}
    </svg>`;
}

async function machineDetail(id) {
  const m = await db.getMachine(id);
  if (!m) return go('#/');
  const sessions = await db.getSessions(id);
  setHeader(m.name, '#/');
  const last = sessions[0];
  const best = sessions.length ? Math.max(...sessions.map(maxWeight)) : null;

  view.innerHTML = `
    <section class="card settings-card">
      <h2>Einstellungen</h2>
      ${
        m.settings.length
          ? `<dl class="settings-grid">${m.settings.map((s) => `<div><dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd></div>`).join('')}</dl>`
          : `<p class="empty">Keine Einstellungen hinterlegt. <a href="#/m/${m.id}/edit">Jetzt eintragen</a></p>`
      }
      ${m.notes ? `<p class="notes">${esc(m.notes)}</p>` : ''}
    </section>

    <a class="btn primary big" href="#/m/${m.id}/log">+ Training erfassen</a>

    ${
      last
        ? `<section class="card">
            <h2>Letztes Training <small>${fmtDate(last.date)}</small></h2>
            <ol class="sets">${last.sets.map((s) => `<li><span>${fmtNum(s.reps)} Wdh.</span><strong>${fmtNum(s.weight)} kg</strong></li>`).join('')}</ol>
            ${last.note ? `<p class="notes">${esc(last.note)}</p>` : ''}
            <p class="stats">Bestes Gewicht: <strong>${fmtNum(best)} kg</strong> · Trainings: <strong>${sessions.length}</strong></p>
          </section>`
        : ''
    }

    ${sessions.length > 1 ? `<section class="card"><h2>Verlauf (Höchstgewicht)</h2>${chart(sessions.slice(0, 30))}</section>` : ''}

    ${
      sessions.length
        ? `<section class="card">
            <h2>Alle Trainings</h2>
            <ul class="list compact">
              ${sessions
                .map(
                  (s) => `<li><a href="#/m/${m.id}/log/${s.id}">
                    <div class="li-main"><strong>${fmtDate(s.date)}</strong><small>${esc(setsSummary(s.sets))}</small></div>
                    <div class="li-side"><small>Vol. ${fmtNum(volume(s))}</small></div>
                  </a></li>`
                )
                .join('')}
            </ul>
          </section>`
        : ''
    }

    <a class="btn ghost" href="#/m/${m.id}/edit">Gerät bearbeiten</a>
  `;
}

// ---------- Gerät anlegen / bearbeiten ----------

const DEFAULT_SETTINGS = ['Sitzhöhe', 'Rückenlehne'];

function settingRow(label = '', value = '') {
  return `
    <div class="setting-row">
      <input class="s-label" placeholder="z. B. Sitzhöhe" value="${esc(label)}" autocapitalize="sentences">
      <input class="s-value" placeholder="Wert" value="${esc(value)}">
      <button type="button" class="icon-btn remove" aria-label="Entfernen">✕</button>
    </div>`;
}

async function editMachine(id, qr = '') {
  const existing = id ? await db.getMachine(id) : null;
  if (id && !existing) return go('#/');
  if (!id && qr) {
    // Falls der Code zwischenzeitlich doch schon bekannt ist.
    const known = await db.findMachineByQr(qr);
    if (known) return go(`#/m/${known.id}`);
  }
  const m = existing || {
    id: db.uid(),
    qrCode: qr,
    name: '',
    settings: DEFAULT_SETTINGS.map((label) => ({ label, value: '' })),
    notes: '',
    createdAt: new Date().toISOString(),
  };

  setHeader(existing ? 'Gerät bearbeiten' : 'Neues Gerät', existing ? `#/m/${m.id}` : '#/');

  view.innerHTML = `
    <form id="form" class="form" autocomplete="off">
      ${!existing && qr ? `<p class="info">Neuer QR-Code erkannt. Lege das Gerät einmalig an – beim nächsten Scan erscheinen die Einstellungen direkt.</p>` : ''}
      <label>Name des Geräts
        <input name="name" required placeholder="z. B. Hip Adduction" value="${esc(m.name)}" autocapitalize="words">
      </label>

      <fieldset>
        <legend>Einstellungen am Gerät</legend>
        <div id="settings">${m.settings.map((s) => settingRow(s.label, s.value)).join('')}</div>
        <button type="button" class="btn ghost small" id="add-setting">+ Einstellung hinzufügen</button>
      </fieldset>

      <label>Notizen
        <textarea name="notes" rows="2" placeholder="z. B. Griffposition, Ausführung …">${esc(m.notes)}</textarea>
      </label>

      <fieldset>
        <legend>QR-Code</legend>
        <p class="qr-value" id="qr-value">${m.qrCode ? esc(m.qrCode) : '<em>Kein QR-Code zugeordnet</em>'}</p>
        <div class="row">
          <button type="button" class="btn ghost small" id="rescan">${m.qrCode ? 'Neu scannen' : 'QR-Code scannen'}</button>
          ${m.qrCode ? `<button type="button" class="btn ghost small" id="clear-qr">Entfernen</button>` : ''}
        </div>
        <div class="scanner small" id="inline-scanner" hidden>
          <video id="video" playsinline muted></video>
          <div class="frame"></div>
          <canvas id="canvas" hidden></canvas>
        </div>
      </fieldset>

      <button class="btn primary big" type="submit">Speichern</button>
      ${existing ? `<button type="button" class="btn danger" id="delete">Gerät löschen</button>` : ''}
    </form>
  `;

  const form = document.getElementById('form');
  const settingsEl = document.getElementById('settings');
  let qrCode = m.qrCode;

  document.getElementById('add-setting').onclick = () => {
    settingsEl.insertAdjacentHTML('beforeend', settingRow());
    settingsEl.lastElementChild.querySelector('.s-label').focus();
  };
  settingsEl.addEventListener('click', (e) => {
    if (e.target.closest('.remove')) e.target.closest('.setting-row').remove();
  });

  const scanner = new Scanner(document.getElementById('video'), document.getElementById('canvas'));
  cleanup = () => scanner.stop();
  document.getElementById('rescan').onclick = () => {
    const box = document.getElementById('inline-scanner');
    box.hidden = false;
    scanner
      .start(async (code) => {
        box.hidden = true;
        const other = await db.findMachineByQr(code);
        if (other && other.id !== m.id) {
          toast(`Code gehört bereits zu „${other.name}“.`);
          return;
        }
        qrCode = code;
        document.getElementById('qr-value').textContent = code;
        toast('QR-Code übernommen');
      })
      .catch((e) => {
        box.hidden = true;
        toast(`Kamera nicht verfügbar: ${e.message}`);
      });
  };
  const clearBtn = document.getElementById('clear-qr');
  if (clearBtn)
    clearBtn.onclick = () => {
      qrCode = '';
      document.getElementById('qr-value').innerHTML = '<em>Kein QR-Code zugeordnet</em>';
    };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const settings = [...settingsEl.querySelectorAll('.setting-row')]
      .map((row) => ({ label: row.querySelector('.s-label').value.trim(), value: row.querySelector('.s-value').value.trim() }))
      .filter((s) => s.label || s.value);
    await db.saveMachine({ ...m, name: fd.get('name').trim(), notes: fd.get('notes').trim(), settings, qrCode });
    toast('Gespeichert');
    // Neues Gerät: Verlauf ersetzen, damit „Zurück“ nicht wieder im Formular landet.
    if (existing) go(`#/m/${m.id}`);
    else location.replace(`#/m/${m.id}`);
  };

  const del = document.getElementById('delete');
  if (del)
    del.onclick = async () => {
      if (!confirm(`„${m.name}“ und alle zugehörigen Trainings löschen?`)) return;
      await db.deleteMachine(m.id);
      toast('Gelöscht');
      go('#/');
    };
}

// ---------- Training erfassen ----------

function setRow(i, reps = '', weight = '') {
  return `
    <div class="set-row">
      <span class="set-no">${i}</span>
      <div class="stepper">
        <button type="button" data-step="-1" data-field="reps">−</button>
        <input class="reps" inputmode="numeric" pattern="[0-9]*" value="${esc(reps)}" aria-label="Wiederholungen">
        <button type="button" data-step="1" data-field="reps">+</button>
        <small>Wdh.</small>
      </div>
      <div class="stepper">
        <button type="button" data-step="-2.5" data-field="weight">−</button>
        <input class="weight" inputmode="decimal" value="${esc(weight)}" aria-label="Gewicht in kg">
        <button type="button" data-step="2.5" data-field="weight">+</button>
        <small>kg</small>
      </div>
      <button type="button" class="icon-btn remove" aria-label="Satz entfernen">✕</button>
    </div>`;
}

async function logSession(machineId, sessionId) {
  const m = await db.getMachine(machineId);
  if (!m) return go('#/');
  const existing = sessionId ? await db.getSession(sessionId) : null;
  const sessions = await db.getSessions(machineId);
  const prev = existing ? null : sessions[0];
  const initialSets = existing?.sets || prev?.sets || [{ reps: 12, weight: '' }, { reps: 12, weight: '' }, { reps: 12, weight: '' }];

  setHeader(existing ? 'Training bearbeiten' : m.name, `#/m/${m.id}`);

  view.innerHTML = `
    ${
      m.settings.length
        ? `<div class="settings-strip">${m.settings.map((s) => `<span><small>${esc(s.label)}</small> ${esc(s.value)}</span>`).join('')}</div>`
        : ''
    }
    <form id="form" class="form" autocomplete="off">
      <label>Datum
        <input type="date" name="date" value="${existing ? existing.date : todayIso()}" required>
      </label>
      ${prev ? `<p class="info">Vorausgefüllt mit dem letzten Training (${fmtDate(prev.date)}).</p>` : ''}
      <div id="sets">${initialSets.map((s, i) => setRow(i + 1, s.reps ?? '', s.weight == null ? '' : String(s.weight).replace('.', ','))).join('')}</div>
      <button type="button" class="btn ghost small" id="add-set">+ Satz</button>
      <label>Notiz
        <input name="note" placeholder="optional" value="${esc(existing?.note)}">
      </label>
      <button class="btn primary big" type="submit">Training speichern</button>
      ${existing ? `<button type="button" class="btn danger" id="delete">Training löschen</button>` : ''}
    </form>
  `;

  const setsEl = document.getElementById('sets');
  const renumber = () => setsEl.querySelectorAll('.set-no').forEach((el, i) => (el.textContent = i + 1));

  document.getElementById('add-set').onclick = () => {
    const rows = setsEl.querySelectorAll('.set-row');
    const lastRow = rows[rows.length - 1];
    setsEl.insertAdjacentHTML(
      'beforeend',
      setRow(rows.length + 1, lastRow?.querySelector('.reps').value ?? '', lastRow?.querySelector('.weight').value ?? '')
    );
  };

  setsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const row = btn.closest('.set-row');
    if (btn.classList.contains('remove')) {
      row.remove();
      renumber();
      return;
    }
    const input = row.querySelector(btn.dataset.field === 'reps' ? '.reps' : '.weight');
    const val = parseNum(input.value) ?? 0;
    input.value = fmtNum(Math.max(0, val + parseFloat(btn.dataset.step))).replace(/\./g, '');
  });

  document.getElementById('form').onsubmit = async (e) => {
    e.preventDefault();
    const sets = [...setsEl.querySelectorAll('.set-row')]
      .map((row) => ({ reps: parseNum(row.querySelector('.reps').value), weight: parseNum(row.querySelector('.weight').value) }))
      .filter((s) => s.reps !== null || s.weight !== null);
    if (!sets.length) return toast('Mindestens einen Satz eintragen.');
    const fd = new FormData(e.target);
    await db.saveSession({
      id: existing?.id || db.uid(),
      machineId,
      date: fd.get('date'),
      sets,
      note: fd.get('note').trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
    });
    toast('Training gespeichert 💪');
    location.replace(`#/m/${machineId}`);
  };

  const del = document.getElementById('delete');
  if (del)
    del.onclick = async () => {
      if (!confirm('Dieses Training löschen?')) return;
      await db.deleteSession(existing.id);
      location.replace(`#/m/${machineId}`);
    };
}

// ---------- Einstellungen / Backup ----------

async function settings() {
  setHeader('Einstellungen', '#/');
  const machines = await db.getMachines();
  const sessions = await db.getAllSessions();
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;

  view.innerHTML = `
    <section class="card">
      <h2>Daten</h2>
      <p>${machines.length} Geräte · ${sessions.length} Trainings</p>
      <p class="hint">Alle Daten liegen nur auf diesem Gerät. Erstelle regelmäßig eine Sicherung (z. B. in iCloud Drive).</p>
      <button class="btn primary" id="export">Sicherung exportieren</button>
      <label class="btn ghost">
        Sicherung importieren
        <input type="file" id="import" accept="application/json,.json" hidden>
      </label>
      <p class="hint">Speicher dauerhaft: ${persisted ? 'ja ✓' : 'nicht garantiert – App über „Zum Home-Bildschirm“ installieren.'}</p>
    </section>
    <section class="card">
      <h2>Info</h2>
      <p class="hint">Gym Tracker – QR-Code am Gerät scannen, Einstellungen ablesen, Sätze erfassen. Funktioniert offline.</p>
    </section>
  `;

  document.getElementById('export').onclick = async () => {
    const data = await db.exportAll();
    const name = `gym-tracker-${todayIso()}.json`;
    const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  document.getElementById('import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm(`Sicherung mit ${data.machines?.length ?? 0} Geräten und ${data.sessions?.length ?? 0} Trainings importieren? Aktuelle Daten werden ersetzt.`)) return;
      await db.importAll(data);
      toast('Import erfolgreich');
      settings();
    } catch (err) {
      toast(`Import fehlgeschlagen: ${err.message}`);
    }
  };
}

// ---------- Start ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW-Registrierung fehlgeschlagen', e));
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

render();
