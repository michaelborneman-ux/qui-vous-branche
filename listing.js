/* Pulls a street address out of a shared or pasted rental listing.
   Pure functions, no DOM: loaded by the page as window.QVBListing and by Node
   for tests. Everything here is based on the live listing sites as checked on
   2026-09-22, and each parser returns null rather than guess. */

(function (root) {
  'use strict';

  // A civic number on its own segment: "370", "1842Z", "3340-3342".
  const CIVIC = /^\d{1,6}[A-Za-z]?(?:-\d{1,6}[A-Za-z]?)?$/;

  // Unit and listing-number segments that sit between the street and the end.
  const UNIT = /^(apt\.?|app\.?|appartement|apartment|unit[eé]?|suite|bureau|#)\s*\S*/i;
  const MLS = /^\d{7,9}(\s*-\s*centris\.ca)?$/i;

  /* Centris puts no address in its URLs, but the page title carries one:
       FR  "Condo / Appartement à louer à Montréal (Ville-Marie), Montréal (Île),
            370, Rue Saint-André, app. 1106, 20626727 - Centris.ca"
       EN  "House for sale in Montréal (Le Sud-Ouest), Montréal (Island),
            6836, Rue Mazarin, 9786547 - Centris.ca"
     Android's share sheet sends that title, which is what makes sharing work. */
  function fromCentrisTitle(title) {
    if (!title || !/centris/i.test(title)) return null;
    const segs = String(title).replace(/\s*-\s*centris\.ca\s*$/i, '').split(/,\s*/);

    const i = segs.findIndex(s => CIVIC.test(s.trim()));
    if (i < 0 || i + 1 >= segs.length) return null;
    const civic = segs[i].trim();
    const street = segs[i + 1].trim();
    if (!street || UNIT.test(street) || MLS.test(street) || CIVIC.test(street)) return null;

    // Greedy prefix so the *last* " à " wins: "Appartement à louer à Montréal"
    // has two, and the first one would make the city "louer à Montréal".
    const place = (segs[0].match(/^.*\s(?:in|à)\s+(.+)$/i) || [])[1];
    const city = place ? place.replace(/\s*\([^)]*\)\s*/g, ' ').trim() : '';

    return {
      query: city ? `${civic} ${street}, ${city}` : `${civic} ${street}`,
      candidates: city ? [`${civic} ${street}, ${city}`, `${civic} ${street}`] : [`${civic} ${street}`],
      source: 'centris',
      confidence: 'high',
    };
  }

  // Abbreviations REALTOR.ca uses in its slugs, expanded so the geocoder
  // matches them reliably. Single-letter directions only count as directions
  // when they come straight after the street name.
  const ABBREV = { boul: 'boulevard', av: 'avenue', ch: 'chemin', rte: 'route', mtee: 'montée' };
  const DIRS = { o: 'ouest', e: 'est', n: 'nord', s: 'sud' };

  /* REALTOR.ca's URL is the address, followed by city and neighbourhood with
     no separator between them:
       /real-estate/30314059/1450-boul-rene-levesque-o-1201-montreal-ville-marie-golden-square-mile
     Every candidate keeps the civic number and street, and trailing words are
     dropped one at a time so the geocoder gets a chance at a clean match. */
  function fromRealtorUrl(url) {
    const m = String(url || '').match(/realtor\.ca\/(?:real-estate|immobilier)\/\d+\/([^/?#\s]+)/i);
    if (!m) return null;

    const raw = decodeURIComponent(m[1]).toLowerCase().split('-').filter(Boolean);
    if (!raw.length || !/^\d/.test(raw[0])) return null;

    // "3340-3342-av-..." is a civic range: keep the first number only.
    let k = 1;
    while (k < raw.length && /^\d+[a-z]?$/.test(raw[k])) k++;
    const civic = raw[0];

    // After the civic number, a bare number is a unit (…-o-1201-montreal…).
    const words = [];
    for (const w of raw.slice(k)) {
      if (/^\d+[a-z]?$/.test(w)) continue;
      const prev = words[words.length - 1];
      if (DIRS[w] && prev && !DIRS[prev]) { words.push(DIRS[w]); continue; }
      words.push(ABBREV[w] || w);
    }
    if (words.length < 1) return null;

    const candidates = [];
    for (let n = words.length; n >= Math.min(2, words.length); n--) {
      candidates.push(`${civic} ${words.slice(0, n).join(' ')}`);
    }
    return { query: candidates[0], candidates, source: 'realtor', confidence: 'medium' };
  }

  // Street types anchor a free-text match, so "3 chambres" or "2 bedrooms" is
  // never mistaken for an address. French puts the type first ("1234 rue
  // Beaubien"), English puts it last ("55 Sherbrooke St. W"), so each order
  // has its own pattern.
  const FR_TYPES = 'rue|avenue|av\\.?|boulevard|boul\\.?|chemin|ch\\.?|rang|route|place|mont[ée]e|c[ôo]te|croissant|terrasse|impasse|all[ée]e|promenade|rue';
  const EN_TYPES = 'street|st\\.?|avenue|ave\\.?|boulevard|blvd\\.?|road|rd\\.?|drive|dr\\.?|crescent|cres\\.?|court|ct\\.?|lane|ln\\.?|place|pl\\.?';
  const DIRECTION = '(?:\\s+(?:n|s|e|w|o|north|south|east|west|nord|sud|est|ouest)\\.?)?';

  // A city is letters, spaces, hyphens and apostrophes only: stopping at a
  // period keeps "Montréal. Chauffé, éclairé" from swallowing the next sentence.
  const CITY = "(?:\\s*,\\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'’\\- ]{1,40}))?";

  const FR_ADDRESS = new RegExp(
    `\\b(\\d{1,6}[A-Za-z]?)[,\\s]+((?:${FR_TYPES})\\s+[A-Za-zÀ-ÿ'’\\-]+(?:\\s+[A-Za-zÀ-ÿ'’\\-]+){0,4}?${DIRECTION})(?=\\s*(?:[,.;\\n(]|\\s-\\s|$))${CITY}`,
    'i'
  );
  const EN_ADDRESS = new RegExp(
    `\\b(\\d{1,6}[A-Za-z]?)\\s+((?:[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\\-]*\\s+){1,4}(?:${EN_TYPES})${DIRECTION})(?=\\s*(?:[,;\\n(]|\\s-\\s|$))${CITY}`,
    'i'
  );
  const POSTAL = /\b([A-CEGHJ-NPR-TVXY]\d[A-CEGHJ-NPR-TV-Z])\s?-?(\d[A-CEGHJ-NPR-TV-Z]\d)\b/i;

  const tidy = s => s.trim().replace(/\s+/g, ' ');

  // Kijiji, Marketplace, Kangalou and the rest: no fixed format, so only a
  // number next to a street type counts, optionally followed by a city.
  function fromFreeText(text) {
    if (!text) return null;
    const s = String(text).replace(/https?:\/\/\S+/g, ' ');
    const m = s.match(FR_ADDRESS) || s.match(EN_ADDRESS);
    if (m) {
      const civic = m[1];
      const street = tidy(m[2]);
      const city = m[3] ? tidy(m[3]) : '';
      const query = city ? `${civic} ${street}, ${city}` : `${civic} ${street}`;
      return { query, candidates: [query], source: 'text', confidence: city ? 'medium' : 'low' };
    }
    const p = s.match(POSTAL);
    if (p) {
      const query = `${p[1]} ${p[2]}`.toUpperCase();
      return { query, candidates: [query], source: 'postal', confidence: 'low' };
    }
    return null;
  }

  // Sites whose links never carry an address, so a bare link can only be
  // answered with an explanation, never a guess.
  const NO_ADDRESS_SITES = [
    [/centris\.ca/i, 'Centris'],
    [/kijiji\.ca/i, 'Kijiji'],
    [/facebook\.com\/marketplace|fb\.me/i, 'Marketplace'],
    [/kangalou\.com/i, 'Kangalou'],
    [/louer\.com/i, 'Louer.com'],
    [/rentals\.ca/i, 'Rentals.ca'],
  ];

  const firstUrl = s => (String(s || '').match(/https?:\/\/[^\s<>"']+/) || [])[0] || '';

  /* One entry point for shares and pastes. Tries the most exact source first.
     Returns {query, candidates, source, confidence}, or {unresolvable, site}
     when a link is recognised but carries no address, or null. */
  function extractAddress(input) {
    const title = String((input && input.title) || '');
    const text = String((input && input.text) || '');
    const url = String((input && input.url) || '') || firstUrl(text) || firstUrl(title);

    const found =
      fromCentrisTitle(title) ||
      fromCentrisTitle(text) ||
      fromRealtorUrl(url) ||
      fromRealtorUrl(text) ||
      fromFreeText(title) ||
      fromFreeText(text);
    if (found) return Object.assign({ url }, found);

    if (url) {
      const hit = NO_ADDRESS_SITES.find(([re]) => re.test(url));
      if (hit) return { unresolvable: true, site: hit[1], url };
    }
    return null;
  }

  // True when a search-box entry is a listing rather than an address to geocode.
  const looksLikeListing = s => /https?:\/\/|centris\.ca|realtor\.ca|kijiji\.ca|kangalou|marketplace/i.test(String(s || ''));

  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const GENERIC_STREET_WORDS = new Set(['rue', 'avenue', 'boulevard', 'chemin', 'route', 'place',
    'ouest', 'est', 'nord', 'sud', 'street', 'road', 'drive']);

  /* A geocoder will happily return *a* Rue Saint-André when asked for
     "370 Rue Saint-André, Montréal" - in testing it came back with Saint-André-
     Avellin, 150 km away, with the civic number silently dropped. So a result
     title is only accepted when it carries the civic number, a distinctive
     word of the street and, when the query names one, the city. */
  function matchesCandidate(placeTitle, query) {
    const title = ` ${fold(placeTitle)} `;

    const civic = String(query).match(/^\s*(\d+)([A-Za-z]?)/);
    if (civic) {
      // "1842Z" may come back as "1842z" or plain "1842"; either will do.
      const withLetter = fold(civic[1] + civic[2]);
      if (!title.includes(` ${withLetter} `) && !title.includes(` ${civic[1]} `)) return false;
    }

    const rest = String(query).replace(/^\s*\d+[A-Za-z]?\s*/, '');
    const comma = rest.indexOf(',');
    const street = comma < 0 ? rest : rest.slice(0, comma);
    // Only the first segment after the street is the city: "…, Montréal, QC"
    // must not demand that the title contain "montreal qc" verbatim.
    const city = comma < 0 ? '' : rest.slice(comma + 1).split(',')[0];

    const words = fold(street).split(' ').filter(w => w.length >= 4 && !GENERIC_STREET_WORDS.has(w));
    if (words.length && !words.slice(0, 3).some(w => title.includes(` ${w} `))) return false;

    if (city.trim() && !title.includes(` ${fold(city)} `)) return false;
    return true;
  }

  const api = { fromCentrisTitle, fromRealtorUrl, fromFreeText, extractAddress, looksLikeListing, matchesCandidate, fold };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QVBListing = api;
})(typeof window !== 'undefined' ? window : globalThis);
