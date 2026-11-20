// What a Share link may carry. A link ends up pasted into chats and tickets,
// so it is built from the design only: layout, addressing, VLANs, sim config,
// policies, circuits. Left out: device credentials (at any depth), the UniFi
// controller location/login, inventory identifiers that tie the plan to real
// hardware (MAC, serial, asset tag, firmware), floor-plan images (size) and
// per-item caches. Pure.

const DEVICE_LISTS = ['APS', 'CAMS', 'SWS', 'CLIENTS'];
const DEVICE_DROP = ['creds', 'mac', 'serial', 'assetTag', 'firmware'];
const SETTINGS_DROP = ['unifiUrl', 'unifiSite', 'unifiUser'];

/**
 * @param {{version:number, settings:any, floors:any[]}} p
 * @returns {{version:number, settings:any, floors:any[]}} a fresh, stripped copy
 */
export function projectForShare({ version, settings, floors }) {
  // Deep copy that drops every `creds` object and `_cache` key wherever it is.
  const copy = JSON.parse(JSON.stringify({ settings, floors }, (k, v) => (k === 'creds' || k.startsWith('_') ? undefined : v)));
  for (const k of SETTINGS_DROP) delete copy.settings[k];
  for (const f of copy.floors) {
    delete f.img; delete f.imgId;
    for (const key of DEVICE_LISTS) {
      for (const d of Array.isArray(f[key]) ? f[key] : []) for (const k of DEVICE_DROP) delete d[k];
    }
  }
  return { version, settings: copy.settings, floors: copy.floors };
}
