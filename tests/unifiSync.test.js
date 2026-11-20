import { describe, it, expect } from 'vitest';
import { applyUnifiDevices, unifiChannelPlan } from '../files/src/unifiSync.js';

const plan = () => [{ APS: [{ id: 'a', name: 'Lobby AP', mac: 'AA:BB:CC:00:11:22', channel: '36', freq: '2.4 / 5 GHz', chanWidth: 80, txPowerDbm: 17 }, { id: 'b', name: 'Pool', channel: 'auto' }],
  SWS: [{ id: 's', name: 'Core', serial: 'KEEP' }], CAMS: [] }];

describe('applyUnifiDevices', () => {
  it('matches by MAC (any format), then by name; fills as-built fields', () => {
    const f = plan();
    const n = applyUnifiDevices(f, [
      { mac: 'aabbcc001122', ip: '10.0.0.9', version: '7.1.66', serial: 'S1', state: 1 },
      { name: 'CORE', ip: '10.0.0.2', serial: 'NEW', mac: 'de:ad:be:ef:00:01' },
      { name: 'nobody', ip: '1.1.1.1' },
    ]);
    expect(n).toBe(2);
    expect(f[0].APS[0]).toMatchObject({ ip: '10.0.0.9', firmware: '7.1.66', serial: 'S1', status: 'live' });
    expect(f[0].SWS[0]).toMatchObject({ ip: '10.0.0.2', serial: 'KEEP', mac: 'de:ad:be:ef:00:01' });
  });
  it('a hostile controller cannot put objects or huge strings into the plan', () => {
    const f = plan();
    applyUnifiDevices(f, [null, 'x', { mac: 'aa:bb:cc:00:11:22', ip: { toString: () => 'evil' }, version: 'v'.repeat(10000), serial: ['a'] }]);
    const ap = f[0].APS[0];
    expect(ap.ip).toBeUndefined();
    expect(ap.firmware.length).toBe(200);
    expect(ap.serial).toBeUndefined();
    expect(applyUnifiDevices(f, /** @type {any} */ ('nope'))).toBe(0);
  });
});

describe('unifiChannelPlan', () => {
  it('only APs with a concrete channel; dual-band planned on 5 GHz', () => {
    expect(unifiChannelPlan(plan())).toEqual([{ mac: 'AA:BB:CC:00:11:22', name: 'Lobby AP', band: '5', channel: 36, width: 80, txPowerDbm: 17 }]);
  });
});
