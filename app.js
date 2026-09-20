/* Qui vous branche - address -> ISED coverage cell -> providers and plans.
   No backend: coverage ships as static 0.5-degree shards under data/hex/. */

(() => {
  'use strict';

  const GEOCODE = 'https://geogratis.gc.ca/services/geolocation/';
  const CELL = 0.5;
  const QC_BOUNDS = { latMin: 44.9, latMax: 62.6, lonMin: -79.9, lonMax: -56.9 };
  const MAX_CELL_DIST_KM = 6;      // a hexagon is ~7 km across; beyond this there is no cell
  const STALE_DAYS = 90;
  const TECH_ORDER = ['fibre', 'cable', 'dsl', 'fixedWireless', 'satellite'];

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
    shardsTried: 0,
    shardsLoaded: 0,
    shardErrors: 0,
  };

  // A wedged client - an old service worker, a half-written cache - otherwise
  // reports "no coverage here" for every address, which is indistinguishable
  // from a genuine gap. Clearing the caches and reloading once recovers it;
  // ?reset=1 does the same on demand.
  async function resetClient() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      }
    } catch (err) {
      console.warn('reset failed', err);
    }
  }

  async function selfHealOnce() {
    let healed = null;
    try { healed = sessionStorage.getItem('healed'); } catch (e) { /* private mode */ }
    if (healed) return false;
    try { sessionStorage.setItem('healed', '1'); } catch (e) { /* private mode */ }
    await resetClient();
    location.reload();
    return true;
  }

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

  // The build stamp from meta.json goes in the URL so a data refresh changes
  // every shard URL, retiring anything a client cached from a previous build.
  async function loadShard(key) {
    if (state.shards.has(key)) return state.shards.get(key);
    const stamp = state.meta && state.meta.built ? `?b=${state.meta.built}` : '';
    state.shardsTried++;
    const p = fetch(`data/hex/${key}.json${stamp}`)
      .then(r => {
        if (!r.ok) return null;          // 404 is normal: nothing is mapped out there
        state.shardsLoaded++;
        return r.json();
      })
      .catch(() => { state.shardErrors++; return null; });
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

  /* ---------- cell towers ---------- */

  // ISED's spectrum licence database, queried live: it needs no key, sends CORS
  // headers, and is the only public record of where cell sites actually are.
  // One physical site holds many licences, so rows are collapsed by position.
  const TOWERS_URL =
    'https://services.arcgis.com/wjcPoefzjpzCgffS/ArcGIS/rest/services/Spectrum_Licences_Site_Data/FeatureServer/0/query';

  // Licence classes that carry mobile phone service. The rest of the database is
  // fixed links, backhaul and point-to-point, which say nothing about coverage.
  const MOBILE_SERVICES = "SERVICE IN ('CELL','PCS','PCSG','AWS','AWS-3','AWS-4','BRS','600B','3500B','MBS','WCS')";

  // One network licenses under several legal names, and Fido runs on Rogers'
  // radio network, so the raw LICENSEE field overstates how many operators are
  // present. These are the only 15 licensees in Quebec, mapped to the network a
  // phone would actually attach to.
  const CARRIERS = [
    { id: 'telus', label: 'Telus', colour: '#2E9E5B', match: /^telus/i, sql: "UPPER(LICENSEE) LIKE 'TELUS%'" },
    { id: 'bell', label: 'Bell', colour: '#1B6CC4', match: /^bell/i, sql: "UPPER(LICENSEE) LIKE 'BELL%'" },
    { id: 'rogers', label: 'Rogers / Fido', colour: '#C0392B', match: /^(rogers|fido)/i, sql: "(UPPER(LICENSEE) LIKE 'ROGERS%' OR UPPER(LICENSEE) LIKE 'FIDO%')" },
    { id: 'videotron', label: 'Vidéotron', colour: '#D98B1F', match: /^vid[eé]otron/i, sql: "UPPER(LICENSEE) LIKE 'VID%'" },
    { id: 'freedom', label: 'Freedom Mobile', colour: '#8E44AD', match: /^freedom/i, sql: "UPPER(LICENSEE) LIKE 'FREEDOM%'" },
  ];
  const OTHER_CARRIER = {
    id: 'other', label: 'Autres / Other', colour: '#7A90A8',
    get sql() { return 'NOT (' + CARRIERS.map(c => c.sql).join(' OR ') + ')'; },
  };

  const carrierOf = licensee =>
    CARRIERS.find(c => c.match.test(String(licensee).trim())) || OTHER_CARRIER;

  // 5G-era spectrum, worth distinguishing from the LTE bands.
  const NR_BANDS = new Set(['600B', '3500B']);
  const TOWER_MIN_ZOOM = 12;
  const TOWER_MAX_ROWS = 1000;

  async function fetchTowers(bounds, carrierId) {
    const carrier = carrierId
      ? [...CARRIERS, OTHER_CARRIER].find(c => c.id === carrierId)
      : null;
    const where = MOBILE_SERVICES + (carrier ? ' AND ' + carrier.sql : '');
    const env = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
    const url = TOWERS_URL + '?' + new URLSearchParams({
      geometry: env,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where,
      outFields: 'LATITUDE,LONGITUDE,LICENSEE,SERVICE',
      returnDistinctValues: 'true',
      returnGeometry: 'false',
      resultRecordCount: String(TOWER_MAX_ROWS),
      f: 'json',
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error('towers ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'towers error');

    const sites = new Map();
    for (const f of data.features || []) {
      const a = f.attributes;
      if (typeof a.LATITUDE !== 'number' || typeof a.LONGITUDE !== 'number') continue;
      const key = a.LATITUDE.toFixed(4) + ',' + a.LONGITUDE.toFixed(4);
      if (!sites.has(key)) sites.set(key, { lat: a.LATITUDE, lon: a.LONGITUDE, carriers: new Map() });
      const site = sites.get(key);
      const carrier = carrierOf(a.LICENSEE);
      if (!site.carriers.has(carrier.id)) site.carriers.set(carrier.id, { carrier, bands: new Set() });
      if (a.SERVICE) site.carriers.get(carrier.id).bands.add(a.SERVICE);
    }
    return { sites: [...sites.values()], truncated: !!data.exceededTransferLimit };
  }

  async function refreshTowers() {
    if (!map.instance) return;
    const note = $('#towers-note');

    if (!map.towersOn) {
      if (map.towers) { map.towers.clearLayers(); }
      note.textContent = '';
      return;
    }
    if (map.instance.getZoom() < TOWER_MIN_ZOOM) {
      if (map.towers) map.towers.clearLayers();
      note.textContent = t().towersZoom;
      return;
    }

    note.textContent = t().towersLoading;
    const token = ++map.towerToken;            // ignore results from a superseded pan
    try {
      const { sites, truncated } = await fetchTowers(map.instance.getBounds(), map.towerCarrier);
      if (token !== map.towerToken || !map.towersOn) return;

      if (!map.towers) map.towers = L.layerGroup().addTo(map.instance);
      map.towers.clearLayers();

      let shown = 0;

      for (const site of sites) {
        const entries = [...site.carriers.values()]
          .sort((a, b) => a.carrier.label.localeCompare(b.carrier.label));
        if (!entries.length) continue;
        shown++;

        // A site shared by several networks gets the neutral ink dot; a
        // single-carrier site is drawn in that carrier's colour.
        const colour = entries.length === 1 ? entries[0].carrier.colour : (cssVar('--ink') || '#0B2545');

        const rows = entries.map(e => {
          const bands = [...e.bands].sort();
          const nr = bands.some(b => NR_BANDS.has(b));
          return `<span style="color:${e.carrier.colour}">●</span> <strong>${escapeHtml(e.carrier.label)}</strong>`
            + `<br><span class="tower-bands">${escapeHtml(bands.join(', '))}${nr ? ' · 5G' : ''}</span>`;
        });

        L.circleMarker([site.lat, site.lon], {
          radius: entries.length > 1 ? 5 : 4,
          weight: 1,
          color: cssVar('--card') || '#fff',
          fillColor: colour,
          fillOpacity: 0.95,
        })
          .bindPopup(`<strong>${t().towerCarriers}</strong><br>${rows.join('<br>')}`)
          .addTo(map.towers);
      }

      note.textContent = truncated ? t().towersTruncated(shown) : t().towersCount(shown);
    } catch (err) {
      if (token !== map.towerToken) return;
      console.warn('tower layer unavailable', err);
      note.textContent = t().towersFailed;
    }
  }

  const escapeHtml = str => String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- the map ---------- */

  // Standard OpenStreetMap raster tiles. Dark mode is handled in CSS by
  // filtering the tile pane, since OSM ships no dark variant.
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTRIB =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  const QC_VIEW = [[45.0, -79.5], [51.5, -61.0]];   // the populated part of Quebec

  const map = {
    instance: null, tiles: null, cell: null, marker: null,
    towers: null, towersOn: false, towerToken: 0, towerCarrier: '',
  };

  const cssVar = name =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function initMap() {
    if (typeof L === 'undefined') {          // Leaflet is a CDN script: offline it is simply absent
      $('#map').hidden = true;
      $('#map-fallback').hidden = false;
      return;
    }

    map.instance = L.map('map', { zoomControl: true, scrollWheelZoom: true })
      .fitBounds(QC_VIEW);

    map.tiles = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIB,
      maxZoom: 19,
    }).addTo(map.instance);

    map.instance.on('click', ev => lookupPoint(ev.latlng.lat, ev.latlng.lng));

    let panTimer = null;
    map.instance.on('moveend zoomend', () => {
      clearTimeout(panTimer);
      panTimer = setTimeout(refreshTowers, 350);   // one request per pause, not per frame
    });

    const toggle = $('#towers-toggle');
    toggle.addEventListener('change', () => {
      map.towersOn = toggle.checked;
      $('#tower-carrier').disabled = !toggle.checked;
      $('#tower-legend').hidden = !toggle.checked;
      refreshTowers();
    });

    const picker = $('#tower-carrier');
    for (const c of [...CARRIERS, OTHER_CARRIER]) {
      const opt = el('option', null, c.label);
      opt.value = c.id;
      picker.append(opt);
    }
    picker.addEventListener('change', () => {
      map.towerCarrier = picker.value;
      refreshTowers();
    });

    const legend = $('#tower-legend');
    for (const c of [...CARRIERS, OTHER_CARRIER]) {
      const chip = el('span', 'legend-chip');
      const dot = el('span', 'legend-dot');
      dot.style.background = c.colour;
      chip.append(dot, document.createTextNode(c.label));
      legend.append(chip);
    }
  }

  // Draw the cell's real outline, not an approximation of it.
  function drawOnMap(place, cell) {
    if (!map.instance) return;
    const [hexLat, hexLon] = cell.hex;
    const ring = (cell.geom || []).map(([dlat, dlon]) => [hexLat + dlat, hexLon + dlon]);

    if (map.cell) map.cell.remove();
    if (map.marker) map.marker.remove();

    if (ring.length) {
      map.cell = L.polygon(ring, {
        color: cssVar('--ink') || '#0B2545',
        weight: 2,
        opacity: 0.85,
        fillColor: cssVar('--ink') || '#0B2545',
        fillOpacity: 0.08,
      }).addTo(map.instance);
    }

    map.marker = L.circleMarker([place.lat, place.lon], {
      radius: 6,
      color: cssVar('--card') || '#fff',
      weight: 2,
      fillColor: cssVar('--fibre') || '#007F8C',
      fillOpacity: 1,
    }).addTo(map.instance);

    if (ring.length) map.instance.fitBounds(map.cell.getBounds(), { padding: [24, 24] });
    else map.instance.setView([place.lat, place.lon], 12);
  }

  function renderFacts(place, cell) {
    $('#fact-address').textContent = place.title;
    $('#fact-hexid').textContent = cell.hexid || '—';
    $('#fact-asof').textContent = state.meta ? state.meta.built : '—';
  }

  /* ---------- handing off to a provider ---------- */

  // A provider's own availability checker is the only real answer about a given
  // address, and it cannot be reached from here: those APIs are private,
  // CORS-blocked and not URL-addressable. So the hand-off carries the address
  // on the clipboard instead of making the user retype it.
  let toastTimer = null;

  function showToast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  // Marks an outbound provider link so the delegated handler copies on the way out.
  function providerLink(href, providerName) {
    const a = el('a', 'isp-link', t().check + ' ↗');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.handoff = '1';
    a.title = t().checkTitle(providerName);
    return a;
  }

  // Delegated, and deliberately not preventing the default: the new tab opens
  // from the user's own click, and a clipboard failure never costs them the link.
  document.addEventListener('click', ev => {
    const link = ev.target.closest && ev.target.closest('a[data-handoff]');
    if (!link) return;
    const address = state.result && state.result.place ? state.result.place.title : '';
    if (!address) return;
    copyText(address).then(ok => { if (ok) showToast(t().copied); });
  });

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
        if (provider.url) li.append(providerLink(provider.url, provider.name));
        list.append(li);
      }
      wrap.append(list);
      host.append(wrap);
    }
  }

  /* ---------- rendering: mobile coverage ---------- */

  // ISED reports mobile as a technology like any other, but it answers a
  // different question, so it gets its own panel - and the absence of any
  // carrier is itself the answer, which a missing section would not convey.
  function renderMobile(entries) {
    const host = $('#mobile');
    host.textContent = '';
    const carriers = [...new Set(entries
      .filter(([, tech]) => tech === 'mobile')
      .map(([idx]) => state.providers[idx].name))].sort();

    if (!carriers.length) {
      const box = el('p', 'deadzone', t().mobileNone);
      host.append(box);
      return;
    }

    host.append(el('p', 'caveat mobile-lede', t().mobileCarriers));
    const list = el('ul', 'isplist mobile-list');
    for (const name of carriers) {
      const li = el('li');
      li.append(el('span', 'isp-name', name));
      list.append(li);
    }
    host.append(list);
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
        const a = providerLink(plan.source, plan.providerName || providerName(plan.provider));
        a.className = '';
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
    renderFacts(r.place, r.cell);
    drawOnMap(r.place, r.cell);
    renderProviders(groupByTech(r.entries));
    renderMobile(r.entries);
    renderPlans(r.entries);
  }

  // A click on the map has coordinates but no address. Show the cell straight
  // away and fill the address in afterwards, so the answer never waits on a
  // reverse lookup that may not come.
  async function lookupPoint(lat, lon) {
    const place = { title: formatCoords(lat, lon), lat, lon };
    const shown = await showCell(place, 'QC');
    if (!shown) return;
    const name = await reverseGeocode(lat, lon);
    if (name && state.result && state.result.place === place) {
      place.title = name;
      $('#fact-address').textContent = name;
    }
  }

  const formatCoords = (lat, lon) =>
    `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=${state.lang}`);
      if (!res.ok) return null;
      const data = await res.json();
      const p = (data.features && data.features[0] && data.features[0].properties) || null;
      if (!p) return null;
      // Photon sometimes answers with a postal code as the feature name; the
      // street or the locality is more use than "G1R 4S9".
      const POSTAL = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;
      const named = p.street || (p.name && !POSTAL.test(p.name.trim()) ? p.name : '');
      const street = [p.housenumber, named].filter(Boolean).join(' ');
      return [street, p.city || p.county, p.state].filter(Boolean).join(', ') || null;
    } catch (err) {
      return null;
    }
  }

  // Shared by address search and map clicks.
  async function showCell(place, provinceHint) {
    state.shardsTried = 0;
    state.shardsLoaded = 0;
    state.shardErrors = 0;
    const cell = await findCell(place.lat, place.lon, provinceHint);
    if (!cell) {
      // A missing shard just means nothing is mapped there - the north, or out
      // at sea. Only fetches that actually failed point at a broken client.
      if (state.shardErrors && !state.shardsLoaded && navigator.onLine) {
        if (await selfHealOnce()) return false;
        showError('errStaleClient');
        return false;
      }
      showError('errNoCell');
      return false;
    }
    state.result = {
      place,
      cell: { hex: cell.hex, geom: cell.geom, hexid: cell.hex[2] },
      entries: cell.hex[3],
    };
    showResult();
    return true;
  }

  async function lookup(place) {
    if (!inQuebec(place)) { showError('errOutside'); return; }
    if (!await showCell(place, provinceCode(place))) return;

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
    // Opened as a file:// document, the browser blocks every fetch of the
    // coverage data and refuses to register a service worker, so the app would
    // look empty for no visible reason. Say so instead.
    if (location.protocol === 'file:') {
      applyLang();
      $('#mapsection').hidden = true;
      showError('errFileProtocol');
      return;
    }

    if (new URL(location.href).searchParams.get('reset')) {
      await resetClient();
      location.replace(location.pathname);
      return;
    }

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

    initMap();

    // Small, deliberate test surface: lets a headless check drive a map click
    // and read back the cell without synthesising mouse events.
    window.QVB = {
      lookupPoint,
      map: () => map.instance,
      cell: () => (state.result ? state.result.cell.hexid : null),
    };

    const q = new URL(location.href).searchParams.get('q');
    if (q) { $('#address').value = q; runSearch(q); }

    // Register, then actively check for a newer worker and reload once when it
    // takes over, so a client cannot sit on a previous build indefinitely.
    if ('serviceWorker' in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;   // first install claims the page; that is not an update
        reloading = true;
        location.reload();
      });
      addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
          .then(reg => reg.update())
          .catch(() => {});
      });
    }
  }

  init();
})();
