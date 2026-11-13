// Simulation-mode UI for the packet tracer. Thin DOM shell over the pure engine
// (sim.js) + adapter (simCompile.js): pick a source and destination device from
// the current plan, run a ping or traceroute, and read the packet's journey as
// a step log. "Step" walks the path on the map by reusing the app's own
// select+zoom (via the onFocus callback) — no changes to the SVG render path.
//
// The formatting helpers below are pure and unit-tested; mountSimPanel is the
// only DOM-touching part.

import { ping, probe, traceroute, resetRuntime } from './sim.js';
import { compileTopology, pingableDevices, pingTargets, applyFaults } from './simCompile.js';
import { reachabilityMatrix } from './simMatrix.js';
import { blastRadius } from './blast.js';

// ── Pure formatting ──────────────────────────────────────────────────────────

// One engine event → one human-readable line. Unknown kinds fall back to the
// raw kind so nothing is silently dropped.
export function describeEvent(e) {
  const who = e.devName || e.dev || '?';
  switch (e.kind) {
    case 'host-send': return e.port != null ? `${who} opens ${e.protocol || 'tcp'} → ${e.to}:${e.port}` : `${who} sends ICMP echo → ${e.to}`;
    case 'arp-request': return `${who} ARP: who-has ${e.who}?`;
    case 'arp-cached': return `${who} ARP cache hit for ${e.ip}`;
    case 'arp-reply': return `${who} ARP: ${e.ip} is-at ${e.mac}`;
    case 'arp-fail': return `${who} ARP for ${e.ip} failed — unreachable`;
    case 'l2-learn': return `${who} learns ${e.mac} on ${e.iface} (VLAN ${e.vlan})`;
    case 'l2-flood': return `${who} floods VLAN ${e.vlan} (unknown ${e.dstMac})`;
    case 'l2-forward': return `${who} forwards to ${e.dstMac} (VLAN ${e.vlan})`;
    case 'l2-drop-vlan': return `${who} drops frame — VLAN ${e.vlan} not on ${e.iface}`;
    case 'l3-route': return `${who} routes ${e.dst} via ${e.via} [${e.routeKind}]`;
    case 'l3-no-route': return `${who} has no route to ${e.dst}`;
    case 'ttl-expired': return `${who} drops packet — TTL expired`;
    case 'icmp-echo': return `${who} receives echo-request from ${e.from}`;
    case 'icmp-reply': return `${who} receives echo-reply from ${e.from}`;
    case 'acl-drop': return `${who} drops packet — blocked by a firewall/ACL rule (${e.proto || 'ip'}${e.port != null ? ` port ${e.port}` : ''} → ${e.dst})`;
    case 'nat-out': return `${who} NAT: source ${e.from} → ${e.to}`;
    case 'nat-in': return `${who} NAT: destination ${e.from} → ${e.to}`;
    case 'cloud-reply': return `${who} (Internet) answers ${e.to}`;
    case 'l4-open': return `${who} accepts ${e.proto || ''} port ${e.port} from ${e.from}`;
    case 'l4-closed': return `${who} refuses ${e.proto || ''} port ${e.port} — nothing listening`;
    case 'l4-reply': return `${who} receives the reply from ${e.from}`;
    default: return `${who} ${e.kind}`;
  }
}

const STATUS_LABEL = {
  delivered: '✓ Reachable — echo reply received',
  unreachable: '✗ Unreachable — no path',
  'ttl-exceeded': '✗ TTL exceeded — routing loop or too many hops',
  filtered: '✗ Filtered — blocked by a firewall/ACL rule',
  closed: '✗ Reached — but the port is closed',
};

export function summarizePing(res) {
  return {
    ok: res.ok,
    label: STATUS_LABEL[res.status] || res.status,
    lines: res.events.map((e) => ({ text: describeEvent(e), dev: e.dev, ev: e })),
  };
}

// Inspector: an event's fields as labelled rows, newest-relevant first. Mirrors
// Packet Tracer's PDU envelope using whatever the engine captured for that step.
export function describePdu(e) {
  if (!e) return [];
  const rows = [['Step', e.kind]];
  if (e.devName) rows.push(['Device', e.devName]);
  if (e.iface) rows.push(['Interface', e.iface]);
  if (e.vlan != null) rows.push(['VLAN', String(e.vlan)]);
  if (e.mac) rows.push(['MAC', e.mac]);
  if (e.dstMac) rows.push(['Dst MAC', e.dstMac]);
  if (e.who) rows.push(['ARP who-has', e.who]);
  if (e.ip) rows.push(['IP', e.ip]);
  if (e.dst) rows.push(['Dst IP', e.dst]);
  if (e.via) rows.push(['Via', e.via]);
  if (e.routeKind) rows.push(['Route', e.routeKind]);
  if (e.proto) rows.push(['Protocol', e.proto]);
  if (e.port != null) rows.push(['Port', String(e.port)]);
  if (e.from) rows.push(['From', e.from]);
  if (e.to) rows.push(['To', e.to]);
  return rows;
}

// A probe() result in words: is the service reachable, closed, or firewalled?
export function summarizeProbe(res, proto, port) {
  const svc = `${proto}/${port}`;
  const label = res.status === 'delivered' ? `✓ Open — ${svc} answered`
    : res.status === 'closed' ? `✗ Closed — host reached, nothing listening on ${svc}`
    : res.status === 'filtered' ? `✗ Filtered — a firewall/ACL rule blocks ${svc}`
    : `✗ Unreachable — no path to the host`;
  return { ok: res.ok, label, lines: res.events.map((e) => ({ text: describeEvent(e), dev: e.dev, ev: e })) };
}

const MATRIX_MARK = { allowed: '✓', blocked: '⛔', unreachable: '✗', 'n/a': '·' };
// Matrix as plain rows for rendering/export: [['', ...vlans], [vlan, mark…], …].
export function matrixRows(matrix) {
  const head = ['from \\ to', ...matrix.vlans.map((v) => `VLAN ${v}`)];
  return [head, ...matrix.vlans.map((v, i) => [`VLAN ${v}`, ...matrix.cells[i].map((c) => MATRIX_MARK[c.status] || '?')])];
}

// Which protocol family a step belongs to — drives the event filters.
export function eventCategory(kind) {
  if (/^arp-/.test(kind)) return 'arp';
  if (/^l2-/.test(kind)) return 'l2';
  if (/^l3-|^ttl-/.test(kind)) return 'l3';
  if (/^acl-|^nat-/.test(kind)) return 'fw';
  return 'l4'; // icmp-*, l4-*, host-send, cloud-reply
}
export const EVENT_FILTERS = [['arp', 'ARP'], ['l2', 'Switching'], ['l3', 'Routing'], ['l4', 'ICMP / L4'], ['fw', 'Firewall / NAT']];

// The PDU at one step, split by OSI layer like Packet Tracer's inspector — from
// what the engine captured for that step. Layers with nothing to show are left out.
export function pduLayers(e) {
  if (!e) return [];
  const p = e.pdu || null;
  const layers = [];
  const push = (layer, rows) => { const r = rows.filter((x) => x[1] != null && x[1] !== ''); if (r.length) layers.push({ layer, rows: r.map(([k, v]) => [k, String(v)]) }); };
  push('At this device', [['Step', e.kind], ['Device', e.devName], ['Interface', e.iface], ['Decision', e.routeKind ? `route (${e.routeKind})` : e.dir ? `filter ${e.dir}bound` : ''], ['Connection state', e.state]]);
  push('Layer 2 — Ethernet', [['Src MAC', e.srcMac], ['Dst MAC', e.dstMac], ['Learned MAC', e.mac], ['VLAN', e.vlan], ['ARP who-has', e.who]]);
  push('Layer 3 — IP', [['Src IP', p ? p.src : e.from], ['Dst IP', p ? p.dst : e.dst || e.to], ['TTL', p ? p.ttl : null], ['Protocol', p ? p.proto : e.proto], ['Next hop', e.via], ['Resolved IP', e.ip]]);
  push(p && (p.proto === 'tcp' || p.proto === 'udp') ? `Layer 4 — ${p.proto.toUpperCase()}` : 'Layer 4 — ICMP',
    [['Type', p ? p.type : null], ['Dst port', p && p.dport != null ? p.dport : e.port]]);
  return layers;
}

export function summarizeTrace(hops) {
  return hops.map((h) => ({
    text: `${h.ttl}  ${h.ip || '* (no reply)'}${h.reached ? '  ← destination' : ''}`,
    reached: h.reached,
  }));
}

function optionLabel(d) {
  return `${d.name} — ${d.ip} (VLAN ${d.vlan})`;
}

// ── DOM mount ──────────────────────────────────────────────────────────────

// Build the panel into `root`. `getProject()` returns the live project object
// ({settings, floors}); `onFocus(meta)` highlights a device on the map;
// `onAnimate(points)` animates the packet across the canvas. Returns { refresh }.
/** @param {{root:any, getProject:Function, onFocus?:Function, onAnimate?:Function}} opts */
export function mountSimPanel(opts) {
  const { root, getProject, onFocus, onAnimate } = opts;
  const doc = root.ownerDocument;
  const el = (tag, attrs = {}, kids = []) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids) n.appendChild(c);
    return n;
  };

  const status = el('div', { class: 'sim-status' });
  const fromSel = el('select', { class: 'sim-sel', id: 'sim-from' });
  const toSel = el('select', { class: 'sim-sel', id: 'sim-to' });
  const pingBtn = el('button', { class: 'btn btn-primary', text: 'Ping' });
  const traceBtn = el('button', { class: 'btn', text: 'Traceroute' });
  // L4 probe: "can this device open tcp/554 on that one?"
  const protoSel = el('select', { class: 'sim-sel sim-proto', id: 'sim-proto' });
  for (const p of ['tcp', 'udp']) { const o = doc.createElement('option'); o.value = p; o.textContent = p.toUpperCase(); protoSel.appendChild(o); }
  const portInp = el('input', { class: 'ep-in sim-port', id: 'sim-port', type: 'number', min: '1', max: '65535', placeholder: 'port', value: '443' });
  const probeBtn = el('button', { class: 'btn', text: 'Probe port' });
  const matrixBtn = el('button', { class: 'btn', text: 'VLAN matrix' });
  const blastBtn = el('button', { class: 'btn', text: 'Blast radius', title: 'If the "From" device were compromised: everything it can reach' });
  // Scenario queue: several tests run back to back on one warm network.
  const queueBtn = el('button', { class: 'btn btn-ghost', text: '＋ Queue', title: 'Add the current From/To (and port) to the scenario' });
  const runQueueBtn = el('button', { class: 'btn', text: 'Run scenario' });
  const queueList = el('ol', { class: 'sim-queue' });
  /** @type {Array<{from:string, to:string, toIp:string, label:string, port:number|null, proto:string, result?:string}>} */
  const queue = [];
  // Step playback + event filters.
  const autoBtn = el('button', { class: 'btn btn-ghost', text: '⏵ Auto' });
  const speedSel = el('select', { class: 'sim-sel sim-speed', id: 'sim-speed' });
  for (const [v, t] of [['1400', '0.5×'], ['700', '1×'], ['350', '2×'], ['150', '4×']]) { const o = doc.createElement('option'); o.value = v; o.textContent = t; if (v === '700') o.selected = true; speedSel.appendChild(o); }
  const filterBar = el('div', { class: 'sim-filters' });
  const hidden = new Set(); // event categories filtered out
  for (const [cat, label] of EVENT_FILTERS) {
    const lab = el('label', { class: 'sim-filter' });
    const cb = doc.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset.cat = cat;
    cb.addEventListener('change', () => { if (cb.checked) hidden.delete(cat); else hidden.add(cat); applyFilters(); });
    lab.append(cb, doc.createTextNode(' ' + label));
    filterBar.appendChild(lab);
  }
  let autoTimer = null;
  // Fault injection: power off switches / cut uplinks, then re-run a test.
  const faultsBox = el('details', { class: 'sim-faults' });
  const faultsSum = el('summary', { text: 'Faults' });
  const faultsList = el('div', { class: 'sim-faults-list' });
  faultsBox.append(faultsSum, faultsList);
  const failDev = new Set(); // plan switch ids powered off
  const failLink = new Set(); // plan switch ids whose uplink is cut
  const matrixBox = el('div', { class: 'sim-matrix' });
  const verdict = el('div', { class: 'sim-verdict' });
  const log = el('ol', { class: 'sim-log' });
  const inspect = el('div', { class: 'sim-inspect' });
  const stepBar = el('div', { class: 'sim-stepbar' });
  const prevBtn = el('button', { class: 'btn btn-ghost', text: '◀ Prev' });
  const nextBtn = el('button', { class: 'btn btn-ghost', text: 'Step ▶' });
  const playBtn = el('button', { class: 'btn', text: '▶ Play' });

  stepBar.append(prevBtn, nextBtn, autoBtn, speedSel, playBtn);
  root.innerHTML = '';
  root.append(
    status,
    el('div', { class: 'sim-row' }, [el('label', { class: 'sim-lbl', text: 'From' }), fromSel]),
    el('div', { class: 'sim-row' }, [el('label', { class: 'sim-lbl', text: 'To' }), toSel]),
    el('div', { class: 'sim-row sim-actions' }, [pingBtn, traceBtn]),
    el('div', { class: 'sim-row sim-actions' }, [protoSel, portInp, probeBtn]),
    el('div', { class: 'sim-row sim-actions' }, [matrixBtn, blastBtn, queueBtn, runQueueBtn]),
    queueList,
    faultsBox,
    verdict,
    matrixBox,
    filterBar,
    log,
    inspect,
    stepBar
  );

  let compiled = null;
  let lineEls = []; // <li> per step, for highlighting
  let lineData = []; // the summary line objects {text, dev, ev} parallel to lineEls
  let pathMeta = []; // ordered {fx, fy, name} waypoints for canvas animation
  let metaById = new Map(); // sim id -> source meta, for onFocus
  let cursor = -1;

  function refresh() {
    let project;
    try {
      project = getProject();
    } catch {
      status.textContent = 'No project loaded.';
      return;
    }
    try {
      compiled = compileTopology(project);
    } catch (err) {
      compiled = null;
      status.textContent = `Could not build topology: ${err && err.message ? err.message : err}`;
      for (const s of [fromSel, toSel]) s.innerHTML = '';
      return;
    }
    metaById = compiled.meta;
    const devs = pingableDevices(compiled).sort((a, b) => a.name.localeCompare(b.name));
    const swCount = [...compiled.meta.values()].filter((m) => m.type === 'switch').length;
    status.textContent = `${devs.length} endpoint(s) · ${swCount} switch(es)` +
      (compiled.warnings.length ? ` · ⚠ ${compiled.warnings.length} warning(s)` : '');
    status.title = compiled.warnings.join('\n');

    const keepTo = toSel.value; // captured before the rebuild below clears it
    for (const sel of [fromSel, toSel]) {
      const keep = sel.value;
      sel.innerHTML = '';
      for (const d of devs) {
        const o = doc.createElement('option');
        o.value = d.simId;
        o.dataset.ip = d.ip;
        o.textContent = optionLabel(d);
        sel.appendChild(o);
      }
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
    // Beyond endpoints, "To" also offers switch management IPs, gateways and
    // the Internet (value "ip:<addr>" — they are destinations, never sources).
    const extra = pingTargets(compiled).filter((t) => t.group !== 'Endpoints');
    for (const group of [...new Set(extra.map((t) => t.group))]) {
      const og = doc.createElement('optgroup');
      og.label = group;
      for (const t of extra.filter((x) => x.group === group)) {
        const o = doc.createElement('option');
        o.value = `ip:${t.ip}`;
        o.dataset.ip = t.ip;
        o.textContent = `${t.name} — ${t.ip}`;
        og.appendChild(o);
      }
      toSel.appendChild(og);
    }
    if ([...toSel.options].some((o) => o.value === keepTo)) toSel.value = keepTo;
    if (toSel.options.length > 1 && toSel.value === fromSel.value) toSel.selectedIndex = 1;
    renderFaults();
  }

  // Checkbox per switch (power off) and per uplink (cut). Faults that no longer
  // exist in the plan are forgotten.
  function renderFaults() {
    const switches = [...compiled.meta.entries()].filter(([, m]) => m.type === 'switch').map(([, m]) => ({ id: m.srcId, name: m.name }));
    const links = compiled.uplinks || [];
    for (const id of [...failDev]) if (!switches.some((s) => s.id === id)) failDev.delete(id);
    for (const id of [...failLink]) if (!links.some((l) => l.id === id)) failLink.delete(id);
    faultsList.innerHTML = '';
    const row = (label, set, id) => {
      const lab = doc.createElement('label');
      lab.className = 'sim-fault';
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.checked = set.has(id);
      cb.addEventListener('change', () => { if (cb.checked) set.add(id); else set.delete(id); updateFaultSummary(); });
      lab.append(cb, doc.createTextNode(' ' + label));
      faultsList.appendChild(lab);
    };
    for (const s of switches) row(`Power off ${s.name}`, failDev, s.id);
    for (const l of links) row(`Cut ${l.mode === 'routed' ? 'routed link' : 'uplink'} ${l.from} → ${l.to}`, failLink, l.id);
    if (!switches.length) faultsList.appendChild(doc.createTextNode('No switches in the plan.'));
    updateFaultSummary();
  }
  function updateFaultSummary() {
    const n = failDev.size + failLink.size;
    faultsSum.textContent = n ? `Faults — ${n} active` : 'Faults';
    faultsBox.classList.toggle('active', n > 0);
  }
  // Recompile and apply the active faults; every test runs through this.
  function prepare() {
    refresh();
    if (!compiled) return false;
    applyFaults(compiled, { devices: [...failDev], links: [...failLink] });
    resetRuntime(compiled.net); // fresh ARP/MAC so the log shows the full exchange
    return true;
  }

  function renderLines(summary) {
    verdict.textContent = summary.label;
    verdict.className = 'sim-verdict ' + (summary.ok ? 'ok' : 'bad');
    log.innerHTML = '';
    inspect.innerHTML = '';
    lineData = summary.lines;
    stopAuto();
    lineEls = summary.lines.map((ln, i) => {
      const li = doc.createElement('li');
      li.textContent = ln.text;
      li.dataset.dev = ln.dev || '';
      if (ln.sep) li.className = 'sim-sep';
      else if (ln.ev) li.dataset.cat = eventCategory(ln.ev.kind);
      li.addEventListener('click', () => focusStep(i));
      log.appendChild(li);
      return li;
    });
    // Waypoints for the canvas animation: each step's device position, de-duped.
    pathMeta = [];
    for (const ln of summary.lines) {
      const m = ln.dev && metaById.get(ln.dev);
      if (!m || !Number.isFinite(m.fx) || !Number.isFinite(m.fy)) continue;
      const last = pathMeta[pathMeta.length - 1];
      if (last && last.fx === m.fx && last.fy === m.fy) continue;
      pathMeta.push({ fx: m.fx, fy: m.fy, name: m.name });
    }
    cursor = -1;
    applyFilters();
  }

  function applyFilters() {
    lineEls.forEach((li) => { li.hidden = !!li.dataset.cat && hidden.has(li.dataset.cat); });
  }
  // Next/previous step that is visible and is a real event (not a separator).
  function seek(from, dir) {
    for (let i = from + dir; i >= 0 && i < lineEls.length; i += dir) {
      if (!lineEls[i].hidden && !lineEls[i].classList.contains('sim-sep')) return i;
    }
    return -1;
  }
  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    autoBtn.textContent = '⏵ Auto';
  }
  function toggleAuto() {
    if (autoTimer) return stopAuto();
    if (seek(cursor, 1) < 0) cursor = -1; // at the end: start over
    if (seek(cursor, 1) < 0) return; // nothing to play
    const tick = () => {
      const n = seek(cursor, 1);
      if (n < 0) return stopAuto();
      focusStep(n);
      if (seek(cursor, 1) < 0) stopAuto(); // that was the last step
    };
    autoBtn.textContent = '⏸ Pause';
    autoTimer = setInterval(tick, Number(speedSel.value) || 700);
    tick();
  }

  function renderInspector(ev) {
    inspect.innerHTML = '';
    const row = (k, v) => {
      const r = doc.createElement('div');
      r.className = 'sim-insp-row';
      const kk = doc.createElement('span'); kk.className = 'sim-insp-k'; kk.textContent = k;
      const vv = doc.createElement('span'); vv.className = 'sim-insp-v'; vv.textContent = v;
      r.append(kk, vv);
      return r;
    };
    for (const { layer, rows } of pduLayers(ev)) {
      const h = doc.createElement('div');
      h.className = 'sim-insp-layer';
      h.textContent = layer;
      inspect.appendChild(h);
      for (const [k, v] of rows) inspect.appendChild(row(k, v));
    }
  }

  function focusStep(i) {
    if (i < 0 || i >= lineEls.length) return;
    cursor = i;
    lineEls.forEach((li, j) => li.classList.toggle('active', j === i));
    const devId = lineEls[i].dataset.dev;
    const m = devId && metaById.get(devId);
    if (m && typeof onFocus === 'function') onFocus(m);
    if (lineData[i]) renderInspector(lineData[i].ev);
    try { lineEls[i].scrollIntoView({ block: 'nearest' }); } catch { /* non-browser env */ }
  }

  function play() {
    if (typeof onAnimate === 'function' && pathMeta.length) onAnimate(pathMeta);
  }

  function runPing() {
    if (!prepare() || !fromSel.value || !toSel.value) return;
    matrixBox.innerHTML = '';
    const toIp = toSel.selectedOptions[0].dataset.ip;
    const res = ping(compiled.net, { from: fromSel.value, to: toIp });
    renderLines(summarizePing(res));
    play(); // auto-animate the packet across the map
  }

  function runProbe() {
    if (!prepare() || !fromSel.value || !toSel.value) return;
    matrixBox.innerHTML = '';
    const port = parseInt(portInp.value, 10);
    if (!(port >= 1 && port <= 65535)) { verdict.textContent = 'Enter a port between 1 and 65535'; verdict.className = 'sim-verdict bad'; return; }
    const toIp = toSel.selectedOptions[0].dataset.ip;
    const res = probe(compiled.net, { from: fromSel.value, to: toIp, port, protocol: protoSel.value });
    renderLines(summarizeProbe(res, protoSel.value, port));
    play();
  }

  // ── Scenario queue ──
  function testLabel(t) {
    const opt = [...fromSel.options].find((o) => o.value === t.from);
    const from = opt ? opt.textContent : t.from;
    return `${t.port ? `${t.proto}/${t.port}` : 'ping'}  ${from.split(' — ')[0]} → ${t.label}`;
  }
  function renderQueue() {
    queueList.innerHTML = '';
    queue.forEach((t, i) => {
      const li = doc.createElement('li');
      const txt = doc.createElement('span');
      txt.textContent = testLabel(t);
      const rm = el('button', { class: 'btn btn-ghost sim-queue-rm', text: '✕', title: 'Remove' });
      rm.addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
      li.append(txt, rm);
      if (t.result) li.classList.add(t.result === 'ok' ? 'ok' : 'bad');
      queueList.appendChild(li);
    });
    runQueueBtn.disabled = !queue.length;
  }
  function addToQueue() {
    if (!fromSel.value || !toSel.value || queue.length >= 20) return;
    const opt = toSel.selectedOptions[0];
    const port = parseInt(portInp.value, 10);
    const usePort = doc.activeElement === portInp || queueBtn.dataset.mode === 'probe';
    queue.push({ from: fromSel.value, to: toSel.value, toIp: opt.dataset.ip, label: opt.textContent.split(' — ')[0], port: usePort && port >= 1 && port <= 65535 ? port : null, proto: protoSel.value });
    renderQueue();
  }
  // Runs every queued test on ONE network without clearing what it learned in
  // between, so later tests see warm ARP/MAC tables and tracked connections.
  function runQueue() {
    if (!queue.length || !prepare()) return;
    matrixBox.innerHTML = '';
    const lines = [];
    let pass = 0;
    for (const t of queue) {
      let res;
      try {
        res = t.port ? probe(compiled.net, { from: t.from, to: t.toIp, port: t.port, protocol: t.proto }) : ping(compiled.net, { from: t.from, to: t.toIp });
      } catch { res = { ok: false, status: 'unreachable', events: [] }; }
      t.result = res.ok ? 'ok' : 'bad';
      if (res.ok) pass++;
      lines.push({ text: `${res.ok ? '✓' : '✗'} ${testLabel(t)} — ${res.status}`, dev: '', ev: null, sep: true });
      for (const e of res.events) lines.push({ text: describeEvent(e), dev: e.dev, ev: e });
    }
    renderLines({ ok: pass === queue.length, label: `Scenario: ${pass}/${queue.length} passed`, lines });
    renderQueue();
    play();
  }

  function runBlast() {
    if (!prepare() || !fromSel.value) return;
    const b = blastRadius(compiled, fromSel.value);
    log.innerHTML = ''; inspect.innerHTML = ''; matrixBox.innerHTML = '';
    lineEls = []; lineData = []; pathMeta = []; cursor = -1; stopAuto();
    if (!b) { verdict.textContent = 'Pick a source device'; verdict.className = 'sim-verdict'; return; }
    verdict.textContent = `If ${b.source.name} is compromised: reaches ${b.reachable} of ${b.total} addresses`;
    verdict.className = 'sim-verdict ' + (b.findings.some((f) => f.severity === 'high') ? 'bad' : b.reachable ? '' : 'ok');
    const ul = doc.createElement('ul');
    ul.className = 'sim-blast';
    for (const f of b.findings) ul.appendChild(el('li', { class: `sim-blast-${f.severity}`, text: `${f.severity === 'high' ? '⛔' : f.severity === 'medium' ? '⚠' : 'ℹ'} ${f.text}` }));
    matrixBox.appendChild(ul);
    const hit = b.targets.filter((t) => t.reachable);
    if (hit.length) {
      const table = doc.createElement('table');
      table.className = 'sim-matrix-table sim-blast-table';
      const head = doc.createElement('tr');
      for (const h of ['Reachable', 'Address', 'Where', 'Open services']) head.appendChild(el('th', { text: h }));
      table.appendChild(head);
      for (const t of hit) {
        const tr = doc.createElement('tr');
        const where = t.group === 'same-vlan' ? 'same VLAN' : t.group === 'other-vlan' ? `VLAN ${t.vlan}` : t.group;
        for (const c of [t.name, t.ip, where, t.open.map((o) => `${o.proto}/${o.port}`).join(', ') || '—']) tr.appendChild(el('td', { text: c }));
        table.appendChild(tr);
      }
      matrixBox.appendChild(table);
    }
  }

  function runMatrix() {
    if (!prepare()) return;
    const m = reachabilityMatrix(compiled);
    verdict.textContent = m.vlans.length ? 'VLAN reachability (✓ allowed · ⛔ firewalled · ✗ no route · · not testable)' : 'No addressed endpoints to test';
    verdict.className = 'sim-verdict';
    log.innerHTML = ''; inspect.innerHTML = ''; matrixBox.innerHTML = '';
    lineEls = []; lineData = []; pathMeta = []; cursor = -1;
    if (!m.vlans.length) return;
    const table = doc.createElement('table');
    table.className = 'sim-matrix-table';
    matrixRows(m).forEach((cells, r) => {
      const tr = doc.createElement('tr');
      cells.forEach((text, c) => {
        const td = doc.createElement(r === 0 || c === 0 ? 'th' : 'td');
        td.textContent = text;
        if (r > 0 && c > 0) {
          const cell = m.cells[r - 1][c - 1];
          td.className = `sim-m-${cell.status === 'n/a' ? 'na' : cell.status}`;
          td.title = cell.to ? `${cell.from} → ${cell.to}: ${cell.status}` : 'only one device in this VLAN';
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    matrixBox.appendChild(table);
  }

  function runTrace() {
    if (!prepare() || !fromSel.value || !toSel.value) return;
    matrixBox.innerHTML = '';
    const toIp = toSel.selectedOptions[0].dataset.ip;
    const hops = traceroute(compiled.net, { from: fromSel.value, to: toIp });
    verdict.textContent = `Traceroute to ${toIp}`;
    verdict.className = 'sim-verdict';
    log.innerHTML = '';
    lineEls = summarizeTrace(hops).map((h) => {
      const li = doc.createElement('li');
      li.textContent = h.text;
      if (h.reached) li.classList.add('ok');
      log.appendChild(li);
      return li;
    });
    cursor = -1;
  }

  pingBtn.addEventListener('click', runPing);
  traceBtn.addEventListener('click', runTrace);
  probeBtn.addEventListener('click', runProbe);
  matrixBtn.addEventListener('click', runMatrix);
  blastBtn.addEventListener('click', runBlast);
  queueBtn.addEventListener('click', addToQueue);
  // A queued test is a port probe when the port field was the last thing touched.
  portInp.addEventListener('input', () => { queueBtn.dataset.mode = 'probe'; });
  for (const s of [fromSel, toSel]) s.addEventListener('change', () => { queueBtn.dataset.mode = 'ping'; });
  runQueueBtn.addEventListener('click', runQueue);
  autoBtn.addEventListener('click', toggleAuto);
  speedSel.addEventListener('change', () => { if (autoTimer) { stopAuto(); toggleAuto(); } });
  nextBtn.addEventListener('click', () => { stopAuto(); const n = seek(cursor, 1); if (n >= 0) focusStep(n); });
  prevBtn.addEventListener('click', () => { stopAuto(); const n = seek(cursor, -1); if (n >= 0) focusStep(n); });
  renderQueue();
  playBtn.addEventListener('click', play);

  refresh();
  return { refresh, el: root };
}
