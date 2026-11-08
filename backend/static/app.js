/* ClientMap · Personal Projects — single-page app (no build step) */
'use strict';

// ------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let CFG = null, ME = null, cleanup = null;

const COMPANY = {
  name: 'Thangam Info tech',
  address: ['5/97/322,Maasakthi Nagar,', 'Serayam palayam,Vellanai patti village,', 'SS kulam block,Coimbatore-641048'],
  mobiles: '9843998950 / 7908908367',
  site: 'https://www.thangaminfotech.com/',
};
const CAT = {
  pharmacy: { label: 'Pharmacy', color: '#16a34a' },
  clinic: { label: 'Clinic', color: '#2563eb' },
  lab: { label: 'Lab', color: '#9333ea' },
};
const VISIT_STATUSES = ['Visited', 'Follow-up', 'Interested', 'Demo given', 'Converted', 'Not interested', 'Closed'];
const CLOSED = ['Converted', 'Not interested', 'Closed'];

let ROUTE_SEQ = 0;
async function api(method, url, body) {
  const seq = ROUTE_SEQ;
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('Please sign in again'); }
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    let d = data && data.detail;
    if (Array.isArray(d)) d = d.map(x => `${(x.loc || []).slice(-1)[0]}: ${x.msg}`).join(', ');
    throw new Error(d || `Request failed (${r.status})`);
  }
  // a page load that finished after the user navigated elsewhere must not render
  if (method === 'GET' && seq !== ROUTE_SEQ) throw Object.assign(new Error('stale'), { stale: true });
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 2800);
}
function modal(html) {
  $('#modalCard').innerHTML = html; $('#modal').hidden = false;
  const f = $('#modalCard input,#modalCard textarea,#modalCard select'); if (f) setTimeout(() => f.focus(), 30);
  return $('#modalCard');
}
function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
function confirmBox(msg, okLabel = 'Delete') {
  return new Promise(res => {
    const c = modal(`<h3>Please confirm</h3><p>${esc(msg)}</p><div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button></div>`);
    c.querySelector('[data-x]').onclick = () => { closeModal(); res(false); };
    c.querySelector('[data-ok]').onclick = () => { closeModal(); res(true); };
  });
}
function promptBox(title, value = '', label = 'Name') {
  return new Promise(res => {
    const c = modal(`<h3>${esc(title)}</h3><form><label>${esc(label)}<input name="v" value="${esc(value)}" required></label>
      <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">OK</button></div></form>`);
    c.querySelector('[data-x]').onclick = () => { closeModal(); res(null); };
    c.querySelector('form').onsubmit = e => { e.preventDefault(); const v = e.target.v.value.trim(); closeModal(); res(v || null); };
  });
}
const title = t => { document.title = `${t} · Personal Projects`; };
const money = n => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseISO = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = s => { if (!s) return ''; const d = parseISO(s); return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtShort = d => `${DAY[d.getDay()]} ${pad(d.getDate())} ${MON[d.getMonth()]}`;
const km = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
function hashColor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 55% 42%)`; }
function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

// ------------------------------------------------------------ auth / shell
function showLogin() { $('#shell').hidden = true; $('#login').hidden = false; }
async function boot() {
  try {
    ME = await api('GET', '/api/auth/me');
    CFG = await api('GET', '/api/config');
  } catch { showLogin(); return; }
  $('#login').hidden = true; $('#shell').hidden = false;
  const nm = ME.username, ini = (nm.trim()[0] || 'U').toUpperCase();
  ['#userName', '#userName2'].forEach(s => $(s).textContent = nm);
  ['#avatar', '#avatar2'].forEach(s => $(s).textContent = ini);
  NAV.setUser(nm);
  router();
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target; $('#loginErr').textContent = '';
  try {
    await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
    f.password.value = ''; boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
const userPop = $('#userPop'), userBtn = $('#userBtn');
const setPop = open => { userPop.hidden = !open; userBtn.setAttribute('aria-expanded', open); };
userBtn.addEventListener('click', e => { e.stopPropagation(); setPop(userPop.hidden); });
document.addEventListener('click', e => { if (!userPop.hidden && !userPop.contains(e.target)) setPop(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setPop(false); });
$$('[data-logout]').forEach(b => b.addEventListener('click', async () => {
  if (!await confirmBox('Do you want to logout?', 'Logout')) return;
  setPop(false); closeDrawer();
  await api('POST', '/api/auth/logout').catch(() => {});
  location.hash = '#/'; showLogin();
}));
const closeDrawer = () => NAV.close();

const ROUTES = {
  '': dashboard, projects, customers, share, route: routeView, visits, visit: visitForm,
  followups, invoice: invoiceView, invoices, password: passwordView,
};
async function router() {
  if ($('#shell').hidden) return;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = ROUTES[parts[0]] ? parts[0] : '';
  closeDrawer(); closeModal(); setPop(false);
  view.innerHTML = '<div class="empty">Loading…</div>';
  window.scrollTo(0, 0);
  const mine = ++ROUTE_SEQ;
  try { await ROUTES[name](...parts.slice(1)); }
  catch (e) { if (!e.stale && mine === ROUTE_SEQ) view.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', router);

// ------------------------------------------------------------ dashboard
function projCard(p) {
  const host = hostOf(p.websiteUrl);
  const icon = `<div class="pc-icon" style="background:${hashColor(p.name)}">${esc(p.name.trim()[0] || '?').toUpperCase()}${host ? `<img alt="" loading="lazy" src="https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}" onerror="this.remove()">` : ''}</div>`;
  return `<div class="proj-card">
    <div class="pc-row">${icon}<div class="pc-name" title="${esc(p.name)}">${esc(p.name)}</div></div>
    <div>${p.websiteUrl ? `<a class="pc-link" href="${esc(p.websiteUrl)}" target="_blank" rel="noopener">${esc(p.websiteUrl.replace(/^https?:\/\//, ''))}</a>` : '<span class="pc-link muted">No website</span>'}</div>
    <div class="pc-row pc-att">${p.hasAttachment
      ? `<span title="${esc(p.attachmentName)}">${esc(p.attachmentName)}</span><button class="att-btn" data-open="${p.id}" title="Open attachment" aria-label="Open attachment">&#128206;</button>`
      : '<span class="muted">No attachment</span>'}</div>
  </div>`;
}
function bindAttachments(root) {
  $$('[data-open]', root).forEach(b => b.onclick = () => window.open(`/api/projects/${b.dataset.open}/attachment`, '_blank', 'noopener'));
}
async function dashboard() {
  title('Dashboard');
  const ps = await api('GET', '/api/projects');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">My Projects (${ps.length})</h2><a class="btn primary" href="#/projects">+ Add project</a></div>
    ${ps.length ? `<div class="proj-grid">${ps.map(projCard).join('')}</div>` : '<div class="card empty">No projects yet. Add one from Project Master.</div>'}`;
  bindAttachments(view);
}

// ------------------------------------------------------------ project master
async function projects() {
  title('Project Master');
  const ps = await api('GET', '/api/projects');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">Project Master</h2><button class="btn primary" id="add">+ Add project</button></div>
  <div class="card table-wrap" style="padding:0">${ps.length ? `<table class="list stack"><thead><tr><th>Project</th><th>Website</th><th>Attachment</th><th></th></tr></thead><tbody>
  ${ps.map(p => `<tr><td data-l="Project"><b>${esc(p.name)}</b></td>
    <td data-l="Website">${p.websiteUrl ? `<a href="${esc(p.websiteUrl)}" target="_blank" rel="noopener">${esc(p.websiteUrl)}</a>` : '<span class="muted">—</span>'}</td>
    <td data-l="Attachment">${p.hasAttachment ? `<a href="#" data-open="${p.id}">&#128206; ${esc(p.attachmentName)}</a>` : '<span class="muted">—</span>'}</td>
    <td class="actions"><div class="row-actions"><button class="btn sm" data-edit="${p.id}">Edit</button><button class="btn sm danger" data-del="${p.id}">Delete</button></div></td></tr>`).join('')}
  </tbody></table>` : '<div class="empty">No projects yet.</div>'}</div>`;
  $$('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); window.open(`/api/projects/${a.dataset.open}/attachment`, '_blank', 'noopener'); });
  $('#add').onclick = () => projectForm();
  $$('[data-edit]').forEach(b => b.onclick = () => projectForm(ps.find(p => p.id == b.dataset.edit)));
  $$('[data-del]').forEach(b => b.onclick = async () => {
    const p = ps.find(x => x.id == b.dataset.del);
    if (!await confirmBox(`Delete project "${p.name}" and its attachment?`)) return;
    try { await api('DELETE', `/api/projects/${p.id}`); toast('Project deleted'); projects(); } catch (e) { toast(e.message, true); }
  });
}
function projectForm(p) {
  const c = modal(`<h3>${p ? 'Edit project' : 'Add project'}</h3>
  <form class="grid">
    <label>Project name *<input name="name" required value="${esc(p?.name)}"></label>
    <label>Website URL<input name="websiteUrl" inputmode="url" placeholder="https://" value="${esc(p?.websiteUrl)}"></label>
    ${p?.hasAttachment ? `<div class="chip">&#128206; ${esc(p.attachmentName)}</div>
      <label style="display:flex;gap:.5rem;align-items:center;font-weight:500"><input type="checkbox" name="removeAttachment"> Remove current attachment</label>` : ''}
    <label>${p?.hasAttachment ? 'Replace attachment' : 'Attachment (optional, e.g. demo PPT)'}<input type="file" name="file"></label>
    <p class="muted" style="margin:0;font-size:.82rem">Attachments are private. They are only shared through 24-hour links from Project Share.</p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div>
  </form>`);
  c.querySelector('[data-x]').onclick = closeModal;
  c.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, fd = new FormData();
    fd.append('name', f.name.value); fd.append('websiteUrl', f.websiteUrl.value);
    if (f.file.files[0]) fd.append('file', f.file.files[0]);
    if (f.removeAttachment?.checked) fd.append('removeAttachment', '1');
    const btn = f.querySelector('.primary'); btn.disabled = true; btn.textContent = 'Saving…';
    try { await api(p ? 'PUT' : 'POST', p ? `/api/projects/${p.id}` : '/api/projects', fd); closeModal(); toast('Project saved'); projects(); }
    catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Save'; }
  };
}

// ------------------------------------------------------------ customer master
// End date for a contract of `months` starting on `start` (yyyy-mm-dd): 01-01 + 12 months → 31-12.
function endAfterMonths(start, months) {
  const s = parseISO(start);
  const day = s.getDate(), e = new Date(s.getFullYear(), s.getMonth() + months, 1);
  const last = new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate();
  // Same day next period minus one; if that month is too short (31 Jan + 1 month), end on its last day.
  if (day > last) e.setDate(last); else e.setDate(day - 1);
  return `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
}
function endAfterDays(start, days) {
  const e = parseISO(start); e.setDate(e.getDate() + days - 1);
  return `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
}
// End date from a start date and a duration: uses its Months, else reads the name ("18 Months", "2 Years", "15 Days", "1 Week").
function endFromDuration(start, dur) {
  if (!start || !dur) return '';
  if (dur.months) return endAfterMonths(start, dur.months);
  const m = /(\d+)\s*(day|week|month|year|yr)/i.exec(dur.name || '');
  if (!m) return '';
  const n = Number(m[1]), unit = m[2].toLowerCase();
  if (!n) return '';
  if (unit === 'day') return endAfterDays(start, n);
  if (unit === 'week') return endAfterDays(start, n * 7);
  return endAfterMonths(start, unit === 'month' ? n : n * 12);
}
const extUrl = u => /^https?:\/\//i.test(u) ? u : `https://${u}`;
async function customers() {
  title('Customer Master');
  const cs = await api('GET', '/api/customers');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">Customer Master</h2><input id="q" placeholder="Search…" style="max-width:240px"><button class="btn primary" id="add">+ Add customer</button></div>
  <div class="card table-wrap" style="padding:0" id="tbl"></div>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const rows = cs.filter(c => !q || [c.name, c.mobile, c.contactPerson, c.url, c.address].some(x => (x || '').toLowerCase().includes(q)));
    const dash = '<span class="muted">—</span>';
    $('#tbl').innerHTML = rows.length ? `<table class="list stack"><thead><tr><th>Name</th><th>Contact person</th><th>Mobile</th><th>Address</th><th>URL</th><th>Period</th><th>Duration</th><th></th></tr></thead><tbody>
    ${rows.map(c => `<tr><td data-l="Name"><b>${esc(c.name)}</b></td>
    <td data-l="Contact">${esc(c.contactPerson) || dash}</td>
    <td data-l="Mobile"><a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a></td>
    <td data-l="Address" style="white-space:pre-line;max-width:260px">${esc(c.address) || dash}</td>
    <td data-l="URL">${c.url ? `<a href="${esc(extUrl(c.url))}" target="_blank" rel="noopener">${esc(c.url.replace(/^https?:\/\//i, ''))}</a>` : dash}</td>
    <td data-l="Period">${c.startDate || c.endDate ? `${fmtDate(c.startDate) || '…'} → ${fmtDate(c.endDate) || '…'}` : dash}</td>
    <td data-l="Duration">${esc(c.duration) || dash}</td>
    <td class="actions"><div class="row-actions"><button class="btn sm" data-edit="${c.id}">Edit</button><button class="btn sm danger" data-del="${c.id}">Delete</button></div></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No customers.</div>';
    $$('[data-edit]').forEach(b => b.onclick = () => customerForm(cs.find(c => c.id == b.dataset.edit)));
    $$('[data-del]').forEach(b => b.onclick = async () => {
      const c = cs.find(x => x.id == b.dataset.del);
      if (!await confirmBox(`Delete customer "${c.name}"?`)) return;
      try { await api('DELETE', `/api/customers/${c.id}`); toast('Customer deleted'); customers(); } catch (e) { toast(e.message, true); }
    });
  };
  $('#q').oninput = draw; draw();
  $('#add').onclick = () => customerForm();
}
async function customerForm(c, after) {
  let durs;
  try { durs = await api('GET', '/api/durations'); } catch (e) { return toast(e.message, true); }
  const m = modal(`<h3>${c ? 'Edit customer' : 'Add customer'}</h3><form class="grid">
    <label>Customer name *<input name="name" required value="${esc(c?.name)}"></label>
    <div class="form-2">
      <label>Contact person<input name="contactPerson" value="${esc(c?.contactPerson)}" placeholder="Person to contact"></label>
      <label>Mobile number *<input name="mobile" type="tel" inputmode="tel" required value="${esc(c?.mobile)}" placeholder="10-digit mobile"></label>
    </div>
    <label>Address<textarea name="address" rows="2" placeholder="Door no, street, area, city, PIN">${esc(c?.address)}</textarea></label>
    <label>URL<input name="url" type="text" inputmode="url" autocomplete="url" value="${esc(c?.url)}" placeholder="https://example.com"></label>
    <div class="form-2">
      <label>Start date<input name="startDate" type="date" value="${esc(c?.startDate || '')}"></label>
      <div class="dur-field">
        <label>Duration<select name="duration"></select></label>
        <button type="button" class="btn" data-mgr aria-expanded="false" title="Add, edit or delete durations">Manage</button>
      </div>
    </div>
    <label>End date <span class="muted end-hint">— calculated from Start date + Duration</span><input name="endDate" type="date" value="${esc(c?.endDate || '')}"></label>
    <div class="dur-mgr" hidden>
      <div class="dur-mgr-head"><b>Duration values</b><span class="muted">Months fill the End date from the Start date</span></div>
      <div class="dur-list"></div>
      <div class="dur-row dur-add"><input data-n placeholder="New duration, e.g. 18 Months"><input data-m type="number" min="1" max="600" inputmode="numeric" placeholder="Months"><button type="button" class="btn sm primary" data-add>Add</button></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
  const f = m.querySelector('form'), el = f.elements;
  const sel = el.duration, mgr = m.querySelector('.dur-mgr'), list = m.querySelector('.dur-list');
  const durOf = name => durs.find(d => d.name === name) || (name ? { name } : null);
  const fillSelect = value => {
    const opts = durs.map(d => d.name);
    if (value && !opts.includes(value)) opts.push(value);   // keep an old value that is no longer in the list
    sel.innerHTML = `<option value="">— Select duration —</option>` + opts.map(n => `<option${n === value ? ' selected' : ''}>${esc(n)}</option>`).join('');
  };
  // Start date + Duration → End date (recalculated whenever either changes; still editable by hand).
  const fillEnd = () => {
    const end = endFromDuration(el.startDate.value, durOf(sel.value));
    if (end) el.endDate.value = end;
    el.endDate.min = el.startDate.value || '';
  };
  sel.onchange = fillEnd;
  el.startDate.oninput = fillEnd;
  el.endDate.min = el.startDate.value || '';
  fillSelect(c?.duration || '');

  const drawList = () => {
    list.innerHTML = durs.length ? durs.map(d => `<div class="dur-row" data-id="${d.id}">
      <input data-n value="${esc(d.name)}" aria-label="Duration name"><input data-m type="number" min="1" max="600" inputmode="numeric" value="${d.months ?? ''}" placeholder="Months" aria-label="Months">
      <button type="button" class="btn sm" data-save>Save</button><button type="button" class="btn sm danger" data-del>Delete</button></div>`).join('')
      : '<div class="muted" style="padding:.4rem 0">No durations yet — add one below.</div>';
  };
  const readRow = row => {
    const name = row.querySelector('[data-n]').value.trim(), mv = row.querySelector('[data-m]').value;
    if (!name) { toast('Enter a duration name', true); return null; }
    return { name, months: mv ? Number(mv) : null };
  };
  list.onclick = async e => {
    const row = e.target.closest('.dur-row'); if (!row) return;
    const d = durs.find(x => x.id == row.dataset.id);
    if (e.target.matches('[data-save]')) {
      const body = readRow(row); if (!body) return;
      try {
        const saved = await api('PUT', `/api/durations/${d.id}`, body);
        if (sel.value === d.name) sel.dataset.keep = saved.name;
        Object.assign(d, saved); toast('Duration updated');
        fillSelect(sel.dataset.keep || sel.value); delete sel.dataset.keep; fillEnd(); drawList();
      } catch (err) { toast(err.message, true); }
    } else if (e.target.matches('[data-del]')) {
      const b = e.target;   // second click confirms (the modal is in use by this form)
      if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Confirm?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete'; } }, 3000); return; }
      try {
        await api('DELETE', `/api/durations/${d.id}`);
        durs = durs.filter(x => x !== d); toast('Duration deleted');
        fillSelect(sel.value); drawList();
      } catch (err) { toast(err.message, true); }
    }
  };
  const addRow = m.querySelector('.dur-add');
  const addDur = async () => {
    const body = readRow(addRow); if (!body) return;
    try {
      const saved = await api('POST', '/api/durations', body);
      durs.push(saved); addRow.querySelector('[data-n]').value = ''; addRow.querySelector('[data-m]').value = '';
      toast('Duration added'); fillSelect(saved.name); fillEnd(); drawList();
    } catch (err) { toast(err.message, true); }
  };
  m.querySelector('[data-add]').onclick = addDur;
  addRow.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addDur(); } };
  list.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.closest('.dur-row')?.querySelector('[data-save]').click(); } };
  m.querySelector('[data-mgr]').onclick = e => {
    mgr.hidden = !mgr.hidden; e.currentTarget.setAttribute('aria-expanded', !mgr.hidden);
    e.currentTarget.textContent = mgr.hidden ? 'Manage' : 'Done';
    if (!mgr.hidden) { drawList(); addRow.querySelector('[data-n]').focus(); }
  };
  m.querySelector('[data-x]').onclick = closeModal;
  f.onsubmit = async e => {
    e.preventDefault();
    if (el.startDate.value && el.endDate.value && el.endDate.value < el.startDate.value) return toast('End date cannot be before start date', true);
    const body = {
      name: el.name.value, mobile: el.mobile.value, url: el.url.value.trim(), contactPerson: el.contactPerson.value.trim(), address: el.address.value.trim(),
      startDate: el.startDate.value || null, endDate: el.endDate.value || null, duration: sel.value,
    };
    try {
      const saved = await api(c ? 'PUT' : 'POST', c ? `/api/customers/${c.id}` : '/api/customers', body);
      closeModal(); toast('Customer saved'); after ? after(saved) : customers();
    } catch (err) { toast(err.message, true); }
  };
}

// ------------------------------------------------------------ project share
async function share() {
  title('Project Share');
  const [cs, ps] = await Promise.all([api('GET', '/api/customers'), api('GET', '/api/projects')]);
  view.innerHTML = `<h2>Project Share</h2>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">
    <div class="card grid">
      <div style="display:flex;gap:.5rem;align-items:end">
        <label style="flex:1">Customer *<select id="cust"><option value="">— Select customer —</option>${cs.map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.mobile)}</option>`).join('')}</select></label>
        <button class="btn" id="newCust" title="Add customer">+ New</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center"><b>Projects</b><label style="display:flex;gap:.4rem;align-items:center;font-weight:500"><input type="checkbox" id="all"> Select all</label></div>
      <div class="pick-list">${ps.length ? ps.map(p => `<label class="pick"><input type="checkbox" data-p="${p.id}">
        <div><div><b>${esc(p.name)}</b></div><div class="muted" style="font-size:.85rem">${esc(p.websiteUrl || 'No website')}</div>
        ${p.hasAttachment ? `<div class="sub"><input type="checkbox" data-att="${p.id}"> Include attachment: <i>${esc(p.attachmentName)}</i></div>` : ''}</div></label>`).join('') : '<div class="empty">No projects. Add them in Project Master.</div>'}</div>
      <button class="btn wa block" id="send">&#128172; Send via WhatsApp</button>
      <p class="muted" style="margin:0;font-size:.82rem">Attachment links expire after 24 hours. Sender mobile ${esc(CFG.senderMobile)} is included in the message.</p>
    </div>
    <div class="card grid" id="out"><b>Message preview</b><div class="muted">Select a customer and projects, then tap Send.</div></div>
  </div>`;
  $('#newCust').onclick = () => customerForm(null, () => share());
  $('#all').onchange = e => $$('[data-p]').forEach(c => c.checked = e.target.checked);
  $$('[data-att]').forEach(a => a.onchange = () => { if (a.checked) $(`[data-p="${a.dataset.att}"]`).checked = true; });
  $('#send').onclick = async () => {
    const customerId = Number($('#cust').value);
    const items = $$('[data-p]').filter(c => c.checked).map(c => ({ projectId: Number(c.dataset.p), includeAttachment: !!$(`[data-att="${c.dataset.p}"]`)?.checked }));
    if (!customerId) return toast('Select a customer', true);
    if (!items.length) return toast('Select at least one project', true);
    const win = window.open('', '_blank');
    try {
      const r = await api('POST', '/api/share', { customerId, items });
      $('#out').innerHTML = `<b>Message preview</b><div class="msg-preview">${esc(r.message)}</div>
        <a class="btn wa" href="${esc(r.whatsappUrl)}" target="_blank" rel="noopener">Open WhatsApp again</a>
        <button class="btn" id="copyMsg">Copy message</button>`;
      $('#copyMsg').onclick = () => navigator.clipboard.writeText(r.message).then(() => toast('Copied'));
      if (win) win.location.href = r.whatsappUrl; else location.href = r.whatsappUrl;
    } catch (e) { if (win) win.close(); toast(e.message, true); }
  };
}

// ------------------------------------------------------------ client route
let mapsPromise = null, routeState = null;
function loadMaps() {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  if (!CFG.mapsBrowserKey) return Promise.reject(new Error('Google Maps browser key is not configured on the server.'));
  mapsPromise = new Promise((res, rej) => {
    window.__gmInit = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(CFG.mapsBrowserKey)}&libraries=geometry,marker&callback=__gmInit&loading=async&region=IN`;
    s.async = true; s.onerror = () => { mapsPromise = null; rej(new Error('Google Maps failed to load')); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}
async function routeView() {
  title('Client Route');
  const st = routeState?.form || { origin: '', destination: '', category: 'all' };
  view.innerHTML = `<div class="card">
    <form class="route-form" id="rf">
      <label class="from">From<input name="origin" required placeholder="Start location" value="${esc(st.origin)}"></label>
      <button type="button" class="btn swap" id="swap" title="Swap locations" aria-label="Swap locations">&#8646;</button>
      <label class="to">To<input name="destination" required placeholder="Destination" value="${esc(st.destination)}"></label>
      <label class="cat">Category<select name="category">
        <option value="all">All categories</option><option value="pharmacy">Pharmacy</option><option value="clinic">Clinic</option><option value="lab">Lab</option></select></label>
      <button class="btn primary go" id="go">&#128269; Search</button>
    </form>
    ${CFG.routeProvider === 'osm' ? '<p class="muted" style="margin:.6rem 0 0;font-size:.82rem">Using free OpenStreetMap data. A search takes about 15 seconds.</p>' : ''}
  </div>
  <div id="rres"></div>`;
  const f = $('#rf'); f.category.value = st.category;
  $('#swap').onclick = () => { const a = f.origin.value; f.origin.value = f.destination.value; f.destination.value = a; };
  f.onsubmit = async e => {
    e.preventDefault();
    const form = { origin: f.origin.value.trim(), destination: f.destination.value.trim(), category: f.category.value };
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Searching…';
    try {
      const data = await api('POST', '/api/route/search', form);
      routeState = { form, data };
      await drawRoute();
      if (data.warning) toast(data.warning, true);
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; btn.innerHTML = '&#128269; Search'; }
  };
  if (routeState?.data) drawRoute().catch(e => toast(e.message, true));
}
async function drawRoute() {
  const { data, form } = routeState;
  const cats = [...new Set(data.places.map(p => p.category))];
  const gmUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(data.origin)}&destination=${encodeURIComponent(data.destination)}&travelmode=driving`;
  const dur = parseInt(data.duration) || 0;
  $('#rres').innerHTML = `<div class="toolbar" style="margin-top:12px">
      <div class="grow"><b>${km(data.distanceM)}</b> · ${Math.floor(dur / 3600) ? Math.floor(dur / 3600) + ' h ' : ''}${Math.round(dur % 3600 / 60)} min · ${data.places.length} places within 2 km</div>
      <button class="btn" id="full">&#128506; Full route</button>
      <a class="btn" href="${esc(gmUrl)}" target="_blank" rel="noopener">Open in Google Maps</a>
    </div>
    <div class="cat-filters">${cats.map(c => `<label><input type="checkbox" data-cat="${c}" checked><span class="dot" style="background:${CAT[c].color}"></span>${CAT[c].label} (${data.places.filter(p => p.category === c).length})</label>`).join('')}</div>
    <div class="route-layout"><div id="map"></div><div class="biz-list" id="biz"></div></div>`;
  $('#biz').innerHTML = data.places.length ? data.places.map(p => `<div class="biz" data-cat="${p.category}" data-seq="${p.seq}">
      <div class="num" style="background:${CAT[p.category].color}">${p.seq}</div>
      <div><div class="name">${esc(p.name)}</div><div class="addr">${esc(p.address)}</div>
      <div class="dist">${km(p.fromStartM)} from start · ${km(p.offRouteM)} off route · <span style="color:${CAT[p.category].color}">${CAT[p.category].label}</span></div>
      <div class="row-actions"><button class="btn sm" data-show="${p.seq}">Show on map</button>
      <a class="btn sm" target="_blank" rel="noopener" href="${esc(p.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`)}">Open in Google Maps</a></div></div></div>`).join('')
    : '<div class="card empty">No businesses found within 2 km of this route.</div>';

  if (!CFG.mapsBrowserKey || googleFailed) return drawLeaflet(data);
  try { await loadMaps(); }
  catch (e) { $('#map').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
  const map = new google.maps.Map($('#map'), { mapId: CFG.mapId || 'DEMO_MAP_ID', gestureHandling: 'greedy', streetViewControl: false, mapTypeControl: true, fullscreenControl: true });
  const path = google.maps.geometry.encoding.decodePath(data.polyline);
  new google.maps.Polyline({ path, map, strokeColor: '#1d6fb8', strokeOpacity: .9, strokeWeight: 5 });
  const bounds = new google.maps.LatLngBounds(); path.forEach(p => bounds.extend(p));
  const fit = () => map.fitBounds(bounds, 40); fit();
  const pin = (txt, bg, size = 26) => { const d = document.createElement('div'); d.textContent = txt; d.style.cssText = `background:${bg};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;font:700 12px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)`; return d; };
  const info = new google.maps.InfoWindow();
  const ll = o => ({ lat: o.latitude, lng: o.longitude });
  new AdvancedMarkerElement({ map, position: ll(data.start), content: pin('A', '#111827', 32), title: `Start: ${data.origin}`, zIndex: 999 });
  new AdvancedMarkerElement({ map, position: ll(data.end), content: pin('B', '#dc2626', 32), title: `End: ${data.destination}`, zIndex: 999 });
  const markers = {};
  data.places.forEach(p => {
    const m = new AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content: pin(p.seq, CAT[p.category].color), title: `${p.seq}. ${p.name}` });
    m.addListener('click', () => openInfo(p));
    markers[p.seq] = m;
  });
  function openInfo(p) {
    info.setContent(`<div style="max-width:240px"><b>${p.seq}. ${esc(p.name)}</b><br><small>${esc(p.address)}</small><br><small>${km(p.fromStartM)} from start · ${km(p.offRouteM)} off route</small></div>`);
    info.open({ map, anchor: markers[p.seq] });
  }
  $('#full').onclick = () => { info.close(); fit(); };
  $$('[data-show]').forEach(b => b.onclick = () => {
    const p = data.places.find(x => x.seq == b.dataset.show);
    map.panTo({ lat: p.lat, lng: p.lng }); map.setZoom(16); openInfo(p);
    if (window.innerWidth < 1100) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('[data-cat]', $('.cat-filters')).forEach(cb => cb.onchange = () => {
    const on = new Set($$('.cat-filters [data-cat]').filter(x => x.checked).map(x => x.dataset.cat));
    data.places.forEach(p => { markers[p.seq].map = on.has(p.category) ? map : null; });
    $$('.biz').forEach(el => el.hidden = !on.has(el.dataset.cat));
  });
  void form;
}

// If Google rejects the key in this browser (restriction, billing, quota), switch to the free map.
let googleFailed = false;
window.gm_authFailure = () => {
  googleFailed = true;
  const old = $('#map');
  if (old && routeState?.data) {
    const fresh = document.createElement('div'); fresh.id = 'map'; old.replaceWith(fresh);
    drawLeaflet(routeState.data);
    toast('Google map unavailable, showing OpenStreetMap instead');
  }
};

// OpenStreetMap / Leaflet map (used when no Google browser key is configured)
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => res(); s.onerror = () => { leafletPromise = null; rej(new Error('Map failed to load')); };
    document.head.appendChild(s);
  });
  return leafletPromise;
}
function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
async function drawLeaflet(data) {
  try { await loadLeaflet(); } catch (e) { $('#map').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const map = L.map($('#map'), { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const line = L.polyline(decodePolyline(data.polyline), { color: '#1d6fb8', weight: 5, opacity: .9 }).addTo(map);
  const fit = () => map.fitBounds(line.getBounds(), { padding: [30, 30] }); fit();
  const pin = (txt, bg, size = 26) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: `<div style="background:${bg};color:#fff;width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;font:700 12px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)">${txt}</div>` });
  L.marker([data.start.latitude, data.start.longitude], { icon: pin('A', '#111827', 32), zIndexOffset: 1000, title: `Start: ${data.origin}` }).addTo(map);
  L.marker([data.end.latitude, data.end.longitude], { icon: pin('B', '#dc2626', 32), zIndexOffset: 1000, title: `End: ${data.destination}` }).addTo(map);
  const markers = {};
  data.places.forEach(p => {
    markers[p.seq] = L.marker([p.lat, p.lng], { icon: pin(p.seq, CAT[p.category].color), title: `${p.seq}. ${p.name}` })
      .bindPopup(`<b>${p.seq}. ${esc(p.name)}</b><br><small>${esc(p.address)}</small><br><small>${km(p.fromStartM)} from start · ${km(p.offRouteM)} off route</small>`)
      .addTo(map);
  });
  $('#full').onclick = () => { map.closePopup(); fit(); };
  $$('[data-show]').forEach(b => b.onclick = () => {
    const p = data.places.find(x => x.seq == b.dataset.show);
    if (window.innerWidth < 1100) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.setView([p.lat, p.lng], 16); markers[p.seq].openPopup();
  });
  $$('[data-cat]', $('.cat-filters')).forEach(cb => cb.onchange = () => {
    const on = new Set($$('.cat-filters [data-cat]').filter(x => x.checked).map(x => x.dataset.cat));
    data.places.forEach(p => { if (on.has(p.category)) markers[p.seq].addTo(map); else markers[p.seq].remove(); });
    $$('.biz').forEach(el => el.hidden = !on.has(el.dataset.cat));
  });
  setTimeout(() => map.invalidateSize(), 200);
}

// ------------------------------------------------------------ visits
function statusChip(v) {
  const cls = CLOSED.includes(v.status) ? (v.status === 'Converted' ? 'ok' : '') : 'warn';
  return `<span class="chip ${cls}">${esc(v.status)}</span>`;
}
async function visits() {
  title('Visits');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">Visits</h2><a class="btn primary" href="#/visit/new">+ New visit</a></div>
  <div class="toolbar"><input id="q" class="grow" placeholder="Search clinic, doctor, notes…"><select id="st" style="max-width:190px"><option value="">All statuses</option>${VISIT_STATUSES.map(s => `<option>${s}</option>`).join('')}</select></div>
  <div id="vl" class="visit-grid"></div>`;
  let list = [];
  const draw = () => {
    const st = $('#st').value;
    const rows = list.filter(v => !st || v.status === st);
    $('#vl').innerHTML = rows.length ? rows.map(v => `<div class="visit-card">
      <div class="top"><div><b>${esc(v.clinicName)}</b>${v.doctorName ? `<div class="meta">Dr. ${esc(v.doctorName)}</div>` : ''}</div>${statusChip(v)}</div>
      <div class="meta">Visited ${fmtDate(v.visitDate)}${v.personMet ? ` · Met ${esc(v.personMet)}` : ''}${v.imageCount ? ` · &#128247; ${v.imageCount}` : ''}${v.latitude ? ' · &#128205;' : ''}</div>
      ${v.followUpDate ? `<div><span class="chip ${v.overdue ? 'overdue' : ''}">Follow-up ${fmtDate(v.followUpDate)}${v.overdue ? ' · Overdue' : ''}</span></div>` : ''}
      ${v.notes ? `<div class="meta" style="white-space:pre-line;max-height:4.4em;overflow:hidden">${esc(v.notes)}</div>` : ''}
      <div class="row-actions"><a class="btn sm" href="#/visit/${v.id}">Edit</a><button class="btn sm danger" data-del="${v.id}">Delete</button></div></div>`).join('')
      : '<div class="card empty" style="grid-column:1/-1">No visits found.</div>';
    $$('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Delete this visit? It will be removed from lists and reports.')) return;
      try { await api('DELETE', `/api/visits/${b.dataset.del}`); toast('Visit deleted'); load(); } catch (e) { toast(e.message, true); }
    });
  };
  let t;
  const load = async () => { list = await api('GET', `/api/visits?q=${encodeURIComponent($('#q').value)}`); draw(); };
  $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  $('#st').onchange = draw;
  await load();
}

function toPoints(text) {
  const parts = String(text)
    .split(/\n+|(?<=[.!?।])\s+|\s*\b(?:next point|new point)\b\s*|\s*(?:அடுத்து|அடுத்த பாயிண்ட்|அடுத்த பாய்ண்ட்)\s*/i)
    .map(s => (s || '').replace(/^\s*(?:[•\-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  return parts.map(s => `• ${s}`).join('\n');
}

async function visitForm(id) {
  const isNew = !id || id === 'new';
  title(isNew ? 'New visit' : 'Edit visit');
  const [v, clinics] = await Promise.all([
    isNew ? Promise.resolve({ visitDate: CFG.today || isoToday(), status: 'Visited', images: [] }) : api('GET', `/api/visits/${id}`),
    api('GET', '/api/clinics').catch(() => []),
  ]);
  const pending = []; // File objects to upload after save
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  view.innerHTML = `<div class="toolbar"><a class="btn" href="#/visits">&#8592; Visit list</a><h2 class="grow" style="margin:0">${isNew ? 'New visit' : 'Edit visit'}</h2></div>
  <form id="vf" class="card grid">
    <div class="form-grid">
      <label>Clinic name *<input name="clinicName" required list="clinicList" value="${esc(v.clinicName)}"></label>
      <datalist id="clinicList">${clinics.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <label>Doctor name<input name="doctorName" value="${esc(v.doctorName)}"></label>
      <label>Visit date *<input type="date" name="visitDate" required value="${esc(String(v.visitDate || '').slice(0, 10))}"></label>
      <label>Follow-up date<input type="date" name="followUpDate" value="${esc(String(v.followUpDate || '').slice(0, 10))}"></label>
      <label>Referral doctor<input name="referralDoctor" value="${esc(v.referralDoctor)}"></label>
      <label>Person met<input name="personMet" value="${esc(v.personMet)}"></label>
      <label>Status<select name="status">${VISIT_STATUSES.map(s => `<option ${s === v.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    </div>
    <div>
      <label>Notes<textarea name="notes" id="notes" rows="6">${esc(v.notes)}</textarea></label>
      <div class="voice-bar">
        <select id="vlang" style="width:auto"><option value="en-IN">English</option><option value="ta-IN">தமிழ் (Tamil)</option></select>
        <button type="button" class="btn sm" id="mic" ${SR ? '' : 'disabled title="Voice input is not supported in this browser (use Chrome)"'}>&#127908; Start voice</button>
        <button type="button" class="btn sm" id="toTa">அ Convert to Tamil</button>
        <button type="button" class="btn sm" id="pts">&#8226; Point form</button>
        <button type="button" class="btn sm" id="undo" hidden>&#8630; Undo</button>
        <span id="micState" class="muted" style="font-size:.82rem"></span>
      </div>
    </div>
    <div>
      <label>Location</label>
      <div class="voice-bar">
        <button type="button" class="btn sm" id="loc">&#128205; Capture location</button>
        <span id="locTxt" class="muted" style="font-size:.85rem"></span>
      </div>
      <input name="locationText" placeholder="Location description / landmark (optional)" value="${esc(v.locationText)}" style="margin-top:.4rem">
    </div>
    <div>
      <label>Images</label>
      <div class="voice-bar">
        <label class="btn sm" style="font-weight:500">&#128247; Take photo<input type="file" accept="image/*" capture="environment" id="cam" hidden></label>
        <label class="btn sm" style="font-weight:500">&#128444; Choose images<input type="file" accept="image/*" multiple id="pick" hidden></label>
      </div>
      <div class="thumbs" id="thumbs"></div>
    </div>
    <div class="row-actions" style="justify-content:flex-end">
      ${isNew ? '' : '<button type="button" class="btn danger" id="del">Delete</button>'}
      <a class="btn" href="#/visits">Cancel</a>
      <button class="btn primary" id="save">Save visit</button>
    </div>
  </form>`;
  const f = $('#vf'), notes = $('#notes');
  let lat = v.latitude, lng = v.longitude, undoText = null;
  const showLoc = () => { $('#locTxt').innerHTML = lat != null ? `${lat.toFixed(6)}, ${lng.toFixed(6)} · <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">view</a> · <a href="#" id="clrLoc">clear</a>` : 'Not captured';
    const c = $('#clrLoc'); if (c) c.onclick = e => { e.preventDefault(); lat = lng = null; showLoc(); }; };
  showLoc();
  $('#loc').onclick = () => {
    if (!navigator.geolocation) return toast('Location not supported', true);
    $('#locTxt').textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(p => { lat = p.coords.latitude; lng = p.coords.longitude; showLoc(); toast('Location captured'); },
      err => { showLoc(); toast('Could not get location: ' + err.message, true); }, { enableHighAccuracy: true, timeout: 20000 });
  };
  // images
  const drawThumbs = () => {
    $('#thumbs').innerHTML = (v.images || []).map(i => `<div class="thumb"><img src="/api/visit-images/${i.id}" alt="" data-full="/api/visit-images/${i.id}"><button type="button" data-rmi="${i.id}" title="Remove">&times;</button></div>`).join('')
      + pending.map((p, k) => `<div class="thumb"><img src="${p.url}" alt=""><button type="button" data-rmp="${k}" title="Remove">&times;</button></div>`).join('');
    $$('[data-full]').forEach(im => im.onclick = () => window.open(im.dataset.full, '_blank'));
    $$('[data-rmp]').forEach(b => b.onclick = () => { URL.revokeObjectURL(pending[b.dataset.rmp].url); pending.splice(b.dataset.rmp, 1); drawThumbs(); });
    $$('[data-rmi]').forEach(b => b.onclick = async () => {
      if (!await confirmBox('Remove this image?', 'Remove')) return;
      await api('DELETE', `/api/visit-images/${b.dataset.rmi}`); v.images = v.images.filter(i => i.id != b.dataset.rmi); drawThumbs();
    });
  };
  const addFiles = list => { [...list].forEach(file => pending.push({ file, url: URL.createObjectURL(file) })); drawThumbs(); };
  $('#cam').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#pick').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  drawThumbs();
  // voice
  let rec = null, listening = false;
  const setUndo = prev => { undoText = prev; $('#undo').hidden = false; };
  $('#undo').onclick = () => { if (undoText != null) { notes.value = undoText; undoText = null; $('#undo').hidden = true; } };
  $('#mic').onclick = () => {
    if (listening) { listening = false; rec && rec.stop(); return; }
    rec = new SR(); rec.lang = $('#vlang').value; rec.continuous = true; rec.interimResults = true;
    let base = notes.value, committed = '';
    const join = (a, b) => a && b ? (/\s$/.test(a) ? a + b : a + ' ' + b) : (a || b);
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) committed = join(committed, t); else interim = join(interim, t);
      }
      notes.value = join(base, join(committed, interim));
    };
    rec.onerror = e => { if (e.error !== 'no-speech') { toast('Voice error: ' + e.error, true); listening = false; } };
    rec.onend = () => {
      if (listening) { base = notes.value; committed = ''; try { rec.start(); } catch { listening = false; } }
      if (!listening) { $('#mic').classList.remove('rec'); $('#mic').innerHTML = '&#127908; Start voice'; $('#micState').textContent = ''; }
    };
    listening = true; rec.start();
    $('#mic').classList.add('rec'); $('#mic').innerHTML = '&#9632; Stop';
    $('#micState').textContent = `Listening (${$('#vlang').selectedOptions[0].text})…`;
  };
  cleanup = () => { listening = false; try { rec && rec.stop(); } catch { /* ignore */ } pending.forEach(p => URL.revokeObjectURL(p.url)); };
  $('#toTa').onclick = async () => {
    if (!notes.value.trim()) return toast('Notes are empty', true);
    const btn = $('#toTa'); btn.disabled = true;
    try { const r = await api('POST', '/api/translate', { text: notes.value, target: 'ta' }); setUndo(notes.value); notes.value = r.text; toast('Converted to Tamil'); }
    catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  $('#pts').onclick = () => { if (!notes.value.trim()) return; setUndo(notes.value); notes.value = toPoints(notes.value); };
  if (!isNew) $('#del').onclick = async () => {
    if (!await confirmBox('Delete this visit?')) return;
    await api('DELETE', `/api/visits/${id}`); toast('Visit deleted'); location.hash = '#/visits';
  };
  f.onsubmit = async e => {
    e.preventDefault();
    if (listening) { listening = false; rec.stop(); }
    const body = {
      clinicName: f.clinicName.value, doctorName: f.doctorName.value, visitDate: f.visitDate.value, followUpDate: f.followUpDate.value || null,
      referralDoctor: f.referralDoctor.value, personMet: f.personMet.value, notes: notes.value, status: f.status.value,
      latitude: lat ?? null, longitude: lng ?? null, locationText: f.locationText.value,
    };
    const btn = $('#save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/visits' : `/api/visits/${id}`, body);
      if (pending.length) {
        const fd = new FormData(); pending.forEach(p => fd.append('files', p.file, p.file.name || 'photo.jpg'));
        await api('POST', `/api/visits/${r.id}/images`, fd);
      }
      toast('Visit saved'); location.hash = '#/visits';
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Save visit'; }
  };
}

// ------------------------------------------------------------ follow-up reports
async function followups() {
  title('Follow-up Reports');
  const { today, visits: list } = await api('GET', '/api/visits/followups');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">Follow-up Reports</h2>
    <label style="display:flex;gap:.4rem;align-items:center;font-weight:500"><input type="checkbox" id="closed"> Include closed</label></div><div id="fr"></div>`;
  const row = v => `<div class="fu-row ${v.overdue ? 'overdue' : ''}">
    <div><b>${esc(v.clinicName)}</b>${v.doctorName ? ` · Dr. ${esc(v.doctorName)}` : ''}<div class="muted" style="font-size:.82rem">Visited ${fmtDate(v.visitDate)}${v.personMet ? ` · Met ${esc(v.personMet)}` : ''}</div></div>
    <div class="row-actions" style="align-items:center"><span class="chip ${v.overdue ? 'overdue' : ''}">&#128197; ${fmtShort(parseISO(v.followUpDate))}${v.overdue ? ' · Overdue' : ''}</span>${statusChip(v)}<a class="btn sm" href="#/visit/${v.id}">Open</a></div></div>`;
  const draw = () => {
    const rows = list.filter(v => $('#closed').checked || !CLOSED.includes(v.status));
    const overdue = rows.filter(v => v.overdue);
    const months = new Map();
    rows.forEach(v => {
      const d = parseISO(v.followUpDate);
      const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const wk = toISO(mon);
      if (!months.has(mk)) months.set(mk, new Map());
      const m = months.get(mk); if (!m.has(wk)) m.set(wk, []); m.get(wk).push(v);
    });
    let html = `<div class="card" style="margin-bottom:12px"><h3 style="color:var(--danger)">Overdue (${overdue.length})</h3>${overdue.length ? overdue.map(row).join('') : '<div class="muted">Nothing overdue. Today is ' + fmtDate(today) + '.</div>'}</div>`;
    if (!rows.length) html += '<div class="card empty">No follow-ups scheduled.</div>';
    for (const [mk, weeks] of months) {
      const [y, m] = mk.split('-').map(Number);
      const count = [...weeks.values()].reduce((a, w) => a + w.length, 0);
      html += `<div class="card month" style="margin-bottom:12px"><h3>${MON[m - 1]} ${y} <span class="muted" style="font-size:.85rem;font-weight:400">· ${count} follow-up${count > 1 ? 's' : ''}</span></h3>`;
      for (const [wk, vs] of [...weeks].sort()) {
        const s = parseISO(wk), e = new Date(s); e.setDate(s.getDate() + 6);
        html += `<div class="week"><h4>Week: ${fmtShort(s)} – ${fmtShort(e)}</h4>${vs.map(row).join('')}</div>`;
      }
      html += '</div>';
    }
    $('#fr').innerHTML = html;
  };
  $('#closed').onchange = draw; draw();
}

// ------------------------------------------------------------ invoice
let INV = null; // current invoice draft
const newRow = (pkg) => ({ pkgId: pkg?.id ?? null, name: pkg?.name ?? '', checked: false, billingType: 'One time', amount: 0, discount: 0, taxPercent: 18, amc: 0 });
function calcRow(r) {
  const amount = r2(r.amount), discount = r2(r.discount);
  const tax = r2((amount - discount) * (Number(r.taxPercent) || 0) / 100);
  return { amount, discount, tax, final: r2(amount - discount + tax), amc: r2(r.amc) };
}
function totals(rows) {
  return rows.filter(r => r.checked).map(calcRow).reduce((t, c) => ({
    amount: t.amount + c.amount, discount: t.discount + c.discount, tax: t.tax + c.tax, final: t.final + c.final, amc: t.amc + c.amc,
  }), { amount: 0, discount: 0, tax: 0, final: 0, amc: 0 });
}
function letterheadHTML(inv) {
  const rows = inv.rows.filter(r => r.checked);
  const t = totals(inv.rows);
  const c = inv.clinic || {};
  return `<div class="a4">
    <div class="lh-head">
      <div class="lh-left">
        <div class="lh-brand"><img src="/static/img/logo.png" alt=""><div class="cname">${esc(COMPANY.name)}</div></div>
        <div class="lh-addr">${COMPANY.address.map(a => `<div>${esc(a)}</div>`).join('')}<div>Mobile: ${esc(COMPANY.mobiles)}</div></div>
      </div>
      <div class="lh-right">
        <div class="bt">Bill To</div>
        <div class="bn">${esc(c.name || '—')}</div>
        ${c.address ? `<div class="ba">${esc(c.address)}</div>` : ''}
        ${c.mobile ? `<div>Mobile: ${esc(c.mobile)}</div>` : ''}
      </div>
    </div>
    <div class="lh-date"><b>Date:</b> ${fmtDate(inv.billDate)}</div>
    <div class="lh-title">Package Details</div>
    <table class="lh-table"><thead><tr><th>#</th><th>Package</th><th>Billing</th><th class="r">Amount (₹)</th><th class="r">Discount (₹)</th><th class="r">Tax (₹)</th><th class="r">Final Amount (₹)</th><th class="r">AMC (₹)</th></tr></thead>
    <tbody>${rows.length ? rows.map((r, i) => { const k = calcRow(r); return `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.billingType)}</td><td class="r">${money(k.amount)}</td><td class="r">${money(k.discount)}</td><td class="r">${money(k.tax)}</td><td class="r">${money(k.final)}</td><td class="r">${money(k.amc)}</td></tr>`; }).join('')
      : '<tr><td colspan="8" style="text-align:center;color:#888">No packages selected</td></tr>'}</tbody>
    <tfoot><tr><td></td><td colspan="2">Total</td><td class="r">${money(t.amount)}</td><td class="r">${money(t.discount)}</td><td class="r">${money(t.tax)}</td><td class="r">${money(t.final)}</td><td class="r">${money(t.amc)}</td></tr></tfoot></table>
    <div class="lh-spacer"></div>
    <div class="lh-foot">${esc(COMPANY.site)}</div>
  </div>`;
}
function printLetterhead(inv) {
  let root = $('#printRoot');
  if (!root) { root = document.createElement('div'); root.id = 'printRoot'; document.body.appendChild(root); }
  root.innerHTML = $('#a4src') ? $('#a4src').innerHTML : letterheadHTML(inv);
  const old = document.title;
  document.title = `Invoice - ${(inv.clinic?.name || 'Clinic').replace(/[\\/:*?"<>|]/g, '')} - ${fmtDate(inv.billDate)}`;
  const img = root.querySelector('img');
  const go = () => { window.print(); setTimeout(() => { document.title = old; root.innerHTML = ''; }, 500); };
  if (img && !img.complete) { img.onload = go; img.onerror = go; } else go();
}
async function invoiceView(id, action) {
  title('Invoice');
  const [pkgs, clinics, custs] = await Promise.all([api('GET', '/api/packages'), api('GET', '/api/clinics'), api('GET', '/api/customers')]);
  // Bill To choices: Customer Master entries first, then saved clinics.
  const custEntry = c => ({ id: null, customerId: c.id, kind: 'Customer', name: c.name, mobile: c.mobile, contactPerson: c.contactPerson, url: c.url,
    duration: c.duration, startDate: c.startDate, endDate: c.endDate, custAddress: c.address,
    // printed under the name on the invoice: contact person, then the address
    address: [c.contactPerson && `Kind Attn: ${c.contactPerson}`, c.address].filter(Boolean).join('\n') });
  const billTo = () => [...custs.map(custEntry), ...clinics.map(c => ({ ...c, kind: 'Clinic' }))];
  if (id) {
    const inv = await api('GET', `/api/invoices/${id}`);
    const rows = pkgs.map(newRow);
    inv.items.forEach(it => {
      let r = rows.find(x => x.name.toLowerCase() === it.packageName.toLowerCase() && !x.checked);
      if (!r) { r = newRow(); r.name = it.packageName; rows.push(r); }
      Object.assign(r, { checked: true, billingType: it.billingType, amount: Number(it.amount), discount: Number(it.discount), taxPercent: Number(it.taxPercent), amc: Number(it.amcAmount) });
    });
    INV = { id: inv.id, clinic: { id: inv.clinicId, name: inv.clinicName, address: inv.clinicAddress, mobile: inv.clinicMobile }, billDate: String(inv.billDate).slice(0, 10), rows };
  } else if (!INV || INV.id) {
    INV = { id: null, clinic: null, billDate: CFG.today || isoToday(), rows: pkgs.map(newRow) };
  } else {
    // keep the draft; sync with current package catalogue
    pkgs.forEach(p => { const r = INV.rows.find(x => x.pkgId === p.id); if (r) r.name = p.name; else INV.rows.push(newRow(p)); });
    INV.rows = INV.rows.filter(r => r.pkgId == null || pkgs.some(p => p.id === r.pkgId));
  }
  const inv = INV;
  title(inv.id ? `Edit invoice #${inv.id}` : 'Invoice');
  view.innerHTML = `<div class="toolbar"><h2 class="grow" style="margin:0">${inv.id ? `Edit invoice #${inv.id}` : 'New invoice'}</h2>
    <a class="btn" href="#/invoices">Saved Invoices</a></div>
  <div class="inv-layout">
    <div class="card grid" style="align-content:start">
      <div class="form-grid">
        <div class="full">
          <label>Bill To — customer / clinic *</label>
          <div style="display:flex;gap:.4rem;margin-top:.25rem">
            <div class="picker" style="flex:1"><input id="cq" autocomplete="off" placeholder="Search customer or clinic by name, mobile, contact person…" value="${esc(inv.clinic?.name)}"><div class="picker-list" id="cl" hidden></div></div>
            <button type="button" class="btn" id="addClinic">+ Add customer</button>
            <button type="button" class="btn" id="editClinic" ${inv.clinic?.id || inv.clinic?.customerId ? '' : 'hidden'}>Edit</button>
          </div>
          <div id="csel" class="muted" style="font-size:.85rem;margin-top:.3rem;white-space:pre-line"></div>
        </div>
        <label>Bill Date *<input type="date" id="bdate" value="${esc(inv.billDate)}"></label>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center"><b>Packages</b><button type="button" class="btn sm" id="addPkg">+ Add package</button></div>
      <div class="table-wrap"><table class="pkg-table"><thead><tr><th></th><th>Package</th><th>Billing</th><th class="num">Amount ₹</th><th class="num">Discount ₹</th><th class="num">Tax %</th><th class="num">Tax ₹</th><th class="num">Final ₹</th><th class="num">AMC ₹</th><th></th></tr></thead>
      <tbody id="pk"></tbody><tfoot id="pkt"></tfoot></table></div>
      <div class="row-actions" style="justify-content:flex-end">
        <button type="button" class="btn" id="newInv">New invoice</button>
        <button type="button" class="btn" id="print">&#128424; Print / Save as PDF</button>
        <button type="button" class="btn primary" id="saveInv">${inv.id ? 'Update invoice' : 'Save invoice'}</button>
      </div>
    </div>
    <div><div class="a4-wrap" id="a4wrap"><div class="a4-scale" id="a4src"></div></div></div>
  </div>`;

  const preview = () => {
    $('#a4src').innerHTML = letterheadHTML(inv);
    const t = totals(inv.rows);
    $('#pkt').innerHTML = `<tr><td class="c-chk"></td><td colspan="2" class="c-name">Total</td><td class="num" data-l="Amount ₹">${money(t.amount)}</td><td class="num" data-l="Discount ₹">${money(t.discount)}</td><td class="c-hide"></td><td class="num" data-l="Tax ₹">${money(t.tax)}</td><td class="num" data-l="Final ₹">${money(t.final)}</td><td class="num" data-l="AMC ₹">${money(t.amc)}</td><td class="c-hide"></td></tr>`;
    scale();
  };
  const scale = () => {
    const wrap = $('#a4wrap'), el = $('#a4src'); if (!wrap || !el) return;
    const a4 = el.firstElementChild; if (!a4) return;
    const s = Math.min(1, (wrap.clientWidth - 24) / a4.offsetWidth);
    el.style.transform = `scale(${s})`; el.style.height = `${a4.offsetHeight * s}px`; el.style.width = `${a4.offsetWidth}px`;
  };
  window.addEventListener('resize', scale);
  cleanup = () => window.removeEventListener('resize', scale);

  const drawRows = () => {
    $('#pk').innerHTML = inv.rows.map((r, i) => { const k = calcRow(r); return `<tr data-i="${i}">
      <td class="c-chk"><input type="checkbox" data-f="checked" ${r.checked ? 'checked' : ''} aria-label="Select"></td>
      <td class="c-name"><input data-f="name" value="${esc(r.name)}" style="min-width:150px" aria-label="Package name"></td>
      <td data-l="Billing"><select data-f="billingType">${CFG.billingTypes.map(b => `<option ${b === r.billingType ? 'selected' : ''}>${b}</option>`).join('')}</select></td>
      <td class="num" data-l="Amount ₹"><input class="n" data-f="amount" type="number" min="0" step="0.01" inputmode="decimal" value="${r.amount || ''}" placeholder="0"></td>
      <td class="num" data-l="Discount ₹"><input class="n" data-f="discount" type="number" min="0" step="0.01" inputmode="decimal" value="${r.discount || ''}" placeholder="0"></td>
      <td class="num" data-l="Tax %"><input class="n" data-f="taxPercent" type="number" min="0" step="0.01" inputmode="decimal" value="${r.taxPercent ?? ''}" style="width:70px"></td>
      <td class="num" data-l="Tax ₹" data-o="tax">${money(k.tax)}</td><td class="num" data-l="Final ₹" data-o="final">${money(k.final)}</td>
      <td class="num" data-l="AMC ₹"><input class="n" data-f="amc" type="number" min="0" step="0.01" inputmode="decimal" value="${r.amc || ''}" placeholder="0"></td>
      <td class="c-rm"><button type="button" class="btn sm danger" data-rm="${i}" title="Remove package">&times;</button></td></tr>`; }).join('');
    $$('#pk tr').forEach(tr => {
      const r = inv.rows[tr.dataset.i];
      $$('[data-f]', tr).forEach(inp => {
        const f = inp.dataset.f;
        inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
          if (f === 'checked') r.checked = inp.checked;
          else {
            r[f] = inp.type === 'number' ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value;
            if (!r.checked) { r.checked = true; $('[data-f="checked"]', tr).checked = true; }
          }
          const k = calcRow(r); $('[data-o="tax"]', tr).textContent = money(k.tax); $('[data-o="final"]', tr).textContent = money(k.final);
          preview();
        });
      });
      $('[data-f="name"]', tr).addEventListener('change', async e => {
        const name = e.target.value.trim();
        if (!name) { e.target.value = r.name || ''; return; }
        if (r.pkgId) { try { await api('PUT', `/api/packages/${r.pkgId}`, { name }); toast('Package renamed'); } catch (err) { toast(err.message, true); } }
      });
    });
    $$('[data-rm]').forEach(b => b.onclick = async () => {
      const r = inv.rows[b.dataset.rm];
      if (!await confirmBox(`Remove package "${r.name}"${r.pkgId ? ' from your package list' : ''}?`, 'Remove')) return;
      if (r.pkgId) { try { await api('DELETE', `/api/packages/${r.pkgId}`); } catch (e) { return toast(e.message, true); } }
      inv.rows.splice(b.dataset.rm, 1); drawRows(); preview();
    });
  };
  $('#addPkg').onclick = async () => {
    const name = await promptBox('Add package', '', 'Package name'); if (!name) return;
    try { const p = await api('POST', '/api/packages', { name }); inv.rows.push(newRow(p)); drawRows(); preview(); } catch (e) { toast(e.message, true); }
  };

  // clinic picker
  const showSel = () => {
    const c = inv.clinic;
    const lines = c?.customerId
      ? [c.contactPerson && `Contact person: ${c.contactPerson}`, c.custAddress && `Address: ${c.custAddress}`, c.mobile && `Mobile: ${c.mobile}`, c.url && `URL: ${c.url}`,
         (c.startDate || c.endDate) && `Period: ${fmtDate(c.startDate) || '…'} → ${fmtDate(c.endDate) || '…'}${c.duration ? ` (${c.duration})` : ''}`]
      : [c?.address, c?.mobile && `Mobile: ${c.mobile}`];
    $('#csel').textContent = c?.name ? lines.filter(Boolean).join('\n') || (c.id ? '' : 'Not in Customer Master — use “Add customer” to save details.') : '';
    $('#editClinic').hidden = !(c?.id || c?.customerId);
  };
  const cq = $('#cq'), cl = $('#cl');
  let hl = -1, matches = [];
  const drawList = () => {
    const q = cq.value.trim().toLowerCase();
    matches = billTo().filter(c => !q || [c.name, c.mobile, c.address, c.contactPerson].some(x => (x || '').toLowerCase().includes(q))).slice(0, 50);
    cl.innerHTML = matches.map((c, i) => `<div data-ci="${i}" class="${i === hl ? 'hl' : ''}"><b>${esc(c.name)} <span class="chip" style="font-size:.7em;font-weight:500">${c.kind}</span></b><small>${esc((c.customerId ? [c.contactPerson, c.mobile, c.custAddress] : [c.mobile, c.address]).filter(Boolean).join(' · '))}</small></div>`).join('')
      + `<div data-add style="color:var(--brand2)">+ Add customer${q ? ` “${esc(cq.value.trim())}”` : ''}</div>`;
    cl.hidden = false;
    $$('[data-ci]', cl).forEach(d => d.onmousedown = e => { e.preventDefault(); pick(matches[d.dataset.ci]); });
    $('[data-add]', cl).onmousedown = e => { e.preventDefault(); cl.hidden = true; addCustomer(cq.value.trim()); };
  };
  // Add or edit a Customer Master entry from here, then use it as Bill To.
  const saveCust = saved => {
    const i = custs.findIndex(x => x.id === saved.id); if (i >= 0) custs[i] = saved; else custs.push(saved);
    custs.sort((a, b) => a.name.localeCompare(b.name));
    pick(custEntry(saved));
  };
  const addCustomer = name => customerForm(name ? { name } : null, saveCust);
  const pick = c => { inv.clinic = { ...c }; cq.value = c.name; cl.hidden = true; showSel(); preview(); };
  cq.onfocus = () => { hl = -1; drawList(); };
  cq.oninput = () => { hl = -1; inv.clinic = cq.value.trim() ? { id: null, name: cq.value.trim(), address: '', mobile: '' } : null; drawList(); showSel(); preview(); };
  cq.onblur = () => setTimeout(() => cl.hidden = true, 150);
  cq.onkeydown = e => {
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, matches.length - 1); drawList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); drawList(); e.preventDefault(); }
    else if (e.key === 'Enter' && hl >= 0) { pick(matches[hl]); e.preventDefault(); }
    else if (e.key === 'Escape') cl.hidden = true;
  };
  const clinicForm = c => {
    const m = modal(`<h3>${c?.id ? 'Edit clinic' : 'Add clinic'}</h3><form class="grid">
      <label>Clinic / client name *<input name="name" required value="${esc(c?.name)}"></label>
      <label>Address<textarea name="address" rows="3">${esc(c?.address)}</textarea></label>
      <label>Mobile number<input name="mobile" type="tel" inputmode="tel" value="${esc(c?.mobile)}"></label>
      <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save clinic</button></div></form>`);
    m.querySelector('[data-x]').onclick = closeModal;
    m.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const body = { name: e.target.name.value, address: e.target.address.value, mobile: e.target.mobile.value };
      try {
        const saved = await api(c?.id ? 'PUT' : 'POST', c?.id ? `/api/clinics/${c.id}` : '/api/clinics', body);
        const i = clinics.findIndex(x => x.id === saved.id); if (i >= 0) clinics[i] = saved; else clinics.push(saved);
        clinics.sort((a, b) => a.name.localeCompare(b.name));
        closeModal(); pick(saved); toast('Clinic saved');
      } catch (err) { toast(err.message, true); }
    };
  };
  $('#addClinic').onclick = () => addCustomer(inv.clinic && !inv.clinic.id && !inv.clinic.customerId ? inv.clinic.name : '');
  $('#editClinic').onclick = () => {
    const c = inv.clinic;
    if (c?.customerId) { const cu = custs.find(x => x.id === c.customerId); if (cu) customerForm(cu, saveCust); }
    else clinicForm(clinics.find(x => x.id === c?.id) || c);
  };
  $('#bdate').onchange = e => { inv.billDate = e.target.value; preview(); };

  $('#newInv').onclick = () => { INV = null; if (location.hash === '#/invoice') router(); else location.hash = '#/invoice'; };
  $('#print').onclick = () => printLetterhead(inv);
  $('#saveInv').onclick = async () => {
    const items = inv.rows.filter(r => r.checked).map(r => ({ packageName: r.name || 'Package', billingType: r.billingType, amount: r2(r.amount), discount: r2(r.discount), taxPercent: Number(r.taxPercent) || 0, amcAmount: r2(r.amc) }));
    if (!inv.clinic?.name) return toast('Select a clinic', true);
    if (!inv.billDate) return toast('Enter the bill date', true);
    if (!items.length) return toast('Select at least one package', true);
    const body = { clinicId: inv.clinic.id || null, clinicName: inv.clinic.name, clinicAddress: inv.clinic.address || '', clinicMobile: inv.clinic.mobile || '', billDate: inv.billDate, items };
    const btn = $('#saveInv'); btn.disabled = true;
    try {
      const saved = await api(inv.id ? 'PUT' : 'POST', inv.id ? `/api/invoices/${inv.id}` : '/api/invoices', body);
      toast(inv.id ? 'Invoice updated' : 'Invoice saved');
      inv.id = saved.id; location.hash = `#/invoice/${saved.id}`;
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  drawRows(); showSel(); preview();
  const img = $('#a4src img'); if (img && !img.complete) img.onload = scale;
  if (action === 'print') setTimeout(() => printLetterhead(inv), 300);
}

// ------------------------------------------------------------ saved invoices
async function invoices() {
  title('Saved Invoices');
  const list = await api('GET', '/api/invoices');
  view.innerHTML = `<div class="toolbar"><h2 class="grow">Saved Invoices</h2><input id="q" placeholder="Search clinic…" style="max-width:240px"><a class="btn primary" href="#/invoice" id="newInv">+ New invoice</a></div>
  <div class="card table-wrap" style="padding:0" id="tbl"></div>`;
  $('#newInv').onclick = () => { INV = null; };
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const rows = list.filter(i => !q || i.clinicName.toLowerCase().includes(q));
    $('#tbl').innerHTML = rows.length ? `<table class="list stack"><thead><tr><th>Date</th><th>Clinic</th><th>Packages</th><th style="text-align:right">Final ₹</th><th style="text-align:right">AMC ₹</th><th></th></tr></thead><tbody>
      ${rows.map(i => `<tr><td data-l="Date">${fmtDate(i.billDate)}</td><td data-l="Clinic"><b>${esc(i.clinicName)}</b>${i.clinicMobile ? `<div class="muted" style="font-size:.82rem">${esc(i.clinicMobile)}</div>` : ''}</td>
      <td data-l="Packages">${(i.packages || []).map(p => `<span class="chip">${esc(p)}</span>`).join(' ')}</td>
      <td data-l="Final ₹" style="text-align:right">${money(i.totalFinal)}</td><td data-l="AMC ₹" style="text-align:right">${money(i.totalAmc)}</td>
      <td class="actions"><div class="row-actions"><a class="btn sm" href="#/invoice/${i.id}">Edit</a><a class="btn sm" href="#/invoice/${i.id}/print">Print</a><button class="btn sm danger" data-del="${i.id}">Delete</button></div></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No saved invoices.</div>';
    $$('[data-del]').forEach(b => b.onclick = async () => {
      const i = list.find(x => x.id == b.dataset.del);
      if (!await confirmBox(`Delete invoice for "${i.clinicName}" dated ${fmtDate(i.billDate)}?`)) return;
      try { await api('DELETE', `/api/invoices/${i.id}`); if (INV?.id === i.id) INV = null; toast('Invoice deleted'); invoices(); } catch (e) { toast(e.message, true); }
    });
  };
  $('#q').oninput = draw; draw();
}

// ------------------------------------------------------------ change password
async function passwordView() {
  title('Change password');
  view.innerHTML = `<form class="card grid" style="max-width:420px" id="pf"><h2>Change password</h2>
    <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
    <label>New password (min 8 chars)<input type="password" name="new" required minlength="8" autocomplete="new-password"></label>
    <label>Confirm new password<input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
    <button class="btn primary">Update password</button></form>`;
  $('#pf').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    if (f.new.value !== f.confirm.value) return toast('Passwords do not match', true);
    try { await api('POST', '/api/auth/change-password', { current: f.current.value, new: f.new.value }); toast('Password updated'); f.reset(); }
    catch (err) { toast(err.message, true); }
  };
}

boot();
