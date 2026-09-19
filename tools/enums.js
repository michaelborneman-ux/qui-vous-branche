// ISED National Broadband Map enum decoding.
// Source: https://ised-isde.canada.ca/app/scr/sittibc/web/js/map/selected_area_info.js
//   (SelectedAreaInfoHelper.initializeAreaInformationMaps -> providerTypeMap)
// Labels: .../web/messages/messages_eng.json + messages_fra.json, keys map.service_type_<n>
// Verified 2026-09-19.

// providerType -> our technology slug
const TECH = {
  1:  'dsl',
  2:  'cable',
  5:  'fixedWireless',
  7:  'satellite',
  8:  'mobile',
  10: 'fibre',
  11: 'transport',   // wholesale high-capacity transport, hidden from consumers on the official map
  12: 'transport',   // high capacity fibre transport
  13: 'transport',   // microwave transport
  14: 'transport',   // satellite transport
  15: 'transport',   // coaxial cable transport
};

// Technologies that are not a residential internet option at an address.
const NON_RESIDENTIAL = new Set(['mobile', 'transport']);

// speedType -> label. All five values were confirmed on 2026-09-19 by calling
// api/hexagon?la=&lo=&lang=eng at the centroid of a cell exhibiting each value
// and reading back the server's own speedTypeDesc.
const SPEED = {
  1: { en: '< 5/1 Mbps',    fr: '< 5/1 Mbit/s',    down: 0 },
  2: { en: '5/1+ Mbps',     fr: '5/1+ Mbit/s',     down: 5 },
  3: { en: '10/2+ Mbps',    fr: '10/2+ Mbit/s',    down: 10 },
  4: { en: '25/5+ Mbps',    fr: '25/5+ Mbit/s',    down: 25 },
  5: { en: '50/10+ Mbps',   fr: '50/10+ Mbit/s',   down: 50 },
};

module.exports = { TECH, SPEED, NON_RESIDENTIAL };
