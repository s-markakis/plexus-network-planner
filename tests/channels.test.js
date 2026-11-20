import { describe, it, expect } from 'vitest';
import { parseChannel, apChansOverlap, bandMatches, heatApShape } from '../files/src/channels.js';

describe('channels', () => {
  it('parses loosely', () => {
    expect(parseChannel('6')).toBe(6);
    expect(parseChannel('ch 149')).toBe(149);
    expect(parseChannel('auto')).toBeNull();
    expect(parseChannel('')).toBeNull();
  });
  it('overlap is band- and width-aware; auto never overlaps', () => {
    const ap = (channel, freq = '5 GHz only', chanWidth = 20) => ({ channel, freq, chanWidth });
    expect(apChansOverlap(ap('36'), ap('36'))).toBe(true);
    expect(apChansOverlap(ap('36'), ap('40'))).toBe(false);
    expect(apChansOverlap(ap('36', '5 GHz only', 80), ap('44'))).toBe(true);
    expect(apChansOverlap(ap('1', '2.4 GHz only'), ap('3', '2.4 GHz only'))).toBe(true);
    expect(apChansOverlap(ap('1', '2.4 GHz only'), ap('6', '2.4 GHz only'))).toBe(false);
    expect(apChansOverlap(ap('auto'), ap('36'))).toBe(false);
  });
  it('band filter', () => {
    expect(bandMatches({ freq: '2.4 / 5 GHz' }, '2.4')).toBe(true);
    expect(bandMatches({ freq: '2.4 / 5 GHz' }, '5')).toBe(true);
    expect(bandMatches({ freq: '6 GHz (WiFi 6E)' }, '5')).toBe(false);
    expect(bandMatches({ freq: '5 GHz only' }, 'all')).toBe(true);
  });
  it('heat job shape is plain and clamps width', () => {
    const s = heatApShape({ fx: 0.1, fy: 0.2, r: 50, freq: '5 GHz only', channel: 'ch44', chanWidth: 33, pattern: 'nope' });
    expect(s).toMatchObject({ fx: 0.1, fy: 0.2, r: 50, channel: 44, widthMhz: 20, headingDeg: 0 });
    expect(() => structuredClone(s)).not.toThrow();
  });
});
