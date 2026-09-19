// Builds the list of hexagon ids to crawl, from ISED's open-data Map_Data_CSV bundle.
// Usage: node tools/fetch-hex-index.js [PROV]   (default QC)
//
// The bundle is the authoritative list of which hexagons exist; it carries provider
// names and technology but no speed tier, no provider URL and no coordinates, so the
// crawler enriches each hexagon from the live api/hexagonArea endpoint.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ZIP_URL = 'https://ised-isde.canada.ca/app/scr/sittibc/web/api/openData/Map_Data_CSV.zip';
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const ZIP = path.join(CACHE, 'Map_Data_CSV.zip');
const CSV_DIR = path.join(CACHE, 'mapcsv');

const prov = (process.argv[2] || 'QC').toUpperCase();
// --near QC keeps only cells close to that province's cells. The hexagon grid
// ignores provincial boundaries, so an address in Gatineau can sit in a cell
// labelled ON; without the neighbouring border cells the nearest-cell lookup
// silently returns the wrong one.
const nearArg = process.argv.indexOf('--near');
const near = nearArg > -1 ? process.argv[nearArg + 1].toUpperCase() : null;
const NEAR_DEG = 0.35;

async function download() {
  if (fs.existsSync(ZIP)) return;
  console.log('downloading', ZIP_URL);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
}

function extract() {
  if (fs.existsSync(CSV_DIR) && fs.readdirSync(CSV_DIR).length) return;
  console.log('extracting');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${ZIP}' -DestinationPath '${CSV_DIR}' -Force`], { stdio: 'inherit' });
}

// Cell ids encode their own rounded position: 2-letter province, latitude x100,
// longitude x10. Good enough to filter candidates before spending a request.
function idToLatLon(id) {
  return [Number(id.slice(2, 6)) / 100, -Number(id.slice(6, 10)) / 10];
}

function hexIds() {
  // Data_Hex_* is every hexagon with population data; it is a superset of the ISP file,
  // so crawling it also captures hexagons that currently have no listed provider.
  const file = fs.readdirSync(CSV_DIR).find(f => /^Data_Hex_/.test(f));
  if (!file) throw new Error('Data_Hex_*.csv not found in ' + CSV_DIR);
  const ids = new Set();
  const nearIds = new Set();
  for (const line of fs.readFileSync(path.join(CSV_DIR, file), 'latin1').split('\n')) {
    const m = line.match(/^"([A-Z]{2}\d+)"/);
    if (m && m[1].startsWith(prov)) ids.add(m[1]);
    if (m && near && m[1].startsWith(near)) nearIds.add(m[1]);
  }
  let out = [...ids];
  if (near) {
    const anchors = [...nearIds].map(idToLatLon);
    out = out.filter(id => {
      const [lat, lon] = idToLatLon(id);
      return anchors.some(([alat, alon]) =>
        Math.abs(alat - lat) <= NEAR_DEG && Math.abs(alon - lon) <= NEAR_DEG);
    });
  }
  return out.sort();
}

(async () => {
  await download();
  extract();
  const ids = hexIds();
  const out = path.join(CACHE, `hexids-${prov}${near ? '-near' + near : ''}.json`);
  fs.writeFileSync(out, JSON.stringify(ids));
  console.log(`${ids.length} ${prov} hexagons${near ? ` within ${NEAR_DEG}deg of ${near}` : ''} -> ${path.relative(ROOT, out)}`);
})();
