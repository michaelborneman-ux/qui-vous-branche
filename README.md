# Qui vous branche · Who wires you

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
| Which cell | Nearest cell centroid in a local 0.5° shard |
| Providers, technology, speed tier | ISED `api/hexagonArea`, crawled offline into `data/hex/` |
| Prices | `data/plans.json`, maintained by hand |

**The honest limit:** a cell is about 7 km across. The app says which providers
operate *in the area*, never that a given address can be served. Every provider
row links to that provider's own address checker, which is the real answer.

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

```bash
npx http-server . -p 8133 -c-1
```

Or use the `isp-finder` preview configuration. Deployment is GitHub Pages from
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
