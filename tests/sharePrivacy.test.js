import { describe, it, expect } from 'vitest';
import { projectForShare } from '../files/src/shareLink.js';
import { remoteImageRefs, remoteImageHosts, stripRemoteImages } from '../files/src/remoteImages.js';

const project = () => ({
  version: 11,
  settings: { company: 'NOCTIS', unifiUrl: 'https://10.0.0.1', unifiUser: 'admin', unifiSite: 'villa', vlans: [{ id: '10' }], logoDataUrl: 'https://track.example/logo.png' },
  floors: [{
    name: 'G', img: 'data:image/png;base64,AAA', imgId: 'i1',
    APS: [{ id: 'a', name: 'AP', ip: '10.0.10.5', mac: 'aa:bb', serial: 'S1', assetTag: 'T1', firmware: '7.1', creds: { user: 'u', pass: 'p' }, imageUrl: '//cdn.example/ap.png', _cache: 1 }],
    SWS: [{ id: 's', name: 'SW', cli: { routes: [], acls: [{ permit: true }], vlans: [], interfaces: {} }, creds: { pass: 'x' } }],
    CAMS: [{ id: 'c', imageUrl: 'data:image/png;base64,BBB' }],
    CLIENTS: [{ id: 'k', nested: { creds: { pass: 'deep' } } }],
  }],
});

describe('projectForShare', () => {
  const p = project();
  const out = projectForShare(p);
  const json = JSON.stringify(out);
  it('drops credentials at any depth, controller login, hardware identifiers, images, caches', () => {
    for (const secret of ['"pass"', 'unifiUrl', 'unifiUser', 'unifiSite', 'aa:bb', '"S1"', '"T1"', '7.1', 'imgId', 'AAA', '_cache']) expect(json).not.toContain(secret);
  });
  it('keeps the design: names, IPs, VLANs, sim config', () => {
    expect(out.floors[0].APS[0]).toMatchObject({ id: 'a', name: 'AP', ip: '10.0.10.5' });
    expect(out.floors[0].SWS[0].cli.acls).toHaveLength(1);
    expect(out.settings.vlans).toEqual([{ id: '10' }]);
    expect(out.version).toBe(11);
  });
  it('never mutates the live project', () => {
    expect(p.floors[0].APS[0].creds.pass).toBe('p');
    expect(p.settings.unifiUser).toBe('admin');
    expect(p.floors[0].img).toContain('AAA');
  });
});

describe('remote images', () => {
  it('finds http(s) and protocol-relative URLs, ignores data:', () => {
    const p = project();
    expect(remoteImageRefs(p).map((r) => r.key)).toEqual(['logoDataUrl', 'imageUrl']);
    expect(remoteImageHosts(p)).toEqual(['cdn.example', 'track.example']);
  });
  it('strips them in place and leaves inline images', () => {
    const p = project();
    expect(stripRemoteImages(p)).toBe(2);
    expect(remoteImageHosts(p)).toEqual([]);
    expect(p.floors[0].CAMS[0].imageUrl).toContain('BBB');
    expect(p.floors[0].img).toContain('AAA');
  });
  it('tolerates junk', () => {
    expect(remoteImageRefs(null)).toEqual([]);
    expect(remoteImageRefs({ floors: [null, { APS: 'x' }] })).toEqual([]);
    expect(remoteImageHosts({ floors: [{ img: 'http://[bad' }] })).toEqual(['http://[bad']);
  });
});
