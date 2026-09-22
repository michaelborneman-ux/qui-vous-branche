// Tests for listing.js against strings captured from the live sites on 2026-09-22.
// Usage: node tools/test-listing.js

const assert = require('assert');
const L = require('../listing.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (err) { console.error('  FAIL', name, '\n       ', err.message); process.exitCode = 1; }
}

console.log('Centris titles');

test('EN sale title with borough and region', () => {
  const r = L.fromCentrisTitle('House for sale in Montréal (Le Sud-Ouest), Montréal (Island), 6836, Rue Mazarin, 9786547 - Centris.ca');
  assert.strictEqual(r.query, '6836 Rue Mazarin, Montréal');
  assert.strictEqual(r.source, 'centris');
  assert.strictEqual(r.confidence, 'high');
});

test('EN rental title skips the apartment segment', () => {
  const r = L.fromCentrisTitle('Condo / Apartment for rent in Montréal (Ville-Marie), Montréal (Island), 370, Rue Saint-André, apt. 1106, 20626727 - Centris.ca');
  assert.strictEqual(r.query, '370 Rue Saint-André, Montréal');
});

test('FR rental title with "à louer à" and "app."', () => {
  const r = L.fromCentrisTitle('Condo / Appartement à louer à Montréal (Ville-Marie), Montréal (Île), 370, Rue Saint-André, app. 1106, 20626727 - Centris.ca');
  assert.strictEqual(r.query, '370 Rue Saint-André, Montréal');
});

test('civic number with a letter suffix', () => {
  const r = L.fromCentrisTitle('House for sale in Montréal (LaSalle), Montréal (Island), 1842Z, Rue du Bois-des-Caryers, 22919080 - Centris.ca');
  assert.strictEqual(r.query, '1842Z Rue du Bois-des-Caryers, Montréal');
});

test('town without a borough', () => {
  const r = L.fromCentrisTitle("House for sale in Baie-D'Urfé, Montréal (Island), 113, Rue Churchill, 19309931 - Centris.ca");
  assert.strictEqual(r.query, "113 Rue Churchill, Baie-D'Urfé");
});

test('a Centris title with no civic segment returns null', () => {
  assert.strictEqual(L.fromCentrisTitle('Residential properties for rent in Montréal (Island) - Centris.ca'), null);
});

test('a non-Centris title is ignored', () => {
  assert.strictEqual(L.fromCentrisTitle('370, Rue Saint-André, Montréal'), null);
});

console.log('REALTOR.ca URLs');

test('slug with unit number and neighbourhood', () => {
  const r = L.fromRealtorUrl('https://www.realtor.ca/real-estate/30314059/1450-boul-rene-levesque-o-1201-montreal-ville-marie-golden-square-mile');
  assert.strictEqual(r.candidates[0].startsWith('1450 boulevard rene levesque ouest montreal'), true, r.candidates[0]);
  assert.ok(!/1201/.test(r.candidates[0]), 'unit number should be dropped');
  assert.ok(r.candidates.includes('1450 boulevard rene levesque ouest montreal'), 'a clean candidate should exist');
});

test('civic range keeps the first number', () => {
  const r = L.fromRealtorUrl('https://www.realtor.ca/real-estate/30314047/3340-3342-av-de-la-falaise-montreal-cote-des-neigesnotre-dame-de-grace-cote-des-neiges');
  assert.ok(r.candidates[0].startsWith('3340 avenue de la falaise'), r.candidates[0]);
  assert.ok(!/3342/.test(r.candidates[0]));
});

test('rue with an apartment number', () => {
  const r = L.fromRealtorUrl('https://www.realtor.ca/real-estate/30314055/188-rue-gary-carter-402-montreal-villeraysaint-michelparc-extension-villeray');
  assert.ok(r.candidates.includes('188 rue gary carter montreal'), JSON.stringify(r.candidates.slice(0, 4)));
});

test('French /immobilier/ form', () => {
  const r = L.fromRealtorUrl('https://www.realtor.ca/immobilier/30314058/2513-rue-champdore-204-montreal-villeraysaint-michelparc-extension-saint-michel');
  assert.ok(r.candidates[0].startsWith('2513 rue champdore montreal'), r.candidates[0]);
});

test('candidates shrink one word at a time and never drop the street', () => {
  const r = L.fromRealtorUrl('https://www.realtor.ca/real-estate/1/10-rue-x-montreal-plateau');
  assert.deepStrictEqual(r.candidates, ['10 rue x montreal plateau', '10 rue x montreal', '10 rue x']);
});

test('a non-listing REALTOR.ca URL returns null', () => {
  assert.strictEqual(L.fromRealtorUrl('https://www.realtor.ca/qc/montreal/real-estate'), null);
});

console.log('Free text (Kijiji, Marketplace, messages)');

test('address with city after a comma', () => {
  const r = L.fromFreeText('4 1/2 à louer — 1234 rue Beaubien Est, Montréal. Chauffé, éclairé.');
  assert.strictEqual(r.query, '1234 rue Beaubien Est, Montréal');
});

test('English street type', () => {
  const r = L.fromFreeText('Bright 2BR, 55 Sherbrooke St. W, Montreal - available July 1');
  assert.ok(r && r.query.startsWith('55 Sherbrooke St. W'), r && r.query);
});

test('room counts are not addresses', () => {
  assert.strictEqual(L.fromFreeText('3 chambres, 2 salles de bain, 1 stationnement'), null);
});

// Real listing prose is full of numbers next to street words that aren't addresses.
const FREE_TEXT_CASES = [
  ['Loyer 1200$ par mois, rue calme, près du métro', null],
  ['À 2 rues du parc, grand 5 1/2', null],
  ['1 chambre, 1 salle de bain', null],
  ['Au 3e étage, 450 avenue du Parc, Montréal. Libre le 1er juillet', '450 avenue du Parc, Montréal'],
  ['5000 boulevard Saint-Laurent, Montréal', '5000 boulevard Saint-Laurent, Montréal'],
  ['Superbe 4 1/2 au 123 rue de la Montagne Est, Montréal', '123 rue de la Montagne Est, Montréal'],
  ['2345 chemin Sainte-Foy, Québec (Sainte-Foy)', '2345 chemin Sainte-Foy, Québec'],
  ['Appartement - 88 rue Principale - Gatineau', '88 rue Principale'],
];
for (const [input, want] of FREE_TEXT_CASES) {
  test(`free text: ${input.slice(0, 48)}`, () => {
    const r = L.fromFreeText(input);
    assert.strictEqual(r ? r.query : null, want);
  });
}

test('postal code as a last resort', () => {
  const r = L.fromFreeText('Logement disponible, secteur H2X 1Y4, animaux acceptés');
  assert.strictEqual(r.query, 'H2X 1Y4');
  assert.strictEqual(r.source, 'postal');
});

console.log('extractAddress (share and paste entry point)');

test('Android share of a Centris page: title wins over the address-less URL', () => {
  const r = L.extractAddress({
    title: 'Condo / Appartement à louer à Montréal (Ville-Marie), Montréal (Île), 370, Rue Saint-André, app. 1106, 20626727 - Centris.ca',
    url: 'https://www.centris.ca/fr/condos-appartements~a-louer~montreal-ville-marie/20626727',
  });
  assert.strictEqual(r.query, '370 Rue Saint-André, Montréal');
  assert.strictEqual(r.url, 'https://www.centris.ca/fr/condos-appartements~a-louer~montreal-ville-marie/20626727');
});

test('apps that put the URL inside the text field', () => {
  const r = L.extractAddress({ text: 'Regarde ça https://www.realtor.ca/real-estate/30314055/188-rue-gary-carter-402-montreal-villeraysaint-michelparc-extension-villeray' });
  assert.strictEqual(r.source, 'realtor');
  assert.ok(r.url.includes('realtor.ca'));
});

test('a bare Centris link is unresolvable, not guessed', () => {
  const r = L.extractAddress({ text: 'https://www.centris.ca/fr/condos-appartements~a-louer~montreal-ville-marie/20626727' });
  assert.deepStrictEqual({ u: r.unresolvable, s: r.site }, { u: true, s: 'Centris' });
});

test('a bare Kijiji link is unresolvable', () => {
  const r = L.extractAddress({ url: 'https://www.kijiji.ca/v-apartments-condos/city-of-montreal/4-1-2/1712345678' });
  assert.strictEqual(r.site, 'Kijiji');
});

test('nothing usable returns null', () => {
  assert.strictEqual(L.extractAddress({ text: 'look at this one!' }), null);
});

test('looksLikeListing separates links from plain addresses', () => {
  assert.strictEqual(L.looksLikeListing('https://www.centris.ca/fr/x/1'), true);
  assert.strictEqual(L.looksLikeListing('370 rue Saint-André, Montréal'), false);
});

console.log('matchesCandidate (guards against same-named streets elsewhere)');

test('rejects the Saint-André-Avellin result that was really returned', () => {
  assert.strictEqual(L.matchesCandidate('Rue Saint-André, Saint-André-Avellin, Quebec', '370 Rue Saint-André, Montréal'), false);
});

test('accepts the right building in Montréal', () => {
  assert.strictEqual(L.matchesCandidate('370 Rue Saint-André, Montréal, Québec', '370 Rue Saint-André, Montréal'), true);
});

test('accent and case differences do not matter', () => {
  assert.strictEqual(L.matchesCandidate('370 RUE SAINT-ANDRE, MONTREAL, QUEBEC', '370 Rue Saint-André, Montréal'), true);
});

test('wrong civic number on the right street is rejected', () => {
  assert.strictEqual(L.matchesCandidate('37 Rue Saint-André, Montréal, Québec', '370 Rue Saint-André, Montréal'), false);
});

test('a civic number that only appears inside another number does not count', () => {
  assert.strictEqual(L.matchesCandidate('1370 Rue Saint-André, Montréal, Québec', '370 Rue Saint-André, Montréal'), false);
});

test('lettered civic number matches with or without the letter', () => {
  assert.strictEqual(L.matchesCandidate('1842Z Rue du Bois-des-Caryers, Montréal, Québec', '1842Z Rue du Bois-des-Caryers, Montréal'), true);
  assert.strictEqual(L.matchesCandidate('1842 Rue du Bois-des-Caryers, Montréal, Québec', '1842Z Rue du Bois-des-Caryers, Montréal'), true);
});

test('REALTOR.ca candidate without a comma still checks number and street', () => {
  const q = '188 rue gary carter montreal villeraysaint michelparc extension villeray';
  assert.strictEqual(L.matchesCandidate('188 Rue Gary-Carter, Montréal, Québec', q), true);
  assert.strictEqual(L.matchesCandidate('188 Rue Principale, Granby, Québec', q), false);
});

test('only the first segment after the street is treated as the city', () => {
  assert.strictEqual(L.matchesCandidate('25 Rue Laurier, Gatineau, Québec', '25 rue Laurier, Gatineau, QC'), true);
  assert.strictEqual(L.matchesCandidate('25 Laurier Avenue West, Ottawa, Ontario', '25 rue Laurier, Gatineau, Quebec'), false);
});

test('a different street with the same number is rejected', () => {
  assert.strictEqual(L.matchesCandidate('370 Rue Sherbrooke, Montréal, Québec', '370 Rue Saint-André, Montréal'), false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
