// Routers / gateways with a built-in WiFi radio. Placed as a switch/router,
// they also light up the floor — so the planner treats each one as an access
// point for coverage, the heatmap and the coverage percentage.
//
// The table is keyed by the catalogue model name (constants.js SW_MODEL_GROUPS)
// and lists ONLY models that have radios; everything else in that catalogue is
// wired-only. Sources: vendor spec pages (mikrotik.com product pages,
// techspecs.ui.com), checked 2026-11.
//   freq     which bands the radios cover (same strings the AP models use)
//   gainDbi  antenna gain; for dual-band units the 5 GHz figure
//   rangeM   planning radius indoors. Deliberately a little under a ceiling AP
//            of the same class: these sit on a desk or in a rack, not overhead.
// rangeM is a planning default, not a measurement — a site survey wins.
export const ROUTER_WIFI = Object.freeze({
  // Ubiquiti UniFi
  'UDM':             { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 3,   rangeM: 15 },
  'Dream Machine':   { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 3,   rangeM: 15 },
  'Dream Router':    { freq: '2.4 / 5 GHz', std: 'Wi-Fi 6', gainDbi: 3,   rangeM: 15 },
  'Dream Router 7':  { freq: '2.4 / 5 / 6 GHz', std: 'Wi-Fi 7', gainDbi: 4, rangeM: 16 },
  // MikroTik — single-band 2.4 GHz
  'hAP mini':        { freq: '2.4 GHz only', std: 'Wi-Fi 4', gainDbi: 1.5, rangeM: 10 },
  'hAP lite':        { freq: '2.4 GHz only', std: 'Wi-Fi 4', gainDbi: 1.5, rangeM: 10 },
  'hAP':             { freq: '2.4 GHz only', std: 'Wi-Fi 4', gainDbi: 2.5, rangeM: 12 },
  'hAP ax lite':     { freq: '2.4 GHz only', std: 'Wi-Fi 6', gainDbi: 4.3, rangeM: 12 },
  'L009UiGS-2HaxD-IN': { freq: '2.4 GHz only', std: 'Wi-Fi 6', gainDbi: 4, rangeM: 14 },
  // MikroTik — dual-band
  'hAP ac lite':     { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 2,   rangeM: 12 },
  'hAP ac²':         { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 2.5, rangeM: 13 },
  'hAP ac³':         { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 5.5, rangeM: 16 },
  'hAP ax²':         { freq: '2.4 / 5 GHz', std: 'Wi-Fi 6', gainDbi: 4.5, rangeM: 14 },
  'hAP ax³':         { freq: '2.4 / 5 GHz', std: 'Wi-Fi 6', gainDbi: 5.5, rangeM: 17 },
  'RB4011iGS+5HacQ2HnD-IN': { freq: '2.4 / 5 GHz', std: 'Wi-Fi 5', gainDbi: 3, rangeM: 17 },
});

/** @param {string|undefined} model @returns {{freq:string,std:string,gainDbi:number,rangeM:number}|null} */
export function routerWifiSpec(model) {
  return Object.prototype.hasOwnProperty.call(ROUTER_WIFI, String(model)) ? ROUTER_WIFI[String(model)] : null;
}

// Does this placed device radiate? A WiFi-capable model, unless its radio was
// switched off on the device (sw.wifi === false).
/** @param {any} sw */
export function hasWifi(sw) {
  return !!sw && sw.wifi !== false && !!routerWifiSpec(sw.model);
}

// The access point a WiFi router stands for, in the floor's own pixel scale
// (scaleM = metres per 100 px). The object is kept on the device under an
// underscore key — the save / undo serialisers drop those — so the coverage
// path cache that lives on AP objects keeps working between renders.
/** @param {any} sw @param {number} [scaleM] @returns {any|null} */
export function routerAsAp(sw, scaleM) {
  if (!hasWifi(sw) || !Number.isFinite(sw.fx) || !Number.isFinite(sw.fy)) return null;
  const spec = /** @type {any} */ (routerWifiSpec(sw.model));
  const s = Number.isFinite(scaleM) && /** @type {number} */ (scaleM) > 0 ? /** @type {number} */ (scaleM) : 100;
  const v = sw._wifiAp || (sw._wifiAp = {});
  Object.assign(v, {
    id: sw.id, name: sw.name, model: sw.model, fx: sw.fx, fy: sw.fy,
    r: spec.rangeM * 100 / s,
    freq: spec.freq, pattern: 'omni', heading: 0, sig: 'strong',
    channel: 'auto', chanWidth: 20,
    txPowerDbm: 20, antennaGainDbi: spec.gainDbi, cableLossDb: 0,
    viaRouter: true,
  });
  return v;
}

// Everything that radiates on a floor: its access points plus its WiFi routers.
/** @param {any} floor @returns {any[]} */
export function rfAps(floor) {
  const aps = (floor && floor.APS) || [];
  const extra = [];
  for (const sw of (floor && floor.SWS) || []) {
    const v = routerAsAp(sw, floor.scaleM);
    if (v) extra.push(v);
  }
  return extra.length ? [...aps, ...extra] : aps;
}

// The floor as the RF code should see it (APS includes the WiFi routers). The
// same object comes back when there are none, so callers can pass it freely.
/** @param {any} floor */
export function rfFloor(floor) {
  const all = rfAps(floor);
  return all === ((floor && floor.APS) || []) || !floor ? floor : { ...floor, APS: all };
}
