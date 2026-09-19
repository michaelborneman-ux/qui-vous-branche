// Crawls ISED's hexagonArea endpoint for each hexagon id, caching the raw JSON.
// Usage: node tools/crawl-providers.js [PROV] [--limit N]
// Resumable: anything already in .cache/hex/ is skipped, so re-running after an
// interruption (or after a monthly data refresh of new ids) is cheap.

const fs = require('fs');
const path = require('path');

const API = 'https://ised-isde.canada.ca/app/scr/sittibc/web/api/hexagonArea?id=';
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(CACHE, 'hex');

const CONCURRENCY = 4;
const GAP_MS = 250;          // per worker, so ~4 requests/second overall
const MAX_ATTEMPTS = 4;

const prov = (process.argv[2] || 'QC').toUpperCase();
const nearArg = process.argv.indexOf('--near');
const near = nearArg > -1 ? process.argv[nearArg + 1].toUpperCase() : null;
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHex(id) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API + id, { headers: { 'Accept': 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(500 * 2 ** attempt);   // exponential backoff
    }
  }
}

(async () => {
  const ids = JSON.parse(fs.readFileSync(path.join(CACHE, `hexids-${prov}${near ? '-near' + near : ''}.json`), 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });

  const todo = ids.filter(id => !fs.existsSync(path.join(OUT, id + '.json'))).slice(0, limit);
  console.log(`${ids.length} hexagons, ${todo.length} to fetch`);

  let done = 0, failed = 0;
  const started = Date.now();

  async function worker(slot) {
    for (let i = slot; i < todo.length; i += CONCURRENCY) {
      const id = todo[i];
      try {
        const data = await fetchHex(id);
        if (data) fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(data));
      } catch (err) {
        failed++;
        console.error('FAIL', id, err.message);
      }
      done++;
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((todo.length - done) / rate / 60);
        console.log(`${done}/${todo.length}  ${rate.toFixed(1)}/s  ~${eta} min left  ${failed} failed`);
      }
      await sleep(GAP_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  console.log(`done: ${done} fetched, ${failed} failed`);
})();
