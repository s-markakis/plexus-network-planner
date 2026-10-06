import { describe, it, expect } from 'vitest';
import { buildZone, resolve, normName } from '../files/src/dns.js';
import { compileTopology } from '../files/src/simCompile.js';

describe('dns resolver', () => {
  it('resolves names case-insensitively, ignoring a trailing dot', () => {
    const z = buildZone([{ name: 'Server-01', ip: '10.0.0.5' }]);
    expect(resolve(z, 'server-01')).toBe('10.0.0.5');
    expect(resolve(z, 'SERVER-01.')).toBe('10.0.0.5');
    expect(resolve(z, 'nope')).toBeNull();
  });
  it('passes an IP straight through', () => {
    expect(resolve({}, '8.8.8.8')).toBe('8.8.8.8');
  });
  it('normName trims/lowercases', () => {
    expect(normName('  AP-01.  ')).toBe('ap-01');
  });
});

describe('compileTopology builds a DNS zone from device names', () => {
  it('every named device with an IP resolves by name; settings.dns overrides', () => {
    const c = compileTopology({
      settings: {
        vlans: [{ id: '10', subnet: '10.0.10.0/24' }],
        dns: [{ name: 'gw', ip: '10.0.10.1' }],
      },
      floors: [{
        SWS: [{ id: 's', name: 'SW-01', ip: '10.0.10.2' }],
        APS: [{ id: 'a1', name: 'AP-01', swId: 's', port: '1', vlan: '10', ip: '10.0.10.5' }],
        CAMS: [],
      }],
    });
    expect(resolve(c.dns, 'AP-01')).toBe('10.0.10.5');
    expect(resolve(c.dns, 'gw')).toBe('10.0.10.1'); // explicit record present
  });
});
