// Client-facing report: what is being installed and how well it covers the
// site — for the person paying for it, not the engineer. Pure: a data model in,
// an HTML document string out (unit-testable, no DOM).
//
// Deliberately NOT in this report (they are in the technical audit report):
// IP/MAC addresses, VLANs, switch ports, credentials and internal notes. The
// model passed in simply must not contain them — buildClientReportModel() is
// the one place that decides what crosses over.
//
// Every value from the project is escaped. The one exception is each floor's
// `overlay.innerSVG`, which is markup the app itself generated.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STRINGS = {
  en: {
    title: 'Network Proposal & Coverage Report',
    summary: 'Summary', floors: ['Floor', 'Floors'], aps: 'Access points', cams: 'Cameras', sws: 'Switches',
    coverage: 'WiFi coverage', clients: 'Devices supported',
    intro: (t) => `This document describes the network designed for ${t.site || 'your site'}: ${t.aps} WiFi access point${t.aps === 1 ? '' : 's'}`
      + `${t.cams ? `, ${t.cams} camera${t.cams === 1 ? '' : 's'}` : ''} and ${t.sws} switch${t.sws === 1 ? '' : 'es'} across ${t.floors} floor${t.floors === 1 ? '' : 's'}.`
      + ` The design is predicted to cover ${t.coveragePct}% of the planned area with a usable WiFi signal.`,
    floorCoverage: 'coverage', floorLine: (f) => `${f.aps} access point${f.aps === 1 ? '' : 's'} · ${f.cams} camera${f.cams === 1 ? '' : 's'}`,
    noPlan: 'No floor plan for this floor.',
    measured: 'Measured on site',
    measuredLine: (s) => `${s.n} measurement point${s.n === 1 ? '' : 's'} · average signal ${s.avg} dBm · weakest ${s.min} dBm · ${s.okPct}% of points at or above the ${s.target} dBm target`,
    legend: 'Coloured areas show where the WiFi signal is predicted to be usable. Stronger colour means stronger signal.',
    equipment: 'Equipment', category: 'Type', model: 'Model', qty: 'Qty',
    kinds: { AP: 'Access point', Camera: 'Camera', Switch: 'Switch / router' },
    cabling: 'Cabling', cablingLine: (c) => `${c.runs} network cable run${c.runs === 1 ? '' : 's'}, about ${c.totalM} m of cable in total (including slack).`,
    storage: 'Video recording', storageLine: (s) => `Recorder capacity for ${s.days} days of footage from all cameras: about ${s.size}.`,
    acceptance: 'Acceptance', acceptText: 'The installation described above has been completed and demonstrated.',
    client: 'Client', installer: 'Installer', date: 'Date', signature: 'Name & signature',
    generated: 'Generated', print: 'Print / Save as PDF', predicted: 'Coverage figures are predictions from a radio model and the floor plans provided; on-site measurements, where shown, are the reference.',
  },
  el: {
    title: 'Πρόταση Δικτύου & Αναφορά Κάλυψης',
    summary: 'Σύνοψη', floors: ['Όροφος', 'Όροφοι'], aps: 'Σημεία πρόσβασης WiFi', cams: 'Κάμερες', sws: 'Switches',
    coverage: 'Κάλυψη WiFi', clients: 'Υποστηριζόμενες συσκευές',
    intro: (t) => `Το έγγραφο περιγράφει το δίκτυο που σχεδιάστηκε για ${t.site || 'τον χώρο σας'}: ${t.aps} ${t.aps === 1 ? 'σημείο πρόσβασης' : 'σημεία πρόσβασης'} WiFi`
      + `${t.cams ? `, ${t.cams} ${t.cams === 1 ? 'κάμερα' : 'κάμερες'}` : ''} και ${t.sws} ${t.sws === 1 ? 'switch' : 'switches'} σε ${t.floors} ${t.floors === 1 ? 'όροφο' : 'ορόφους'}.`
      + ` Ο σχεδιασμός προβλέπεται να καλύπτει το ${t.coveragePct}% του χώρου με αξιοποιήσιμο σήμα WiFi.`,
    floorCoverage: 'κάλυψη', floorLine: (f) => `${f.aps} ${f.aps === 1 ? 'σημείο πρόσβασης' : 'σημεία πρόσβασης'} · ${f.cams} ${f.cams === 1 ? 'κάμερα' : 'κάμερες'}`,
    noPlan: 'Δεν υπάρχει κάτοψη για αυτόν τον όροφο.',
    measured: 'Μετρήσεις στον χώρο',
    measuredLine: (s) => `${s.n} ${s.n === 1 ? 'σημείο μέτρησης' : 'σημεία μέτρησης'} · μέσο σήμα ${s.avg} dBm · ασθενέστερο ${s.min} dBm · ${s.okPct}% των σημείων στον στόχο των ${s.target} dBm ή καλύτερα`,
    legend: 'Οι χρωματισμένες περιοχές δείχνουν πού το σήμα WiFi προβλέπεται αξιοποιήσιμο. Εντονότερο χρώμα σημαίνει ισχυρότερο σήμα.',
    equipment: 'Εξοπλισμός', category: 'Είδος', model: 'Μοντέλο', qty: 'Τεμ.',
    kinds: { AP: 'Σημείο πρόσβασης', Camera: 'Κάμερα', Switch: 'Switch / router' },
    cabling: 'Καλωδίωση', cablingLine: (c) => `${c.runs} ${c.runs === 1 ? 'γραμμή' : 'γραμμές'} καλωδίου δικτύου, περίπου ${c.totalM} m καλωδίου συνολικά (με περιθώριο).`,
    storage: 'Καταγραφή βίντεο', storageLine: (s) => `Χωρητικότητα καταγραφικού για ${s.days} ημέρες από όλες τις κάμερες: περίπου ${s.size}.`,
    acceptance: 'Παραλαβή', acceptText: 'Η εγκατάσταση που περιγράφεται παραπάνω ολοκληρώθηκε και επιδείχθηκε.',
    client: 'Πελάτης', installer: 'Εγκαταστάτης', date: 'Ημερομηνία', signature: 'Ονοματεπώνυμο & υπογραφή',
    generated: 'Δημιουργήθηκε', print: 'Εκτύπωση / Αποθήκευση ως PDF', predicted: 'Τα ποσοστά κάλυψης είναι προβλέψεις από μοντέλο διάδοσης και τις κατόψεις που δόθηκαν· όπου υπάρχουν μετρήσεις στον χώρο, αυτές αποτελούν την αναφορά.',
  },
};

// 'el' for a Greek UI language or locale, else 'en'.
export function reportLang(settings = {}) {
  return /^el\b/i.test(String(settings.language || '')) || /^el\b/i.test(String(settings.locale || '')) ? 'el' : 'en';
}

// Survey statistics for one floor's measurement points, or null when none.
/** @param {Array<{rssi?:number}>|undefined} samples @param {number} [target] */
export function surveyStats(samples, target = -67) {
  const vals = /** @type {number[]} */ ((samples || []).map((s) => s && s.rssi).filter((v) => Number.isFinite(v)));
  if (!vals.length) return null;
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  return { n: vals.length, avg, min: Math.min(...vals), okPct: Math.round(vals.filter((v) => v >= target).length / vals.length * 100), target };
}

// Equipment grouped by kind + model → [{kind, model, qty}], stable order.
export function equipmentList(floors) {
  const tally = new Map();
  const add = (kind, model) => {
    const m = String(model || '').trim() || '—';
    const k = kind + '|' + m;
    const e = tally.get(k) || { kind, model: m, qty: 0 };
    e.qty++; tally.set(k, e);
  };
  for (const f of floors || []) {
    for (const a of (f && f.APS) || []) add('AP', a.model);
    for (const c of (f && f.CAMS) || []) add('Camera', c.model);
    for (const s of (f && f.SWS) || []) add('Switch', s.model);
  }
  const order = { AP: 0, Camera: 1, Switch: 2 };
  return [...tally.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.model.localeCompare(b.model));
}

/**
 * The only bridge from a project to the client report: picks the fields a
 * client should see and nothing else.
 * @param {{settings:any, floors:any[], floorViews:Array<{src:string, overlay:{cw:number,ch:number,innerSVG:string}, pct:number}>,
 *   coveragePct:number, clientCapacity:number, cable:{runs:number,totalM:number}, storageGb:number, now?:Date}} p
 */
export function buildClientReportModel(p) {
  const s = p.settings || {};
  const floors = p.floors || [];
  const count = (k) => floors.reduce((n, f) => n + ((f && f[k]) || []).length, 0);
  const days = parseInt(s.retentionDays, 10) || 30;
  return {
    lang: reportLang(s),
    locale: s.locale || 'en-GB',
    company: s.company || 'Plexus', tagline: s.tagline || '', contact: s.contact || '',
    logoDataUrl: /^data:image\//.test(String(s.logoDataUrl || '')) ? s.logoDataUrl : '',
    site: s.siteCode || '', footerLine: s.footerLine || '',
    date: p.now || new Date(),
    totals: { floors: floors.length, aps: count('APS'), cams: count('CAMS'), sws: count('SWS'), coveragePct: p.coveragePct, clients: p.clientCapacity },
    floors: floors.map((f, i) => ({
      name: f.name || `Floor ${i + 1}`,
      aps: (f.APS || []).length, cams: (f.CAMS || []).length,
      src: (p.floorViews[i] || {}).src || '',
      overlay: (p.floorViews[i] || {}).overlay || null,
      pct: (p.floorViews[i] || {}).pct || 0,
      survey: surveyStats(f.SAMPLES),
    })),
    equipment: equipmentList(floors),
    cable: p.cable && p.cable.runs > 0 ? { runs: p.cable.runs, totalM: p.cable.totalM } : null,
    storage: p.storageGb > 0 ? { days, size: p.storageGb >= 1000 ? (p.storageGb / 1000).toFixed(1) + ' TB' : Math.round(p.storageGb) + ' GB' } : null,
  };
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f4f2ec;font-family:'Rajdhani','Helvetica Neue',Arial,sans-serif;color:#111;padding:44px 52px;font-size:14px;line-height:1.45}
.cover{padding:8px 0 34px;border-bottom:2px solid #111;margin-bottom:30px}
.cover-logo{max-height:64px;max-width:260px;display:block;margin-bottom:22px}
.company{font-size:56px;font-weight:700;letter-spacing:-.02em;line-height:1}
.tagline{font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin-top:10px;color:#444}
.doc-title{font-size:24px;font-weight:600;margin-top:30px}
.doc-sub{font-size:12px;color:#555;margin-top:4px}
h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;margin:30px 0 10px;padding-bottom:6px;border-bottom:1px solid #111;display:flex;justify-content:space-between;align-items:baseline}
h2 .cov{font-size:15px;letter-spacing:0;text-transform:none;color:#1e7d3c;font-weight:700}
.stats{display:flex;flex-wrap:wrap;gap:26px;margin:14px 0 6px}
.stat strong{display:block;font-size:34px;font-weight:700;line-height:1}
.stat span{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#444}
p{margin:8px 0}
.muted{color:#555;font-size:12px}
.map{position:relative;width:100%;border:1px solid #111;background:#e9e6df;overflow:hidden;margin:8px 0}
.map img{width:100%;display:block}
.map svg{position:absolute;top:0;left:0;width:100%;height:100%}
.map.empty{aspect-ratio:1200/600;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px}
.measured{border-left:3px solid #1e7d3c;padding:6px 12px;margin:8px 0;background:#fff}
.measured b{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin:6px 0 14px}
th{text-align:left;font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid #111}
td{padding:8px 10px;border-bottom:1px solid rgba(0,0,0,.1)}
td.qty,th.qty{text-align:right;width:70px}
.sign{display:flex;gap:40px;margin-top:26px}
.sign div{flex:1}
.sign .line{border-bottom:1px solid #111;height:46px}
.sign label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#444;display:block;margin-top:6px}
.footer{margin-top:40px;padding-top:12px;border-top:1px solid #111;font-size:10px;letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;color:#333}
.footer-line{text-align:center;font-size:10px;color:#666;margin-top:8px}
.print-btn{margin-top:22px;padding:12px 26px;background:#111;color:#f4f2ec;border:none;border-radius:2px;font-size:12px;cursor:pointer;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
.floor.break{page-break-before:always}
@media print{body{padding:22px 26px;background:#fff}.print-btn{display:none}.cover{page-break-after:avoid}h2{page-break-after:avoid}tr,.floor,.sign{page-break-inside:avoid}}
`;

/** @param {ReturnType<typeof buildClientReportModel>} m @returns {string} a complete HTML document */
export function renderClientReport(m) {
  const t = STRINGS[m.lang] || STRINGS.en;
  const dateStr = (() => { try { return m.date.toLocaleDateString(m.locale); } catch { return m.date.toISOString().slice(0, 10); } })();
  const T = m.totals;
  const stat = (v, label) => `<div class="stat"><strong>${esc(v)}</strong><span>${esc(label)}</span></div>`;
  const floors = m.floors.map((f, i) => {
    const o = f.overlay;
    const map = f.src && o
      ? `<div class="map"><img src="${esc(f.src)}" alt=""/><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Number(o.cw) || 1000} ${Number(o.ch) || 700}" preserveAspectRatio="xMidYMid meet">${o.innerSVG}</svg></div>`
      : `<div class="map empty"><span>${esc(t.noPlan)}</span></div>`;
    const measured = f.survey ? `<div class="measured"><b>${esc(t.measured)}</b>${esc(t.measuredLine(f.survey))}</div>` : '';
    return `<section class="floor${i > 0 ? ' break' : ''}">
<h2><span>${esc(f.name)}</span><span class="cov">${esc(f.pct)}% ${esc(t.floorCoverage)}</span></h2>
<div class="muted">${esc(t.floorLine(f))}</div>
${map}
${measured}
</section>`;
  }).join('\n');
  const equipment = m.equipment.length ? `<h2><span>${esc(t.equipment)}</span></h2>
<table><thead><tr><th>${esc(t.category)}</th><th>${esc(t.model)}</th><th class="qty">${esc(t.qty)}</th></tr></thead><tbody>
${m.equipment.map((e) => `<tr><td>${esc(t.kinds[e.kind] || e.kind)}</td><td>${esc(e.model)}</td><td class="qty">${esc(e.qty)}</td></tr>`).join('\n')}
</tbody></table>` : '';
  const cabling = m.cable ? `<h2><span>${esc(t.cabling)}</span></h2><p>${esc(t.cablingLine(m.cable))}</p>` : '';
  const storage = m.storage ? `<h2><span>${esc(t.storage)}</span></h2><p>${esc(t.storageLine(m.storage))}</p>` : '';
  return `<!DOCTYPE html><html lang="${esc(m.lang)}"><head><meta charset="UTF-8"/><title>${esc(m.company)} — ${esc(t.title)}</title><style>${CSS}</style></head><body>
<div class="cover">
${m.logoDataUrl ? `<img class="cover-logo" src="${esc(m.logoDataUrl)}" alt=""/>` : ''}
<div class="company">${esc(m.company)}</div>
${m.tagline ? `<div class="tagline">${esc(m.tagline)}</div>` : ''}
<div class="doc-title">${esc(t.title)}${m.site ? ' — ' + esc(m.site) : ''}</div>
<div class="doc-sub">${esc(dateStr)}${m.contact ? ' · ' + esc(m.contact) : ''}</div>
</div>
<h2><span>${esc(t.summary)}</span></h2>
<p>${esc(t.intro({ ...T, site: m.site }))}</p>
<div class="stats">
${stat(T.coveragePct + '%', t.coverage)}${stat(T.aps, t.aps)}${T.cams ? stat(T.cams, t.cams) : ''}${stat(T.sws, t.sws)}${stat(T.floors, t.floors[T.floors === 1 ? 0 : 1])}${T.clients ? stat('~' + T.clients, t.clients) : ''}
</div>
<p class="muted">${esc(t.legend)}</p>
${floors}
${equipment}
${cabling}
${storage}
<h2><span>${esc(t.acceptance)}</span></h2>
<p>${esc(t.acceptText)}</p>
<div class="sign">
<div><div class="line"></div><label>${esc(t.client)} — ${esc(t.signature)}</label></div>
<div><div class="line"></div><label>${esc(t.installer)} — ${esc(t.signature)}</label></div>
<div><div class="line"></div><label>${esc(t.date)}</label></div>
</div>
<p class="muted" style="margin-top:18px">${esc(t.predicted)}</p>
<div class="footer"><span>${esc(m.company)}${m.contact ? ' · ' + esc(m.contact) : ''}</span><span>${esc(t.generated)} ${esc(dateStr)}</span></div>
${m.footerLine ? `<div class="footer-line">${esc(m.footerLine)}</div>` : ''}
<button class="print-btn">${esc(t.print)}</button>
</body></html>`;
}
