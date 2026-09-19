// Turns the raw crawl cache into the static data the PWA fetches.
// Usage: node tools/build-shards.js [PROV]
//
//   data/providers.json      [{id, name, url}]                (index-addressed)
//   data/hex/<a>_<b>.json    { hexes: [[lat,lon,id,[[idx,tech,speed]],[[dlat,dlon],...]]] }
//   data/meta.json           { built, provinces, hexCount, ... }
//
// Shards are 0.5-degree cells, so a lookup fetches one small file. They are not
// split by province on purpose: the hexagon grid crosses provincial borders, so
// a Gatineau address can belong to a cell labelled ON. Everything in .cache/hex
// is shipped, and the neighbouring-province border cells come from
// `fetch-hex-index.js ON --near QC`.

const fs = require('fs');
const path = require('path');
const { TECH } = require('./enums');

const ROOT = path.join(__dirname, '..');
const HEX_CACHE = path.join(ROOT, '.cache', 'hex');
const OUT_DIR = path.join(ROOT, 'data', 'hex');

const CELL = 0.5;
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

const slug = name => name.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Each cell's real outline, as offsets from its reported point. Every cell
// stores its own: the point ISED returns is a representative point rather than
// the polygon's centre, so the offsets differ from cell to cell and no shared
// template reproduces them. The repeated closing vertex is dropped.
function geomOffsets(kml, lat, lon) {
  const coords = (kml.match(/<coordinates>([^<]+)<\/coordinates>/) || [])[1];
  if (!coords) return null;
  const pts = coords.trim().split(/\s+/).map(pair => {
    const [x, y] = pair.split(',').map(Number);
    return [Number((y - lat).toFixed(5)), Number((x - lon).toFixed(5))];
  });
  const first = pts[0], last = pts[pts.length - 1];
  if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts;
}

const providers = [];            // [{id, name, url}]
const providerIdx = new Map();   // id -> index
function providerIndex(name, url) {
  const id = slug(name);
  if (!providerIdx.has(id)) {
    providerIdx.set(id, providers.length);
    providers.push({ id, name, url: url || null });
  } else if (url) {
    const p = providers[providerIdx.get(id)];
    if (!p.url) p.url = url;
  }
  return providerIdx.get(id);
}

const shards = new Map();
let hexCount = 0, skipped = 0;

const provinces = new Set();

for (const file of fs.readdirSync(HEX_CACHE)) {
  if (!file.endsWith('.json')) continue;
  provinces.add(file.slice(0, 2));
  const hex = JSON.parse(fs.readFileSync(path.join(HEX_CACHE, file), 'utf8'));
  if (typeof hex.hexLat !== 'number' || typeof hex.hexLon !== 'number') { skipped++; continue; }

  // Dedupe: a provider can appear once per technology, and occasionally twice
  // for the same technology at different speed tiers - keep the best speed.
  const best = new Map();
  for (const p of hex.providers || []) {
    const tech = TECH[p.providerType];
    if (!tech || tech === 'transport') continue;   // wholesale transport is not a retail option
    const idx = providerIndex(p.name, p.url);
    const key = idx + '|' + tech;
    const speed = p.speedType || 0;
    if (!best.has(key) || best.get(key)[2] < speed) best.set(key, [idx, tech, speed]);
  }

  const lat = Number(hex.hexLat.toFixed(6));
  const lon = Number(hex.hexLon.toFixed(6));
  const key = cellKey(lat, lon);
  if (!shards.has(key)) shards.set(key, { hexes: [] });
  const shard = shards.get(key);
  const poly = hex.hexKml ? geomOffsets(hex.hexKml, lat, lon) : null;
  shard.hexes.push([lat, lon, hex.hexid, [...best.values()], poly]);
  hexCount++;
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
let bytes = 0, biggest = 0;
for (const [key, shard] of shards) {
  const json = JSON.stringify(shard);
  fs.writeFileSync(path.join(OUT_DIR, key + '.json'), json);
  bytes += json.length;
  biggest = Math.max(biggest, json.length);
}

providers.sort((a, b) => a.id.localeCompare(b.id));
// re-index after the sort
const remap = new Map(providers.map((p, i) => [providerIdx.get(p.id), i]));
for (const shard of shards.values()) {
  for (const hex of shard.hexes) for (const entry of hex[3]) entry[0] = remap.get(entry[0]);
}
for (const [key, shard] of shards) {
  fs.writeFileSync(path.join(OUT_DIR, key + '.json'), JSON.stringify(shard));
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'providers.json'), JSON.stringify(providers, null, 1));
fs.writeFileSync(path.join(ROOT, 'data', 'meta.json'), JSON.stringify({
  built: new Date().toISOString().slice(0, 10),
  provinces: [...provinces].sort(),
  hexCount,
  providerCount: providers.length,
  shardCount: shards.size,
  source: 'ISED/CRTC National Broadband Data, Open Government Licence - Canada',
}, null, 1));

console.log(`${hexCount} hexagons -> ${shards.size} shards (${(bytes / 1e6).toFixed(1)} MB total, largest ${(biggest / 1024).toFixed(0)} KB)`);
console.log(`${providers.length} providers, ${skipped} skipped`);
