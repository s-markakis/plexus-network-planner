// Terminal UI for the per-device CLI console (Phase 3c). A thin DOM shell over
// the pure CLI engine (cli.js): it binds a session to the selected device's
// running-config (sw.cli), echoes commands and output like a real terminal, and
// executes `ping` by compiling the live plan and running the sim engine. The
// config it mutates is the same object compileTopology reads, so typing
// `interface vlan 10 / ip address …` makes the device route in the simulator.
//
// Everything the engine needs is pure and tested elsewhere; the only logic here
// is terminal plumbing plus pingSummary (pure, tested).

import { newConfig, makeSession } from './cli.js';
import { compileTopology } from './simCompile.js';
import { ping } from './sim.js';

export function guessVendor(model = '') {
  const m = String(model).toLowerCase();
  if (/\b(mikrotik|routeros|rb\d|crs\d|ccr\d|hap|cap ?ac)\b/.test(m)) return 'mikrotik';
  return 'cisco'; // default dialect; a UniFi/other switch is driven in IOS style
}

// Pure: turn a sim ping result into one terminal line. `result` is null when the
// device has no routed interface to source the ping from.
export function pingSummary(result, target) {
  if (!result) return `% no routed interface to source a ping from`;
  if (result.ok) return `Reply from ${target}: echo reply received`;
  if (result.status === 'ttl-exceeded') return `${target}: TTL expired in transit`;
  return `${target}: destination host unreachable`;
}

// Mount the console into `root`.
//   getDevice()      → the selected switch/router object (we read/write .cli).
//   getProject()     → { settings, floors } for compiling the live ping.
//   onConfigChange() → called after any command that may have mutated the config.
export function mountCliConsole({ root, getDevice, getProject, onConfigChange }) {
  const doc = root.ownerDocument;
  const dev = getDevice();
  const vendor = (dev.cli && dev.cli.vendor) || guessVendor(dev.model);
  if (!dev.cli) dev.cli = newConfig({ vendor, hostname: dev.name || dev.id });
  if (!dev.cli.vendor) dev.cli.vendor = vendor;
  let session = makeSession(dev.cli, dev.cli.vendor);

  const el = (tag, attrs = {}) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    return n;
  };

  const vendorSel = el('select', { class: 'cli-vendor' });
  for (const [val, label] of [['cisco', 'Cisco IOS'], ['mikrotik', 'MikroTik RouterOS']]) {
    const o = doc.createElement('option');
    o.value = val; o.textContent = label; if (val === dev.cli.vendor) o.selected = true;
    vendorSel.appendChild(o);
  }
  const out = el('div', { class: 'cli-out' });
  const promptLbl = el('span', { class: 'cli-prompt' });
  const input = el('input', { class: 'cli-input', spellcheck: 'false', autocomplete: 'off' });
  const inputRow = el('div', { class: 'cli-row' });
  inputRow.append(promptLbl, input);

  const bar = el('div', { class: 'cli-bar' });
  bar.append(el('span', { class: 'cli-dialect-lbl', text: 'Dialect' }), vendorSel);

  root.innerHTML = '';
  root.append(bar, out, inputRow);

  const history = [];
  let hix = -1;

  function updatePrompt() { promptLbl.textContent = session.prompt(); }

  function print(lines, cls) {
    for (const line of lines) {
      const div = doc.createElement('div');
      div.className = 'cli-line' + (cls ? ' ' + cls : '');
      div.textContent = line;
      out.appendChild(div);
    }
    out.scrollTop = out.scrollHeight;
  }

  function execPing(target) {
    let compiled;
    try { compiled = compileTopology(getProject()); } catch { return null; }
    const rid = `r:${dev.id}`;
    if (!compiled.net.devices.has(rid)) return null;
    return ping(compiled.net, { from: rid, to: target });
  }

  function submit(raw) {
    print([`${session.prompt()} ${raw}`], 'cli-cmd');
    const res = session.exec(raw);
    if (res.ping) print([pingSummary(execPing(res.ping), res.ping)], 'cli-std');
    else if (res.output && res.output.length) print(res.output, res.error ? 'cli-err' : 'cli-std');
    else if (res.error) print(['% error'], 'cli-err');
    if (typeof onConfigChange === 'function') onConfigChange();
    updatePrompt();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value;
      if (line.trim()) { history.push(line); hix = history.length; }
      input.value = '';
      submit(line);
    } else if (e.key === 'ArrowUp') {
      if (hix > 0) { hix--; input.value = history[hix]; e.preventDefault(); }
    } else if (e.key === 'ArrowDown') {
      if (hix < history.length - 1) { hix++; input.value = history[hix]; }
      else { hix = history.length; input.value = ''; }
      e.preventDefault();
    }
  });

  vendorSel.addEventListener('change', () => {
    dev.cli.vendor = vendorSel.value;
    session = makeSession(dev.cli, dev.cli.vendor);
    updatePrompt();
    print([`% dialect set to ${vendorSel.value}`], 'cli-std');
    if (typeof onConfigChange === 'function') onConfigChange();
  });

  print([`${dev.name || dev.id} console — type commands (↑/↓ history). "ping <ip>" simulates against the plan.`], 'cli-std');
  updatePrompt();
  return { el: root, focus: () => input.focus(), session: () => session };
}
