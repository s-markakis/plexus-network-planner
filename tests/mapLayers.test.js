// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderCAMLayer } from '../files/src/mapLayers.js';

const ctx = (over = {}) => ({
  doc: document, w: 1000, h: 800, cams: [{ id: 'c1', name: 'cam <1>', fx: 0.5, fy: 0.5, fov: 80, range: 100, heading: 0 }],
  settings: { showDori: true }, scaleM: 50, isSelected: () => false, statusDimmed: () => false,
  vlanColor: () => '', hexToRgba: () => 'rgba(0,0,0,.1)', tInk: () => '#000', tBg: () => '#fff',
  onItemPointerDown: vi.fn(), ...over,
});
const layer = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');

describe('camera layer', () => {
  it('puts the cone, lens and label on the page (they once vanished into a detached group)', () => {
    const l = layer();
    renderCAMLayer(l, ctx());
    for (const cls of ['cam-cone', 'cam-lens', 'cam-lbl', 'cam-heading']) expect(l.querySelector('.' + cls)).not.toBeNull();
    expect(l.querySelector('.cam-lbl').textContent).toBe('CAM <1>');
  });
  it('the hit area selects/drags the camera and carries its id for the context menu', () => {
    const c = ctx(); const l = layer();
    renderCAMLayer(l, c);
    const hit = l.querySelector('.cam-grp');
    expect(hit && hit.getAttribute('data-id')).toBe('c1');
    hit.dispatchEvent(new Event('pointerdown'));
    expect(c.onItemPointerDown).toHaveBeenCalledWith('cam', c.cams[0], expect.anything());
  });
});

describe('RF layers see WiFi routers', async () => {
  const { renderSampleLayer, renderRoamingLayer } = await import('../files/src/mapLayers.js');
  const router = { fx: 0.5, fy: 0.5, r: 300, freq: '2.4 / 5 GHz', pattern: 'omni' };
  const base = (over) => ({ doc: document, w: 400, h: 400, aps: [], rfAps: [router], walls: [], samples: [{ fx: 0.5, fy: 0.52, rssi: -45 }], settings: { showRoamingOverlap: true }, scaleM: 100, ...over });
  it('a survey sample next to a router is compared with the router', () => {
    const l = layer();
    renderSampleLayer(l, base());
    expect(l.querySelector('circle title')).not.toBeNull();   // has a prediction
  });
  it('roaming overlap counts a router as one of the two APs', () => {
    const l = layer();
    renderRoamingLayer(l, base({ rfAps: [router, { ...router, fx: 0.55 }] }));
    expect(l.querySelector('path.roaming-fill')).not.toBeNull();
  });
});
