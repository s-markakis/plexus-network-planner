// Images a project pulls from other servers. A project file or share link is
// untrusted, and an <img> pointing at someone else's server tells that server
// the viewer's IP address and when the plan was opened (a tracking beacon).
// So remote images in a loaded project are listed for the user to allow or
// drop. data:/blob: and same-origin images never leave the machine. Pure.

const DEVICE_LISTS = ['APS', 'CAMS', 'SWS', 'CLIENTS'];
const isRemote = (u) => typeof u === 'string' && /^\s*(?:https?:)?\/\//i.test(u);

function hostOf(u) {
  try { return new URL(u.trim().startsWith('//') ? 'https:' + u.trim() : u.trim()).host || u; } catch { return u; }
}

/** Every remote image reference: {owner, key, url}. `owner[key]` holds the URL. */
export function remoteImageRefs(project) {
  const out = [];
  if (!project || typeof project !== 'object') return out;
  const s = project.settings;
  if (s && isRemote(s.logoDataUrl)) out.push({ owner: s, key: 'logoDataUrl', url: s.logoDataUrl });
  for (const f of Array.isArray(project.floors) ? project.floors : []) {
    if (!f || typeof f !== 'object') continue;
    if (isRemote(f.img)) out.push({ owner: f, key: 'img', url: f.img });
    for (const k of DEVICE_LISTS) {
      for (const d of Array.isArray(f[k]) ? f[k] : []) {
        if (d && isRemote(d.imageUrl)) out.push({ owner: d, key: 'imageUrl', url: d.imageUrl });
      }
    }
  }
  return out;
}

/** Distinct hosts the project would contact, sorted. */
export function remoteImageHosts(project) {
  return [...new Set(remoteImageRefs(project).map((r) => hostOf(r.url)))].sort();
}

/** Blank every remote image reference in place; returns how many were dropped. */
export function stripRemoteImages(project) {
  const refs = remoteImageRefs(project);
  for (const r of refs) r.owner[r.key] = '';
  return refs.length;
}
