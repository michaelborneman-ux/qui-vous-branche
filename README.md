# Qui vous branche · Who wires you

**Live: https://michaelborneman-ux.github.io/qui-vous-branche/**

A static, installable PWA: type a Quebec address, see which internet providers
operate a network in its coverage cell, on what technology, at what speed tier —
and what the plans cost, as far as the plans are public.

Bilingual (FR default), no backend, no build step, works offline after first load.

## How it knows

There is no free API in Canada that answers "what can I get at this address".
What exists is ISED/CRTC's **National Broadband Data**, which names providers per
hexagonal cell of roughly 25 km². This app ships that data as static JSON.

| Piece | Where it comes from |
|---|---|
| Address → lat/lon | NRCan geolocation service, live, no key (`geogratis.gc.ca`), with Photon as a fallback |
| Which cell | Point-in-polygon against the cells in a local 0.5° shard |
| Base map | OpenStreetMap raster tiles via Leaflet (CDN) |
| Providers, technology, speed tier | ISED `api/hexagonArea`, crawled offline into `data/hex/` |
| Prices | `data/plans.json`, maintained by hand |

### The hand-off cannot be an in-app check

A provider's own availability checker is the only real answer for a given
address, and the app cannot stand in for it. Their qualification APIs are
private and CORS-blocked, the checkers are JavaScript flows with no
URL-addressable form (checked against Videotron, EBOX and Bell), and relaying
them through a proxy would mean reverse-engineering each checkout past its bot
protection. So clicking a provider copies the address to the clipboard and opens
their checker, which saves the retyping and nothing more. The click is never
blocked on the copy: a clipboard failure costs the toast, not the link.

**The honest limit:** a cell is about 7 km across. The app says which providers
operate *in the area*, never that a given address can be served. Every provider
row links to that provider's own address checker, which is the real answer.
The map draws each cell's true outline, so the size of that claim is visible
rather than described.

### Mobile coverage and cell towers

Mobile is reported by ISED as a technology like any other, but it answers a
different question, so it has its own panel - and a cell with no mobile carrier
says so explicitly, because an absent section reads as "not checked" rather than
"nothing here". 2,377 of Quebec's 9,118 cells have no mobile carrier at all.

The tower layer queries ISED's **spectrum licence database** live (ArcGIS, no
key, CORS-enabled) for the current map bounds, filtered to the licence classes
that carry phone service - CELL, PCS, AWS, BRS, 600B, 3500B and the rest - since
the database also holds fixed links and backhaul that say nothing about
coverage. One site holds many licences, so rows are collapsed by rounded
position. It loads only above zoom 12, debounces panning, and drops results from
a superseded pan.

Each site is colour-coded by network with a legend, and the popup lists the
networks present and their spectrum bands, flagging 5G where 600B or 3500B is
licensed. A carrier filter narrows the layer to one network.

The filter is applied **in the query, not after it**: the service caps results
at 1,000 rows, so filtering client-side silently dropped sites that were never
returned - Bell showed 30 in downtown Montreal when the true figure was 38.

Licensee names are normalised to the network a phone attaches to. Quebec has
only 15 distinct licensees, and several are one operator - `TELUS
Communications Inc.`, `Telus - Regulatory Affairs` and `TELUS Communications
Company` are all Telus, and Fido runs on Rogers' radio network.

**This is not signal strength.** No free, licensable source publishes bars or
dBm; carrier maps are proprietary and crowd-sourced ones are not reusable. The
app reports where service is declared and where towers are licensed, which is a
different and weaker claim.

### The map

Leaflet over OpenStreetMap tiles, loaded from a CDN with SRI hashes. Clicking
anywhere queries that point directly - no address needed - and Photon's reverse
geocoder fills in a place name afterwards, so the answer never waits on it.
Leaflet is the one external dependency; offline it is simply absent and the map
hides itself behind a note while address search keeps working. OSM has no dark
tile set, so dark mode inverts the tile pane in CSS.

`window.QVB` exposes `lookupPoint`, `map` and `cell` as a deliberate test
surface for driving the map headlessly.

### Geocoding has a fallback on purpose

`geogratis.gc.ca` redirects to `geolocator.api.geo.ca`, which intermittently
answers without CORS headers (it appears to drop them when rate-limiting). A
single flaky response would otherwise look to the user like "address not found",
so `geocode()` falls back to Photon, whose titles end with the province in the
same shape. NRCan stays primary: its Canadian address coverage is better.

### Why the data is pre-baked

ISED's endpoint sends no CORS headers, so a page on GitHub Pages cannot call it.
The crawl happens offline; the browser only ever reads static files from this repo.

## Refreshing the coverage data

ISED republishes the open-data bundle every few months. To pick up a new one:

```bash
rm .cache/Map_Data_CSV.zip                       # force a fresh bundle
node tools/fetch-hex-index.js QC                 # which cells exist (9,158 in Quebec)
node tools/crawl-providers.js QC                 # ~40 min at 4 req/s; resumable

# Border cells. The hexagon grid crosses provincial boundaries, so a Gatineau
# address can belong to a cell labelled ON. Without these the nearest-cell
# lookup silently returns a Quebec cell kilometres away.
for P in ON NB NL; do
  node tools/fetch-hex-index.js $P --near QC
  node tools/crawl-providers.js $P --near QC
done

node tools/build-shards.js                       # everything in .cache/hex -> data/hex/
```

The crawler skips anything already in `.cache/hex/`, so re-running after an
interruption is cheap. To force a full refresh, delete `.cache/hex/` first.
Then bump `CACHE` in `sw.js` and the `?v=` query strings in `index.html`, or
installed clients keep serving the old shell.

### Another province

Everything is keyed by the two-letter province prefix in the cell id:

```bash
node tools/fetch-hex-index.js ON && node tools/crawl-providers.js ON && node tools/build-shards.js
```

Shards are not split by province, so the new cells simply join the same tree.
Then widen `QC_BOUNDS` in `app.js` and relax `inQuebec()`, which currently sends
anything the geocoder labels with another province to the "outside coverage"
state.

## Maintaining prices

`data/plans.json` is the only hand-kept file. Providers gate their real prices
behind an address check, so this catalogue is deliberately small and honest
rather than large and invented: **add only numbers you have actually seen**, and
set `verified` to the day you saw them. Plans older than 90 days are flagged
"recheck" in the UI; plans with `"price": null` render as "price after check".

```json
{
  "provider": "ebox",                  // id from data/providers.json, or a reseller id
  "providerName": "EBOX",              // display name, if the id is not in providers.json
  "name": { "fr": "Câble 500", "en": "Cable 500" },
  "tech": "cable",                     // fibre | cable | dsl | fixedWireless | satellite
  "down": 500, "up": 50,
  "price": 55,                         // null when only revealed after an address check
  "promoPrice": null, "promoMonths": null,
  "term": "month-to-month",            // or a number of months
  "cap": "unlimited",
  "ridesOn": ["videotron", "cogeco-connexion"],   // show where the host network exists
  "anywhere": false,                   // true for satellite, shown regardless of cell
  "source": "https://…",
  "verified": "2026-09-19",
  "note": "anything the price alone does not say"
}
```

`ridesOn` is what makes resellers correct: an independent appears only where the
network it resells actually runs. Providers listed by ISED only as wholesale
transport are filtered out of the coverage data, so resellers reach the UI
through `ridesOn`, not through the cell's own provider list.

## Running it

**It has to be served over http.** Opening `index.html` by double-clicking it
gives a `file://` page, where the browser blocks every fetch of the coverage
data, refuses to register a service worker, and sends no Referer - which makes
OpenStreetMap return blocked tiles. The app detects that case and says so
rather than looking empty.

```bash
npx http-server . -p 8133 -c-1
```

Then open http://localhost:8133. Or use the `isp-finder` preview configuration.
`.nojekyll` is committed so GitHub Pages serves the files as they are. Deployment is GitHub Pages from
`main` — everything the browser needs is committed; `.cache/` is not.

## Data enums

`tools/enums.js` decodes ISED's `providerType` and `speedType` integers. Those
mappings were read out of the National Broadband Map's own JavaScript
(`js/map/selected_area_info.js`) rather than guessed — if ISED renumbers them,
that file is the place to re-check.

## Attribution

Coverage data: ISED/CRTC National Broadband Data, used under the
[Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
Geocoding: Natural Resources Canada Geolocation Service.
Not affiliated with any internet provider.
