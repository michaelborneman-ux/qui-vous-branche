/* Qui vous branche - address -> ISED coverage cell -> providers and plans.
   No backend: coverage ships as static 0.5-degree shards under data/hex/. */

(() => {
  'use strict';

  const GEOCODE = 'https://geogratis.gc.ca/services/geolocation/';
  const CELL = 0.5;
  const QC_BOUNDS = { latMin: 44.9, latMax: 62.6, lonMin: -79.9, lonMax: -56.9 };
  const MAX_CELL_DIST_KM = 6;      // a hexagon is ~7 km across; beyond this there is no cell
  const STALE_DAYS = 90;
  const TECH_ORDER = ['fibre', 'cable', 'dsl', 'fixedWireless', 'satellite', 'mobile'];

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    lang: 'fr',
    meta: null,
    providers: [],
    byId: new Map(),
    plans: [],
    shards: new Map(),
    result: null,
    sort: 'value',
  };

  const t = () => window.I18N[state.lang];

  /* ---------- geometry ---------- */

  const kmPerLat = 110.574;
  const kmPerLon = lat => 111.320 * Math.cos(lat * Math.PI / 180);

  function distKm(lat1, lon1, lat2, lon2) {
    const x = (lon2 - lon1) * kmPerLon((lat1 + lat2) / 2);
    const y = (lat2 - lat1) * kmPerLat;
    return Math.hypot(x, y);
  }

  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

  // The point can sit near a cell edge, so also consider neighbouring shards.
  function candidateCells(lat, lon) {
    const keys = new Set([cellKey(lat, lon)]);
    const pad = 0.06;
    for (const dlat of [-pad, 0, pad]) {
      for (const dlon of [-pad, 0, pad]) keys.add(cellKey(lat + dlat, lon + dlon));
    }
    return [...keys];
  }

  // Shards are cached cache-first and never revalidated, so the build stamp from
  // meta.json (which is fetched network-first) goes in the URL. A data refresh
  // changes every shard URL, which retires the old entries instead of leaving a
  // client serving a previous build's shape forever.
  async function loadShard(key) {
    if (state.shards.has(key)) return state.shards.get(key);
    const stamp = state.meta && state.meta.built ? `?b=${state.meta.built}` : '';
    const p = fetch(`data/hex/${key}.json${stamp}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    state.shards.set(key, p);
    return p;
  }

  function pointInPolygon(lat, lon, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [yi, xi] = pts[i];
      const [yj, xj] = pts[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Which cell a point belongs to is a point-in-polygon question, not a nearest
  // -centroid one: each province has its own grid, and along a border the two
  // overlap, so the containing cell can be further away than a neighbour's.
  // A Gatineau address sits inside both a QC and an ON cell; prefer the one
  // whose province matches the address.
  async function findCell(lat, lon, provinceHint) {
    const shards = (await Promise.all(candidateCells(lat, lon).map(loadShard))).filter(Boolean);
    const containing = [];
    let nearest = null;

    for (const shard of shards) {
      for (const hex of shard.hexes) {
        const prov = String(hex[2]).slice(0, 2);
        const geom = hex[4];
        const dist = distKm(lat, lon, hex[0], hex[1]);
        const cell = { dist, hex, geom, prov };
        if (!nearest || dist < nearest.dist) nearest = cell;
        if (geom && pointInPolygon(lat, lon, geom.map(([dy, dx]) => [hex[0] + dy, hex[1] + dx]))) {
          containing.push(cell);
        }
      }
    }

    if (containing.length) {
      const preferred = containing.filter(c => c.prov === provinceHint);
      const pool = preferred.length ? preferred : containing;
      return pool.reduce((a, b) => (a.dist <= b.dist ? a : b));
    }
    return nearest && nearest.dist <= MAX_CELL_DIST_KM ? nearest : null;
  }

  /* ---------- geocoding ---------- */

  // NRCan is the primary geocoder: it is Canadian, needs no key and handles
  // accented Quebec addresses. It redirects to another host that intermittently
  // answers without CORS headers, so Photon backs it up rather than letting a
  // single flaky response look like "address not found".
  async function geocode(query) {
    try {
      const rows = await geocodeNRCan(query);
      if (rows.length) return rows;
    } catch (err) {
      console.warn('NRCan geocoder unavailable, falling back to Photon', err);
    }
    return geocodePhoton(query);
  }

  async function geocodePhoton(query) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=${state.lang}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('photon ' + res.status);
    const data = await res.json();
    return (data.features || [])
      .filter(f => (f.properties || {}).countrycode === 'CA' && f.geometry)
      .map(f => {
        const p = f.properties;
        const street = [p.housenumber, p.street || p.name].filter(Boolean).join(' ');
        return {
          title: [street, p.city || p.county, p.state].filter(Boolean).join(', '),
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          kind: p.street || p.housenumber ? 'Street' : 'Geoname',
        };
      })
      .filter((p, i, all) => all.findIndex(o => o.title === p.title) === i)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 6);
  }

  async function geocodeNRCan(query) {
    const lang = state.lang === 'fr' ? 'fr' : 'en';
    const url = `${GEOCODE}${lang}/locate?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('geocode ' + res.status);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : [])
      .filter(r => r.geometry && r.geometry.type === 'Point')
      .map(r => ({
        title: r.title,
        lon: r.geometry.coordinates[0],
        lat: r.geometry.coordinates[1],
        kind: (r.type || '').split('.').pop(),
      }))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 6);
  }

  // geogratis mixes exact street matches with far-away placenames of a similar
  // name, so rank a real street in Quebec first.
  function score(place) {
    let n = 0;
    if (place.kind === 'Street') n += 4;
    if (/Qu[eé]bec/i.test(place.title)) n += 2;
    if (inQuebec(place)) n += 1;
    return n;
  }

  const inBounds = ({ lat, lon }) =>
    lat >= QC_BOUNDS.latMin && lat <= QC_BOUNDS.latMax &&
    lon >= QC_BOUNDS.lonMin && lon <= QC_BOUNDS.lonMax;

  // The coverage grid ignores provincial borders - an address in Gatineau can
  // belong to a cell labelled ON - so Quebec is decided by the province the
  // geocoder names, not by which cell the point lands in.
  //
  // geogratis titles end with the province: "25 Rue Laurier, Gatineau, Quebec".
  // Only that last segment counts - Montreal has a rue Ontario and a rue
  // Saskatchewan, so searching the whole title for a province name is wrong.
  function provinceOf(title) {
    const last = String(title).split(',').pop();
    return last.replace(/\([^)]*\)/g, '').trim();
  }

  const OTHER_PROVINCES = /^(Ontario|New Brunswick|Nouveau-Brunswick|Nova Scotia|Nouvelle-Écosse|Newfoundland and Labrador|Terre-Neuve-et-Labrador|Manitoba|Saskatchewan|Alberta|British Columbia|Colombie-Britannique|Prince Edward Island|Île-du-Prince-Édouard|Yukon|Nunavut|Northwest Territories|Territoires du Nord-Ouest)$/i;

  const PROVINCE_CODES = {
    quebec: 'QC', 'québec': 'QC', ontario: 'ON',
    'new brunswick': 'NB', 'nouveau-brunswick': 'NB',
    'newfoundland and labrador': 'NL', 'terre-neuve-et-labrador': 'NL',
  };

  const provinceCode = place => PROVINCE_CODES[provinceOf(place.title).toLowerCase()] || 'QC';

  function inQuebec(place) {
    const prov = provinceOf(place.title);
    if (/^Qu[eé]bec$/i.test(prov)) return true;
    if (OTHER_PROVINCES.test(prov)) return false;
    return inBounds(place);          // the title did not name a province
  }

  /* ---------- rendering: the coverage cell ---------- */

  function drawCell(place, cell) {
    const [hexLat, hexLon] = cell.hex;
    const svg = $('#hexmap');
    const geom = cell.geom && cell.geom.length
      ? cell.geom
      : regularHex();                       // fallback if a shard shipped without geometry

    // Work in km relative to the cell's reported point. That point is not the
    // polygon's centre, so centre the drawing on the outline's own bounds and
    // move the address dot by the same amount.
    const pts = geom.map(([dlat, dlon]) => [dlon * kmPerLon(hexLat), dlat * kmPerLat]);
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const halfW = (Math.max(...xs) - Math.min(...xs)) / 2;
    const halfH = (Math.max(...ys) - Math.min(...ys)) / 2;
    const scale = Math.min(54 / halfW, 44 / halfH);

    $('#hexshape').setAttribute('points',
      pts.map(([x, y]) => `${((x - cx) * scale).toFixed(2)},${(-(y - cy) * scale).toFixed(2)}`).join(' '));

    const px = ((place.lon - hexLon) * kmPerLon(hexLat) - cx) * scale;
    const py = -((place.lat - hexLat) * kmPerLat - cy) * scale;
    $('#hexpoint').setAttribute('transform', `translate(${px.toFixed(2)} ${py.toFixed(2)})`);

    const bar = 2 * scale;                  // a 2 km rule, so the cell has a real sense of size
    const g = $('#scalebar');
    g.querySelector('line').setAttribute('x1', -54);
    g.querySelector('line').setAttribute('x2', -54 + bar);
    g.querySelector('line').setAttribute('y1', 47);
    g.querySelector('line').setAttribute('y2', 47);
    const label = g.querySelector('text');
    label.setAttribute('x', -54);
    label.setAttribute('y', 51);
    label.textContent = '2 km';

    svg.setAttribute('aria-label', t().hexTitle);

    $('#fact-address').textContent = place.title;
    $('#fact-hexid').textContent = cell.hexid || '—';
    $('#fact-asof').textContent = state.meta ? state.meta.built : '—';
  }

  function regularHex() {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const a = (Math.PI / 3) * i;
      out.push([0.024 * Math.sin(a), 0.040 * Math.cos(a)]);
    }
    return out;
  }

  /* ---------- rendering: providers ---------- */

  function groupByTech(entries) {
    const groups = new Map();
    for (const [idx, tech, speed] of entries) {
      if (!groups.has(tech)) groups.set(tech, { tech, best: 0, isps: [] });
      const g = groups.get(tech);
      g.best = Math.max(g.best, speed);
      g.isps.push({ provider: state.providers[idx], speed });
    }
    for (const g of groups.values()) {
      g.isps.sort((a, b) => b.speed - a.speed || a.provider.name.localeCompare(b.provider.name));
    }
    return TECH_ORDER.filter(k => groups.has(k)).map(k => groups.get(k));
  }

  function renderProviders(groups) {
    const host = $('#providers');
    host.textContent = '';
    for (const g of groups) {
      const wrap = el('div', 'techgroup');
      wrap.style.setProperty('--tech', `var(--${g.tech.toLowerCase()})`);

      const head = el('div', 'techhead');
      head.append(el('span', 'techdot'));
      head.append(el('h3', 'techname', t().tech[g.tech]));
      if (g.best) head.append(el('span', 'techspeed', t().speed[g.best]));
      wrap.append(head);

      const list = el('ul', 'isplist');
      for (const { provider, speed } of g.isps) {
        const li = el('li');
        li.append(el('span', 'isp-name', provider.name));
        if (speed && speed !== g.best) li.append(el('span', 'techspeed', t().speed[speed]));
        if (provider.url) {
          const a = el('a', 'isp-link', t().check + ' ↗');
          a.href = provider.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          li.append(a);
        }
        list.append(li);
      }
      wrap.append(list);
      host.append(wrap);
    }
  }

  /* ---------- rendering: plans ---------- */

  function matchPlans(entries) {
    const present = new Map();     // providerId -> Set(tech)
    for (const [idx, tech] of entries) {
      const id = state.providers[idx].id;
      if (!present.has(id)) present.set(id, new Set());
      present.get(id).add(tech);
    }

    const out = [];
    for (const plan of state.plans) {
      if (plan.anywhere) { out.push({ plan, resoldOn: null }); continue; }
      if (present.get(plan.provider) && present.get(plan.provider).has(plan.tech)) {
        out.push({ plan, resoldOn: null });
        continue;
      }
      const host = (plan.ridesOn || []).find(op => present.get(op) && present.get(op).has(plan.tech));
      if (host) out.push({ plan, resoldOn: host });
    }
    return out;
  }

  // Plans whose price is only revealed after an address check sort last in the
  // price-based orders, but still rank normally by speed.
  const priced = p => (p.price == null ? Infinity : p.price);
  const sorters = {
    value: (a, b) => priced(a.plan) / a.plan.down - priced(b.plan) / b.plan.down,
    price: (a, b) => priced(a.plan) - priced(b.plan),
    speed: (a, b) => b.plan.down - a.plan.down,
  };

  function daysSince(iso) {
    return Math.round((Date.now() - new Date(iso + 'T00:00:00Z').getTime()) / 86400000);
  }

  function providerName(id) {
    const p = state.byId.get(id);
    return p ? p.name : id;
  }

  function renderPlans(entries) {
    const host = $('#plans');
    host.textContent = '';
    const matches = matchPlans(entries).sort(sorters[state.sort]);

    if (!matches.length) {
      host.append(el('p', 'caveat', t().noPlans));
      return;
    }

    for (const { plan, resoldOn } of matches) {
      const row = el('div', 'plan');
      row.style.setProperty('--tech', `var(--${plan.tech.toLowerCase()})`);

      const main = el('div', 'plan-main');
      main.append(el('span', 'plan-isp', plan.providerName || providerName(plan.provider)));
      main.append(el('span', 'plan-name', plan.name[state.lang] || plan.name.en));
      main.append(el('span', 'tag', t().tech[plan.tech]));
      if (resoldOn) main.append(el('span', 'tag tag-resold', t().resoldOn(providerName(resoldOn))));
      if (plan.anywhere) main.append(el('span', 'tag tag-resold', t().anywhere));
      const age = daysSince(plan.verified);
      if (age > STALE_DAYS) main.append(el('span', 'tag tag-stale', t().stale));
      row.append(main);

      const price = el('div', 'plan-price');
      if (plan.price == null) {
        price.classList.add('plan-price-unknown');
        price.textContent = t().priceOnCheck;
      } else if (plan.promoPrice) {
        price.append(document.createTextNode(money(plan.promoPrice)));
        price.append(el('s', null, ` ${money(plan.price)}`));
      } else {
        price.textContent = money(plan.price);
      }
      row.append(price);

      const meta = el('div', 'plan-meta');
      meta.append(el('span', 'plan-speed',
        plan.up ? `${plan.down}/${plan.up} Mbps` : `${plan.down} Mbps`));
      meta.append(el('span', null, plan.cap === 'unlimited' ? t().unlimited : plan.cap));
      meta.append(el('span', null, plan.term === 'month-to-month' ? t().monthToMonth : t().term(plan.term)));
      if (plan.promoPrice) meta.append(el('span', null, `${t().promo(plan.promoMonths)} ${money(plan.price)}`));
      if (plan.note) meta.append(el('span', null, plan.note));
      meta.append(el('span', null, t().verified(plan.verified)));
      if (plan.source) {
        const a = el('a', null, t().check + ' ↗');
        a.href = plan.source;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        meta.append(a);
      }
      row.append(meta);
      host.append(row);
    }
  }

  const money = n => new Intl.NumberFormat(state.lang === 'fr' ? 'fr-CA' : 'en-CA',
    { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n);

  /* ---------- flow ---------- */

  function showError(key) {
    $('#result').hidden = true;
    const box = $('#empty');
    box.hidden = false;
    $('#empty-title').textContent = t()[key].t;
    $('#empty-body').textContent = t()[key].b;
  }

  function showResult() {
    const r = state.result;
    if (!r) return;
    $('#empty').hidden = true;
    $('#result').hidden = false;
    drawCell(r.place, r.cell);
    renderProviders(groupByTech(r.entries));
    renderPlans(r.entries);
  }

  async function lookup(place) {
    if (!inQuebec(place)) { showError('errOutside'); return; }
    const cell = await findCell(place.lat, place.lon, provinceCode(place));
    if (!cell) { showError('errNoCell'); return; }

    state.result = {
      place,
      cell: { hex: cell.hex, geom: cell.geom, hexid: cell.hex[2] },
      entries: cell.hex[3],
    };
    showResult();
    const url = new URL(location.href);
    url.searchParams.set('q', place.title);
    history.replaceState(null, '', url);
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSuggestions(list) {
    const host = $('#suggestions');
    host.textContent = '';
    if (!list.length) { host.hidden = true; return; }
    for (const place of list) {
      const li = el('li');
      const btn = el('button', null);
      btn.type = 'button';
      btn.append(el('span', 'sug-kind', place.kind || ''));
      btn.append(document.createTextNode(place.title));
      btn.addEventListener('click', () => {
        host.hidden = true;
        $('#address').value = place.title;
        lookup(place);
      });
      li.append(btn);
      host.append(li);
    }
    host.hidden = false;
  }

  async function runSearch(query) {
    const go = $('.go');
    go.disabled = true;
    const label = go.textContent;
    go.textContent = t().searching;
    try {
      if (!navigator.onLine) { showError('errOffline'); return; }
      const places = await geocode(query);
      if (!places.length) { showError('errNotFound'); renderSuggestions([]); return; }
      $('#empty').hidden = true;
      if (places.length === 1) { renderSuggestions([]); await lookup(places[0]); }
      else renderSuggestions(places);
    } catch (err) {
      console.error(err);
      showError('errNetwork');
    } finally {
      go.disabled = false;
      go.textContent = label;
    }
  }

  /* ---------- language ---------- */

  function applyLang() {
    document.documentElement.lang = state.lang;
    for (const node of document.querySelectorAll('[data-i18n]')) {
      const val = t()[node.dataset.i18n];
      if (typeof val === 'string') node.textContent = val;
    }
    for (const node of document.querySelectorAll('[data-i18n-attr]')) {
      const [attr, key] = node.dataset.i18nAttr.split(':');
      if (t()[key]) node.setAttribute(attr, t()[key]);
    }
    for (const btn of document.querySelectorAll('.lang-btn')) {
      btn.classList.toggle('is-on', btn.dataset.lang === state.lang);
      btn.setAttribute('aria-pressed', btn.dataset.lang === state.lang);
    }
    if (state.meta) {
      $('#hero-note').textContent = t().heroNote({
        hexCount: state.meta.hexCount.toLocaleString(state.lang === 'fr' ? 'fr-CA' : 'en-CA'),
        asOf: state.meta.built,
      });
    }
    document.title = state.lang === 'fr'
      ? 'Qui vous branche · Internet au Québec'
      : 'Who wires you · Internet in Quebec';
    if (state.result) showResult();
  }

  function setLang(lang) {
    state.lang = lang;
    try { localStorage.setItem('lang', lang); } catch (e) { /* private mode */ }
    applyLang();
  }

  /* ---------- boot ---------- */

  async function init() {
    let saved = null;
    try { saved = localStorage.getItem('lang'); } catch (e) { /* private mode */ }
    const browserLang = (navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'fr';
    state.lang = saved === 'en' || saved === 'fr' ? saved : browserLang;

    const [meta, providers, plans] = await Promise.all([
      fetch('data/meta.json').then(r => r.json()).catch(() => null),
      fetch('data/providers.json').then(r => r.json()).catch(() => []),
      fetch('data/plans.json').then(r => r.json()).catch(() => []),
    ]);
    state.meta = meta;
    state.providers = providers;
    state.byId = new Map(providers.map(p => [p.id, p]));
    state.plans = plans;

    applyLang();

    $('#search-form').addEventListener('submit', ev => {
      ev.preventDefault();
      const q = $('#address').value.trim();
      if (q) runSearch(q);
    });

    for (const btn of document.querySelectorAll('.lang-btn')) {
      btn.addEventListener('click', () => setLang(btn.dataset.lang));
    }

    for (const btn of document.querySelectorAll('.sort-btn')) {
      btn.addEventListener('click', () => {
        state.sort = btn.dataset.sort;
        for (const b of document.querySelectorAll('.sort-btn')) b.classList.toggle('is-on', b === btn);
        if (state.result) renderPlans(state.result.entries);
      });
    }

    const q = new URL(location.href).searchParams.get('q');
    if (q) { $('#address').value = q; runSearch(q); }

    if ('serviceWorker' in navigator) {
      addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }

  init();
})();
