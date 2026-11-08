/* ClientMap · navigation: desktop top bar / side column + phone drill-down menu.
   One MENU_GROUPS config drives every view. No build step. */
'use strict';
(function () {
  // ------------------------------------------------------------ config
  // Groups hold leaves ({ key, label, to }) or nested nodes ({ label, submenu: [...] }).
  const MENU_GROUPS = [
    { group: 'Dashboard', items: [{ key: 'dashboard', label: 'Dashboard', to: '#/' }] },
    { group: 'Master', items: [
      { key: 'projects', label: 'Project Master', to: '#/projects' },
      { key: 'customers', label: 'Customer Master', to: '#/customers' },
    ] },
    { group: 'Field Work', items: [
      { label: 'Outreach', submenu: [
        { key: 'share', label: 'Project Share', to: '#/share' },
        { key: 'route', label: 'Client Route', to: '#/route' },
      ] },
      { label: 'Visit Details', submenu: [
        { key: 'visits', label: 'Visits', to: '#/visits' },
        { key: 'followups', label: 'Follow-up Reports', to: '#/followups' },
      ] },
    ] },
    { group: 'Invoice', items: [
      { key: 'invoice', label: 'Invoice', to: '#/invoice' },
      { key: 'invoices', label: 'Saved Invoices', to: '#/invoices' },
    ] },
    { group: 'Tools', items: [{ key: 'voice', label: 'Voice to Text', to: '#/voice' }] },
    { group: 'Settings', items: [{ key: 'password', label: 'Change Password', to: '#/password' }] },
  ];
  // One colour per main menu: used by the phone menu and every page header.
  const MENU_TONE_OF = { Dashboard: 'brand', Master: 'violet', 'Field Work': 'teal', Invoice: 'amber', Tools: 'sky', Settings: 'slate' };
  // label / key → sprite icon
  const ICON = {
    Dashboard: 'i-dash', Master: 'i-box', 'Field Work': 'i-compass', Invoice: 'i-receipt', Tools: 'i-mic', Settings: 'i-settings',
    Outreach: 'i-send', 'Visit Details': 'i-clip',
    dashboard: 'i-dash', projects: 'i-box', customers: 'i-users', share: 'i-share', route: 'i-route',
    visits: 'i-pin', followups: 'i-cal', invoice: 'i-file', invoices: 'i-archive', password: 'i-key', voice: 'i-mic',
  };
  const CARD_GRADS = ['g-blue', 'g-teal', 'g-violet', 'g-amber', 'g-rose', 'g-sky', 'g-emerald'];

  // ------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#${id || 'i-dot'}"/></svg>`;
  const iconOf = n => ICON[n.key] || ICON[n.label] || ICON[n.group] || 'i-dot';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  function mark(text, q) {
    const t = esc(text); if (!q) return t;
    const i = text.toLowerCase().indexOf(q); if (i < 0) return t;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function flatten(nodes, trail) {
    return nodes.flatMap(n => n.submenu ? flatten(n.submenu, [...trail, n.label]) : [{ ...n, trail }]);
  }
  const ALL = MENU_GROUPS.flatMap(g => flatten(g.items, [g.group]).map(l => ({ ...l, group: g.group })));
  const has = (n, key) => n.key === key || (n.submenu || []).some(c => has(c, key));
  const groupHas = (g, key) => g.items.some(n => has(n, key));
  const isSingle = g => g.items.length === 1 && !g.items[0].submenu && g.items[0].label === g.group;
  const count = n => n.submenu ? n.submenu.reduce((a, c) => a + count(c), 0) : 1;
  const countG = g => g.items.reduce((a, c) => a + count(c), 0);

  function currentKey() {
    const p = location.hash.replace(/^#\/?/, '').split('/')[0];
    return p === '' ? 'dashboard' : p === 'visit' ? 'visits' : p;
  }
  function sectionOf(key = currentKey()) {
    const l = ALL.find(x => x.key === key);
    if (!l) return { group: '', trail: [], label: '', tone: 'brand', icon: 'i-dot' };
    return { group: l.group, trail: l.trail, label: l.label, tone: MENU_TONE_OF[l.group] || 'brand', icon: iconOf(l) };
  }

  // ------------------------------------------------------------ desktop top bar
  const shell = $('#shell'), topnav = $('#topnav'), side = $('#sidenav');
  let drop = null, dropBtn = null;

  function renderTop() {
    const k = currentKey();
    topnav.innerHTML = MENU_GROUPS.map((g, i) => {
      const on = groupHas(g, k) ? ' on' : '';
      if (isSingle(g)) return `<a class="tn-btn${on}" href="${g.items[0].to}">${ic(iconOf(g))}<span>${esc(g.group)}</span></a>`;
      return `<button type="button" class="tn-btn${on}" data-g="${i}" aria-haspopup="true" aria-expanded="false">${ic(iconOf(g))}<span>${esc(g.group)}</span>${ic('i-down', 'chev')}</button>`;
    }).join('');
  }

  function simpleList(nodes, k) {
    return nodes.map(n => n.submenu
      ? `<div class="dd-sub">${esc(n.label)}</div><div class="dd-indent">${simpleList(n.submenu, k)}</div>`
      : `<a class="dd-link${n.key === k ? ' on' : ''}" href="${n.to}">${ic(iconOf(n))}<span>${esc(n.label)}</span></a>`).join('');
  }

  function gridPanel(g, k) {
    const loose = g.items.filter(n => !n.submenu);
    const cards = [...g.items.filter(n => n.submenu), ...(loose.length ? [{ label: g.group, submenu: loose, loose: true }] : [])];
    return `<div class="gp-head">${ic(iconOf(g))}<b>${esc(g.group)}</b><span class="gp-count">· ${cards.length} sections</span>
        <label class="gp-search">${ic('i-search')}<input type="search" placeholder="Search pages…" aria-label="Search ${esc(g.group)} pages"></label></div>
      <div class="gp-grid">${cards.map((c, i) => `<div class="gp-card" data-card>
        <span class="gp-edge ${CARD_GRADS[i % CARD_GRADS.length]}"></span>
        <div class="gp-title"><span class="gp-chip ${CARD_GRADS[i % CARD_GRADS.length]}">${ic(c.loose ? iconOf(g) : iconOf(c))}</span>${esc(c.label)}</div>
        ${flatten(c.submenu, []).map(l => `<a class="gp-link${l.key === k ? ' on' : ''}" href="${l.to}" data-label="${esc(l.label)}"><span>${esc(l.label)}</span>${ic('i-chev', 'nudge')}</a>`).join('')}
      </div>`).join('')}</div>
      <div class="gp-empty" hidden>No pages match.</div>`;
  }

  function openDrop(btn) {
    closeDrop();
    const g = MENU_GROUPS[btn.dataset.g], k = currentKey();
    const grid = g.items.filter(n => n.submenu).length >= 2;
    drop = document.createElement('div');
    drop.className = 'tn-drop menu-drop' + (grid ? ' grid' : '');
    drop.setAttribute('role', 'menu');
    drop.innerHTML = grid ? gridPanel(g, k) : `<div class="dd-list">${simpleList(g.items, k)}</div>`;
    if (grid) {
      const cards = drop.querySelectorAll('[data-card]').length;
      drop.style.width = `min(${cards * 184 + 32}px, calc(100vw - 16px))`;
    }
    shell.appendChild(drop);
    dropBtn = btn; btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    place();
    if (grid) wireGridSearch();
  }
  function place() {
    if (!drop || !dropBtn) return;
    const r = dropBtn.getBoundingClientRect(), w = drop.offsetWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    drop.style.left = left + 'px';
    drop.style.top = (r.bottom + 6) + 'px';
    drop.style.maxHeight = Math.max(160, innerHeight - r.bottom - 14) + 'px';
  }
  function closeDrop() {
    if (drop) drop.remove();
    if (dropBtn) { dropBtn.classList.remove('open'); dropBtn.setAttribute('aria-expanded', 'false'); }
    drop = dropBtn = null;
  }
  function wireGridSearch() {
    const inp = drop.querySelector('.gp-search input');
    setTimeout(() => inp.focus(), 20);
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase(); let any = false;
      drop.querySelectorAll('[data-card]').forEach(card => {
        let vis = 0;
        card.querySelectorAll('.gp-link').forEach(a => {
          const lb = a.dataset.label, ok = !q || lb.toLowerCase().includes(q);
          a.hidden = !ok; a.querySelector('span').innerHTML = mark(lb, q); if (ok) vis++;
        });
        card.hidden = !vis; if (vis) any = true;
      });
      drop.querySelector('.gp-empty').hidden = any;
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const a = drop.querySelector('.gp-link:not([hidden])'); if (a) location.hash = a.getAttribute('href'); }
      if (e.key === 'Escape') { e.stopPropagation(); if (inp.value) { inp.value = ''; inp.dispatchEvent(new Event('input')); } else closeDrop(); }
    });
  }

  topnav.addEventListener('click', e => {
    const b = e.target.closest('button[data-g]'); if (!b) return;
    e.stopPropagation();
    if (dropBtn === b) closeDrop(); else openDrop(b);
  });
  topnav.addEventListener('scroll', closeDrop, { passive: true });
  document.addEventListener('click', e => { if (drop && !drop.contains(e.target) && !e.target.closest('[data-g]')) closeDrop(); });
  addEventListener('resize', place);

  // ------------------------------------------------------------ desktop side column
  let sideQ = '', sideHi = 0;
  function sideNodes(nodes, k) {
    return nodes.map(n => n.submenu
      ? `<div class="sn-group sub${has(n, k) ? ' open' : ''}"><button type="button" class="sn-head">${ic(iconOf(n))}<span>${esc(n.label)}</span>${ic('i-chev', 'chev')}</button><div class="sn-body">${sideNodes(n.submenu, k)}</div></div>`
      : `<a class="sn-link${n.key === k ? ' on' : ''}" href="${n.to}">${esc(n.label)}</a>`).join('');
  }
  function renderSide() {
    const k = currentKey();
    side.innerHTML = `<div class="sn-search">${ic('i-search')}<input type="search" placeholder="Search menu…" aria-label="Search menu" value="${esc(sideQ)}"></div>
      <div class="sn-results" hidden></div>
      <div class="sn-tree">${MENU_GROUPS.map(g => isSingle(g)
        ? `<a class="sn-top${groupHas(g, k) ? ' on' : ''}" href="${g.items[0].to}">${ic(iconOf(g))}<span>${esc(g.group)}</span></a>`
        : `<div class="sn-group${groupHas(g, k) ? ' open' : ''}"><button type="button" class="sn-head top">${ic(iconOf(g))}<span>${esc(g.group)}</span>${ic('i-chev', 'chev')}</button><div class="sn-body">${sideNodes(g.items, k)}</div></div>`).join('')}</div>`;
    const inp = side.querySelector('input');
    inp.addEventListener('input', () => { sideQ = inp.value; sideHi = 0; drawSideResults(); });
    inp.addEventListener('keydown', e => {
      const items = side.querySelectorAll('.sn-res');
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sideHi = (sideHi + 1) % items.length; drawSideResults(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sideHi = (sideHi - 1 + items.length) % items.length; drawSideResults(); }
      else if (e.key === 'Enter' && items[sideHi]) { e.preventDefault(); sideQ = ''; location.hash = items[sideHi].getAttribute('href'); }
      else if (e.key === 'Escape') { sideQ = ''; inp.value = ''; drawSideResults(); }
    });
    drawSideResults();
  }
  function drawSideResults() {
    const q = sideQ.trim().toLowerCase(), box = side.querySelector('.sn-results'), tree = side.querySelector('.sn-tree');
    if (!q) { box.hidden = true; tree.hidden = false; return; }
    const hits = ALL.filter(l => [...l.trail, l.label].join(' ').toLowerCase().includes(q));
    box.innerHTML = hits.length ? hits.map((l, i) => `<a class="sn-res${i === sideHi ? ' hi' : ''}" href="${l.to}"><small>${l.trail.map(esc).join(' › ')} ›</small>${mark(l.label, q)}</a>`).join('')
      : '<div class="sn-none">No pages match.</div>';
    box.hidden = false; tree.hidden = true;
  }
  side.addEventListener('click', e => {
    const h = e.target.closest('.sn-head'); if (h) h.parentElement.classList.toggle('open');
    if (e.target.closest('.sn-res')) sideQ = '';
  });

  function setSide(on) {
    shell.classList.toggle('nav-side', on);
    const t = $('#navToggle');
    t.innerHTML = ic(on ? 'i-panel-top' : 'i-panel');
    t.setAttribute('aria-label', on ? 'Move menu to the top' : 'Move menu to the side');
    store.set('nav-side', on ? '1' : '0');
    closeDrop();
  }
  $('#navToggle').addEventListener('click', () => setSide(!shell.classList.contains('nav-side')));

  // ------------------------------------------------------------ phone menu (FAB + drill-down)
  const fab = document.createElement('button');
  fab.type = 'button'; fab.className = 'fab no-print'; fab.setAttribute('aria-label', 'Open menu'); fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = `<span class="fab-halo"></span><span class="fab-ic m">${ic('i-menu')}</span><span class="fab-ic x">${ic('i-x')}</span>`;
  shell.appendChild(fab);
  let pm = null, pmTrail = [], pmDir = 'fwd', userName = '';

  function levelNodes(trail) {
    if (!trail.length) return null;
    let nodes = MENU_GROUPS[trail[0]].items;
    for (const i of trail.slice(1)) nodes = nodes[i].submenu;
    return nodes;
  }
  function levelTitles(trail) {
    const out = []; if (!trail.length) return out;
    out.push(MENU_GROUPS[trail[0]].group);
    let nodes = MENU_GROUPS[trail[0]].items;
    for (const i of trail.slice(1)) { out.push(nodes[i].label); nodes = nodes[i].submenu; }
    return out;
  }
  function pmRow(n, i, tone, k) {
    const isG = !!n.items, leaf = isG ? (isSingle(n) ? n.items[0] : null) : (n.submenu ? null : n);
    const label = isG ? n.group : n.label;
    const active = leaf ? leaf.key === k : (isG ? groupHas(n, k) : has(n, k));
    const kids = isG ? n.items : n.submenu;
    const preview = !leaf ? kids.map(c => c.label).join(' · ') : (active ? 'You are here' : '');
    const delay = reduced() ? 0 : 40 + i * 35;
    const inner = `<span class="pm-chip ${active && leaf ? 'solid' : ''}">${ic(iconOf(isG ? n : n))}</span>
      <span class="pm-txt"><b>${esc(label)}</b>${preview ? `<small>${esc(preview)}</small>` : ''}</span>
      ${!leaf ? `<span class="pm-count">${isG ? countG(n) : count(n)}</span>` : ''}${ic('i-chev', 'pm-chev')}`;
    const cls = `pm-row menu-item-in tone-${tone}${active ? ' on' : ''}${leaf ? ' leaf' : ''}`;
    return leaf
      ? `<a class="${cls}" href="${leaf.to}" style="animation-delay:${delay}ms">${inner}</a>`
      : `<button type="button" class="${cls}" data-i="${i}" style="animation-delay:${delay}ms">${inner}</button>`;
  }
  function renderPM() {
    if (!pm) return;
    const k = currentKey(), depth = pmTrail.length, titles = levelTitles(pmTrail);
    const tone = depth ? (MENU_TONE_OF[MENU_GROUPS[pmTrail[0]].group] || 'brand') : null;
    const head = depth
      ? `<button type="button" class="pm-back" aria-label="Back">${ic('i-left')}</button>
         <div class="pm-ttl menu-title-in"><b>${esc(titles[titles.length - 1])}</b><small>Main Menu › ${titles.map(esc).join(' › ')}</small></div>
         <button type="button" class="pm-home">${ic('i-home')}Main Menu</button>`
      : `<span class="pm-tile">${ic('i-grid')}</span>
         <div class="pm-ttl menu-title-in"><b>Main Menu</b><small>Hi ${esc(userName || 'there')} · where to next?</small></div>`;
    const maxDepth = 3;
    const dots = Array.from({ length: maxDepth }, (_, i) => `<i class="${i === depth ? 'cur' : i < depth ? 'past' : ''}"></i>`).join('');
    const rows = depth
      ? levelNodes(pmTrail).map((n, i) => pmRow(n, i, tone, k))
      : MENU_GROUPS.map((g, i) => pmRow(g, i, MENU_TONE_OF[g.group] || 'brand', k));
    pm.panel.innerHTML = `<div class="pm-head"><span class="pm-c1"></span><span class="pm-c2"></span><div class="pm-hrow">${head}</div><div class="pm-dots">${dots}</div></div>
      <nav class="pm-list menu-slide-${pmDir}" aria-label="Menu level">${rows.join('')}</nav>`;
  }
  function openPM() {
    if (pm) return;
    const bd = document.createElement('div'); bd.className = 'pm-backdrop menu-fade';
    const panel = document.createElement('div'); panel.className = 'pm-panel menu-pop'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Main menu');
    shell.append(bd, panel);
    pm = { bd, panel };
    pmTrail = []; pmDir = 'fwd';   // always starts at the main menus
    renderPM(); positionFab();
    bd.addEventListener('click', closePM);
    panel.addEventListener('click', e => {
      if (e.target.closest('.pm-back')) { pmTrail = pmTrail.slice(0, -1); pmDir = 'back'; renderPM(); return; }
      if (e.target.closest('.pm-home')) { pmTrail = []; pmDir = 'back'; renderPM(); return; }
      const b = e.target.closest('button.pm-row');
      if (b) { pmTrail = [...pmTrail, Number(b.dataset.i)]; pmDir = 'fwd'; renderPM(); return; }
      if (e.target.closest('a.pm-row')) closePM();
    });
    fab.classList.add('open'); fab.setAttribute('aria-expanded', 'true'); fab.setAttribute('aria-label', 'Close menu');
  }
  function closePM() {
    if (!pm) return;
    pm.bd.remove(); pm.panel.remove(); pm = null;
    fab.classList.remove('open'); fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-label', 'Open menu');
  }
  fab.addEventListener('click', () => { fab.classList.add('used'); pm ? closePM() : openPM(); });

  // FAB sits inside a page's fixed bottom bar ([data-phone-footer]) when one exists
  let footRO = null, footEl = null;
  function positionFab() {
    const f = document.querySelector('[data-phone-footer]');
    let bottom = 16;
    if (f && f.offsetParent !== null) {
      const r = f.getBoundingClientRect();
      bottom = Math.max(8, innerHeight - r.bottom + (r.height - 44) / 2);
    }
    if (f !== footEl) {
      if (footRO) footRO.disconnect();
      footEl = f;
      if (f && 'ResizeObserver' in window) { footRO = new ResizeObserver(positionFab); footRO.observe(f); }
    }
    fab.style.bottom = bottom + 'px';
    if (pm) pm.panel.style.bottom = (bottom + 44 + 12) + 'px';
  }
  new MutationObserver(positionFab).observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', positionFab);

  // ------------------------------------------------------------ page header (CardHeader)
  const view = $('#view');
  function decorate() {
    const kids = [...view.children];
    if (!kids.length || view.querySelector(':scope > .page-head')) return;
    if (kids.length === 1 && kids[0].classList.contains('empty') && /Loading/.test(kids[0].textContent)) return;
    const sec = sectionOf();
    const h2 = view.querySelector('h2');
    const titleText = h2 ? h2.textContent.trim() : (document.title.split(' · ')[0] || sec.label);
    const crumb = sec.trail.filter((t, i) => i === 0 || t !== sec.label).join(' › ');
    const main = document.createElement('div');
    main.className = 'ph-main';
    main.innerHTML = `<span class="ph-tile">${ic(sec.icon)}</span><div class="ph-text">${crumb ? `<div class="ph-crumb">${esc(crumb)}</div>` : ''}<h2>${esc(titleText)}</h2></div>`;
    const tb = h2 && h2.parentElement.classList.contains('toolbar') && h2.parentElement.parentElement === view ? h2.parentElement : null;
    let head;
    if (tb) {
      head = tb;
      const actions = [...tb.children].filter(c => c !== h2);
      const back = actions.filter(a => a.matches('a.btn') && /←|Visit list/.test(a.textContent));
      h2.remove();
      const act = document.createElement('div'); act.className = 'ph-actions';
      actions.filter(a => !back.includes(a)).forEach(a => act.appendChild(a));
      tb.innerHTML = '';
      back.forEach(b => { b.classList.add('ph-back'); tb.appendChild(b); });
      tb.append(main, act);
    } else {
      head = document.createElement('div');
      head.className = 'toolbar';
      head.appendChild(main);
      view.prepend(head);
      // a bare page title (directly in the page, or first thing in a card) is now in the header
      if (h2 && (h2.parentElement === view || h2.parentElement.firstElementChild === h2)) h2.remove();
    }
    head.classList.add('page-head', 'tone-' + sec.tone);
    view.classList.remove('animate-fade-in'); void view.offsetWidth; view.classList.add('animate-fade-in');
  }
  new MutationObserver(decorate).observe(view, { childList: true });

  // ------------------------------------------------------------ route + key wiring
  function sync() { closeDrop(); closePM(); sideQ = ''; renderTop(); renderSide(); }
  addEventListener('hashchange', sync);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (drop) closeDrop();
    if (pm) closePM();
  });

  // login: password eye + year
  const eye = $('#pwEye');
  if (eye) eye.addEventListener('click', () => {
    const inp = eye.parentElement.querySelector('input'), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    eye.innerHTML = ic(show ? 'i-eye-off' : 'i-eye');
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  const yr = $('#lgYear'); if (yr) yr.textContent = new Date().getFullYear();

  setSide(store.get('nav-side') === '1');
  sync();

  window.NAV = {
    MENU_GROUPS, MENU_TONE_OF, sectionOf,
    setUser(name) { userName = name; },
    close() { closeDrop(); closePM(); },
  };
})();
