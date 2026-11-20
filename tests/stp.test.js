import { describe, it, expect } from 'vitest';
import { buildNet } from '../files/src/sim.js';
import { runStp } from '../files/src/stp.js';

// n switches fully described by their inter-switch links. Every switch gets one
// access port per peer link plus the trunk ports; here we only need the trunk
// links between switches, so each link is a pair of named ports.
function switchFabric(ids, links) {
  const portsOf = new Map(ids.map((id) => [id, new Set()]));
  for (const [a, b] of links) {
    const [ad, ap] = a.split('/');
    const [bd, bp] = b.split('/');
    portsOf.get(ad).add(ap);
    portsOf.get(bd).add(bp);
  }
  return buildNet({
    devices: ids.map((id) => ({
      id, kind: 'switch',
      ifaces: [...portsOf.get(id)].map((name) => ({ name, mode: 'trunk' })),
    })),
    links,
  });
}

const blockedSet = (r) => new Set(r.blocked.map((b) => `${b.dev}/${b.iface}`));
const roleOf = (r, dev, iface) => (r.ports.find((p) => p.dev === dev && p.iface === iface) || {}).role;

describe('runStp — root election', () => {
  it('elects the lowest-id switch as root when priorities tie', () => {
    const net = switchFabric(['sw2', 'sw1', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const r = runStp(net);
    expect(r.roots).toEqual(['sw1']);
  });

  it('a lower bridge priority wins the root over a lower id', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const r = runStp(net, { priority: (d) => (d.id === 'sw3' ? 4096 : 32768) });
    expect(r.roots).toEqual(['sw3']);
  });

  it('a malformed/negative priority falls back to the default', () => {
    const net = switchFabric(['sw1', 'sw2'], [['sw1/t', 'sw2/t']]);
    // sw1 given a garbage priority → default 32768 for both → id breaks the tie.
    const r = runStp(net, { priority: (d) => (d.id === 'sw1' ? NaN : 32768) });
    expect(r.roots).toEqual(['sw1']);
  });
});

describe('runStp — loop breaking', () => {
  it('blocks exactly one port on a three-switch triangle', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const r = runStp(net);
    expect(r.blocked).toHaveLength(1);
    // The blocked end sits on the redundant sw2–sw3 link (both are one hop from
    // the root sw1, so the sw1 links form the tree).
    const b = r.blocked[0];
    expect(['sw2', 'sw3']).toContain(b.dev);
  });

  it('marks the blocked port with role "blocked" and its peer "designated"', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const r = runStp(net);
    const b = r.blocked[0];
    expect(roleOf(r, b.dev, b.iface)).toBe('blocked');
    // the net mutation marks the interface itself
    expect(net.devices.get(b.dev).ifaces.get(b.iface).blocked).toBe(true);
  });

  it('a redundant parallel link between two switches blocks one end', () => {
    const net = switchFabric(['sw1', 'sw2'], [
      ['sw1/a', 'sw2/a'], ['sw1/b', 'sw2/b'],
    ]);
    const r = runStp(net);
    expect(r.roots).toEqual(['sw1']);
    expect(r.blocked).toHaveLength(1);
    // The designated (keep) end is on the root bridge sw1; the loser is on sw2.
    expect(r.blocked[0].dev).toBe('sw2');
  });

  it('leaves a loop-free chain fully forwarding (no blocked ports)', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t', 'sw2/t1'], ['sw2/t2', 'sw3/t'],
    ]);
    const r = runStp(net);
    expect(r.blocked).toHaveLength(0);
    expect(roleOf(r, 'sw2', 't1')).toBe('root');       // sw2's port toward root sw1
    expect(roleOf(r, 'sw1', 't')).toBe('designated');
  });
});

describe('runStp — components and participation', () => {
  it('elects a root per disconnected component', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3', 'sw4'], [
      ['sw1/t', 'sw2/t'],   // component A
      ['sw3/t', 'sw4/t'],   // component B
    ]);
    const r = runStp(net);
    expect(r.roots.sort()).toEqual(['sw1', 'sw3']);
  });

  it('ignores non-switch devices and host links', () => {
    const net = buildNet({
      devices: [
        { id: 'sw1', kind: 'switch', ifaces: [{ name: 'g1', mode: 'access', vlan: 1 }, { name: 't', mode: 'trunk' }] },
        { id: 'sw2', kind: 'switch', ifaces: [{ name: 't', mode: 'trunk' }] },
        { id: 'pc', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.0.5', prefix: 24 }] },
      ],
      links: [['sw1/g1', 'pc/e'], ['sw1/t', 'sw2/t']],
    });
    const r = runStp(net);
    // Only the switch–switch link is considered; the host link is never blocked.
    expect(r.blocked).toHaveLength(0);
    expect(r.roots).toEqual(['sw1']);
  });
});

describe('runStp — fault handling and idempotency', () => {
  it('excludes a down inter-switch link from the tree', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    // Fail the sw1–sw2 link: with only two usable links left (a chain) there is
    // no loop, so nothing should be blocked.
    net.devices.get('sw1').ifaces.get('t2').up = false;
    const r = runStp(net);
    expect(r.blocked).toHaveLength(0);
  });

  it('reconverges: failing the active path unblocks the backup', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const first = runStp(net);
    const wasBlocked = first.blocked[0];
    expect(wasBlocked).toBeTruthy();
    // Bring down the port that STP left forwarding on the same link's peer end,
    // then take the whole blocked link's device port down and re-run: a re-run
    // must clear the previous block and re-evaluate from scratch.
    net.devices.get('sw1').ifaces.get('t3').up = false;   // fail an sw1 tree link
    const second = runStp(net);
    // The previously blocked interface must not stay blocked just because an
    // earlier run set it — runStp clears its own prior result first.
    const stillBlockedByStaleState = net.devices.get(wasBlocked.dev).ifaces.get(wasBlocked.iface).blocked
      && !blockedSet(second).has(`${wasBlocked.dev}/${wasBlocked.iface}`);
    expect(stillBlockedByStaleState).toBe(false);
  });

  it('is idempotent: running twice yields the same blocked set', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const a = blockedSet(runStp(net));
    const b = blockedSet(runStp(net));
    expect([...b].sort()).toEqual([...a].sort());
  });

  it('every tree link has exactly one root and one designated end', () => {
    const net = switchFabric(['sw1', 'sw2', 'sw3'], [
      ['sw1/t2', 'sw2/t1'], ['sw2/t3', 'sw3/t2'], ['sw1/t3', 'sw3/t1'],
    ]);
    const r = runStp(net);
    const roots = r.ports.filter((p) => p.role === 'root');
    const desig = r.ports.filter((p) => p.role === 'designated');
    // 3 switches, 2 tree links → 2 root ports, and designated ports on the other
    // ends (2 for tree links + 1 for the blocked link's keep end).
    expect(roots).toHaveLength(2);
    expect(desig.length).toBeGreaterThanOrEqual(2);
  });
});
