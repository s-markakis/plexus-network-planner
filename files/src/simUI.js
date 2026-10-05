// Simulation-mode UI for the packet tracer. Thin DOM shell over the pure engine
// (sim.js) + adapter (simCompile.js): pick a source and destination device from
// the current plan, run a ping or traceroute, and read the packet's journey as
// a step log. "Step" walks the path on the map by reusing the app's own
// select+zoom (via the onFocus callback) — no changes to the SVG render path.
//
// The formatting helpers below are pure and unit-tested; mountSimPanel is the
// only DOM-touching part.

import { ping, traceroute, resetRuntime } from './sim.js';
import { compileTopology, pingableDevices } from './simCompile.js';

// ── Pure formatting ──────────────────────────────────────────────────────────

// One engine event → one human-readable line. Unknown kinds fall back to the
// raw kind so nothing is silently dropped.
export function describeEvent(e) {
  const who = e.devName || e.dev || '?';
  switch (e.kind) {
    case 'host-send': return `${who} sends ICMP echo → ${e.to}`;
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
    default: return `${who} ${e.kind}`;
  }
}

const STATUS_LABEL = {
  delivered: '✓ Reachable — echo reply received',
  unreachable: '✗ Unreachable — no path',
  'ttl-exceeded': '✗ TTL exceeded — routing loop or too many hops',
};

export function summarizePing(res) {
  return {
    ok: res.ok,
    label: STATUS_LABEL[res.status] || res.status,
    lines: res.events.map((e) => ({ text: describeEvent(e), dev: e.dev })),
  };
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
// ({settings, floors}); `onFocus(meta)` is called to highlight a device on the
// map (meta carries srcId + type). Returns { refresh } so callers can rebuild
// the device lists when the plan changes.
export function mountSimPanel({ root, getProject, onFocus }) {
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
  const verdict = el('div', { class: 'sim-verdict' });
  const log = el('ol', { class: 'sim-log' });
  const stepBar = el('div', { class: 'sim-stepbar' });
  const prevBtn = el('button', { class: 'btn btn-ghost', text: '◀ Prev' });
  const nextBtn = el('button', { class: 'btn btn-ghost', text: 'Step ▶' });

  stepBar.append(prevBtn, nextBtn);
  root.innerHTML = '';
  root.append(
    status,
    el('div', { class: 'sim-row' }, [el('label', { class: 'sim-lbl', text: 'From' }), fromSel]),
    el('div', { class: 'sim-row' }, [el('label', { class: 'sim-lbl', text: 'To' }), toSel]),
    el('div', { class: 'sim-row sim-actions' }, [pingBtn, traceBtn]),
    verdict,
    log,
    stepBar
  );

  let compiled = null;
  let lineEls = []; // <li> per step, for highlighting
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
    compiled = compileTopology(project);
    metaById = compiled.meta;
    const devs = pingableDevices(compiled).sort((a, b) => a.name.localeCompare(b.name));
    const swCount = [...compiled.meta.values()].filter((m) => m.type === 'switch').length;
    status.textContent = `${devs.length} endpoint(s) · ${swCount} switch(es)` +
      (compiled.warnings.length ? ` · ⚠ ${compiled.warnings.length} warning(s)` : '');
    status.title = compiled.warnings.join('\n');

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
    if (toSel.options.length > 1 && toSel.value === fromSel.value) toSel.selectedIndex = 1;
  }

  function renderLines(summary) {
    verdict.textContent = summary.label;
    verdict.className = 'sim-verdict ' + (summary.ok ? 'ok' : 'bad');
    log.innerHTML = '';
    lineEls = summary.lines.map((ln, i) => {
      const li = doc.createElement('li');
      li.textContent = ln.text;
      li.dataset.dev = ln.dev || '';
      li.addEventListener('click', () => focusStep(i));
      log.appendChild(li);
      return li;
    });
    cursor = -1;
  }

  function focusStep(i) {
    if (i < 0 || i >= lineEls.length) return;
    cursor = i;
    lineEls.forEach((li, j) => li.classList.toggle('active', j === i));
    const devId = lineEls[i].dataset.dev;
    const m = devId && metaById.get(devId);
    if (m && typeof onFocus === 'function') onFocus(m);
    try { lineEls[i].scrollIntoView({ block: 'nearest' }); } catch { /* non-browser env */ }
  }

  function runPing() {
    refresh();
    if (!fromSel.value || !toSel.value) return;
    resetRuntime(compiled.net); // fresh ARP/MAC so the log shows the full exchange
    const toIp = toSel.selectedOptions[0].dataset.ip;
    const res = ping(compiled.net, { from: fromSel.value, to: toIp });
    renderLines(summarizePing(res));
  }

  function runTrace() {
    refresh();
    if (!fromSel.value || !toSel.value) return;
    resetRuntime(compiled.net);
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
  nextBtn.addEventListener('click', () => focusStep(Math.min(cursor + 1, lineEls.length - 1)));
  prevBtn.addEventListener('click', () => focusStep(Math.max(cursor - 1, 0)));

  refresh();
  return { refresh, el: root };
}
