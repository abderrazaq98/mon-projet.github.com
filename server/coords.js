const proj4 = require('proj4');

/**
 * Définitions des projections Lambert marocaines (Merchich).
 * IMPORTANT : à vérifier avec un point connu de votre jeu de données.
 */
const PROJECTIONS = {
  LAMBERT_NORD: '+proj=lcc +lat_1=33.3 +lat_2=35.76666666666667 +lat_0=33.3 +lon_0=-5.4 +k_0=0.999625769 +x_0=500000 +y_0=300000 +ellps=clrk80 +towgs84=31,146,47,0,0,0,0 +units=m +no_defs',

  LAMBERT_CENTRE: '+proj=lcc +lat_1=29.7 +lat_2=31.7 +lat_0=29.7 +lon_0=-5.4 +k_0=0.999616304 +x_0=500000 +y_0=300000 +ellps=clrk80 +towgs84=31,146,47,0,0,0,0 +units=m +no_defs',

  LAMBERT_SUD: '+proj=lcc +lat_1=26.0 +lat_2=28.0 +lat_0=26.0 +lon_0=-5.4 +k_0=0.999615401 +x_0=500000 +y_0=300000 +ellps=clrk80 +towgs84=31,146,47,0,0,0,0 +units=m +no_defs',

  LAMBERT_SAHARA: '+proj=lcc +lat_1=26.7 +lat_2=28.7 +lat_0=26.7 +lon_0=-5.4 +k_0=0.999616437 +x_0=1200000 +y_0=400000 +ellps=clrk80 +towgs84=31,146,47,0,0,0,0 +units=m +no_defs',
};

const WGS84 = 'WGS84';
const ZONE = process.env.LAMBERT_ZONE || 'LAMBERT_NORD';

function lambertToWGS84(x, y) {
  const def = PROJECTIONS[ZONE] || PROJECTIONS.LAMBERT_NORD;
  const [lng, lat] = proj4(def, WGS84, [Number(x), Number(y)]);
  return { lat, lng };
}

function wgs84ToLambert(lat, lng) {
  const def = PROJECTIONS[ZONE] || PROJECTIONS.LAMBERT_NORD;
  const [x, y] = proj4(WGS84, def, [Number(lng), Number(lat)]);
  return { x, y };
}

module.exports = { lambertToWGS84, wgs84ToLambert, PROJECTIONS, ZONE };