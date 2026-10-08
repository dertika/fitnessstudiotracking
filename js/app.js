import * as db from './db.js';
import { Scanner, decodeImageFile } from './scanner.js';
import * as st from './stats.js';

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');
let cleanup = null;

// ---------- Helfer ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) : '–');

const fmtDate = (iso) =>
  st.parseDate(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' });

const parseNum = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const todayIso = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

// Diagramm-Elemente mit data-tip zeigen ihren Wert beim Antippen (Touch hat kein Hover).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) toast(el.dataset.tip, 3000);
});

function setHeader(title, back) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => (location.hash = back) : null;
}

const go = (hash) => (location.hash = hash);

function setsSummary(sets) {
  return sets.map((s) => `${fmtNum(s.reps)}×${fmtNum(s.weight)}`).join(' · ');
}

const maxWeight = st.sessionMaxWeight;
const volume = st.sessionVolume;

const fmtPct = (p) => (p === null ? '–' : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${fmtNum(Math.abs(Math.round(p)))} %`);
const fmtKg = (n) => `${fmtNum(Math.round(n * 10) / 10)} kg`;
const fmtVol = (n) => (n >= 10000 ? `${fmtNum(Math.round(n / 100) / 10)} t` : `${fmtNum(Math.round(n))} kg`);

// ---------- Router ----------

const routes = [
  [/^#?\/?$/, home],
  [/^#\/scan$/, scan],
  [/^#\/new(?:\?qr=(.*))?$/, (qr) => editMachine(null, qr ? decodeURIComponent(qr) : '')],
  [/^#\/m\/([^/]+)$/, machineDetail],
  [/^#\/m\/([^/]+)\/edit$/, (id) => editMachine(id)],
  [/^#\/m\/([^/]+)\/log(?:\/([^/]+))?$/, logSession],
  [/^#\/settings$/, settings],
  [/^#\/stats$/, statsView],
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
    ${sessions.length ? `<a class="btn ghost" href="#/stats">📊 Statistik</a>` : ''}
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
      <input id="photo" type="file" accept="image/*" hidden>
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

// Liniendiagramm für einen Verlauf. pts: [{ date, v }] älteste zuerst.
function lineChart(pts, label, fmt = fmtKg) {
  if (pts.length < 2) return '';
  const W = 320, H = 160, L = 8, R = 8, T = 22, B = 34;
  const vs = pts.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 5; max += 5; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const hi = Math.max(...vs), lo = Math.min(...vs);
  const short = (iso) => st.parseDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      <line x1="${L}" x2="${W - R}" y1="${y(hi).toFixed(1)}" y2="${y(hi).toFixed(1)}" class="grid"/>
      <line x1="${L}" x2="${W - R}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}" class="grid"/>
      <text x="${L}" y="${(y(hi) - 5).toFixed(1)}" class="axis">${fmt(hi)}</text>
      <text x="${L}" y="${(y(lo) + 13).toFixed(1)}" class="axis">${fmt(lo)}</text>
      <path d="${line}" class="line"/>
      ${pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" class="dot"/>`).join('')}
      ${pts.map((p, i) => `<rect x="${(x(i) - 12).toFixed(1)}" y="0" width="24" height="${H}" class="hit" data-tip="${fmtDate(p.date)}: ${fmt(p.v)}"/>`).join('')}
      <text x="${L}" y="${H - 4}" class="axis">${short(pts[0].date)}</text>
      <text x="${W - R}" y="${H - 4}" class="axis" text-anchor="end">${short(pts[pts.length - 1].date)}</text>
    </svg>`;
}

function recordsCard(sessions) {
  const r = st.machineRecords(sessions);
  const p = st.progress(sessions);
  const row = (label, value, date) =>
    value ? `<div><dt>${label}</dt><dd>${value}</dd><small>${fmtDate(date)}</small></div>` : '';
  return `
    <section class="card">
      <h2>Rekorde</h2>
      <dl class="records">
        ${row('Schwerster Satz', r.heaviest && `${fmtKg(r.heaviest.value)} × ${fmtNum(r.heaviest.reps)}`, r.heaviest?.date)}
        ${row('Bestes 1RM (geschätzt)', r.bestE1rm && fmtKg(r.bestE1rm.value), r.bestE1rm?.date)}
        ${row('Höchstes Volumen', r.volume && fmtVol(r.volume.value), r.volume?.date)}
        ${row('Meiste Wdh. in einem Satz', r.mostReps && `${fmtNum(r.mostReps.value)} × ${fmtKg(r.mostReps.weight)}`, r.mostReps?.date)}
      </dl>
      ${p.sinceStart !== null ? `<p class="stats">1RM-Fortschritt: <strong>${fmtPct(p.sinceStart)}</strong> seit Beginn${p.last4Weeks !== null ? ` · <strong>${fmtPct(p.last4Weeks)}</strong> in 4 Wochen` : ''}</p>` : ''}
    </section>`;
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

    ${sessions.length ? recordsCard(sessions) : ''}

    ${
      sessions.length > 1
        ? `<section class="card">
            <h2>Verlauf</h2>
            <div class="tabs" role="tablist">
              <button type="button" role="tab" data-chart="weight" aria-selected="true">Höchstgewicht</button>
              <button type="button" role="tab" data-chart="e1rm" aria-selected="false">1RM</button>
              <button type="button" role="tab" data-chart="volume" aria-selected="false">Volumen</button>
            </div>
            <div id="chart"></div>
          </section>`
        : ''
    }

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

  const chartEl = document.getElementById('chart');
  if (chartEl) {
    const recent = sessions.slice(0, 30).reverse();
    const series = {
      weight: ['Verlauf Höchstgewicht', st.sessionMaxWeight, fmtKg],
      e1rm: ['Verlauf geschätztes 1RM', st.sessionBestE1rm, fmtKg],
      volume: ['Verlauf Volumen', st.sessionVolume, fmtVol],
    };
    const show = (key) => {
      const [label, fn, fmt] = series[key];
      chartEl.innerHTML = lineChart(recent.map((s) => ({ date: s.date, v: fn(s) })), label, fmt);
      view.querySelectorAll('[data-chart]').forEach((b) => b.setAttribute('aria-selected', b.dataset.chart === key));
    };
    view.querySelectorAll('[data-chart]').forEach((b) => (b.onclick = () => show(b.dataset.chart)));
    show('weight');
  }
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
    const session = {
      id: existing?.id || db.uid(),
      machineId,
      date: fd.get('date'),
      sets,
      note: fd.get('note').trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    const records = st.newRecords(session, sessions);
    await db.saveSession(session);
    if (records.length) {
      const text = { heaviest: (v) => `schwerster Satz ${fmtKg(v)}`, e1rm: (v) => `1RM ${fmtKg(v)}`, volume: (v) => `Volumen ${fmtVol(v)}` };
      toast(`🏆 Neuer Rekord: ${records.map((r) => text[r.type](r.value)).join(' · ')}`, 4500);
    } else {
      toast('Training gespeichert 💪');
    }
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

// ---------- Statistik ----------

function barChart(weeks, valueOf, fmt, label) {
  const W = 320, H = 130, T = 18, B = 20, gap = 2;
  const vals = weeks.map(valueOf);
  const max = Math.max(...vals, 1);
  const bw = (W - gap * (weeks.length - 1)) / weeks.length;
  const short = (d) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const bars = weeks
    .map((w, i) => {
      const v = vals[i];
      const h = v ? Math.max(3, (v / max) * (H - T - B)) : 0;
      const x = i * (bw + gap);
      const y = H - B - h;
      // Oben gerundet, unten an der Grundlinie gerade.
      const r = Math.min(4, bw / 2, h);
      const path = h
        ? `M${x},${H - B} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - B} Z`
        : '';
      const current = i === weeks.length - 1;
      return `<g>
        ${path ? `<path d="${path}" class="bar${current ? ' current' : ''}"/>` : ''}
        <rect x="${x}" y="0" width="${bw + gap}" height="${H}" class="hit" data-tip="Woche ab ${short(w.start)}: ${fmt(v)}"/>
      </g>`;
    })
    .join('');
  const maxIdx = vals.indexOf(Math.max(...vals));
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      <line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" class="baseline"/>
      ${bars}
      ${vals[maxIdx] ? `<text x="${maxIdx * (bw + gap) + bw / 2}" y="${H - B - (vals[maxIdx] / max) * (H - T - B) - 5}" class="axis" text-anchor="middle">${fmt(vals[maxIdx])}</text>` : ''}
      <text x="0" y="${H - 5}" class="axis">${short(weeks[0].start)}</text>
      <text x="${W}" y="${H - 5}" class="axis" text-anchor="end">diese Woche</text>
    </svg>`;
}

function heatmap(sessions, weeks = 26, today = new Date()) {
  const daily = st.dailyStats(sessions);
  const first = st.weekStart(today);
  first.setDate(first.getDate() - 7 * (weeks - 1));
  const vols = [...daily.values()].map((d) => d.volume).filter((v) => v > 0).sort((a, b) => a - b);
  // Stufen nach Quartilen der eigenen Trainingstage, damit die Farben aussagekräftig bleiben.
  const q = (p) => vols[Math.min(vols.length - 1, Math.floor(p * vols.length))] ?? 0;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  const level = (v) => (!v ? 1 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
  const todayIso = st.toIso(today);
  const C = 11, G = 2, LEFT = 18, TOP = 14;
  const cells = [];
  const months = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d);
      const iso = st.toIso(date);
      if (iso > todayIso) continue;
      if (d === 0 && date.getMonth() !== lastMonth && w < weeks - 2) {
        lastMonth = date.getMonth();
        months.push(`<text x="${LEFT + w * (C + G)}" y="10" class="axis">${date.toLocaleDateString('de-DE', { month: 'short' })}</text>`);
      }
      const e = daily.get(iso);
      const tip = e ? `${fmtDate(iso)}: ${e.sessions} Gerät${e.sessions > 1 ? 'e' : ''}, ${fmtVol(e.volume)}` : `${fmtDate(iso)}: kein Training`;
      cells.push(
        `<rect x="${LEFT + w * (C + G)}" y="${TOP + d * (C + G)}" width="${C}" height="${C}" rx="2" class="hm ${e ? `l${level(e.volume)}` : 'l0'}" data-tip="${tip}"/>`
      );
    }
  }
  const W = LEFT + weeks * (C + G);
  const H = TOP + 7 * (C + G);
  const dayLabels = ['Mo', '', 'Mi', '', 'Fr', '', 'So']
    .map((l, d) => (l ? `<text x="0" y="${TOP + d * (C + G) + 9}" class="axis">${l}</text>` : ''))
    .join('');
  return `
    <svg class="chart heatmap" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trainingskalender der letzten ${weeks} Wochen">
      ${months.join('')}${dayLabels}${cells.join('')}
    </svg>
    <div class="hm-legend"><span>weniger</span>${[0, 1, 2, 3, 4].map((l) => `<i class="l${l}"></i>`).join('')}<span>mehr Volumen</span></div>`;
}

async function statsView() {
  setHeader('Statistik', '#/');
  const machines = await db.getMachines();
  const sessions = await db.getAllSessions();
  if (!sessions.length) {
    view.innerHTML = `<p class="empty">Noch keine Trainings erfasst. Sobald du trainierst, erscheinen hier deine Statistiken.</p>`;
    return;
  }
  const o = st.overview(sessions);
  const weeks = st.weeklyStats(sessions, 12);
  const byMachine = machines
    .map((m) => {
      const list = sessions.filter((s) => s.machineId === m.id);
      if (!list.length) return null;
      const last = list.reduce((a, b) => (b.date > a.date ? b : a));
      return { m, count: list.length, last, p: st.progress(list) };
    })
    .filter(Boolean)
    .sort((a, b) => (b.p.sinceStart ?? -Infinity) - (a.p.sinceStart ?? -Infinity));

  const tile = (value, label) => `<div class="tile"><strong>${value}</strong><span>${label}</span></div>`;
  view.innerHTML = `
    <div class="stat-tiles">
      ${tile(fmtNum(o.daysThisMonth), 'Trainingstage diesen Monat')}
      ${tile(fmtNum(Math.round(o.avgDaysPerWeek * 10) / 10), 'Ø Tage pro Woche (7 Wochen)')}
      ${tile(`${fmtNum(o.streak)} 🔥`, o.streak === 1 ? 'Woche in Folge' : 'Wochen in Folge')}
      ${tile(fmtVol(o.volumeThisWeek), 'Volumen diese Woche')}
    </div>

    <section class="card">
      <h2>Trainingskalender</h2>
      <div class="scroll-x">${heatmap(sessions)}</div>
    </section>

    <section class="card">
      <h2>Trainingstage pro Woche</h2>
      ${barChart(weeks, (w) => w.days, (v) => `${fmtNum(v)} ${v === 1 ? 'Tag' : 'Tage'}`, 'Trainingstage pro Woche, letzte 12 Wochen')}
    </section>

    <section class="card">
      <h2>Volumen pro Woche</h2>
      ${barChart(weeks, (w) => w.volume, fmtVol, 'Volumen pro Woche, letzte 12 Wochen')}
      <p class="hint">Volumen = Wiederholungen × Gewicht, über alle Sätze.</p>
    </section>

    <section class="card">
      <h2>Fortschritt pro Gerät</h2>
      <ul class="list compact">
        ${byMachine
          .map(
            ({ m, count, last, p }) => `<li><a href="#/m/${m.id}">
              <div class="li-main"><strong>${esc(m.name)}</strong><small>${count}× · zuletzt ${st.parseDate(last.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</small></div>
              <div class="li-side"><span class="${p.sinceStart > 0 ? 'up' : p.sinceStart < 0 ? 'down' : ''}">${fmtPct(p.sinceStart)}</span><small>1RM seit Beginn</small></div>
            </a></li>`
          )
          .join('')}
      </ul>
    </section>
    <p class="hint">Tippe auf Balken oder Kalendertage, um die Werte zu sehen.</p>
  `;
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
