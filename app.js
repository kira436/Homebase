/* Homebase web app. Local-first: everything is saved on the phone, and synced through
   Supabase when config.js has a project URL and key. No build step, no dependencies. */
(function () {
  'use strict';
  const L = window.HBLogic;
  const CFG = window.HB_CONFIG || {};
  const LS_KEY = 'homebase.v1';
  const $app = document.getElementById('app');

  // ---------------------------------------------------------------- storage
  function blankDb() {
    return { household: null, meId: null, recs: {}, dirty: {}, lastPull: '1970-01-01T00:00:00Z' };
  }
  let db;
  try { db = Object.assign(blankDb(), JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {}); }
  catch (e) { db = blankDb(); }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { toast('Could not save on this device'); } }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  function newCode() {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  }

  function put(rec) {
    rec.updatedLocal = Date.now();
    db.recs[rec.id] = rec;
    db.dirty[rec.id] = rec.updatedLocal;
    save();
    syncSoon();
  }
  function remove(rec) { rec.deleted = true; put(rec); }
  function all(type) { return Object.values(db.recs).filter((r) => r.type === type && !r.deleted); }

  const members = () => all('member').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const me = () => db.recs[db.meId] && !db.recs[db.meId].deleted ? db.recs[db.meId] : null;
  const memberName = (id) => (db.recs[id] && db.recs[id].name) || 'Someone';
  const tasks = () => all('task').filter((t) => !t.archived);

  // ---------------------------------------------------------------- sync
  const syncOn = () => !!(CFG.supabaseUrl && CFG.supabaseKey && db.household);
  let syncing = false, syncTimer = null, syncState = { ok: null, error: '', at: 0 };

  async function rpc(fn, body) {
    const headers = { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' };
    if (CFG.supabaseKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + CFG.supabaseKey; // legacy anon JWT
    const res = await fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/' + fn,
      { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(fn + ' failed (' + res.status + '): ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }

  async function sync() {
    if (!syncOn() || syncing) return;
    syncing = true;
    try {
      const ids = Object.keys(db.dirty);
      if (ids.length) {
        const sent = {};
        const rows = ids.filter((id) => db.recs[id]).map((id) => {
          sent[id] = db.dirty[id];
          const r = db.recs[id];
          return { id, type: r.type, deleted: !!r.deleted, data: r };
        });
        await rpc('hb_push', { p_household: db.household.id, p_rows: rows });
        // Only clear what was not edited again while the request was in flight.
        for (const id of Object.keys(sent)) if (db.dirty[id] === sent[id]) delete db.dirty[id];
      }
      // Overlap by a few seconds so slow concurrent writes are never missed; merging is idempotent.
      const since = new Date(Date.parse(db.lastPull) - 5000).toISOString();
      const rows = (await rpc('hb_pull', { p_household: db.household.id, p_since: since })) || [];
      let maxSeen = db.lastPull, changed = false;
      for (const row of rows) {
        if (!db.dirty[row.id]) {
          const incoming = Object.assign({}, row.data, { deleted: row.deleted });
          if (JSON.stringify(incoming) !== JSON.stringify(db.recs[row.id])) { db.recs[row.id] = incoming; changed = true; }
        }
        if (Date.parse(row.updated_at) > Date.parse(maxSeen)) maxSeen = row.updated_at;
      }
      db.lastPull = maxSeen;
      const hh = Object.values(db.recs).find((r) => r.type === 'household');
      if (hh && hh.name && db.household.name !== hh.name) { db.household.name = hh.name; changed = true; }
      save();
      syncState = { ok: true, error: '', at: Date.now() };
      if (changed) renderSoon();
    } catch (e) {
      syncState = { ok: false, error: String(e.message || e), at: Date.now() };
    } finally {
      syncing = false;
    }
  }
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 1200); }
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  window.addEventListener('online', sync);

  // ---------------------------------------------------------------- UI state
  const ui = { tab: 'today', sheet: null, taskFilter: 'all', shopMode: 'grocery', undo: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDay(d) {
    return L.parseDay(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function relDay(d) {
    const n = L.daysBetween(L.today(), d);
    if (n < 0) return 'Overdue · ' + -n + ' day' + (n === -1 ? '' : 's');
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n < 7) return fmtDay(d);
    return fmtDay(d);
  }

  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.className = 'show';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 2600);
  }

  // ---------------------------------------------------------------- domain actions
  const ruleOf = (t) => ({ every: t.every || 1, unit: t.unit || 'weeks', fromCompletion: t.fromCompletion !== false });

  function assigneeLabel(t) {
    if (t.assign === 'member') return t.assigneeId ? memberName(t.assigneeId) : 'Unassigned';
    if (t.assign === 'rotate') return t.assigneeId ? memberName(t.assigneeId) + "'s turn" : 'Takes turns';
    return 'Anyone';
  }
  function metaText(t) {
    const parts = [];
    if (t.repeat) parts.push('↻ ' + L.summary(ruleOf(t)));
    parts.push(assigneeLabel(t));
    return parts.join(' · ');
  }

  function logCompletion(t, outcome, daysLate) {
    const m = me();
    const c = { type: 'completion', id: uid(), taskId: t.id, taskTitle: t.title, at: Date.now(), day: L.today(),
      outcome, daysLate: daysLate || 0, memberId: m ? m.id : null, memberName: m ? m.name : 'Someone' };
    put(c);
    return c;
  }

  function markDone(t) {
    const day = L.today();
    const due = t.nextDue || day;
    const late = Math.max(0, L.daysBetween(due, day));
    const early = L.daysBetween(day, due) > 0;
    logCompletion(t, early ? 'early' : 'done', late);
    t.lastDone = day;
    if (t.repeat) {
      t.nextDue = L.nextAfterDone(due, day, ruleOf(t));
      if (t.assign === 'rotate') t.assigneeId = L.nextInRotation(members().map((m) => m.id), t.assigneeId);
    } else {
      t.archived = true;
    }
    if (t.kind === 'laundry') Object.assign(t, { basket: 0, stage: 0, washAt: null, dryAt: null, cycleBy: null });
    put(t);
  }

  function skipRound(t) {
    const prev = t.nextDue || L.today();
    const c = logCompletion(t, 'skipped', 0);
    t.nextDue = L.nextAfterSkip(prev, L.today(), ruleOf(t));
    put(t);
    ui.undo = { taskId: t.id, prevDue: prev, completionId: c.id };
  }

  function undoSkip() {
    const u = ui.undo; if (!u) return;
    const t = db.recs[u.taskId]; const c = db.recs[u.completionId];
    if (t) { t.nextDue = u.prevDue; put(t); }
    if (c) remove(c);
    ui.undo = null;
  }

  function advanceLaundry(t) {
    const now = Date.now();
    const stage = t.stage || 0;
    if (stage === 0) { Object.assign(t, { stage: 1, washAt: now, cycleBy: (me() || {}).name || 'Someone' }); put(t); }
    else if (stage === 1) { Object.assign(t, { stage: 2, dryAt: now }); put(t); }
    else { markDone(t); toast('Laundry done. Next one ' + fmtDay(t.nextDue)); ui.sheet = null; }
  }

  // ---------------------------------------------------------------- icons
  const ICON = {
    today: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    tasks: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    shop: '<path d="M3 4h2l2.4 11h10.2l2-8H6.5"/><circle cx="9" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/>',
    dates: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    home: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.6 0 4.5 1.8 4.5 4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M6 12.5l4 4 8-9"/>',
    washer: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="4.5"/><path d="M7.5 6.5h.01M10.5 6.5h3"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const icon = (n, size) => '<svg aria-hidden="true" width="' + (size || 22) + '" height="' + (size || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[n] + '</svg>';

  // ---------------------------------------------------------------- shared pieces
  function avatar(m, size) {
    const s = size || 36;
    return '<span class="avatar c' + ((m.color || 0) % 4) + '" style="width:' + s + 'px;height:' + s + 'px;font-size:' + Math.round(s * 0.42) + 'px" aria-hidden="true">' + esc((m.name || '?').slice(0, 1).toUpperCase()) + '</span>';
  }

  function taskRow(t) {
    const overdue = t.nextDue && t.nextDue < L.today();
    const left = t.kind === 'laundry'
      ? '<button class="check laundry" data-act="open-laundry" data-id="' + t.id + '" aria-label="Open laundry: ' + esc(t.title) + '">' + icon('washer') + '</button>'
      : '<button class="check" data-act="done" data-id="' + t.id + '" aria-label="Mark done: ' + esc(t.title) + '"><span class="ring"></span></button>';
    let extra = '';
    if (t.kind === 'laundry' && (t.stage || 0) > 0) extra = '<span class="pill green">' + ['', 'Washing', 'Drying'][t.stage] + '</span>';
    else if (t.kind === 'laundry' && t.basket === 3) extra = '<span class="pill green">Basket full</span>';
    else if (overdue) extra = '<span class="pill warm">Overdue</span>';
    return '<div class="row">' + left +
      '<button class="row-main" data-act="' + (t.kind === 'laundry' ? 'open-laundry' : 'open-task') + '" data-id="' + t.id + '">' +
      '<span class="row-title">' + esc(t.title) + '</span>' +
      '<span class="row-meta' + (overdue ? ' warm-text' : '') + '">' + esc(relDay(t.nextDue || L.today())) + ' · ' + esc(metaText(t)) + '</span></button>' +
      extra + '</div>';
  }

  function section(title, rows, empty) {
    if (!rows.length && !empty) return '';
    return '<h2 class="sec">' + esc(title) + '</h2><div class="stack">' + (rows.length ? rows.join('') : '<p class="empty">' + esc(empty) + '</p>') + '</div>';
  }

  function header(kicker, title, addAct) {
    return '<header class="top"><div><div class="kicker">' + esc(kicker) + '</div><h1>' + esc(title) + '</h1></div>' +
      (addAct ? '<button class="fab" data-act="' + addAct + '" aria-label="Add">' + icon('plus', 24) + '</button>' : '') + '</header>';
  }

  function segmented(name, options, value, id) {
    const idAttr = id ? ' data-id="' + esc(id) + '"' : '';
    return '<div class="seg" role="group">' + options.map(([v, label]) =>
      '<button class="' + (v === value ? 'on' : '') + '" data-act="' + name + '" data-v="' + v + '"' + idAttr + ' aria-pressed="' + (v === value) + '">' + esc(label) + '</button>').join('') + '</div>';
  }

  // ---------------------------------------------------------------- screens
  function viewToday() {
    const t0 = L.today();
    const ts = tasks();
    const overdue = ts.filter((t) => t.nextDue && t.nextDue < t0);
    const due = ts.filter((t) => t.nextDue === t0 || (t.kind === 'laundry' && t.nextDue > t0 && (t.basket === 3 || (t.stage || 0) > 0)));
    const toBuy = all('shop').filter((s) => !s.done).length;
    const soon = all('event').filter((e) => e.date >= t0 && L.daysBetween(t0, e.date) <= 30).sort((a, b) => a.date.localeCompare(b.date));
    const hello = me() ? 'Hi ' + me().name : '';
    let html = header(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + (hello ? ' · ' + hello : ''), 'Today', 'new-task');
    html += '<div class="stats"><div class="stat"><b>' + due.length + '</b><span>due today</span></div>' +
      '<div class="stat"><b class="' + (overdue.length ? 'warm-text' : '') + '">' + overdue.length + '</b><span>overdue</span></div>' +
      '<div class="stat"><b>' + toBuy + '</b><span>to buy</span></div></div>';
    html += section('Needs attention', overdue.map(taskRow));
    html += section('Due today', due.map(taskRow), 'Nothing due today.');
    const week = ts.filter((t) => t.nextDue > t0 && t.nextDue <= L.addDays(t0, 7) && !due.includes(t))
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    html += section('Later this week', week.map(taskRow));
    if (soon.length) {
      html += '<h2 class="sec">Coming up</h2><div class="stack">' + soon.map((e) => {
        const items = e.items || []; const done = items.filter((i) => i.done).length;
        const n = L.daysBetween(t0, e.date);
        return '<button class="event-card" data-act="open-event" data-id="' + e.id + '"><span class="kicker light">' + (n === 0 ? 'Today' : 'In ' + n + ' day' + (n === 1 ? '' : 's')) + ' · ' + esc(fmtDay(e.date)) + '</span>' +
          '<span class="event-title">' + esc(e.name) + '</span>' +
          (items.length ? '<span class="bar light"><span style="width:' + Math.round(100 * done / items.length) + '%"></span></span><span class="kicker light">' + done + ' of ' + items.length + ' prep tasks done</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    return html;
  }

  function viewTasks() {
    const t0 = L.today(); const weekEnd = L.addDays(t0, 7);
    const f = ui.taskFilter;
    const ts = tasks().filter((t) => f === 'all' || t.kind === f || (f === 'cleaning' && t.kind === 'laundry'))
      .sort((a, b) => (a.nextDue || '').localeCompare(b.nextDue || ''));
    let html = header('Cleaning, repairs & upkeep', 'Tasks', 'new-task');
    html += segmented('task-filter', [['all', 'All'], ['cleaning', 'Cleaning'], ['repair', 'Repairs'], ['seasonal', 'Seasonal']], f);
    const overdue = ts.filter((t) => t.nextDue < t0);
    const week = ts.filter((t) => t.nextDue >= t0 && t.nextDue <= weekEnd);
    const later = ts.filter((t) => t.nextDue > weekEnd);
    html += section('Overdue', overdue.map(taskRow));
    html += section('This week', week.map(taskRow));
    html += section('Later', later.map(taskRow));
    if (!ts.length) html += '<p class="empty">No tasks yet. Tap + to add one.</p>';
    return html;
  }

  const AISLES = ['Produce', 'Dairy', 'Pantry', 'Frozen', 'Household', 'Other'];
  function viewShop() {
    const isOrder = ui.shopMode === 'order';
    const items = all('shop').filter((s) => !!s.order === isOrder).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let html = header(all('shop').filter((s) => !s.done).length + ' items still to get', 'Shopping');
    html += segmented('shop-mode', [['grocery', 'Groceries'], ['order', 'To order']], ui.shopMode);
    html += '<form class="addbar" data-form="add-shop"><label class="sr" for="shop-title">Item</label>' +
      '<input id="shop-title" name="title" placeholder="' + (isOrder ? 'e.g. HVAC filter 20×25×1' : 'e.g. Tomatoes') + '" autocomplete="off" required>' +
      '<label class="sr" for="shop-qty">Quantity</label><input id="shop-qty" name="qty" placeholder="Qty" class="qty" autocomplete="off">' +
      (isOrder ? '' : '<label class="sr" for="shop-aisle">Aisle</label><select id="shop-aisle" name="aisle">' + AISLES.map((a) => '<option' + (a === (ui.lastAisle || 'Produce') ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>') +
      '<button class="fab small" aria-label="Add item">' + icon('plus', 20) + '</button></form>';
    const groups = isOrder ? [['To order', items]] : AISLES.map((a) => [a, items.filter((i) => (i.aisle || 'Other') === a)]);
    for (const [name, list] of groups) {
      if (!list.length) continue;
      html += '<h2 class="sec">' + esc(name) + '</h2><div class="stack">' + list.map((i) =>
        '<div class="row' + (i.done ? ' is-done' : '') + '"><button class="check" data-act="toggle-shop" data-id="' + i.id + '" aria-label="' + (i.done ? 'Mark not done: ' : 'Got it: ') + esc(i.title) + '">' +
        (i.done ? '<span class="ring filled">' + icon('check', 16) + '</span>' : '<span class="ring"></span>') + '</button>' +
        '<span class="row-main static"><span class="row-title">' + esc(i.title) + '</span>' + (i.qty ? '<span class="row-meta">' + esc(i.qty) + '</span>' : '') + '</span>' +
        '<button class="icon-btn" data-act="del-shop" data-id="' + i.id + '" aria-label="Delete ' + esc(i.title) + '">' + icon('close', 18) + '</button></div>').join('') + '</div>';
    }
    if (!items.length) html += '<p class="empty">' + (isOrder ? 'Things to order for the house go here.' : 'Your grocery list is empty.') + '</p>';
    if (items.some((i) => i.done)) html += '<button class="btn ghost" data-act="clear-shop">Clear checked items</button>';
    return html;
  }

  function viewDates() {
    const t0 = L.today();
    const evs = all('event').sort((a, b) => a.date.localeCompare(b.date));
    const up = evs.filter((e) => e.date >= t0), past = evs.filter((e) => e.date < t0).reverse().slice(0, 5);
    let html = header('Festivals, hosting & family dates', 'Dates', 'new-event');
    const card = (e) => {
      const d = L.parseDay(e.date); const items = e.items || []; const done = items.filter((i) => i.done).length;
      const n = L.daysBetween(t0, e.date);
      return '<button class="row date-row" data-act="open-event" data-id="' + e.id + '"><span class="datebox"><span>' + d.toLocaleDateString('en-US', { month: 'short' }) + '</span><b>' + d.getDate() + '</b></span>' +
        '<span class="row-main static"><span class="row-title">' + esc(e.name) + '</span><span class="row-meta">' + esc(e.kind || 'Festival') + ' · ' + (n >= 0 ? (n === 0 ? 'today' : 'in ' + n + ' day' + (n === 1 ? '' : 's')) : fmtDay(e.date)) + '</span></span>' +
        (items.length ? '<span class="pill green">' + done + ' of ' + items.length + '</span>' : '') + '</button>';
    };
    html += section('Upcoming', up.map(card), 'No dates yet. Add festivals, guests visiting or family events with +.');
    html += section('Recently', past.map(card));
    return html;
  }

  function viewHousehold() {
    const ms = members();
    const monthStart = L.today().slice(0, 8) + '01';
    const comps = all('completion').sort((a, b) => b.at - a.at);
    const count = (id) => comps.filter((c) => c.memberId === id && c.day >= monthStart && c.outcome !== 'skipped').length;
    let html = header('Everyone sees the same list', (db.household && db.household.name) || 'Household');
    html += '<h2 class="sec">Done this month</h2><div class="members">' + ms.map((m) =>
      '<div class="member">' + avatar(m, 44) + '<b>' + esc(m.name) + (m.id === db.meId ? ' (you)' : '') + '</b><span>' + count(m.id) + ' done</span></div>').join('') + '</div>';
    html += section('Recent activity', comps.slice(0, 25).map((c) => {
      const verb = c.outcome === 'skipped' ? 'skipped' : 'finished';
      const note = c.outcome === 'skipped' ? 'not needed yet' : c.outcome === 'early' ? 'early' : c.daysLate > 0 ? c.daysLate + ' day' + (c.daysLate === 1 ? '' : 's') + ' late' : 'on time';
      const m = db.recs[c.memberId] || { name: c.memberName, color: 0 };
      return '<div class="row act">' + avatar(m, 34) + '<span class="row-main static"><span class="row-title">' + esc(c.memberName) + ' <span class="normal">' + verb + ' ' + esc(c.taskTitle) + '</span></span>' +
        '<span class="row-meta">' + esc(new Date(c.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + ' · ' + note + '</span></span></div>';
    }), 'Completed tasks show up here.');

    html += '<h2 class="sec">Invite roommates</h2><div class="card">';
    if (syncOn()) {
      html += '<p>Send this link. They open it in Safari, pick their name, and then add it to their Home Screen.</p>' +
        '<div class="code">' + esc(inviteLink()) + '</div>' +
        '<div class="btn-row"><button class="btn" data-act="share-invite">Share invite link</button></div>' +
        '<p class="small">Anyone with this link can see and edit your household, so only send it to people who live with you.</p>';
    } else {
      html += '<p>Sharing is off: this copy has no Supabase project set up in <code>config.js</code>, so data stays on this phone only. The README explains the free setup.</p>';
    }
    html += '</div>';

    html += '<h2 class="sec">This device</h2><div class="card">' +
      '<p>You are <b>' + esc((me() || {}).name || 'not set') + '</b>. ' + syncLine() + '</p>' +
      '<div class="btn-row"><button class="btn ghost" data-act="switch-user">Switch person</button>' +
      (syncOn() ? '<button class="btn ghost" data-act="sync-now">Sync now</button>' : '') +
      '<button class="btn ghost" data-act="rename-household">Rename home</button>' +
      '<button class="btn ghost" data-act="export">Back up data</button></div>' +
      '<button class="btn danger-text" data-act="reset">Remove this household from this phone</button></div>';
    return html;
  }

  function syncLine() {
    if (!syncOn()) return 'Saved on this phone only.';
    if (syncState.ok === null) return 'Syncing…';
    if (!syncState.ok) return '<span class="warm-text">Sync problem: ' + esc(syncState.error) + '</span>';
    const pending = Object.keys(db.dirty).length;
    return 'Synced at ' + fmtTime(syncState.at) + (pending ? ' · ' + pending + ' change' + (pending === 1 ? '' : 's') + ' waiting' : '') + '.';
  }

  function inviteLink() {
    return location.origin + location.pathname + '#join=' + encodeURIComponent(db.household.id) + '&n=' + encodeURIComponent(db.household.name || '');
  }

  // ---------------------------------------------------------------- sheets
  function sheetTaskEditor(t) {
    const isNew = !t;
    t = t || { title: '', room: '', kind: 'cleaning', repeat: true, every: 3, unit: 'weeks', fromCompletion: true,
      nextDue: L.addDays(L.today(), 1), assign: 'anyone', assigneeId: db.meId };
    const ms = members();
    const opt = (v, label, cur) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    return '<form data-form="save-task" data-id="' + (isNew ? '' : t.id) + '">' +
      sheetHead(isNew ? 'New task' : 'Edit task') +
      '<div class="field"><label for="f-title">Task</label><input id="f-title" name="title" value="' + esc(t.title) + '" placeholder="e.g. Vacuum full home" required autocomplete="off"></div>' +
      '<div class="two"><div class="field"><label for="f-room">Room or area</label><input id="f-room" name="room" value="' + esc(t.room || '') + '" placeholder="Optional" autocomplete="off"></div>' +
      '<div class="field"><label for="f-kind">Type</label><select id="f-kind" name="kind">' +
      opt('cleaning', 'Cleaning', t.kind) + opt('laundry', 'Laundry', t.kind) + opt('repair', 'Repair', t.kind) + opt('seasonal', 'Seasonal', t.kind) + '</select></div></div>' +
      '<div class="field check-field"><input type="checkbox" id="f-repeat" name="repeat"' + (t.repeat ? ' checked' : '') + '><label for="f-repeat">Repeats</label></div>' +
      '<div class="repeat-box' + (t.repeat ? '' : ' hidden') + '">' +
      '<div class="chips">' + [[1, 'weeks', 'Weekly'], [2, 'weeks', 'Every 2 wks'], [3, 'weeks', 'Every 3 wks'], [1, 'months', 'Monthly']].map(([n, u, l]) =>
        '<button type="button" class="chip" data-act="preset" data-n="' + n + '" data-u="' + u + '">' + l + '</button>').join('') + '</div>' +
      '<div class="two"><div class="field"><label for="f-every">Every</label><input id="f-every" name="every" type="number" min="1" max="365" inputmode="numeric" value="' + (t.every || 1) + '"></div>' +
      '<div class="field"><label for="f-unit">Unit</label><select id="f-unit" name="unit">' + opt('days', 'Days', t.unit) + opt('weeks', 'Weeks', t.unit) + opt('months', 'Months', t.unit) + '</select></div></div>' +
      '<div class="field"><label for="f-from">Next date counts from</label><select id="f-from" name="fromCompletion">' +
      opt('yes', 'When it was actually done', t.fromCompletion !== false ? 'yes' : 'no') + opt('no', 'Fixed dates on the calendar', t.fromCompletion !== false ? 'yes' : 'no') + '</select></div>' +
      '</div>' +
      '<div class="field"><label for="f-due">' + (t.repeat ? 'First time' : 'Due') + '</label><input id="f-due" name="nextDue" type="date" value="' + esc(t.nextDue) + '" required></div>' +
      '<p class="preview" id="rule-preview"></p>' +
      '<div class="two"><div class="field"><label for="f-assign">Who does it</label><select id="f-assign" name="assign">' +
      opt('anyone', 'Anyone', t.assign) + opt('member', 'One person', t.assign) + opt('rotate', 'Take turns', t.assign) + '</select></div>' +
      '<div class="field"><label for="f-who">Person / starts with</label><select id="f-who" name="assigneeId">' + ms.map((m) => opt(m.id, m.name, t.assigneeId)).join('') + '</select></div></div>' +
      '<button class="btn primary wide">' + (isNew ? 'Save task' : 'Save changes') + '</button></form>';
  }

  function sheetHead(title) {
    return '<div class="sheet-head"><h2>' + esc(title) + '</h2><button type="button" class="icon-btn" data-act="close" aria-label="Close">' + icon('close') + '</button></div>';
  }

  function sheetTask(t) {
    const hist = all('completion').filter((c) => c.taskId === t.id).sort((a, b) => b.at - a.at).slice(0, 10);
    const undoHere = ui.undo && ui.undo.taskId === t.id;
    let html = sheetHead(t.title) + '<div class="card info">' +
      '<div><span>Next due</span><b>' + esc(relDay(t.nextDue)) + '</b></div>' +
      (t.repeat ? '<div><span>Repeats</span><b>' + esc(L.summary(ruleOf(t))) + '</b></div><div><span>Counted from</span><b>' + (t.fromCompletion !== false ? 'When it is done' : 'Fixed dates') + '</b></div>' : '') +
      '<div><span>Who</span><b>' + esc(assigneeLabel(t)) + '</b></div>' + (t.room ? '<div><span>Where</span><b>' + esc(t.room) + '</b></div>' : '') + '</div>';
    html += '<button class="btn primary wide" data-act="done" data-id="' + t.id + '">Mark done</button>';
    if (t.repeat) {
      if (undoHere) html += '<div class="note">Skipped. Back on ' + esc(fmtDay(t.nextDue)) + ', still ' + esc(assigneeLabel(t)) + '.</div><button class="btn ghost wide" data-act="undo-skip">Undo skip</button>';
      else html += '<button class="btn ghost wide" data-act="skip" data-id="' + t.id + '">Not needed yet · skip to ' + esc(fmtDay(L.nextAfterSkip(t.nextDue || L.today(), L.today(), ruleOf(t)))) + '</button>';
      html += '<p class="small">Skipping keeps the turn with the same person and is logged in the history.</p>';
    }
    html += '<h3 class="sec">History</h3>' + (hist.length ? '<div class="stack">' + hist.map((c) => '<div class="hist"><b>' + esc(c.memberName) + '</b> ' +
      (c.outcome === 'skipped' ? 'skipped' : c.outcome === 'early' ? 'did it early' : c.daysLate ? 'did it, ' + c.daysLate + ' day' + (c.daysLate === 1 ? '' : 's') + ' late' : 'did it') +
      ' · ' + esc(fmtDay(c.day)) + '</div>').join('') + '</div>' : '<p class="empty">Nothing logged yet.</p>');
    html += '<div class="btn-row"><button class="btn ghost" data-act="edit-task" data-id="' + t.id + '">Edit</button><button class="btn danger-text" data-act="del-task" data-id="' + t.id + '">Delete</button></div>';
    return html;
  }

  function sheetLaundry(t) {
    const stage = t.stage || 0;
    const level = t.basket || 0;
    const nextCycle = t.repeat ? L.nextAfterSkip(t.nextDue || L.today(), L.today(), ruleOf(t)) : null;
    const planned = fmtDay(t.nextDue || L.today());
    let html = sheetHead(t.title) + '<p class="small">' + esc(relDay(t.nextDue || L.today())) + ' · ' + esc(metaText(t)) + '</p>';

    if (stage === 0) {
      html += '<div class="card"><h3>How full is the laundry basket?</h3>' +
        '<div class="gauge" aria-hidden="true">' + [0, 1, 2, 3].map((i) => '<span class="' + (i < [0, 2, 3, 4][level] ? 'on' : '') + '"></span>').join('') + '</div>' +
        segmented('basket', L.BASKET.map((b, i) => [String(i), b]), String(level), t.id) + '</div>';
      const undoHere = ui.undo && ui.undo.taskId === t.id;
      if (undoHere) {
        html += '<div class="note">Skipped this round. Next laundry day is ' + esc(fmtDay(t.nextDue)) + ' and it stays ' + esc(assigneeLabel(t)) + '.</div><button class="btn ghost wide" data-act="undo-skip">Undo skip</button>';
      } else {
        const adv = L.basketAdvice(level);
        const copy = {
          0: ['Not needed yet', 'The basket is nearly empty, so a wash now would waste a load. Skip and it comes back next cycle.'],
          1: ['Not full enough yet', 'About half a basket. Skip this round and it comes back ' + (nextCycle ? fmtDay(nextCycle) : 'next cycle') + ', or do it anyway.'],
          2: ['Almost there', 'You could wait for ' + planned + ', or start a load now and clear the basket early.'],
          3: ['The basket is full', 'No need to wait for ' + planned + '. Doing it now starts the next cycle from today.'],
        }[level];
        html += '<div class="note"><b>' + copy[0] + '</b><br>' + esc(copy[1]) + '</div>';
        if (adv === 'skip' && t.repeat) html += '<button class="btn primary wide" data-act="skip" data-id="' + t.id + '">Skip this round · back ' + esc(fmtDay(nextCycle)) + '</button><button class="btn ghost wide" data-act="laundry-next" data-id="' + t.id + '">Do it anyway</button>';
        else if (adv === 'either') html += '<button class="btn primary wide" data-act="close">Keep it on ' + esc(planned) + '</button><button class="btn ghost wide" data-act="laundry-next" data-id="' + t.id + '">Start now instead</button>';
        else html += '<button class="btn primary wide" data-act="laundry-next" data-id="' + t.id + '">Put to wash now</button>';
      }
      html += '<p class="small">Anyone who sees the basket is full can mark it here. Laundry then shows on everyone\'s Today list, even before the planned day.</p>';
    }

    // The three steps
    const now = Date.now();
    const washEnd = t.washAt ? t.washAt + (t.washMin || 45) * 60000 : null;
    const dryEnd = t.dryAt ? t.dryAt + (t.dryMin || 60) * 60000 : null;
    const remain = (end) => { const m = Math.round((end - now) / 60000); return m > 0 ? 'in ' + m + ' min' : 'should be done now'; };
    const steps = [
      ['Put to wash', stage > 0 ? 'Started ' + fmtTime(t.washAt) + ' by ' + esc(t.cycleBy || 'someone') : 'Start the load, then tap below.'],
      ['Put to dry', stage > 1 ? 'Moved ' + fmtTime(t.dryAt) : stage === 1 ? 'Washer finishes about ' + fmtTime(washEnd) + ' · ' + remain(washEnd) : 'After the wash.'],
      ['Clothes folded', stage === 2 ? 'Dryer finishes about ' + fmtTime(dryEnd) + ' · ' + remain(dryEnd) : 'After drying.'],
    ];
    if (stage > 0) {
      html += '<div class="steps">' + steps.map(([title, detail], i) =>
        '<div class="step ' + (stage > i ? 'done' : stage === i ? 'active' : '') + '"><span class="dot">' + (stage > i ? icon('check', 16) : '') + '</span><div><b>' + title + '</b><span>' + detail + '</span></div></div>').join('') + '</div>';
      if (stage === 1) {
        html += '<div class="card"><h3>Dry cycle length</h3><div class="chips">' + [40, 60, 80].map((m) =>
          '<button class="chip' + ((t.dryMin || 60) === m ? ' on' : '') + '" data-act="dry-min" data-id="' + t.id + '" data-v="' + m + '">' + m + ' min</button>').join('') + '</div></div>';
      }
      html += '<button class="btn primary wide" data-act="laundry-next" data-id="' + t.id + '">' + (stage === 1 ? 'Put to dry now' : 'Clothes are folded') + '</button>';
      html += '<p class="small">The countdown is shared, so roommates can see where the load is. iPhone web apps cannot ring an alarm when it ends, so also say “Hey Siri, set a timer for ' + (stage === 1 ? (t.washMin || 45) : (t.dryMin || 60)) + ' minutes.”</p>';
      html += '<button class="btn danger-text" data-act="laundry-cancel" data-id="' + t.id + '">Cancel this load</button>';
    } else {
      html += '<div class="card"><h3>Wash cycle length</h3><div class="chips">' + [30, 45, 60, 90].map((m) =>
        '<button class="chip' + ((t.washMin || 45) === m ? ' on' : '') + '" data-act="wash-min" data-id="' + t.id + '" data-v="' + m + '">' + m + ' min</button>').join('') + '</div></div>';
    }
    html += '<div class="btn-row"><button class="btn ghost" data-act="edit-task" data-id="' + t.id + '">Edit schedule</button><button class="btn ghost" data-act="open-task" data-id="' + t.id + '">History</button></div>';
    return html;
  }

  function sheetEventEditor() {
    return '<form data-form="save-event">' + sheetHead('New date') +
      '<div class="field"><label for="e-name">What</label><input id="e-name" name="name" placeholder="e.g. Diwali, parents visiting, Thanksgiving dinner" required autocomplete="off"></div>' +
      '<div class="two"><div class="field"><label for="e-date">Date</label><input id="e-date" name="date" type="date" value="' + L.addDays(L.today(), 14) + '" required></div>' +
      '<div class="field"><label for="e-kind">Type</label><select id="e-kind" name="kind"><option>Festival</option><option>Hosting</option><option>Family</option><option>Other</option></select></div></div>' +
      '<div class="field"><label for="e-items">Prep list (one per line, optional)</label><textarea id="e-items" name="items" rows="5" placeholder="Deep clean kitchen&#10;Buy flowers and diyas&#10;Set up guest bed"></textarea></div>' +
      '<button class="btn primary wide">Save</button></form>';
  }

  function sheetEvent(e) {
    const items = e.items || [];
    const n = L.daysBetween(L.today(), e.date);
    return sheetHead(e.name) + '<p class="small">' + esc(e.kind || 'Festival') + ' · ' + esc(fmtDay(e.date)) + ' · ' + (n > 0 ? 'in ' + n + ' days' : n === 0 ? 'today' : -n + ' days ago') + '</p>' +
      '<h3 class="sec">Prep list</h3><div class="stack">' + (items.length ? items.map((it, i) =>
        '<div class="row' + (it.done ? ' is-done' : '') + '"><button class="check" data-act="toggle-item" data-id="' + e.id + '" data-i="' + i + '" aria-label="' + (it.done ? 'Mark not done: ' : 'Mark done: ') + esc(it.text) + '">' +
        (it.done ? '<span class="ring filled">' + icon('check', 16) + '</span>' : '<span class="ring"></span>') + '</button><span class="row-main static"><span class="row-title">' + esc(it.text) + '</span>' +
        (it.by ? '<span class="row-meta">Done by ' + esc(it.by) + '</span>' : '') + '</span>' +
        '<button class="icon-btn" data-act="del-item" data-id="' + e.id + '" data-i="' + i + '" aria-label="Delete ' + esc(it.text) + '">' + icon('close', 18) + '</button></div>').join('') : '<p class="empty">No prep items yet.</p>') + '</div>' +
      '<form class="addbar" data-form="add-item" data-id="' + e.id + '"><label class="sr" for="item-text">New prep item</label><input id="item-text" name="text" placeholder="Add a prep item" required autocomplete="off"><button class="fab small" aria-label="Add prep item">' + icon('plus', 20) + '</button></form>' +
      '<button class="btn danger-text" data-act="del-event" data-id="' + e.id + '">Delete this date</button>';
  }

  // ---------------------------------------------------------------- setup screens
  function viewSetup() {
    const join = parseJoin();
    if (join) {
      return '<div class="setup"><h1>Join ' + esc(join.name || 'a household') + '</h1>' +
        (CFG.supabaseUrl ? '<p>You were invited to share a home list. Joining downloads it to this phone.</p><button class="btn primary wide" data-act="join">Join household</button>'
          : '<p class="warm-text">This copy of the app has no sync set up, so it cannot join. Ask whoever sent the link to check config.js.</p>') + '</div>';
    }
    return '<div class="setup"><div class="logo">' + icon('today', 40) + '</div><h1>Homebase</h1><p>Chores, laundry, shopping and dates for a shared home.</p>' +
      '<form data-form="create"><div class="field"><label for="s-home">Name your home</label><input id="s-home" name="home" value="Our home" required></div>' +
      '<div class="field"><label for="s-name">Your name</label><input id="s-name" name="name" required autocomplete="given-name"></div>' +
      '<div class="field check-field"><input type="checkbox" id="s-starters" name="starters" checked><label for="s-starters">Add starter tasks (laundry, vacuum, patio, HVAC filter, bedsheets)</label></div>' +
      '<button class="btn primary wide">Create household</button></form>' +
      '<p class="small">' + (CFG.supabaseUrl ? 'Roommates join with a link from the Household tab.' : 'Sync is not set up yet, so this works on one phone. Add your free Supabase details to config.js to share with roommates.') + '</p>' +
      (CFG.supabaseUrl ? '<h2 class="sec">Got an invite from a roommate?</h2><form class="addbar" data-form="paste-invite"><label class="sr" for="s-invite">Invite link</label>' +
        '<input id="s-invite" name="invite" placeholder="Paste the invite link" required autocomplete="off"><button class="btn primary">Join</button></form>' : '') + '</div>';
  }

  function viewPickMember() {
    const ms = members();
    return '<div class="setup"><h1>Who are you?</h1><p>In ' + esc((db.household && db.household.name) || 'this home') + '</p>' +
      (ms.length ? '<div class="stack">' + ms.map((m) => '<button class="row" data-act="pick-me" data-id="' + m.id + '">' + avatar(m) + '<span class="row-main static"><span class="row-title">' + esc(m.name) + '</span></span></button>').join('') + '</div>'
        : '<p class="small">' + (syncOn() ? 'Loading the household… if nobody shows up, check your connection.' : '') + '</p>') +
      '<h2 class="sec">I\'m new here</h2><form class="addbar" data-form="add-me"><label class="sr" for="me-name">Your name</label><input id="me-name" name="name" placeholder="Your name" required autocomplete="given-name"><button class="btn primary">Join</button></form></div>';
  }

  function parseJoin() {
    const m = location.hash.match(/join=([^&]+)(?:&n=([^&]*))?/);
    return m ? { id: decodeURIComponent(m[1]), name: decodeURIComponent(m[2] || '') } : null;
  }

  function createHousehold(home, name, starters) {
    db = blankDb();
    db.household = { id: newCode(), name: home };
    put({ type: 'household', id: 'household', name: home });
    const m = { type: 'member', id: uid(), name, color: 0, createdAt: Date.now() };
    put(m); db.meId = m.id;
    if (starters) {
      const add = (title, kind, room, every, unit, inDays) => put({ type: 'task', id: uid(), title, kind, room, repeat: true, every, unit,
        fromCompletion: true, nextDue: L.addDays(L.today(), inDays), assign: 'rotate', assigneeId: m.id, createdAt: Date.now() });
      add('Do laundry', 'laundry', 'Laundry', 1, 'weeks', 3);
      add('Vacuum full home', 'cleaning', 'Whole home', 3, 'weeks', 1);
      add('Wash bedsheets', 'cleaning', 'Bedrooms', 2, 'weeks', 4);
      add('Clean patio', 'cleaning', 'Patio', 3, 'weeks', 6);
      add('Replace HVAC filter', 'seasonal', 'Whole home', 3, 'months', 30);
    }
    save();
  }

  // ---------------------------------------------------------------- render
  let pendingRender = false;
  function renderSoon() {
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pendingRender = true; return; }
    render();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) { pendingRender = false; renderSoon(); } }, 50));

  function render() {
    let main, tabs = true;
    if (!db.household) { main = viewSetup(); tabs = false; }
    else if (!me()) { main = viewPickMember(); tabs = false; }
    else main = { today: viewToday, tasks: viewTasks, shop: viewShop, dates: viewDates, home: viewHousehold }[ui.tab]();

    let sheet = '';
    if (ui.sheet) {
      const s = ui.sheet, rec = s.id ? db.recs[s.id] : null;
      let body = '';
      if (s.kind === 'task-edit') body = sheetTaskEditor(rec);
      else if (s.kind === 'task' && rec && !rec.deleted) body = sheetTask(rec);
      else if (s.kind === 'laundry' && rec && !rec.deleted) body = sheetLaundry(rec);
      else if (s.kind === 'event-edit') body = sheetEventEditor();
      else if (s.kind === 'event' && rec && !rec.deleted) body = sheetEvent(rec);
      if (body) sheet = '<div class="scrim" data-act="close"></div><section class="sheet" role="dialog" aria-modal="true">' + body + '</section>';
      else ui.sheet = null;
    }
    const scrollY = window.scrollY;
    const sheetEl = document.querySelector('.sheet'); const sheetScroll = sheetEl ? sheetEl.scrollTop : 0;
    $app.innerHTML = '<main class="content">' + main + '</main>' + (tabs ? tabBar() : '') + sheet;
    window.scrollTo(0, scrollY);
    const newSheet = document.querySelector('.sheet'); if (newSheet) newSheet.scrollTop = sheetScroll;
    document.body.classList.toggle('has-sheet', !!sheet);
    if (ui.sheet && ui.sheet.kind === 'task-edit') updatePreview();
  }

  function tabBar() {
    const items = [['today', 'Today'], ['tasks', 'Tasks'], ['shop', 'Shop'], ['dates', 'Dates'], ['home', 'Household']];
    return '<nav class="tabs" aria-label="Main">' + items.map(([k, label]) =>
      '<button class="' + (ui.tab === k ? 'on' : '') + '" data-act="tab" data-v="' + k + '"' + (ui.tab === k ? ' aria-current="page"' : '') + '><span class="tab-icon">' + icon(k) + '</span>' + label + '</button>').join('') + '</nav>';
  }

  function updatePreview() {
    const f = document.querySelector('[data-form="save-task"]'); if (!f) return;
    const repeat = f.repeat.checked;
    f.querySelector('.repeat-box').classList.toggle('hidden', !repeat);
    const p = document.getElementById('rule-preview');
    if (!repeat || !f.nextDue.value) { p.textContent = ''; return; }
    const rule = { every: +f.every.value || 1, unit: f.unit.value };
    const d = [f.nextDue.value]; for (let i = 0; i < 3; i++) d.push(L.advance(d[i], rule));
    p.textContent = L.summary(rule) + '. First ' + fmtDay(d[0]) + ', then ' + d.slice(1).map(fmtDay).join(', ') + '…';
    document.querySelectorAll('[data-act="preset"]').forEach((b) => b.classList.toggle('on', +b.dataset.n === rule.every && b.dataset.u === rule.unit));
  }

  // ---------------------------------------------------------------- events
  $app.addEventListener('input', (e) => { if (e.target.closest('[data-form="save-task"]')) updatePreview(); });
  $app.addEventListener('change', (e) => { if (e.target.closest('[data-form="save-task"]')) updatePreview(); });

  $app.addEventListener('click', (e) => { onClick(e).catch((err) => { console.error(err); toast('Something went wrong: ' + err.message); }); });
  async function onClick(e) {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, id = el.dataset.id, rec = id ? db.recs[id] : null;
    switch (act) {
      case 'tab': ui.tab = el.dataset.v; ui.sheet = null; window.scrollTo(0, 0); break;
      case 'close': ui.sheet = null; ui.undo = null; break;
      case 'new-task': ui.sheet = { kind: 'task-edit' }; break;
      case 'edit-task': ui.sheet = { kind: 'task-edit', id }; break;
      case 'open-task': ui.sheet = { kind: 'task', id }; ui.undo = null; break;
      case 'open-laundry': ui.sheet = { kind: 'laundry', id }; ui.undo = null; break;
      case 'done': markDone(rec); toast(rec.repeat ? 'Done. Next one ' + fmtDay(rec.nextDue) : 'Done'); ui.sheet = null; break;
      case 'skip': skipRound(rec); toast('Skipped to ' + fmtDay(rec.nextDue)); break;
      case 'undo-skip': undoSkip(); toast('Skip undone'); break;
      case 'del-task': if (confirm('Delete "' + rec.title + '"? Its history stays.')) { remove(rec); ui.sheet = null; } else return; break;
      case 'task-filter': ui.taskFilter = el.dataset.v; break;
      case 'preset': {
        const f = el.closest('form'); f.every.value = el.dataset.n; f.unit.value = el.dataset.u; updatePreview(); return;
      }
      case 'basket': rec.basket = +el.dataset.v; put(rec); ui.undo = null; break;
      case 'wash-min': rec.washMin = +el.dataset.v; put(rec); break;
      case 'dry-min': rec.dryMin = +el.dataset.v; put(rec); break;
      case 'laundry-next': advanceLaundry(rec); break;
      case 'laundry-cancel': Object.assign(rec, { stage: 0, washAt: null, dryAt: null, cycleBy: null }); put(rec); break;
      case 'shop-mode': ui.shopMode = el.dataset.v; break;
      case 'toggle-shop': rec.done = !rec.done; put(rec); break;
      case 'del-shop': remove(rec); break;
      case 'clear-shop': all('shop').filter((s) => s.done && !!s.order === (ui.shopMode === 'order')).forEach(remove); break;
      case 'new-event': ui.sheet = { kind: 'event-edit' }; break;
      case 'open-event': ui.sheet = { kind: 'event', id }; break;
      case 'toggle-item': { const it = rec.items[+el.dataset.i]; it.done = !it.done; it.by = it.done ? (me() || {}).name : null; put(rec); break; }
      case 'del-item': rec.items.splice(+el.dataset.i, 1); put(rec); break;
      case 'del-event': if (confirm('Delete "' + rec.name + '"?')) { remove(rec); ui.sheet = null; } else return; break;
      case 'pick-me': db.meId = id; save(); history.replaceState(null, '', location.pathname); break;
      case 'switch-user': db.meId = null; save(); break;
      case 'sync-now': await sync(); toast(syncState.ok ? 'Synced' : 'Sync failed'); break;
      case 'rename-household': {
        const name = prompt('Name of your home', db.household.name || ''); if (!name) return;
        db.household.name = name.trim(); put({ type: 'household', id: 'household', name: db.household.name }); break;
      }
      case 'share-invite': {
        const link = inviteLink();
        try {
          if (navigator.share) await navigator.share({ title: 'Join our Homebase', text: 'Our shared home list:', url: link });
          else { await navigator.clipboard.writeText(link); toast('Link copied'); }
        } catch (err) { /* share sheet dismissed */ }
        return;
      }
      case 'export': {
        const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'homebase-backup-' + L.today() + '.json'; a.click();
        return;
      }
      case 'reset':
        if (!confirm(syncOn() ? 'Remove the household from this phone? Your roommates keep it, and you can rejoin with the invite link.' : 'Delete everything on this phone? Sync is off, so this cannot be undone.')) return;
        db = blankDb(); save(); ui.tab = 'today'; ui.sheet = null; break;
      case 'join': {
        const j = parseJoin();
        db = blankDb(); db.household = { id: j.id, name: j.name }; save();
        render(); await sync();
        if (!syncState.ok) toast('Could not reach the household. Check your connection.');
        break;
      }
      default: return;
    }
    render();
  }

  $app.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, kind = f.dataset.form, v = Object.fromEntries(new FormData(f));
    const text = (s) => String(s || '').trim();
    if (kind === 'create') { createHousehold(text(v.home) || 'Our home', text(v.name), !!v.starters); ui.tab = 'today'; }
    else if (kind === 'paste-invite') {
      const m = text(v.invite).match(/join=([^&\s]+)(?:&n=([^&\s]*))?/);
      const code = m ? m[1] : text(v.invite);
      if (!/^[a-z0-9%]{16,}$/i.test(code)) { toast('That does not look like an invite link'); return; }
      location.hash = 'join=' + code + (m && m[2] ? '&n=' + m[2] : '');
      return;
    } else if (kind === 'add-me') {
      const m = { type: 'member', id: uid(), name: text(v.name), color: members().length % 4, createdAt: Date.now() };
      put(m); db.meId = m.id; save(); history.replaceState(null, '', location.pathname);
    } else if (kind === 'save-task') {
      const existing = f.dataset.id ? db.recs[f.dataset.id] : null;
      const t = existing || { type: 'task', id: uid(), createdAt: Date.now() };
      Object.assign(t, { title: text(v.title), room: text(v.room), kind: v.kind, repeat: !!v.repeat,
        every: Math.max(1, Math.min(365, parseInt(v.every, 10) || 1)), unit: v.unit, fromCompletion: v.fromCompletion !== 'no',
        nextDue: v.nextDue, assign: v.assign, assigneeId: v.assign === 'anyone' ? null : v.assigneeId });
      put(t); ui.sheet = null; toast(existing ? 'Saved' : 'Task added');
    } else if (kind === 'add-shop') {
      const order = ui.shopMode === 'order';
      if (!order) ui.lastAisle = v.aisle;
      put({ type: 'shop', id: uid(), title: text(v.title), qty: text(v.qty), aisle: order ? null : v.aisle, order, done: false, createdAt: Date.now() });
      render(); const input = document.getElementById('shop-title'); if (input) input.focus(); return;
    } else if (kind === 'save-event') {
      const items = text(v.items).split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t, done: false }));
      const ev = { type: 'event', id: uid(), name: text(v.name), date: v.date, kind: v.kind, items, createdAt: Date.now() };
      put(ev); ui.sheet = { kind: 'event', id: ev.id };
    } else if (kind === 'add-item') {
      const ev = db.recs[f.dataset.id]; (ev.items = ev.items || []).push({ text: text(v.text), done: false }); put(ev);
      render(); const input = document.getElementById('item-text'); if (input) input.focus(); return;
    }
    render();
  });

  // Keep laundry countdowns fresh while open.
  setInterval(() => { if (ui.sheet && ui.sheet.kind === 'laundry') renderSoon(); }, 30000);
  window.addEventListener('hashchange', render);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // A join link opened on a phone that already belongs to another household: ask first.
  const j = parseJoin();
  if (j && db.household && db.household.id !== j.id) {
    if (confirm('Leave "' + (db.household.name || 'your current household') + '" on this phone and join "' + (j.name || 'the invited household') + '"?')) db = blankDb();
    else history.replaceState(null, '', location.pathname);
  } else if (j && db.household && db.household.id === j.id) history.replaceState(null, '', location.pathname);

  render();
  sync();
  window.__hb = { db: () => db, sync, render }; // for debugging from the console
})();
